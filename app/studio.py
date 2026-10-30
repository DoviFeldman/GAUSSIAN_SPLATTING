"""Splat Studio: local web app that turns a video into a Gaussian splat.

    venv/bin/python -I app/studio.py [--port 8770] [--no-browser]

Serves the UI on http://127.0.0.1:PORT and works through a queue of videos, one
pipeline.py process per video. Between videos it confirms every process of the last
one is gone, so RAM and GPU memory start clean. The queue is saved to disk: after a
pause, crash or power cut, finished videos are safe and the rest continue on Resume.

It shuts itself down (killing every job and its GPU processes) when the UI
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
QUALITY = {"quick": int(os.environ.get("SPLAT_QUICK_STEPS", 7000)), "full": 30000}  # env override: fast test runs
QUEUE_FILE = os.path.join(DATA, "queue.json")
MIN_FREE_DISK_GB = 4     # a job can use ~2 GB; pause instead of filling the disk
HEARTBEAT_TIMEOUT = 150  # no heartbeat this long = UI gone. Long, because browsers slow timers in background tabs to ~1/min
BYE_GRACE = 8            # after the window says goodbye (closed or reloading), wait this long for a new heartbeat
STARTUP_GRACE = 180      # how long to wait for the UI to open the first time

jobs = {}                # project id -> subprocess.Popen (only the job that's running)
current = None           # project id of the running job
queue = {"paused": True, "items": [], "message": None}  # items[0] runs next; [{"id", "quality"}]
last_beat = None
last_bye = None
started = time.time()
info_cache = None
lock = threading.RLock()  # guards queue, current and jobs


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
        fh.flush()
        os.fsync(fh.fileno())  # survive a power cut
    os.replace(path + ".tmp", path)


def job_running(pid):
    p = jobs.get(pid)
    return p is not None and p.poll() is None


def queue_item(pid):
    return next((i for i in queue["items"] if i["id"] == pid), None)


def project_state(pid, st, cfg):
    if job_running(pid):
        return "running"
    if queue_item(pid):
        return "paused" if st else "queued"  # "paused" = has saved progress to continue from
    state = st.get("state", cfg.get("state", "ready"))
    return "interrupted" if state == "running" else state  # app closed / crashed mid-job


def project_summary(pid):
    d = os.path.join(PROJECTS, pid)
    cfg = read_json(os.path.join(d, "project.json"))
    if not cfg:
        return None
    st = read_json(os.path.join(d, "status.json"), {})
    return {
        "id": pid, "name": cfg.get("name", pid), "created": cfg.get("created"), "state": project_state(pid, st, cfg),
        "quality": cfg.get("quality"), "elapsed": st.get("elapsed"),
        "thumb": f"/projects/{pid}/thumb.jpg" if os.path.exists(os.path.join(d, "thumb.jpg")) else None,
        "scene": f"/projects/{pid}/scene.splat" if os.path.exists(os.path.join(d, "scene.splat")) else None,
        "video": f"/projects/{pid}/flyaround.mp4" if os.path.exists(os.path.join(d, "flyaround.mp4")) else None,
        "video_seconds": cfg.get("video_seconds"),
    }


def project_estimates(cfg):
    """Seconds per stage for each quality, using this computer's latest measured speed."""
    n = cfg.get("n_frames_est", 127)
    return {q: hardware.estimate(system_info(), cfg["video_seconds"], cfg["video_pixels"], n, steps)
            for q, steps in QUALITY.items()}


def probe_video(path):
    thumb = os.path.join(os.path.dirname(path), "thumb.jpg")
    r = subprocess.run([sys.executable, "-I", os.path.join(APP, "probe_video.py"), path, thumb],
                       capture_output=True, text=True)
    return json.loads(r.stdout) if r.returncode == 0 else None


