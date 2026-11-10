# Splat Studio: guide for AI agents (debugging, tuning, updating)

Read this before changing Splat Studio or diagnosing a run. Everything is local files; no services.

## Architecture

```
Dock icon / app menu
  └─ app/launch.sh ── starts ──► app/studio.py  (HTTP server on 127.0.0.1:8770, stdlib + psutil)
        │                           ├─ serves app/ui/index.html (the UI) and tools/viewer/ (WebGL splat viewer)
        │                           ├─ /api/upload   saves the video to projects/<id>/, probes it (app/probe_video.py, short-lived), adds it to the queue
        │                           ├─ scheduler     runs queue items[0] as app/pipeline.py projects/<id> (own process group);
        │                           │                when it exits, release_job confirms no tool is left, then the next starts
        │                           ├─ /api/queue    state; /api/queue/{start,pause,add,remove,move,quality} change it
        │                           └─ watchdog: window closed (/api/bye, 8 s grace) ⇒ stop all jobs and exit. Missing heartbeats
        │                              never stop a running job; with nothing running, 1 h without one ⇒ exit
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

## Queue and resume rules

- `app_data/queue.json` is the queue, fsynced on every change: `{paused, items: [{id, quality}], message}`; `items[0]` runs next.
  An item leaves it only when its job ends `done` or `failed`, or the user removes it. So after a pause, crash or power
  cut the running video is still first. On startup the queue always loads paused: GPU work needs a Resume press.
- Each video is its own `pipeline.py` process, so its memory goes back to the OS on exit. The server stays small (~20 MB)
  because it never loads OpenCV or video data. `studio.log` records RAM available and server size at every job
  start and release; use those lines to check for bloat.
- `projects/<id>/resume.json` records finished stages. A re-run skips them. Training continues from the newest complete
  checkpoint (`ply_complete` rejects files a power cut left partial): it's moved to `dataset/init.ply`, and Brush runs with
  `--start-iter N`. Brush's optimizer state restarts, so `TRAIN_PROFILE` timing is approximate after a resume.
  Changing quality on a part-done video discards training only; frames and cameras are reused.
- Pause = SIGTERM the group and keep the item. Stop/remove = same, and drop the item (a never-started video's folder is deleted).
  A job that dies without reporting while the queue is running is marked `failed` and the queue moves on; Try again resumes it.
- `pipeline.py` exits by itself if the server disappears (`parent_watch`). Server startup also kills leftover `pipeline.py` processes.
- `our_processes` only matches our tools (Brush, our scripts, the job's Chrome profile), never other programs with a project path in their arguments.
- The watchdog treats a >30 s gap in its own loop as the computer waking from sleep, not as a closed window.
- Fast tests: `SPLAT_TARGET_FRAMES=40 SPLAT_QUICK_STEPS=1500` when starting `studio.py` gives ~2.5 min per video.
  Simulate a power cut with `kill -STOP <server>`, `kill -9` on `pipeline.py` and `brush_app`, then `kill -9 <server>`
  (server PID is in `app_data/studio.json`). Kill the server first or it will see a crashed job and mark it failed.

## Where to look after a run (projects/<id>/)

| File | What's in it |
|---|---|
| `summary.json` | **Start here.** state, error, warnings, machine, settings, frames kept/registered, splat count, peak memory, estimated vs actual seconds per stage |
| `status.json` | Last live status the UI saw (stages, progress, ETA, preview step) |
| `logs/pipeline.log` | Every line every tool printed, timestamped (`=== stage N` markers, `$ command` lines, COLMAP glog, Brush `RUST_LOG=info`, checkpoint lines with splat counts and the training ETA) |
| `logs/metrics.csv` | Every 15 s: stage, stage progress, estimated training step, tool memory MB (macOS `footprint`, which includes GPU memory), system RAM %, CPU %, GPU utilization %, GPU memory MB (macOS `ioreg` / Linux `nvidia-smi`) |
| `logs_stdout.txt` | Python tracebacks from pipeline.py itself (if it crashed) |
| `project.json` | Upload metadata + the estimate shown to the user |
| `resume.json` | Finished stages, training step reached, time spent; `summary.json` says `"resumed": true` if this run continued from it |
| `scene.ply`, `scene.splat`, `flyaround.mp4`, `camera_path.json` | Results |
| `images/`, `colmap/`, `dataset/` | Intermediate data (frames, COLMAP database + sparse model, undistorted dataset) |

App-wide (`app_data/`): `studio.log` (server: starts, uploads, job start/stop, shutdown reason),
`launch.log` (launcher), `queue.json` (the queue), `calibration.json` (this machine's measured speeds, which replace the built-in guesses; interrupted runs don't update it).

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
| State `paused` / `interrupted` | App closed or stopped mid-job (by design, closing the window stops all work) | Resume the queue / "Try again" in the UI; both continue from saved progress |
| Queue paused with a disk message | Under `MIN_FREE_DISK_GB` free | Free up space (old `projects/*/images`, `colmap`, `dataset` can go), then Resume |

## Tuning knobs (all in plain code)

- Quality presets: `QUALITY` in `app/studio.py` (`quick` 7000, `full` 30000 steps).
- Frames per video: `TARGET_FRAMES` in `app/pipeline.py`.
- Checkpoint/preview interval: `every` in `Job.stage_train`.
- Estimates: `hardware.estimate`, `APPLE_GPU`, `TRAIN_PROFILE` (fraction of training time by step, measured on an M5).
- Shutdown: `IDLE_TIMEOUT` (1 h, env `SPLAT_IDLE_TIMEOUT`; only counts while nothing is running) and `BYE_GRACE` in `app/studio.py`.
  **Don't make a running job depend on heartbeats.** On 2026-11-10 the display went to sleep mid-job, Chrome stopped the
  page's timers, and the old 150 s heartbeat timeout killed a 30k-step training run. Closing is detected by the page's
  goodbye (`pagehide` → `/api/bye`) and by `launch.sh` seeing the app window's process exit (it then calls `/api/quit`).

## Testing a change

```bash
venv/bin/python -I app/studio.py --port 8770 --no-browser &      # then open http://127.0.0.1:8770
# or headless, without the UI:
curl -s -X POST --data-binary @video.mp4 "http://127.0.0.1:8770/api/upload?name=test.mp4"   # returns project id
curl -s -X POST "http://127.0.0.1:8770/api/queue/quality?id=<id>&quality=quick"
curl -s -X POST "http://127.0.0.1:8770/api/queue/start"
curl -s "http://127.0.0.1:8770/api/queue" | python3 -m json.tool
curl -s "http://127.0.0.1:8770/api/status?id=<id>" | python3 -m json.tool
```
Without a UI open, the server exits 3 minutes after starting if it never got a heartbeat. One
`curl -X POST http://127.0.0.1:8770/api/heartbeat` is enough: after that it only quits when idle for `IDLE_TIMEOUT`.

## Measured reference (Apple M5, 16 GB, 30 s 1080p video, 127 frames)

frames 4–6 s · COLMAP 6.5 min (features 30–60 s, matching 4 min, GLOMAP mapping 1.5 min) · training 30k steps 62 min
(5k: 6 min, 15k: 27 min) · Quick (7k steps) 13 min → 628k splats · peak memory 4.5 GB (Brush), 4.2 GB (COLMAP features) ·
full run 1.35 M splats · scene.ply 318 MB · scene.splat 41 MB.

Why GLOMAP: the incremental mapper took 9–19 min on this video and once produced a slightly-off solve that
made the splat smeary/ghosted. GLOMAP did the same 127 frames in ~1.5 min with lower reprojection error
(0.50 vs 0.67 px), and the Quick result was sharp. If a splat looks ghosted, suspect the camera solve first.
