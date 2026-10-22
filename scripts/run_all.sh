#!/bin/zsh
# Video -> Gaussian splat, end to end.
#   usage: scripts/run_all.sh /path/to/video.mp4 project_name [train_steps]
# Result: projects/<name>/splat/splat_<steps>.ply  (+ camera_path.json for recording)
set -e
ROOT=${0:A:h:h}  # repo root (this script lives in scripts/)
VIDEO=$1
NAME=$2
STEPS=${3:-30000}
PY="$ROOT/venv/bin/python -I"
BRUSH=$ROOT/tools/brush/brush-app-aarch64-apple-darwin/brush_app
P=$ROOT/projects/$NAME

[[ -f $VIDEO && -n $NAME ]] || { echo "usage: $0 VIDEO NAME [STEPS]"; exit 1; }
mkdir -p $P
cp "$VIDEO" $P/video.mp4

echo "== 1/4 picking sharp frames"
rm -rf $P/images
$PY $ROOT/scripts/extract_frames.py $P/video.mp4 $P/images --frames 150

echo "== 2/4 COLMAP camera solve (~10-15 min)"
$PY $ROOT/scripts/run_colmap.py $P 2>&1 | tee $P/colmap.log | grep -E "done|ready|could not"

echo "== 3/4 training splat ($STEPS steps, ~60 min on M5)"
mkdir -p $P/splat
(cd $P && $BRUSH dataset --total-steps $STEPS --export-every 5000 \
    --export-path splat --export-name "splat_{iter}.ply" > train.log 2>&1)
ls -la $P/splat

echo "== 4/4 camera path for the fly-around video"
$PY $ROOT/scripts/make_camera_path.py $P

echo "done. Final splat: $(ls $P/splat/*.ply | tail -1)"
