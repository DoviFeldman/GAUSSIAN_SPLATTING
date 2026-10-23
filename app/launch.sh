#!/bin/bash
# Start Splat Studio: local server + an app window. Used by the Dock icon (Mac)
# and the app-menu entry (Linux); you can also run it directly.
# Closing the window stops the server and every job it started (within seconds).
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT=8770
URL="http://127.0.0.1:$PORT/"
DATA="$ROOT/app_data"
mkdir -p "$DATA"
exec >>"$DATA/launch.log" 2>&1
echo "=== $(date) launch"

find_chrome() {
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           "/Applications/Chromium.app/Contents/MacOS/Chromium" \
           "/Applications/Thorium.app/Contents/MacOS/Thorium"; do
    [ -x "$c" ] && { echo "$c"; return; }
  done
  for c in google-chrome google-chrome-stable chromium chromium-browser; do
    command -v "$c" >/dev/null && { command -v "$c"; return; }
  done
}

open_window() {
  CHROME="$(find_chrome)"
  if [ -n "$CHROME" ]; then
    # its own profile = its own window, and it doesn't touch your normal browser tabs
    "$CHROME" --app="$URL" --user-data-dir="$DATA/chrome-profile" --no-first-run \
      --no-default-browser-check --window-size=1300,880 >/dev/null 2>&1 &
    WINDOW=$!
  elif [ "$(uname)" = Darwin ]; then
    open "$URL"
  else
    xdg-open "$URL"
  fi
}

if [ ! -x "$ROOT/venv/bin/python" ]; then
  MSG="Splat Studio isn't installed yet. Open Terminal in $ROOT and run ./setup.sh"
  if [ "$(uname)" = Darwin ]; then osascript -e "display alert \"Splat Studio\" message \"$MSG\""; else
    notify-send "Splat Studio" "$MSG" 2>/dev/null || echo "$MSG"; fi
  exit 1
fi

# already running? just open another window onto it
if curl -s -m 2 "${URL}api/system" >/dev/null 2>&1; then
  open_window
  exit 0
fi

"$ROOT/venv/bin/python" -I "$ROOT/app/studio.py" --port "$PORT" --no-browser &
SERVER=$!
for _ in $(seq 1 60); do
  curl -s -m 1 "${URL}api/system" >/dev/null 2>&1 && break
  kill -0 $SERVER 2>/dev/null || { echo "server failed to start"; exit 1; }
  sleep 0.5
done
open_window

# the server exits by itself once the window is closed
wait $SERVER
echo "server exited"
[ -n "$WINDOW" ] && kill $WINDOW 2>/dev/null   # close the app-window browser instance too
exit 0
