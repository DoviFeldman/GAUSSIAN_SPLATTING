"""Runs one video -> Gaussian splat job, start to finish.

    python -I app/pipeline.py projects/<id>

Reads  projects/<id>/project.json   (video file name, training steps)
Writes projects/<id>/status.json    (live progress for the UI, rewritten every second)
       projects/<id>/logs/pipeline.log   (everything every tool printed, timestamped)
       projects/<id>/logs/metrics.csv    (memory / GPU / CPU samples every 15 s)
       projects/<id>/summary.json        (timings, counts, peak memory; written at the end)
       projects/<id>/preview.splat       (latest training checkpoint, for the live preview)
       projects/<id>/scene.splat + scene.ply + flyaround.mp4   (results)

The UI starts this in its own process group and stops it by killing that group.
"""
import csv
import glob
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time

import psutil

APP = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(APP)
sys.path.insert(0, APP)
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import hardware  # noqa: E402
from ply_to_splat import convert  # noqa: E402

PY = [sys.executable, "-I"]
TARGET_FRAMES = 150


class Job:
    def __init__(self, proj):
        self.proj = os.path.abspath(proj)
        with open(os.path.join(self.proj, "project.json")) as fh:
            self.cfg = json.load(fh)
        self.steps = int(self.cfg.get("steps", 30000))
        os.makedirs(os.path.join(self.proj, "logs"), exist_ok=True)
        self.log_fh = open(os.path.join(self.proj, "logs", "pipeline.log"), "a", buffering=1)
        self.info = hardware.detect()
        self.lock = threading.Lock()
        self.child = None  # current subprocess (for memory sampling)
        self.peak_mem_mb = 0
        self.t0 = time.time()
        est = self.cfg["estimate"]
        self.status = {
            "state": "running", "message": "Starting…", "warnings": [], "error": None,
            "started": self.t0, "elapsed": 0, "eta": sum(est.values()), "progress": 0.0,
            "stage": 0, "preview": None, "result": None, "train_step": 0, "train_total": self.steps,
            "stages": [
                {"key": "frames", "label": "Picking sharp frames", "est": est["frames"]},
                {"key": "colmap", "label": "Finding camera positions (COLMAP)", "est": est["colmap"]},
                {"key": "train", "label": "Training the 3D splat", "est": est["train"]},
                {"key": "finish", "label": "Making the viewer file and fly-around video", "est": est["finish"]},
            ],
        }
        for s in self.status["stages"]:
            s.update(start=None, end=None, progress=0.0)

    # ---------- logging / status ----------
    def log(self, msg):
        line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}"
        self.log_fh.write(line[:400] + "\n")

    def write_status(self):
        with self.lock:
            st = self.status
            now = time.time()
            st["elapsed"] = round(now - self.t0)
            total_est = sum(s["est"] for s in st["stages"])
            remaining, done_weight = 0.0, 0.0
            for i, s in enumerate(st["stages"]):
                if s["end"]:
                    done_weight += s["est"]
                elif s["start"]:
                    spent = now - s["start"]
                    p = s["progress"]
                    left = s["est"] - spent
                    if p > 0.08:  # trust the measured rate once there's some progress
                        left = 0.5 * left + 0.5 * spent * (1 - p) / p
                    if s["key"] == "train" and s.get("eta_left") is not None:
                        left = s["eta_left"] - (now - s["eta_at"])
                    remaining += max(left, 5)
                    done_weight += s["est"] * p
                else:
                    remaining += s["est"]
            st["eta"] = round(remaining) if st["state"] == "running" else 0
            st["progress"] = round(min(0.999, done_weight / max(1, total_est)), 4) if st["state"] == "running" else st["progress"]
            tmp = os.path.join(self.proj, "status.json.tmp")
            with open(tmp, "w") as fh:
                json.dump(st, fh)
            os.replace(tmp, os.path.join(self.proj, "status.json"))

    def set(self, **kw):
        with self.lock:
            self.status.update(kw)

    def stage(self, i, progress=None, **kw):
        with self.lock:
            s = self.status["stages"][i]
            if progress is not None:
                s["progress"] = max(s["progress"], min(1.0, progress))
            s.update(kw)

    def begin(self, i):
        self.stage(i, start=time.time())
        self.set(stage=i, message=self.status["stages"][i]["label"] + "…")
        self.log(f"=== stage {i + 1}: {self.status['stages'][i]['label']}")

    def end(self, i):
        self.stage(i, progress=1.0, end=time.time())
        s = self.status["stages"][i]
        self.log(f"=== stage {i + 1} done in {s['end'] - s['start']:.0f}s (estimated {s['est']}s)")

    # ---------- running tools ----------
    def run(self, cmd, cwd=None, on_line=None, env=None):
        self.log("$ " + " ".join(cmd))
        p = subprocess.Popen(cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                             text=True, bufsize=1, env=env, errors="replace")
        self.child = p
        for line in p.stdout:
            line = line.rstrip()
            if "load_scene_img" in line:  # Brush prints one huge line per photo; skip
                continue
            self.log("  " + line)
            if on_line:
                on_line(line)
        p.wait()
        self.child = None
        if p.returncode != 0:
            raise RuntimeError(f"{os.path.basename(cmd[min(2, len(cmd) - 1)])} failed (exit code {p.returncode}). "
                               f"See logs/pipeline.log.")
        return p

    # ---------- metrics sampler ----------
    def sampler(self):
        path = os.path.join(self.proj, "logs", "metrics.csv")
        new = not os.path.exists(path)
        with open(path, "a", newline="") as fh:
            w = csv.writer(fh)
            if new:
                w.writerow(["time", "elapsed_s", "stage", "stage_progress", "train_step_est",
                            "tool_mem_mb", "system_mem_used_pct", "cpu_pct", "gpu_util_pct", "gpu_mem_mb"])
            while self.status["state"] == "running":
                try:
                    st = self.status
                    i = st["stage"]
                    mem = self.child_mem_mb()
                    self.peak_mem_mb = max(self.peak_mem_mb, mem)
                    gpu_util, gpu_mem = gpu_stats(self.info)
                    w.writerow([time.strftime("%H:%M:%S"), round(time.time() - self.t0), st["stages"][i]["key"],
                                round(st["stages"][i]["progress"], 3), st["train_step"], round(mem),
                                psutil.virtual_memory().percent, psutil.cpu_percent(), gpu_util, gpu_mem])
                    fh.flush()
                except Exception as e:  # never let monitoring kill the job
                    self.log(f"metrics error: {e}")
                for _ in range(15):
                    if self.status["state"] != "running":
                        return
                    time.sleep(1)

    def child_mem_mb(self):
        p = self.child
        if p is None or p.poll() is not None:
            return 0
        if self.info["os"] == "Darwin":  # footprint includes GPU (Metal) memory; RSS doesn't
            out = subprocess.run(["footprint", "-p", str(p.pid)], capture_output=True, text=True).stdout
            m = re.search(r"phys_footprint:\s+([\d.]+)\s+(KB|MB|GB)", out)
            if m:
                return float(m.group(1)) * {"KB": 1 / 1024, "MB": 1, "GB": 1024}[m.group(2)]
        try:
            proc = psutil.Process(p.pid)
            return sum(c.memory_info().rss for c in [proc] + proc.children(recursive=True)) / 2**20
        except psutil.Error:
            return 0

    # ---------- the stages ----------
    def stage_frames(self):
        self.begin(0)
        def on_line(l):
            if l.startswith("progress "):
                self.stage(0, float(l.split()[1]))
            m = re.match(r"kept (\d+) frames", l)
            if m:
                self.n_frames = int(m.group(1))
        self.run(PY + [os.path.join(ROOT, "scripts", "extract_frames.py"), os.path.join(self.proj, self.cfg["video"]),
                       os.path.join(self.proj, "images"), "--frames", str(TARGET_FRAMES)], on_line=on_line)
        if self.n_frames < 20:
            raise RuntimeError(f"Only {self.n_frames} sharp frames found. The video is too short or too blurry. "
                               "Try again moving slower, with more light.")
        # re-estimate COLMAP for the real frame count
        est = hardware.estimate(self.info, self.cfg["video_seconds"], self.cfg["video_pixels"], self.n_frames, self.steps)
        self.stage(1, est=est["colmap"])
        self.end(0)

    def stage_colmap(self):
        self.begin(1)
        n = self.n_frames
        def on_line(l):
            # rough time shares: features 8%, matching 70%, mapping 20%, undistort 2%
            if m := re.search(r"Processed file \[(\d+)/(\d+)\]", l):
                self.stage(1, 0.08 * int(m.group(1)) / int(m.group(2)))
            elif m := re.search(r"Processing block \[(\d+)/(\d+), (\d+)/(\d+)\]", l):
                a, b, c, d = map(int, m.groups())
                self.stage(1, 0.08 + 0.70 * ((a - 1) * d + c) / (b * d))
            elif "matching done" in l:
                self.stage(1, 0.78)
            elif m := re.search(r"num_reg_frames=(\d+)", l):  # incremental fallback only
                self.stage(1, 0.78 + 0.18 * int(m.group(1)) / n)
            elif "Undistorting image" in l:
                self.stage(1, 0.96)
            elif m := re.search(r"best has (\d+)/(\d+) images", l):
                self.registered = int(m.group(1))
        self.registered = 0
        self.run(PY + [os.path.join(ROOT, "scripts", "run_colmap.py"), self.proj], on_line=on_line)
        if self.registered < 0.3 * n:
            raise RuntimeError(f"COLMAP could only place {self.registered} of {n} frames, which isn't enough. "
                               "Film slower, go all the way around, and keep the object in view.")
        if self.registered < 0.8 * n:
            self.status["warnings"].append(f"Only {self.registered} of {n} frames were placed in 3D; "
                                           "parts of the object may look blurry.")
        # plan the fly-around now, so the live preview opens with a good view and "up" direction
        self.run(PY + [os.path.join(ROOT, "scripts", "make_camera_path.py"), self.proj, "--seconds", "10"])
        self.end(1)

    def stage_train(self):
        self.begin(2)
        every = 1000 if self.steps <= 10000 else 2500
        out = os.path.join(self.proj, "splat")
        os.makedirs(out, exist_ok=True)
        brush = hardware.brush_path(self.info)
        cmd = [brush, os.path.join(self.proj, "dataset"), "--total-steps", str(self.steps),
               "--export-every", str(every), "--export-path", out, "--export-name", "splat_{iter}.ply"]
        cache = os.path.join(ROOT, "app_data", "brush")  # Brush keeps its GPU autotune cache in ./target
        os.makedirs(cache, exist_ok=True)
        env = dict(os.environ, RUST_LOG="info")
        start = time.time()
        stop = threading.Event()

        def watch():
            seen = set()
            while not stop.is_set():
                for f in sorted(glob.glob(os.path.join(out, "splat_*.ply"))):
                    if f in seen:
                        continue
                    size = os.path.getsize(f)
                    time.sleep(1.5)
                    if os.path.getsize(f) != size:
                        break  # still being written; look again next round
                    seen.add(f)
                    step = int(re.search(r"splat_(\d+)", f).group(1))
                    self.checkpoint(f, step, start)
                    for old in glob.glob(os.path.join(out, "splat_*.ply")):  # keep disk use down
                        if old != f and old in seen:
                            os.remove(old)
                stop.wait(3)

        def tick():
            # between checkpoints, estimate the step from elapsed time and the training profile
            while not stop.is_set():
                s = self.status["stages"][2]
                left = s.get("eta_left")
                if left is not None:
                    total = (time.time() - start) + (left - (time.time() - s["eta_at"]))
                    f_now = (time.time() - start) / max(1, total) * hardware.train_fraction(self.steps)
                else:
                    f_now = (time.time() - start) / max(1, s["est"]) * hardware.train_fraction(self.steps)
                step = inverse_fraction(f_now)
                with self.lock:
                    self.status["train_step"] = max(self.status["train_step"], min(step, self.steps - 1))
                self.stage(2, self.status["train_step"] / self.steps)
                stop.wait(2)

        threads = [threading.Thread(target=watch, daemon=True), threading.Thread(target=tick, daemon=True)]
        for t in threads:
            t.start()
        try:
            self.run(cmd, cwd=cache, env=env)
        finally:
            stop.set()
            for t in threads:
                t.join(timeout=30)
        final = os.path.join(out, f"splat_{self.steps}.ply")
        if not os.path.exists(final):
            cands = sorted(glob.glob(os.path.join(out, "splat_*.ply")))
            if not cands:
                raise RuntimeError("Training finished but produced no splat file. See logs/pipeline.log.")
            final = cands[-1]
        if self.status["preview"] is None or self.status["preview"]["step"] != self.steps:
            self.checkpoint(final, self.steps, start)
        os.replace(final, os.path.join(self.proj, "scene.ply"))
        shutil.rmtree(out, ignore_errors=True)  # older checkpoints
        self.train_s = time.time() - start
        self.set(train_step=self.steps)
        self.end(2)

    def checkpoint(self, ply, step, start):
        elapsed = time.time() - start
        kept, total = convert(ply, os.path.join(self.proj, "preview.splat.tmp"))
        os.replace(os.path.join(self.proj, "preview.splat.tmp"), os.path.join(self.proj, "preview.splat"))
        self.splat_count = total
        # measured speed so far -> remaining time on the profile
        frac_now, frac_end = hardware.train_fraction(step), hardware.train_fraction(self.steps)
        total_est = elapsed / max(1e-3, frac_now) * frac_end
        self.stage(2, step / self.steps, eta_left=max(0, total_est - elapsed), eta_at=time.time())
        with self.lock:
            self.status["train_step"] = step
            self.status["preview"] = {"step": step, "splats": total, "updated": time.time()}
        self.log(f"checkpoint step {step}: {total} splats ({kept} visible) after {elapsed:.0f}s; "
                 f"training ETA {max(0, total_est - elapsed):.0f}s")

    def stage_finish(self):
        self.begin(3)
        convert(os.path.join(self.proj, "scene.ply"), os.path.join(self.proj, "scene.splat"))
        if os.path.exists(os.path.join(self.proj, "preview.splat")):
            os.remove(os.path.join(self.proj, "preview.splat"))
        self.stage(3, 0.3)
        video = None
        if self.info["chrome"]:
            try:
                video = self.record_video()
            except Exception as e:
                self.status["warnings"].append(f"Fly-around video failed ({e}); the 3D scene is fine.")
                self.log(f"video failed: {e}")
        self.set(result={"splat": "scene.splat", "ply": "scene.ply", "video": video,
                         "camera_path": "camera_path.json"})
        self.end(3)

    def record_video(self):
        frames_dir = os.path.join(self.proj, "render_frames")
        out = os.path.join(self.proj, "flyaround.mp4")
        port = free_port()
        prof = os.path.join(self.proj, ".chrome_profile")
        server = subprocess.Popen(PY + [os.path.join(ROOT, "tools", "viewer", "serve.py"), "--port", str(port),
                                        "--frames-dir", frames_dir, "--video", out],
                                  stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        rel = os.path.relpath(self.proj, ROOT)
        url = (f"http://127.0.0.1:{port}/tools/viewer/index.html?scene=/{rel}/scene.splat"
               f"&path=/{rel}/camera_path.json&record=1")
        time.sleep(1)
        chrome = subprocess.Popen([self.info["chrome"], "--headless=new", f"--user-data-dir={prof}",
                                   "--no-first-run", "--disable-extensions", url],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.child = chrome
        n = len(json.load(open(os.path.join(self.proj, "camera_path.json")))["frames"])
        try:
            deadline = time.time() + 900
            for line in server.stdout:
                self.log("  " + line.rstrip())
                if "frames ->" in line:
                    break
                if time.time() > deadline:
                    raise RuntimeError("timed out")
            else:
                raise RuntimeError("viewer server exited")
        finally:
            for p in (chrome, server):
                kill_tree(p.pid)
            self.child = None
            shutil.rmtree(prof, ignore_errors=True)
            shutil.rmtree(frames_dir, ignore_errors=True)
        self.log(f"recorded {n} frames -> {out}")
        return "flyaround.mp4"

    # ---------- main ----------
    def main(self):
        threading.Thread(target=self.sampler, daemon=True).start()
        def status_loop():
            while self.status["state"] == "running":
                self.write_status()
                time.sleep(1)
        threading.Thread(target=status_loop, daemon=True).start()
        self.log(f"job start: {json.dumps(self.cfg)}")
        self.log(f"machine: {json.dumps({k: self.info[k] for k in ('os', 'arch', 'gpu', 'ram_gb', 'cpu_cores')})}")
        self.n_frames = 0
        try:
            self.stage_frames()
            self.stage_colmap()
            self.stage_train()
            self.stage_finish()
            hardware.save_calibration(self.status["stages"][1]["end"] - self.status["stages"][1]["start"],
                                      self.n_frames, self.train_s, self.steps)
            self.set(state="done", message="Done!", progress=1.0)
        except Exception as e:
            self.log(f"FAILED: {e!r}")
            self.set(state="failed", error=str(e), message="Failed")
        finally:
            self.write_status()
            self.write_summary()
            self.log("job end")

    def write_summary(self):
        st = self.status
        summary = {
            "state": st["state"], "error": st["error"], "warnings": st["warnings"],
            "machine": {k: self.info[k] for k in ("os", "arch", "gpu", "ram_gb", "cpu_cores", "gpu_factor")},
            "settings": {"steps": self.steps, "target_frames": TARGET_FRAMES, "video": self.cfg["video"],
                         "video_seconds": self.cfg["video_seconds"]},
            "frames_kept": self.n_frames, "frames_registered": getattr(self, "registered", None),
            "splat_count": getattr(self, "splat_count", None),
            "peak_tool_mem_mb": round(self.peak_mem_mb),
            "total_s": round(time.time() - self.t0),
            "stages": {s["key"]: {"estimated_s": s["est"],
                                  "actual_s": round(s["end"] - s["start"]) if s["end"] else None}
                       for s in st["stages"]},
        }
        with open(os.path.join(self.proj, "summary.json"), "w") as fh:
            json.dump(summary, fh, indent=2)


def inverse_fraction(f):
    prof = hardware.TRAIN_PROFILE
    for (s0, f0), (s1, f1) in zip(prof, prof[1:]):
        if f <= f1:
            return int(s0 + (s1 - s0) * (f - f0) / max(1e-9, f1 - f0))
    return prof[-1][0]


def gpu_stats(info):
    """(utilization %, GPU memory in use MB) - cheap to call."""
    try:
        if info["os"] == "Darwin":
            out = subprocess.run(["ioreg", "-r", "-d", "1", "-c", "IOAccelerator"],
                                 capture_output=True, text=True, timeout=5).stdout
            u = re.search(r'"Device Utilization %"=(\d+)', out)
            m = re.search(r'"In use system memory"=(\d+)', out)
            return (int(u.group(1)) if u else "", round(int(m.group(1)) / 2**20) if m else "")
        out = subprocess.run(["nvidia-smi", "--query-gpu=utilization.gpu,memory.used", "--format=csv,noheader,nounits"],
                             capture_output=True, text=True, timeout=5).stdout
        if out.strip():
            u, m = out.splitlines()[0].split(",")
            return int(u), int(m)
    except Exception:
        pass
    return "", ""


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def kill_tree(pid):
    try:
        parent = psutil.Process(pid)
        procs = parent.children(recursive=True) + [parent]
    except psutil.Error:
        return
    for p in procs:
        try:
            p.terminate()
        except psutil.Error:
            pass
    _, alive = psutil.wait_procs(procs, timeout=5)
    for p in alive:
        try:
            p.kill()
        except psutil.Error:
            pass


if __name__ == "__main__":
    job = Job(sys.argv[1])

    def on_term(*_):
        job.log("cancelled (SIGTERM)")
        job.set(state="cancelled", message="Stopped")
        job.write_status()
        for child in psutil.Process().children(recursive=True):  # Brush, COLMAP, Chrome...
            kill_tree(child.pid)
        os._exit(1)

    signal.signal(signal.SIGTERM, on_term)
    job.main()
