"""Hardware detection, "can this computer do it?" checks, and time estimates.

Estimates are calibrated on a real run (Apple M5, 10 cores, 16 GB, 127 frames):
  frames 4 s · COLMAP features 27 s / matching 230 s / mapping (GLOMAP) 70 s · training 30k steps 62 min
and scaled by a GPU speed factor (training) and CPU core count (COLMAP). Once this
computer has finished a job, its real timings (app_data/calibration.json) replace the guesses.
"""
import json
import os
import platform
import re
import shutil
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CALIBRATION = os.path.join(ROOT, "app_data", "calibration.json")

BRUSH = {
    ("Darwin", "arm64"): "tools/brush/brush-app-aarch64-apple-darwin/brush_app",
    ("Linux", "x86_64"): "tools/brush/brush-app-x86_64-unknown-linux-gnu/brush_app",
}

# Rough GPU speed relative to the Apple M5 (10-core GPU) the timings were measured on.
APPLE_GPU = [
    ("M1 Ultra", 2.4), ("M1 Max", 1.3), ("M1 Pro", 0.7), ("M1", 0.4),
    ("M2 Ultra", 3.0), ("M2 Max", 1.6), ("M2 Pro", 0.85), ("M2", 0.5),
    ("M3 Ultra", 3.6), ("M3 Max", 2.0), ("M3 Pro", 0.9), ("M3", 0.6),
    ("M4 Max", 2.4), ("M4 Pro", 1.3), ("M4", 0.75),
    ("M5 Max", 3.0), ("M5 Pro", 1.6), ("M5", 1.0),
]
REF_CORES = 7  # M5: 4 performance + 6 efficiency cores (efficiency cores count half)

# Training time profile: fraction of total training time spent by each step
# (splats multiply early on, so later steps are slower). Measured on the M5 run.
TRAIN_PROFILE = [(0, 0.0), (5000, 0.097), (10000, 0.26), (15000, 0.44),
                 (20000, 0.63), (25000, 0.82), (30000, 1.0)]
REF_TRAIN_30K_S = 62 * 60


def _run(cmd):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return ""


def detect():
    sysname, arch = platform.system(), platform.machine()
    info = {"os": sysname, "arch": arch, "cpu_cores": os.cpu_count() or 4,
            "ram_gb": 0.0, "gpu": "unknown", "gpu_factor": 1.0, "gpu_factor_known": False,
            "vulkan": None, "chrome": find_chrome()}
    if sysname == "Darwin":
        info["ram_gb"] = int(_run(["sysctl", "-n", "hw.memsize"]) or 0) / 2**30
        chip = _run(["sysctl", "-n", "machdep.cpu.brand_string"]).strip()
        info["gpu"] = chip or "Apple GPU"
        perf = _run(["sysctl", "-n", "hw.perflevel0.physicalcpu"]).strip()
        if perf.isdigit():
            info["cpu_cores"] = int(perf) + 0.5 * (info["cpu_cores"] - int(perf))  # efficiency cores count half
        for name, f in APPLE_GPU:
            if re.search(r"\b" + name.replace(" ", r"\s+") + r"\b", chip):
                info["gpu_factor"], info["gpu_factor_known"] = f, True
                break
    elif sysname == "Linux":
        try:
            with open("/proc/meminfo") as fh:
                info["ram_gb"] = int(fh.readline().split()[1]) / 2**20
        except OSError:
            pass
        nv = _run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]).strip()
        if nv:
            name, mem = [s.strip() for s in nv.splitlines()[0].split(",")]
            info["gpu"], info["gpu_vram_gb"] = name, int(mem) / 1024
            info["gpu_factor"] = 1.5  # most CUDA-class cards with 8 GB+ train at least this fast
        else:
            vga = [l for l in _run(["lspci"]).splitlines() if "VGA" in l or "3D controller" in l]
            info["gpu"] = vga[0].split(": ", 1)[-1] if vga else "unknown"
        icd_dirs = ["/usr/share/vulkan/icd.d", "/etc/vulkan/icd.d", "/usr/local/share/vulkan/icd.d"]
        info["vulkan"] = any(os.path.isdir(d) and os.listdir(d) for d in icd_dirs)
    info["ram_gb"] = round(info["ram_gb"], 1)
    info.update(support(info))
    return info


