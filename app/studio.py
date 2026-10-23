"""Splat Studio: local web app that turns a video into a Gaussian splat.

    venv/bin/python -I app/studio.py [--port 8770] [--no-browser]

Serves the UI on http://127.0.0.1:PORT, runs one pipeline.py process per job,
and shuts itself down (killing every job and its GPU processes) when the UI
window is closed (a few seconds; ~2.5 min if it vanished without saying goodbye), or on POST /api/quit.
Everything is local; nothing is uploaded anywhere.
"""
import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.parse
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import psutil

APP = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(APP)
sys.path.insert(0, APP)
import hardware  # noqa: E402

PROJECTS = os.path.join(ROOT, "projects")
DATA = os.path.join(ROOT, "app_data")
QUALITY = {"quick": 7000, "full": 30000}
HEARTBEAT_TIMEOUT = 150  # no heartbeat this long = UI gone. Long, because browsers slow timers in background tabs to ~1/min
BYE_GRACE = 8            # after the window says goodbye (closed or reloading), wait this long for a new heartbeat
STARTUP_GRACE = 180      # how long to wait for the UI to open the first time

jobs = {}                # project id -> subprocess.Popen
last_beat = None
last_bye = None
started = time.time()
info_cache = None
lock = threading.Lock()


def log(msg):
    os.makedirs(DATA, exist_ok=True)
    with open(os.path.join(DATA, "studio.log"), "a") as fh:
        fh.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}\n")


def system_info():
    global info_cache
    if info_cache is None:
        info_cache = hardware.detect()
    return info_cache


def read_json(path, default=None):
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


def write_json(path, data):
    with open(path + ".tmp", "w") as fh:
        json.dump(data, fh, indent=2)
    os.replace(path + ".tmp", path)


def job_running(pid):
    p = jobs.get(pid)
    return p is not None and p.poll() is None


def project_summary(pid):
    d = os.path.join(PROJECTS, pid)
    cfg = read_json(os.path.join(d, "project.json"))
    if not cfg:
        return None
    st = read_json(os.path.join(d, "status.json"), {})
    state = st.get("state", cfg.get("state", "ready"))
    if state == "running" and not job_running(pid):
        state = "interrupted"  # app was closed / crashed mid-job
    return {
        "id": pid, "name": cfg.get("name", pid), "created": cfg.get("created"), "state": state,
        "quality": cfg.get("quality"), "elapsed": st.get("elapsed"),
        "thumb": f"/projects/{pid}/thumb.jpg" if os.path.exists(os.path.join(d, "thumb.jpg")) else None,
        "scene": f"/projects/{pid}/scene.splat" if os.path.exists(os.path.join(d, "scene.splat")) else None,
        "video": f"/projects/{pid}/flyaround.mp4" if os.path.exists(os.path.join(d, "flyaround.mp4")) else None,
        "estimates": cfg.get("estimates"), "video_seconds": cfg.get("video_seconds"),
    }


