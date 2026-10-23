#!/bin/bash
# Create the Splat Studio launcher icon.
#   Mac:   ~/Applications/Splat Studio.app, added to the Dock
#   Linux: an app-menu entry (~/.local/share/applications/splat-studio.desktop)
# Uninstall: delete that .app / .desktop file (and drag the Dock icon out).
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
chmod +x "$ROOT/app/launch.sh"

if [ "$(uname)" = Darwin ]; then
  APPDIR="$HOME/Applications/Splat Studio.app"
  rm -rf "$APPDIR"
  mkdir -p "$APPDIR/Contents/MacOS" "$APPDIR/Contents/Resources"
  cat > "$APPDIR/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Splat Studio</string>
  <key>CFBundleDisplayName</key><string>Splat Studio</string>
  <key>CFBundleIdentifier</key><string>io.github.dovifeldman.splatstudio</string>
  <key>CFBundleExecutable</key><string>SplatStudio</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
</dict></plist>
EOF
  cat > "$APPDIR/Contents/MacOS/SplatStudio" <<EOF
#!/bin/bash
exec "$ROOT/app/launch.sh"
EOF
  chmod +x "$APPDIR/Contents/MacOS/SplatStudio"

  # icon.icns from the 1024px PNG (sips + iconutil ship with macOS)
  SET="$(mktemp -d)/icon.iconset"
  mkdir -p "$SET"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$ROOT/app/ui/icon.png" --out "$SET/icon_${s}x${s}.png" >/dev/null
    sips -z $((s * 2)) $((s * 2)) "$ROOT/app/ui/icon.png" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$SET" -o "$APPDIR/Contents/Resources/icon.icns"
  touch "$APPDIR"

  # add to the Dock once
  if ! defaults read com.apple.dock persistent-apps 2>/dev/null | grep -q "Splat%20Studio.app"; then
    URL="file://$(echo "$APPDIR" | sed 's/ /%20/g')/"
    defaults write com.apple.dock persistent-apps -array-add \
      "<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>$URL</string><key>_CFURLStringType</key><integer>15</integer></dict></dict></dict>"
    killall Dock
  fi
  echo "Installed: $APPDIR (and added to your Dock)"
else
  mkdir -p "$HOME/.local/share/applications" "$HOME/.local/share/icons"
  cp "$ROOT/app/ui/icon.png" "$HOME/.local/share/icons/splat-studio.png"
  cat > "$HOME/.local/share/applications/splat-studio.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Splat Studio
Comment=Turn a video into a 3D Gaussian splat
Exec="$ROOT/app/launch.sh"
Icon=$HOME/.local/share/icons/splat-studio.png
Terminal=false
Categories=Graphics;3DGraphics;
EOF
  chmod +x "$HOME/.local/share/applications/splat-studio.desktop"
  update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
  echo "Installed: Splat Studio in your app menu. Right-click it -> 'Add to Favorites' / 'Pin to dock' to keep it in your dock."
fi
