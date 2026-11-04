"""Splat Director: local web app for filming camera moves through Gaussian splats.

    venv/bin/python -I director/director.py [--port 8771] [--no-browser]

Built like Splat Studio (app/studio.py): a small stdlib HTTP server on 127.0.0.1 that
serves the UI and shuts itself down when the window closes. It never loads splats or
video itself; the browser does all 3D work. The server only:
  - lists splats in projects/ and films/media in app_data/director/
  - saves and loads film files (JSON)
  - stores imported videos and music
  - takes rendered frames + a mixed audio track from the UI and encodes the mp4 with ffmpeg
Everything is local; nothing is uploaded anywhere.
"""
import argparse
import glob
import json
import mimetypes
import os
import re
import shutil
import signal
import subprocess
import threading
import time
import urllib.parse
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

APP = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(APP)
PROJECTS = os.path.join(ROOT, "projects")
DATA = os.path.join(ROOT, "app_data", "director")
FILMS = os.path.join(DATA, "films")
MEDIA = os.path.join(DATA, "media")
RENDERS = os.path.join(DATA, "renders")
EXPORTS = os.path.expanduser("~/Movies/Splat Director")
HEARTBEAT_TIMEOUT = 150  # same reasoning as Splat Studio: background tabs slow timers to ~1/min
BYE_GRACE = 8
STARTUP_GRACE = 180
FFMPEG = shutil.which("ffmpeg") or next((p for p in ("/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg") if os.path.exists(p)), None)

last_beat = None
last_bye = None
started = time.time()
renders = {}             # job id -> {"proc", "dir", "frames", "out", "fps"}
lock = threading.RLock()


def log(msg):
    os.makedirs(DATA, exist_ok=True)
    with open(os.path.join(DATA, "director.log"), "a") as fh:
        fh.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}\n")


def read_json(path, default=None):
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


def write_json(path, data):
    with open(path + ".tmp", "w") as fh:
        json.dump(data, fh, indent=1)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(path + ".tmp", path)


def safe_name(name):
    name = re.sub(r"[^A-Za-z0-9 _.-]+", "_", name or "").strip(" .")[:60]
    if not name:
        raise ValueError("bad name")
    return name


def list_splats():
    """Every splat under projects/: scene.splat / *.splat / *.ply, newest first, with the
    project's camera_path.json (gives the scene's 'up' and a centre point for auto-alignment)."""
    out = []
    for proj in sorted(os.listdir(PROJECTS)) if os.path.isdir(PROJECTS) else []:
        d = os.path.join(PROJECTS, proj)
        if not os.path.isdir(d):
            continue
        files = sorted(glob.glob(os.path.join(d, "*.splat")))
        if not files:  # fall back to the trained .ply only when no .splat was made (ply files are huge)
            files = sorted(glob.glob(os.path.join(d, "scene.ply")))
        cam = read_json(os.path.join(d, "camera_path.json"), {})
        cfg = read_json(os.path.join(d, "project.json"), {})
        for f in files:
            out.append({
                "project": proj,
                "name": cfg.get("name") or proj,
                "file": os.path.basename(f),
                "url": "/" + os.path.relpath(f, ROOT),
                "mb": round(os.path.getsize(f) / 1e6, 1),
                "modified": os.path.getmtime(f),
                "up": cam.get("up"),
                "center": cam.get("target"),
                "fov": cam.get("fov"),
                "start": cam["frames"][0] if cam.get("frames") else None,
                "thumb": "/" + os.path.relpath(os.path.join(d, "thumb.jpg"), ROOT) if os.path.exists(os.path.join(d, "thumb.jpg")) else None,
            })
    out.sort(key=lambda s: -s["modified"])
    return out


def list_films():
    os.makedirs(FILMS, exist_ok=True)
    out = []
    for f in glob.glob(os.path.join(FILMS, "*.json")):
        out.append({"name": os.path.splitext(os.path.basename(f))[0], "modified": os.path.getmtime(f)})
    out.sort(key=lambda s: -s["modified"])
    return out


def list_media():
    os.makedirs(MEDIA, exist_ok=True)
    out = []
    for f in sorted(os.listdir(MEDIA)):
        if f.startswith("."):
            continue
        mime = mimetypes.guess_type(f)[0] or ""
        out.append({"name": f, "url": "/media/" + urllib.parse.quote(f), "kind": "audio" if mime.startswith("audio") else "video",
                    "mb": round(os.path.getsize(os.path.join(MEDIA, f)) / 1e6, 1)})
    return out