def probe_video(path):
    import cv2
    cap = cv2.VideoCapture(path)
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    cap.set(cv2.CAP_PROP_POS_FRAMES, n // 3)
    ok, frame = cap.read()
    cap.release()
    if not ok:
        return None
    h, w = frame.shape[:2]
    thumb = cv2.resize(frame, (320, int(320 * h / w)))
    cv2.imwrite(os.path.join(os.path.dirname(path), "thumb.jpg"), thumb, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return {"seconds": n / fps, "frames": n, "pixels": w * h, "width": w, "height": h}


def start_job(pid, quality):
    d = os.path.join(PROJECTS, pid)
    cfg = read_json(os.path.join(d, "project.json"))
    cfg["quality"], cfg["steps"] = quality, QUALITY[quality]
    cfg["estimate"] = cfg["estimates"][quality]
    cfg["state"] = "running"
    write_json(os.path.join(d, "project.json"), cfg)
    for f in ("status.json", "summary.json"):
        if os.path.exists(os.path.join(d, f)):
            os.remove(os.path.join(d, f))
    p = subprocess.Popen([sys.executable, "-I", os.path.join(APP, "pipeline.py"), d],
                         stdout=open(os.path.join(d, "logs_stdout.txt"), "w"), stderr=subprocess.STDOUT,
                         start_new_session=True, cwd=ROOT)
    jobs[pid] = p
    log(f"started job {pid} ({quality}) pid={p.pid}")


def stop_job(pid):
    p = jobs.get(pid)
    if p and p.poll() is None:
        log(f"stopping job {pid}")
        try:
            os.killpg(p.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            p.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, signal.SIGKILL)
    # belt and braces: nothing from this project may keep the GPU busy
    for proc in psutil.process_iter(["pid", "cmdline"]):
        try:
            if any(os.path.join(PROJECTS, pid) in (a or "") for a in proc.info["cmdline"] or []) \
                    or (proc.cwd() == os.path.join(PROJECTS, pid)):
                proc.kill()
        except (psutil.Error, OSError):
            pass


def shutdown(reason):
    log(f"shutting down: {reason}")
    for pid in list(jobs):
        stop_job(pid)
    try:
        os.remove(os.path.join(DATA, "studio.json"))
    except OSError:
        pass
    os._exit(0)


def watchdog():
    while True:
        time.sleep(5)
        now = time.time()
        if last_beat is None and now - started > STARTUP_GRACE:
            shutdown("UI never opened")
        if last_beat is not None and now - last_beat > HEARTBEAT_TIMEOUT:
            shutdown("no heartbeat from the UI")
        if last_bye is not None and now - last_bye > BYE_GRACE and (last_beat or 0) < last_bye:
            shutdown("UI window closed")


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

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        q = dict(urllib.parse.parse_qsl(url.query))
        if url.path in ("/", "/index.html"):
            self.path = "/app/ui/index.html"
            return super().do_GET()
        if url.path == "/api/system":
            return self.send(system_info())
        if url.path == "/api/projects":
            os.makedirs(PROJECTS, exist_ok=True)
            items = [project_summary(p) for p in sorted(os.listdir(PROJECTS), reverse=True)
                     if os.path.isdir(os.path.join(PROJECTS, p))]
            return self.send([i for i in items if i])
        if url.path == "/api/status":
            pid = safe_id(q.get("id"))
            st = read_json(os.path.join(PROJECTS, pid, "status.json"), {})
            st["running"] = job_running(pid)
            st["project"] = project_summary(pid)
            return self.send(st)
        # static files: only the UI, the viewer and project outputs
        if not re.match(r"^/(app/ui|tools/viewer|projects|example)/", url.path) or ".." in url.path:
            return self.send_error(404)
        return super().do_GET()

    def do_POST(self):
        global last_beat, last_bye
        url = urllib.parse.urlparse(self.path)
        q = dict(urllib.parse.parse_qsl(url.query))
        if url.path == "/api/heartbeat":
            last_beat = time.time()
            return self.send({"ok": True, "running": [p for p in jobs if job_running(p)]})
        if url.path == "/api/bye":
            last_bye = time.time()
            return self.send({"ok": True})
        if url.path == "/api/upload":
            return self.upload(q.get("name", "video.mp4"))
        if url.path == "/api/start":
            pid = safe_id(q.get("id"))
            if any(job_running(p) for p in jobs):
                return self.send({"error": "Another video is still processing. One at a time keeps your GPU happy."}, 409)
            start_job(pid, q.get("quality", "full"))
            return self.send({"ok": True})
        if url.path == "/api/cancel":
            stop_job(safe_id(q.get("id")))
            return self.send({"ok": True})
        if url.path == "/api/delete":
            pid = safe_id(q.get("id"))
            stop_job(pid)
            shutil.rmtree(os.path.join(PROJECTS, pid), ignore_errors=True)
            log(f"deleted project {pid}")
            return self.send({"ok": True})
        if url.path == "/api/quit":
            self.send({"ok": True})
            threading.Thread(target=shutdown, args=("quit from UI",)).start()
            return
        self.send_error(404)

    def upload(self, name):
        info = system_info()
        if not info["supported"]:
            return self.send({"error": " ".join(info["problems"])}, 400)
        base = re.sub(r"[^A-Za-z0-9_-]+", "_", os.path.splitext(name)[0])[:40].strip("_") or "video"
        pid = time.strftime("%Y%m%d-%H%M%S-") + base
        d = os.path.join(PROJECTS, pid)
        os.makedirs(d)
        ext = os.path.splitext(name)[1].lower() or ".mp4"
        video = "input" + ext
        remaining = int(self.headers.get("Content-Length", 0))
        with open(os.path.join(d, video), "wb") as fh:
            while remaining > 0:
                chunk = self.rfile.read(min(1 << 20, remaining))
                if not chunk:
                    break
                fh.write(chunk)
                remaining -= len(chunk)
        meta = probe_video(os.path.join(d, video))
        if not meta or meta["frames"] < 30:
            shutil.rmtree(d, ignore_errors=True)
            return self.send({"error": "Couldn't read that video. Try an .mp4 or .mov from your phone."}, 400)
        n_frames = min(127, int(meta["frames"] * 0.85))  # ~85% of the 150 picked frames survive the blur filter
        ests = {qual: hardware.estimate(info, meta["seconds"], meta["pixels"], n_frames, steps)
                for qual, steps in QUALITY.items()}
        cfg = {"name": os.path.splitext(name)[0], "created": time.time(), "video": video,
               "video_seconds": round(meta["seconds"], 1), "video_pixels": meta["pixels"],
               "video_size": [meta["width"], meta["height"]], "estimates": ests, "state": "ready"}
        write_json(os.path.join(d, "project.json"), cfg)
        log(f"uploaded {name} -> {pid} ({meta['seconds']:.0f}s, {meta['width']}x{meta['height']})")
        warn = []
        if meta["seconds"] < 10:
            warn.append("This video is very short. 20–40 seconds all the way around works best.")
        self.send({"project": project_summary(pid), "warnings": warn})


def safe_id(pid):
    if not pid or not re.match(r"^[A-Za-z0-9_-]+$", pid):
        raise ValueError("bad id")
    return pid


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8770)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    os.makedirs(DATA, exist_ok=True)
    os.makedirs(PROJECTS, exist_ok=True)
    for pid in os.listdir(PROJECTS):  # videos dropped in but never started
        cfg = read_json(os.path.join(PROJECTS, pid, "project.json"))
        if cfg and cfg.get("state") == "ready" and time.time() - cfg.get("created", 0) > 3600:
            shutil.rmtree(os.path.join(PROJECTS, pid), ignore_errors=True)
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    write_json(os.path.join(DATA, "studio.json"), {"pid": os.getpid(), "port": args.port})
    signal.signal(signal.SIGTERM, lambda *_: shutdown("SIGTERM"))
    signal.signal(signal.SIGINT, lambda *_: shutdown("Ctrl-C"))
    threading.Thread(target=watchdog, daemon=True).start()
    log(f"studio started on port {args.port} (pid {os.getpid()})")
    url = f"http://127.0.0.1:{args.port}/"
    print(url, flush=True)
    if not args.no_browser:
        webbrowser.open(url)
    srv.serve_forever()


if __name__ == "__main__":
    main()
