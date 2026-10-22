#!/bin/zsh
# Render the fly-around video of a trained splat (headless Chrome, separate
# throwaway profile - does not touch your normal Chrome windows/tabs).
#   usage: scripts/record_video.sh project_name [splat.ply] [out.mp4]
#   (make the path first: venv/bin/python scripts/make_camera_path.py projects/NAME [options])
set -e
ROOT=${0:A:h:h}  # repo root (this script lives in scripts/)
NAME=$1
P=$ROOT/projects/$NAME
PLY=${2:-$(ls $P/splat/*.ply | tail -1)}
OUT=${3:-$P/new_angle.mp4}
PORT=8766
REL=${PLY#$ROOT}

rm -rf $P/render_frames "$OUT"
PROF=$(mktemp -d)
$ROOT/venv/bin/python -I $ROOT/tools/viewer/serve.py --port $PORT \
    --frames-dir $P/render_frames --video "$OUT" > $PROF/server.log 2>&1 &
SERVER=$!
trap 'kill $SERVER $CHROME 2>/dev/null; wait 2>/dev/null; rm -rf $PROF 2>/dev/null || true' EXIT
sleep 1

"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
    --user-data-dir=$PROF --no-first-run --disable-extensions --use-angle=metal \
    "http://127.0.0.1:$PORT/tools/viewer/index.html?scene=$REL&path=/projects/$NAME/camera_path.json&record=1" \
    > $PROF/chrome.log 2>&1 &
CHROME=$!

N=$(python3 -c "import json;print(len(json.load(open('$P/camera_path.json'))['frames']))")
echo "rendering $N frames of $REL ..."
until grep -q "frames ->" $PROF/server.log 2>/dev/null; do  # serve.py logs this once the mp4 is fully written
    sleep 3
    kill -0 $CHROME 2>/dev/null || { echo "chrome exited early"; cat $PROF/chrome.log | tail; exit 1; }
    printf "\r  %d/%d" $(ls $P/render_frames 2>/dev/null | wc -l) $N
done
echo "\nvideo: $OUT"