def shutdown(reason):
    log(f"shutting down: {reason}")
    with lock:
        for job in renders.values():
            if job["proc"].poll() is None:
                job["proc"].kill()
    os._exit(0)


def watchdog():
    global last_beat
    tick = time.time()
    while True:
        time.sleep(5)
        now = time.time()
        if now - tick > 30 and last_beat is not None:  # computer was asleep
            last_beat = now
        tick = now
        if last_beat is None and now - started > STARTUP_GRACE:
            shutdown("UI never opened")
        if last_beat is not None and now - last_beat > HEARTBEAT_TIMEOUT:
            shutdown("no heartbeat from the UI")
        if last_bye is not None and now - last_bye > BYE_GRACE and (last_beat or 0) < last_bye:
            shutdown("UI window closed")


def start_render(name, fps, width, height):
    """Start ffmpeg reading JPEG frames from a pipe. Audio is muxed in at finish."""
    if not FFMPEG:
        raise RuntimeError("ffmpeg not found. Install it with: brew install ffmpeg")
    job = time.strftime("%Y%m%d-%H%M%S")
    d = os.path.join(RENDERS, job)
    os.makedirs(d, exist_ok=True)
    video = os.path.join(d, "video.mp4")
    cmd = [FFMPEG, "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", str(fps), "-c:v", "mjpeg", "-i", "-",
           "-vf", f"scale={width}:{height}", "-c:v", "libx264", "-preset", "medium", "-crf", "17",
           "-pix_fmt", "yuv420p", "-r", str(fps), video]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=open(os.path.join(d, "ffmpeg.log"), "wb"))
    renders[job] = {"proc": proc, "dir": d, "frames": 0, "video": video, "fps": fps, "name": name}
    log(f"render {job} started: {name} {width}x{height}@{fps}")
    return job


