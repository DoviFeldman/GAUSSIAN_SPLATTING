#!/bin/zsh
# One-time setup on an Apple Silicon Mac (M1-M5). Installs everything inside this folder:
#   venv/        Python env with pycolmap (COLMAP), OpenCV, numpy   (~150 MB)
#   tools/brush/ Brush splat trainer, prebuilt for Apple Silicon     (~40 MB)
# Nothing is installed system-wide. Delete those two folders to uninstall.
set -e
ROOT=${0:A:h}
cd $ROOT

# 1. Python 3.10+ (macOS's built-in /usr/bin/python3 is 3.9 - too old for pycolmap)
PY=""
for c in python3.13 python3.12 python3.11 python3.10 /opt/homebrew/bin/python3; do
  if command -v $c >/dev/null && $c -c 'import sys; sys.exit(sys.version_info < (3,10))' 2>/dev/null; then PY=$c; break; fi
done
if [[ -z $PY ]]; then
  echo "Need Python 3.10+. Install Homebrew (https://brew.sh) then: brew install python@3.12"; exit 1
fi
echo "== using $PY ($($PY --version))"
[[ -d venv ]] || $PY -m venv venv
./venv/bin/pip install -q --upgrade pip
./venv/bin/pip install -r requirements.txt

# 2. Brush v0.3.0 (https://github.com/ArthurBrussee/brush), checksum-verified
BRUSH_URL=https://github.com/ArthurBrussee/brush/releases/download/v0.3.0/brush-app-aarch64-apple-darwin.tar.xz
BRUSH_SHA=65b2631398c839be3c1d4d7160fe2326389dec87830aac0710985e6690a1048c
mkdir -p tools/brush
if [[ ! -x tools/brush/brush-app-aarch64-apple-darwin/brush_app ]]; then
  echo "== downloading Brush"
  curl -fL -o tools/brush/brush.tar.xz $BRUSH_URL
  echo "$BRUSH_SHA  tools/brush/brush.tar.xz" | shasum -a 256 -c -
  tar -xf tools/brush/brush.tar.xz -C tools/brush
  rm tools/brush/brush.tar.xz
  xattr -dr com.apple.quarantine tools/brush 2>/dev/null || true
fi
tools/brush/brush-app-aarch64-apple-darwin/brush_app --version
echo "== setup done. Next: scripts/run_all.sh /path/to/video.mp4 my_project"