def support(info):
    """Return {"supported": bool, "problems": [...], "warnings": [...]}."""
    problems, warnings = [], []
    key = (info["os"], info["arch"])
    if info["os"] == "Darwin" and info["arch"] != "arm64":
        problems.append("Intel Macs aren't supported: the splat trainer (Brush) only has an Apple Silicon (M1–M5) build.")
    elif info["os"] == "Linux" and info["arch"] != "x86_64":
        problems.append(f"Linux on {info['arch']} isn't supported: Brush only has an x86_64 Linux build.")
    elif key not in BRUSH:
        problems.append(f"{info['os']} isn't supported (Mac with Apple Silicon or x86_64 Linux only).")
    if info["os"] == "Linux" and info["arch"] == "x86_64" and not info["vulkan"]:
        problems.append("No Vulkan GPU driver found. Install your graphics driver with Vulkan support "
                        "(NVIDIA: the proprietary driver; AMD/Intel: mesa-vulkan-drivers).")
    if key in BRUSH and not os.path.exists(os.path.join(ROOT, BRUSH[key])):
        problems.append("Brush isn't installed yet. Run ./setup.sh in the GaussianSplatting folder.")
    if not os.path.exists(os.path.join(ROOT, "venv")):
        problems.append("The Python environment isn't installed yet. Run ./setup.sh in the GaussianSplatting folder.")
    if 0 < info["ram_gb"] < 7.5:
        problems.append(f"Only {info['ram_gb']:.0f} GB RAM. Training needs about 4.5 GB on top of the system; 8 GB is the minimum.")
    elif 0 < info["ram_gb"] < 12:
        warnings.append(f"{info['ram_gb']:.0f} GB RAM is tight. Close Chrome and other big apps while it trains.")
    if not info["gpu_factor_known"]:
        warnings.append("Unknown GPU speed, so the first time estimate is a rough guess. It corrects itself as training runs.")
    if not info["chrome"]:
        warnings.append("Google Chrome/Chromium not found, so the fly-around video will be skipped (the 3D viewer still works).")
    return {"supported": not problems, "problems": problems, "warnings": warnings}


def find_chrome():
    for p in ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
              "/Applications/Chromium.app/Contents/MacOS/Chromium",
              "/Applications/Thorium.app/Contents/MacOS/Thorium"]:
        if os.path.exists(p):
            return p
    for name in ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]:
        p = shutil.which(name)
        if p:
            return p
    return None


def brush_path(info):
    return os.path.join(ROOT, BRUSH.get((info["os"], info["arch"]), "missing"))


def load_calibration():
    try:
        with open(CALIBRATION) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def train_fraction(step):
    for (s0, f0), (s1, f1) in zip(TRAIN_PROFILE, TRAIN_PROFILE[1:]):
        if step <= s1:
            return f0 + (f1 - f0) * (step - s0) / (s1 - s0)
    return 1.0


def estimate(info, video_seconds, video_pixels, n_frames, steps):
    """Seconds per stage: {"frames", "colmap", "train", "finish"}."""
    cal = load_calibration()
    cpu = REF_CORES / max(1.0, info["cpu_cores"])
    gpu = info["gpu_factor"]
    n = n_frames / 127.0
    frames_s = max(3.0, video_seconds * (video_pixels / (1080 * 1920)) * 0.15)  # 30 s 1080p video: ~4 s
    colmap_s = colmap_model(n) * cpu
    # training time to `steps` steps, on the 30k-step profile
    train_s = REF_TRAIN_30K_S * train_fraction(steps) / gpu
    # this machine's real history wins over the guesses
    if cal.get("colmap_ratio"):
        colmap_s = colmap_model(n) * cal["colmap_ratio"]
    if cal.get("train_30k_s"):
        train_s = cal["train_30k_s"] * train_fraction(steps)
    finish_s = 60 if info["chrome"] else 20
    return {"frames": round(frames_s), "colmap": round(colmap_s), "train": round(train_s), "finish": finish_s}


def colmap_model(n):
    """COLMAP seconds on the reference M5 for n = frames/127: features ~n, matching ~n^2, mapping ~n^1.5."""
    return 27 * n + 230 * n * n + 70 * n ** 1.5


def save_calibration(colmap_s, n_frames, train_s, steps):
    cal = load_calibration()
    ratio = colmap_s / colmap_model(n_frames / 127.0)
    frac = train_fraction(steps)
    ref_train = train_s / frac if frac > 0 else None
    # running average so one odd run doesn't dominate
    for key, val in (("colmap_ratio", ratio), ("train_30k_s", ref_train)):
        if val:
            cal[key] = round(val if key not in cal else 0.5 * cal[key] + 0.5 * val, 3)
    cal["runs"] = cal.get("runs", 0) + 1
    os.makedirs(os.path.dirname(CALIBRATION), exist_ok=True)
    with open(CALIBRATION, "w") as fh:
        json.dump(cal, fh, indent=2)


if __name__ == "__main__":
    i = detect()
    print(json.dumps(i, indent=2))
    print(estimate(i, 30, 1080 * 1920, 127, 30000))