def finish_render(job, audio):
    j = renders.pop(job)
    j["proc"].stdin.close()
    j["proc"].wait()
    if j["proc"].returncode != 0 or not os.path.exists(j["video"]):
        raise RuntimeError("ffmpeg failed: " + open(os.path.join(j["dir"], "ffmpeg.log")).read()[-800:])
    os.makedirs(EXPORTS, exist_ok=True)
    base = os.path.join(EXPORTS, safe_name(j["name"]))
    out, n = base + ".mp4", 2
    while os.path.exists(out):
        out, n = f"{base} {n}.mp4", n + 1
    if audio:
        wav = os.path.join(j["dir"], "audio.wav")
        with open(wav, "wb") as fh:
            fh.write(audio)
        r = subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", j["video"], "-i", wav, "-c:v", "copy",
                            "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", out],
                           capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError("ffmpeg audio mux failed: " + r.stderr[-800:])
    else:
        shutil.move(j["video"], out)
    shutil.rmtree(j["dir"], ignore_errors=True)
    log(f"render {job} done: {j['frames']} frames -> {out}")
    return {"path": out, "frames": j["frames"]}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, *a):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        n = int(self.headers.get("Content-Length", 0))
        chunks = []
        while n > 0:
            c = self.rfile.read(min(1 << 20, n))
            if not c:
                break
            chunks.append(c)
            n -= len(c)
        return b"".join(chunks)

    def send_file_ranged(self, path):
        """Static file with HTTP Range support: video elements need it to seek."""
        size = os.path.getsize(path)
        start, end = 0, size - 1
        m = re.match(r"bytes=(\d*)-(\d*)", self.headers.get("Range", ""))
        if m and (m.group(1) or m.group(2)):
            if m.group(1):
                start = int(m.group(1))
                end = int(m.group(2)) if m.group(2) else size - 1
            else:
                start = size - int(m.group(2))
            end = min(end, size - 1)
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(path)[0] or "application/octet-stream")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        with open(path, "rb") as fh:
            fh.seek(start)
            left = end - start + 1
            try:
                while left > 0:
                    c = fh.read(min(1 << 20, left))
                    if not c:
                        break
                    self.wfile.write(c)
                    left -= len(c)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        q = dict(urllib.parse.parse_qsl(url.query))
        path = urllib.parse.unquote(url.path)
        if path in ("/", "/index.html"):
            self.path = "/director/ui/index.html"
            return super().do_GET()
        if path == "/api/info":
            return self.send({"ffmpeg": bool(FFMPEG), "exports": EXPORTS})
        if path == "/api/splats":
            return self.send(list_splats())
        if path == "/api/films":
            return self.send(list_films())
        if path == "/api/film":
            film = read_json(os.path.join(FILMS, safe_name(q.get("name")) + ".json"))
            return self.send(film) if film else self.send({"error": "not found"}, 404)
        if path == "/api/media":
            return self.send(list_media())
        if path.startswith("/media/") and ".." not in path:
            f = os.path.join(MEDIA, os.path.basename(path))
            return self.send_file_ranged(f) if os.path.isfile(f) else self.send_error(404)
        # static files: the UI, the shared viewer library and project outputs
        if not re.match(r"^/(director/ui|tools/viewer/lib|projects|example)/", path) or ".." in path:
            return self.send_error(404)
        f = os.path.join(ROOT, path.lstrip("/"))
        if os.path.isfile(f) and re.search(r"\.(mp4|mov|m4v|webm)$", f, re.I):
            return self.send_file_ranged(f)
        return super().do_GET()

    def do_POST(self):
        global last_beat, last_bye
        url = urllib.parse.urlparse(self.path)
        q = dict(urllib.parse.parse_qsl(url.query))
        try:
            if url.path == "/api/heartbeat":
                last_beat = time.time()
                return self.send({"ok": True})
            if url.path == "/api/bye":
                last_bye = time.time()
                return self.send({"ok": True})
            if url.path == "/api/film":
                name = safe_name(q.get("name"))
                film = json.loads(self.body())
                os.makedirs(FILMS, exist_ok=True)
                f = os.path.join(FILMS, name + ".json")
                if os.path.exists(f):  # one rolling backup, in case a save goes wrong
                    shutil.copyfile(f, f + ".bak")
                write_json(f, film)
                return self.send({"ok": True, "name": name})
            if url.path == "/api/media":
                name = safe_name(q.get("name"))
                os.makedirs(MEDIA, exist_ok=True)
                base, ext = os.path.splitext(name)
                f, n = os.path.join(MEDIA, name), 2
                while os.path.exists(f):
                    f, n = os.path.join(MEDIA, f"{base} {n}{ext}"), n + 1
                remaining = int(self.headers.get("Content-Length", 0))
                with open(f, "wb") as fh:  # streamed: videos can be large
                    while remaining > 0:
                        c = self.rfile.read(min(1 << 20, remaining))
                        if not c:
                            break
                        fh.write(c)
                        remaining -= len(c)
                log(f"imported media {os.path.basename(f)}")
                return self.send({"ok": True, "media": next(m for m in list_media() if m["name"] == os.path.basename(f))})
            if url.path == "/api/render/start":
                with lock:
                    job = start_render(q.get("name", "film"), float(q.get("fps", 30)), int(q.get("w", 1920)), int(q.get("h", 1080)))
                return self.send({"job": job})
            if url.path == "/api/render/frame":
                data = self.body()
                with lock:
                    j = renders[q["job"]]
                    j["proc"].stdin.write(data)
                    j["frames"] += 1
                return self.send({"ok": True, "frames": j["frames"]})
            if url.path == "/api/render/finish":
                audio = self.body()
                with lock:
                    res = finish_render(q["job"], audio if len(audio) > 44 else None)
                return self.send(res)
            if url.path == "/api/render/cancel":
                with lock:
                    j = renders.pop(q.get("job"), None)
                if j:
                    j["proc"].kill()
                    shutil.rmtree(j["dir"], ignore_errors=True)
                return self.send({"ok": True})
            if url.path == "/api/reveal":
                p = q.get("path", "")
                if p.startswith(EXPORTS) and os.path.exists(p):
                    subprocess.Popen(["open", "-R", p])
                return self.send({"ok": True})
            if url.path == "/api/quit":
                self.send({"ok": True})
                threading.Thread(target=shutdown, args=("quit from UI",)).start()
                return
        except (ValueError, KeyError, RuntimeError, OSError) as e:
            log(f"error on {url.path}: {e}")
            return self.send({"error": str(e)}, 400)
        self.send_error(404)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8771)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    for d in (DATA, FILMS, MEDIA, RENDERS):
        os.makedirs(d, exist_ok=True)
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    signal.signal(signal.SIGTERM, lambda *_: shutdown("SIGTERM"))
    signal.signal(signal.SIGINT, lambda *_: shutdown("Ctrl-C"))
    threading.Thread(target=watchdog, daemon=True).start()
    log(f"director started on port {args.port} (pid {os.getpid()})")
    url = f"http://127.0.0.1:{args.port}/"
    print(url, flush=True)
    if not args.no_browser:
        webbrowser.open(url)
    srv.serve_forever()


if __name__ == "__main__":
    main()