def start_job(pid, quality):
    global current
    d = os.path.join(PROJECTS, pid)
    cfg = read_json(os.path.join(d, "project.json"))
    cfg["quality"], cfg["steps"] = quality, QUALITY[quality]
    cfg["estimate"] = project_estimates(cfg)[quality]
    cfg["state"] = "running"
    write_json(os.path.join(d, "project.json"), cfg)
    if os.path.exists(os.path.join(d, "summary.json")):
        os.remove(os.path.join(d, "summary.json"))
    with open(os.path.join(d, "logs_stdout.txt"), "a") as out:
        p = subprocess.Popen([sys.executable, "-I", os.path.join(APP, "pipeline.py"), d],
                             stdout=out, stderr=subprocess.STDOUT, start_new_session=True, cwd=ROOT)
    jobs[pid] = p
    current = pid
    log(f"started job {pid} ({quality}) pid={p.pid}; {memory_note()}")


def memory_note():
    vm = psutil.virtual_memory()
    return (f"system RAM available {vm.available / 2**30:.1f} GB, "
            f"studio server {psutil.Process().memory_info().rss / 2**20:.0f} MB")


def our_processes(pid):
    """Every tool still running for this project. Matches only our own tools, never e.g. an
    editor or terminal that merely has a path from this project on its command line."""
    d = os.path.join(PROJECTS, pid)
    found = []
    for proc in psutil.process_iter(["pid", "cmdline"]):
        try:
            cmd = proc.info["cmdline"] or []
            if not any(d in a for a in cmd):
                continue
            if "brush_app" in cmd[0] or any(a.endswith(".py") and os.path.dirname(os.path.dirname(a)) in (ROOT, os.path.join(ROOT, "tools"))
                                            for a in cmd[:3]) or any(a.startswith("--user-data-dir=" + d) for a in cmd):
                found.append(proc)
        except (psutil.Error, IndexError):
            pass
    return found


def release_job(pid):
    """Make sure nothing from this job is still alive, so its RAM and GPU memory are back."""
    deadline = time.time() + 15
    while time.time() < deadline:
        left = our_processes(pid)
        if not left:
            break
        for proc in left:
            try:
                proc.kill()
            except psutil.Error:
                pass
        time.sleep(0.5)
    else:
        log(f"WARNING: job {pid} still has processes after 15 s: {[p.pid for p in our_processes(pid)]}")
    p = jobs.pop(pid, None)
    if p:
        p.poll()  # reap
    log(f"released job {pid}; {memory_note()}")


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
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    release_job(pid)


# ---------- queue ----------
def save_queue():
    write_json(QUEUE_FILE, queue)


def load_queue():
    saved = read_json(QUEUE_FILE, {})
    items = [i for i in saved.get("items", []) if os.path.exists(os.path.join(PROJECTS, i["id"], "project.json"))]
    # never start GPU work by surprise after a crash or power cut: wait for Resume
    queue.update(items=items, paused=True, message=None)
    save_queue()


def finish_current():
    """The running job's process has exited: record the outcome and move on."""
    global current
    pid, current = current, None
    p = jobs.get(pid)
    code = p.returncode if p else None
    release_job(pid)
    path = os.path.join(PROJECTS, pid, "status.json")
    st = read_json(path, {})
    if st.get("state") == "running" and queue_item(pid) and not queue["paused"]:  # died without reporting (out of memory...)
        st.update(state="failed", error=f"The job stopped unexpectedly (exit code {code}). See logs/pipeline.log.")
        write_json(path, st)
    log(f"job {pid} ended: {st.get('state')}")
    if st.get("state") in ("done", "failed"):  # a failed video mustn't block the ones behind it
        queue["items"] = [i for i in queue["items"] if i["id"] != pid]
        if not queue["items"]:
            queue["paused"] = True  # ready for the next "Start"
        save_queue()


def scheduler():
    while True:
        time.sleep(1)
        try:
            with lock:
                if current:
                    if job_running(current):
                        continue
                    finish_current()
                if queue["paused"] or not queue["items"]:
                    continue
                free_gb = shutil.disk_usage(PROJECTS).free / 2**30
                if free_gb < MIN_FREE_DISK_GB:
                    queue.update(paused=True, message=f"Queue paused: only {free_gb:.1f} GB of disk left. "
                                                      "Free up some space, then press Resume.")
                    save_queue()
                    log(queue["message"])
                    continue
                item = queue["items"][0]
                start_job(item["id"], item["quality"])
        except Exception as e:  # keep the queue alive; the log says what happened
            log(f"scheduler error: {e!r}")


