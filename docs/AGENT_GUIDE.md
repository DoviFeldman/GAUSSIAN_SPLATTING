# Splat Studio: guide for AI agents (debugging, tuning, updating)

Read this before changing Splat Studio or diagnosing a run. Everything is local files; no services.

## Architecture

```
Dock icon / app menu
  └─ app/launch.sh ── starts ──► app/studio.py  (HTTP server on 127.0.0.1:8770, stdlib + psutil)
        │                           ├─ serves app/ui/index.html (the UI) and tools/viewer/ (WebGL splat viewer)
        │                           ├─ /api/upload   saves the video to projects/<id>/, probes it, estimates time
        │                           ├─ /api/start    spawns app/pipeline.py projects/<id>  (own process group)
        │                           ├─ /api/cancel   SIGTERM to that process group (Brush/COLMAP/Chrome die with it)
        │                           └─ watchdog: window closed (/api/bye, 8 s grace) or no heartbeat for 150 s ⇒ stop all jobs and exit
        └─ opens Chrome --app (separate profile app_data/chrome-profile) or the default browser;
           kills that window process after the server exits
app/pipeline.py  (one job)
  1 frames  scripts/extract_frames.py    150 time windows, sharpest frame each (OpenCV)
  2 colmap  scripts/run_colmap.py        pycolmap: SIFT → exhaustive match → GLOMAP global SfM (incremental fallback) → undistort
            scripts/make_camera_path.py  orbit path + "up" (RANSAC table plane), used by preview + video
  3 train   Brush (tools/brush/…/brush_app) with --export-every 1000|2500; each checkpoint →
            preview.splat (scripts/ply_to_splat.py); older checkpoints deleted
  4 finish  scene.ply → scene.splat; headless Chrome + tools/viewer/serve.py renders flyaround.mp4
app/hardware.py  detection, support checks, time estimates, calibration
```

## Where to look after a run (projects/<id>/)

| File | What's in it |
|---|---|
| `summary.json` | **Start here.** state, error, warnings, machine, settings, frames kept/registered, splat count, peak memory, estimated vs actual seconds per stage |
| `status.json` | Last live status the UI saw (stages, progress, ETA, preview step) |
| `logs/pipeline.log` | Every line every tool printed, timestamped (`=== stage N` markers, `$ command` lines, COLMAP glog, Brush `RUST_LOG=info`, checkpoint lines with splat counts and the training ETA) |
| `logs/metrics.csv` | Every 15 s: stage, stage progress, estimated training step, tool memory MB (macOS `footprint`, which includes GPU memory), system RAM %, CPU %, GPU utilization %, GPU memory MB (macOS `ioreg` / Linux `nvidia-smi`) |
| `logs_stdout.txt` | Python tracebacks from pipeline.py itself (if it crashed) |
| `project.json` | Upload metadata + the estimate shown to the user |
| `scene.ply`, `scene.splat`, `flyaround.mp4`, `camera_path.json` | Results |
| `images/`, `colmap/`, `dataset/` | Intermediate data (frames, COLMAP database + sparse model, undistorted dataset) |

App-wide (`app_data/`): `studio.log` (server: starts, uploads, job start/stop, shutdown reason),
`launch.log` (launcher), `calibration.json` (this machine's measured speeds, which replace the built-in guesses).

### Quick diagnosis commands
```bash
cd ~/GaussianSplatting
P=$(ls -d projects/2* | tail -1)                     # newest job
cat $P/summary.json
grep -E "===|checkpoint|FAILED|best has|kept" $P/logs/pipeline.log
column -s, -t < $P/logs/metrics.csv | tail -20
sort -t, -k6 -n $P/logs/metrics.csv | tail -1        # peak tool memory row
tail -20 app_data/studio.log
```

## Common failures and what they mean

| Symptom (summary/pipeline.log) | Cause | Fix |
|---|---|---|
| `Only N sharp frames found` | Video too short or blurry | Re-film; or lower the blur threshold `0.3 * median` in extract_frames.py |
| `COLMAP could only place R of N frames` / `best has R/N` low | Too little overlap, fast motion, textureless or shiny subject | Re-film slower; or raise `TARGET_FRAMES` in pipeline.py (COLMAP time grows ~N²) |
| `brush_app failed (exit code …)` | GPU/driver problem or out of memory | Check metrics.csv memory near the end; add `--max-splats 1500000 --max-resolution 1280` to the Brush command in `stage_train` |
| Training ETA way off | GPU factor guess wrong for this chip | Fixed automatically after one finished job (calibration.json); or edit `APPLE_GPU` in hardware.py |
| `Fly-around video failed` | Chrome missing or headless WebGL issue | The 3D scene is still fine; check `chrome` in /api/system |
| State `interrupted` | App closed mid-job (by design, closing the window stops all work) | "Try again" in the UI |

## Tuning knobs (all in plain code)

- Quality presets: `QUALITY` in `app/studio.py` (`quick` 7000, `full` 30000 steps).
- Frames per video: `TARGET_FRAMES` in `app/pipeline.py`.
- Checkpoint/preview interval: `every` in `Job.stage_train`.
- Estimates: `hardware.estimate`, `APPLE_GPU`, `TRAIN_PROFILE` (fraction of training time by step, measured on an M5).
- Shutdown: `HEARTBEAT_TIMEOUT` (150 s; browsers throttle background-tab timers to ~1/min, so don't go below ~90) and `BYE_GRACE` in `app/studio.py`.

## Testing a change

```bash
venv/bin/python -I app/studio.py --port 8770 --no-browser &      # then open http://127.0.0.1:8770
# or headless, without the UI:
curl -s -X POST --data-binary @video.mp4 "http://127.0.0.1:8770/api/upload?name=test.mp4"   # returns project id
curl -s -X POST "http://127.0.0.1:8770/api/start?id=<id>&quality=quick"
curl -s "http://127.0.0.1:8770/api/status?id=<id>" | python3 -m json.tool
```
Without a UI open, the server exits 3 minutes after starting (no heartbeat). Send
`curl -X POST http://127.0.0.1:8770/api/heartbeat` every ~60 s to keep it alive while testing.

## Measured reference (Apple M5, 16 GB, 30 s 1080p video, 127 frames)

frames 4–6 s · COLMAP 6.5 min (features 30–60 s, matching 4 min, GLOMAP mapping 1.5 min) · training 30k steps 62 min
(5k: 6 min, 15k: 27 min) · Quick (7k steps) 13 min → 628k splats · peak memory 4.5 GB (Brush), 4.2 GB (COLMAP features) ·
full run 1.35 M splats · scene.ply 318 MB · scene.splat 41 MB.

Why GLOMAP: the incremental mapper took 9–19 min on this video and once produced a slightly-off solve that
made the splat smeary/ghosted. GLOMAP did the same 127 frames in ~1.5 min with lower reprojection error
(0.50 vs 0.67 px), and the Quick result was sharp. If a splat looks ghosted, suspect the camera solve first.
