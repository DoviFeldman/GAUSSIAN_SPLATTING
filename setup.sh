#!/bin/bash
# One-time setup (Mac with Apple Silicon, or x86_64 Linux with a Vulkan GPU driver).
# Installs everything inside this folder - nothing system-wide:
#   venv/        Python env with pycolmap (COLMAP), OpenCV, numpy, psutil  (~150 MB)
#   tools/brush/ Brush splat trainer, prebuilt                             (~40 MB)
# then adds the Splat Studio icon (Dock on Mac, app menu on Linux).
# After this, everything works offline.  Skip the icon with: ./setup.sh --no-app
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
OS="$(uname)"; ARCH="$(uname -m)"

if [ "$OS" = Darwin ] && [ "$ARCH" = arm64 ]; then
  BRUSH_NAME=brush-app-aarch64-apple-darwin
  BRUSH_SHA=65b2631398c839be3c1d4d7160fe2326389dec87830aac0710985e6690a1048c
elif [ "$OS" = Linux ] && [ "$ARCH" = x86_64 ]; then
  BRUSH_NAME=brush-app-x86_64-unknown-linux-gnu
  BRUSH_SHA=4f0f9a8785d1951c62df26aae247c02c5bba32b00f40b06df4e1c9b867399e20
else
  echo "Sorry: $OS on $ARCH isn't supported. Needs a Mac with Apple Silicon (M1-M5) or x86_64 Linux."
  exit 1
fi

# 1. Python 3.10+ (macOS's built-in /usr/bin/python3 is 3.9 - too old for pycolmap)
PY=""
for c in python3.13 python3.12 python3.11 python3.10 /opt/homebrew/bin/python3 python3; do
  if command -v "$c" >/dev/null && "$c" -c 'import sys; sys.exit(sys.version_info < (3,10))' 2>/dev/null; then PY=$c; break; fi
done
if [ -z "$PY" ]; then
  if [ "$OS" = Darwin ]; then echo "Need Python 3.10+. Install Homebrew (https://brew.sh), then: brew install python@3.12"
  else echo "Need Python 3.10+ with venv, e.g.: sudo apt install python3 python3-venv"; fi
  exit 1
fi
echo "== using $PY ($($PY --version))"
[ -d venv ] || "$PY" -m venv venv
./venv/bin/pip install -q --upgrade pip
./venv/bin/pip install -r requirements.txt

# 2. Brush v0.3.0 (https://github.com/ArthurBrussee/brush), checksum-verified
mkdir -p tools/brush
if [ ! -x "tools/brush/$BRUSH_NAME/brush_app" ]; then
  echo "== downloading Brush"
  curl -fL -o tools/brush/brush.tar.xz "https://github.com/ArthurBrussee/brush/releases/download/v0.3.0/$BRUSH_NAME.tar.xz"
  if command -v sha256sum >/dev/null; then echo "$BRUSH_SHA  tools/brush/brush.tar.xz" | sha256sum -c -
  else echo "$BRUSH_SHA  tools/brush/brush.tar.xz" | shasum -a 256 -c -; fi
  tar -xf tools/brush/brush.tar.xz -C tools/brush
  rm tools/brush/brush.tar.xz
  [ "$OS" = Darwin ] && xattr -dr com.apple.quarantine tools/brush 2>/dev/null || true
fi
"tools/brush/$BRUSH_NAME/brush_app" --version

# 3. hardware check + app icon
./venv/bin/python -I -c "
import sys; sys.path.insert(0, 'app'); import hardware; i = hardware.detect()
print('== this computer:', i['gpu'], f\"{i['ram_gb']:.0f} GB RAM\", '- supported' if i['supported'] else '- NOT supported')
for p in i['problems']: print('  problem:', p)
for w in i['warnings']: print('  note:', w)"
if [ "$1" != "--no-app" ]; then
  bash app/install_app.sh
fi
echo "== setup done. Open Splat Studio from the Dock / app menu, or run: app/launch.sh"