def queue_view():
    with lock:
        items, total, total_full = [], 0, True
        for pos, it in enumerate(queue["items"]):
            d = os.path.join(PROJECTS, it["id"])
            cfg = read_json(os.path.join(d, "project.json"))
            if not cfg:
                continue
            st = read_json(os.path.join(d, "status.json"), {})
            ests = project_estimates(cfg)
            state = project_state(it["id"], st, cfg)
            left = st["eta"] if state in ("running", "paused") and st.get("eta") else sum(ests[it["quality"]].values())
            total += left
            stages = st.get("stages") or []
            stage = stages[st.get("stage", 0)]["label"] if state == "running" and stages else None
            items.append({"id": it["id"], "name": cfg.get("name", it["id"]), "quality": it["quality"], "state": state,
                          "thumb": f"/projects/{it['id']}/thumb.jpg", "left": left, "stage": stage,
                          "progress": st.get("progress", 0) if state != "queued" else 0,
                          "estimates": {q: sum(e.values()) for q, e in ests.items()},
                          "seconds": cfg.get("video_seconds")})
        return {"paused": queue["paused"], "message": queue["message"], "current": current,
                "items": items, "total_left": total}


def queue_add(pid, quality):
    if not queue_item(pid):
        queue["items"].append({"id": pid, "quality": quality if quality in QUALITY else "full"})
        save_queue()


def queue_remove(pid):
    """Take a video out of the queue. If it never started there's nothing to keep, so delete it."""
    queue["items"] = [i for i in queue["items"] if i["id"] != pid]
    if not queue["items"]:
        queue["paused"] = True
    save_queue()
    if job_running(pid):
        stop_job(pid)
    d = os.path.join(PROJECTS, pid)
    if not os.path.exists(os.path.join(d, "status.json")):
        shutil.rmtree(d, ignore_errors=True)
        log(f"removed unstarted video {pid}")


def queue_move(pid, direction):
    items = queue["items"]
    i = next((n for n, it in enumerate(items) if it["id"] == pid), None)
    j = None if i is None else i + (-1 if direction == "up" else 1)
    if i is None or not 0 <= j < len(items) or current in (items[i]["id"], items[j]["id"]):
        return  # the running video stays first
    items[i], items[j] = items[j], items[i]
    save_queue()


def shutdown(reason):
    log(f"shutting down: {reason}")
    with lock:
        queue["paused"] = True  # what's left waits for Resume next time
        save_queue()
        for pid in list(jobs):
            stop_job(pid)
    try:
        os.remove(os.path.join(DATA, "studio.json"))
    except OSError:
        pass
    os._exit(0)


def watchdog():
    global last_beat
    tick = time.time()
    while True:
        time.sleep(5)
        now = time.time()
        if now - tick > 30 and last_beat is not None:  # the computer was asleep: the window just hasn't had a chance
            last_beat = now
        tick = now
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
            with lock:
                st["running"] = job_running(pid)
                st["project"] = project_summary(pid)
                st["state"] = st["project"]["state"] if st["project"] else st.get("state")
            return self.send(st)
        if url.path == "/api/queue":
            return self.send(queue_view())
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
            return self.send({"ok": True, "current": current})
        if url.path == "/api/bye":
            last_bye = time.time()
            return self.send({"ok": True})
        if url.path == "/api/upload":
            return self.upload(q.get("name", "video.mp4"), q.get("quality", "full"))
        if url.path == "/api/queue/start":
            with lock:
                if not system_info()["supported"]:
                    return self.send({"error": " ".join(system_info()["problems"])}, 400)
                queue.update(paused=False, message=None)
                save_queue()
            return self.send({"ok": True})
        if url.path == "/api/queue/pause":  # stops the work now; progress is saved
            with lock:
                queue["paused"] = True
                save_queue()
                if current:
                    stop_job(current)
            return self.send({"ok": True})
        if url.path == "/api/queue/add":  # "Try again" on a stopped or failed video
            with lock:
                queue_add(safe_id(q.get("id")), q.get("quality", "full"))
                if q.get("start") == "1":
                    queue.update(paused=False, message=None)
                    save_queue()
            return self.send({"ok": True})
        if url.path in ("/api/queue/remove", "/api/cancel"):
            with lock:
                queue_remove(safe_id(q.get("id")))
            return self.send({"ok": True})
        if url.path == "/api/queue/move":
            with lock:
                queue_move(safe_id(q.get("id")), q.get("dir"))
            return self.send({"ok": True})
        if url.path == "/api/queue/quality":
            with lock:
                item = queue_item(safe_id(q.get("id")))
                if item and q.get("id") != current and q.get("quality") in QUALITY:
                    item["quality"] = q["quality"]
                    save_queue()
            return self.send({"ok": True})
        if url.path == "/api/delete":
            pid = safe_id(q.get("id"))
            with lock:
                queue["items"] = [i for i in queue["items"] if i["id"] != pid]
                save_queue()
                if job_running(pid):
                    stop_job(pid)
            shutil.rmtree(os.path.join(PROJECTS, pid), ignore_errors=True)
            log(f"deleted project {pid}")
            return self.send({"ok": True})
        if url.path == "/api/quit":
            self.send({"ok": True})
            threading.Thread(target=shutdown, args=("quit from UI",)).start()
            return
        self.send_error(404)

    def upload(self, name, quality):
        info = system_info()
        if not info["supported"]:
            return self.send({"error": " ".join(info["problems"])}, 400)
        base = re.sub(r"[^A-Za-z0-9_-]+", "_", os.path.splitext(name)[0])[:40].strip("_") or "video"
        pid = time.strftime("%Y%m%d-%H%M%S-") + base
        d = os.path.join(PROJECTS, pid)
        while os.path.exists(d):  # same file name added twice within a second
            pid += "_"
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
        meta = probe_video(os.path.join(d, video)) if remaining == 0 else None
        if not meta or meta["frames"] < 30:
            shutil.rmtree(d, ignore_errors=True)
            return self.send({"error": "Couldn't read that video. Try an .mp4 or .mov from your phone."}, 400)
        cfg = {"name": os.path.splitext(name)[0], "created": time.time(), "video": video,
               "video_seconds": round(meta["seconds"], 1), "video_pixels": meta["pixels"],
               "video_size": [meta["width"], meta["height"]], "state": "ready",
               "n_frames_est": min(127, int(meta["frames"] * 0.85))}  # ~85% of the 150 picked frames survive the blur filter
        write_json(os.path.join(d, "project.json"), cfg)
        with lock:
            queue_add(pid, quality)
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
    for proc in psutil.process_iter(["pid", "cmdline"]):  # a force-killed earlier run must not keep the GPU busy
        try:
            if os.path.join(APP, "pipeline.py") in (proc.info["cmdline"] or []):
                log(f"killing leftover job process {proc.pid}")
                proc.kill()
        except psutil.Error:
            pass
    load_queue()
    for pid in os.listdir(PROJECTS):  # uploads that never made it into the queue
        cfg = read_json(os.path.join(PROJECTS, pid, "project.json"))
        if cfg and cfg.get("state") == "ready" and not queue_item(pid) and time.time() - cfg.get("created", 0) > 3600:
            shutil.rmtree(os.path.join(PROJECTS, pid), ignore_errors=True)
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    write_json(os.path.join(DATA, "studio.json"), {"pid": os.getpid(), "port": args.port})
    signal.signal(signal.SIGTERM, lambda *_: shutdown("SIGTERM"))
    signal.signal(signal.SIGINT, lambda *_: shutdown("Ctrl-C"))
    threading.Thread(target=watchdog, daemon=True).start()
    threading.Thread(target=scheduler, daemon=True).start()
    log(f"studio started on port {args.port} (pid {os.getpid()})")
    url = f"http://127.0.0.1:{args.port}/"
    print(url, flush=True)
    if not args.no_browser:
        webbrowser.open(url)
    srv.serve_forever()


if __name__ == "__main__":
    main()
