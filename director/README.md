# Splat Director

Film your own camera moves through Gaussian splats: draw camera paths in 3D, aim the camera,
speed-ramp it like Resolve's retime curves, cut shots together with video clips and music, and
export an mp4. It's a separate app from Splat Studio, built the same way so the two can be merged later.

## Start it

```bash
director/install_app.sh        # once: adds "Splat Director" to ~/Applications and the Dock
```
Or run it without installing: `director/launch.sh`. Needs the Splat Studio setup (`./setup.sh`) and `ffmpeg`.
Closing the window stops the server.

## How it works

**Moving around** (works right through the middle of the scene, there's no slowdown near the centre):
drag = orbit the spot under the mouse · scroll / pinch = fly toward the mouse · right-drag = look around, and
hold it + W A S D / Q E to fly (scroll while flying changes the speed) · shift-drag or middle-drag = pan ·
double-click = focus there · F = frame the selection.

**Paths** (toolbar above the view):

| Key | Tool | |
|---|---|---|
| L | Line | click points; Enter or double-click finishes |
| B | Bezier curve | click for smooth points, click-drag to pull out handles |
| A | Half circle | click start and end (Shift = bulge up, Alt = reverse) |
| S | Orbit / spiral | click what to orbit; it starts where your camera is and aims at a target there. Turns, radius in/out, rise and direction are on the right |
| P | Point at camera | fly somewhere, press P, fly on, P again… Enter finishes |
| K | Camera key | click on a path |
| T | Target | click the splat; selected key then keeps looking at it |

Points land on the splat surface (pulled back by the *Stand-off* distance) or, if you miss, in the air.
Move a point by dragging it (hold **X**, **Y** or **Z** to stay on that axis), with the gizmo arrows, or Blender-style:
**G**, then X/Y/Z, click to place, Esc to cancel. Y is up: each splat is turned so its own "up" (from Splat Studio's
camera solve) points up.

- Start drawing on the end of an existing path to continue it; drag an end point onto another path's end to join them.
- An end point's **Extend** field continues the path the way it's already going (a curve keeps curving) or pulls it back.
- Double-click on a path to insert a point.

**Camera keys** sit along a path. Each one has a time, a place along the path (drag it along the path to slide it),
and an aim: *Along path*, *At target* (keeps turning to look at a point), or *Fixed*, plus yaw, pitch, roll and zoom (FOV).
*Aim with mouse* looks through the key so you can drag to aim and scroll to zoom. Between keys the aim blends
smoothly and never overshoots.

**Speed** (right panel, top): the graph is the camera's speed over the shot. Each stretch between two keys has
its own speed; drag it up or down (or type a %), and the rest of the shot slides later or earlier, like Resolve's
retime. The ◆ handles at each key set its *ramp*: how long the speed takes to change (0 = a sudden change).
The speed blends with a smootherstep curve, so speed and acceleration are both continuous, and the camera still
reaches every key at its time. *Hold 1 s here* stops the camera at a key with an eased stop and start.
100% is a speed set per film (scaled to the first splat's size).

**Timeline**: V1 plays shots and videos back to back (drag to reorder, drag edges to trim, ⌘B to split).
A1/A2 hold music anywhere, with volume and fades. The **+** on a cut adds a transition; pick Dissolve, Blur,
Dip to colour or Flash, as short as 1 frame. Space plays, ←/→ steps a frame, 0 toggles the camera view.
⌘Z / ⇧⌘Z undo and redo. Films save automatically to `app_data/director/films/`.

**Before / after**: add both splats (+ Add), lower one's opacity, and line it up with its position / rotation /
scale fields (or select it and press G). Put the same path on V1 twice, tick a different splat on each clip,
and add a dissolve between them.

**Export** renders every frame at full size with a complete depth sort (no flicker), mixes all sound, and writes
`~/Movies/Splat Director/<film>.mp4` (H.264 + AAC).

## Files

```
director/
  director.py        stdlib HTTP server on 127.0.0.1:8771 (like app/studio.py): serves the UI and the shared viewer
                     library, lists splats in projects/, saves films/media, pipes export frames into ffmpeg
  launch.sh          starts the server + a Chrome app window (own profile in app_data/director/chrome-profile)
  install_app.sh     Dock / app-menu launcher, same as app/install_app.sh
  make_icon.py       draws ui/icon.png
  ui/index.html      layout and styles (Resolve-like colours)
  ui/js/model.js     film data and all the maths: Bezier paths, arc length, extend/join, speed profile, camera aim, timeline
  ui/js/state.js     shared state, events, undo history, autosave
  ui/js/viewport.js  splat rendering (GaussianSplats3D from tools/viewer/lib), navigation, picking, tools, overlay
  ui/js/program.js   what the timeline shows at a moment, transitions, playback, export and audio mix
  ui/js/timeline.js  the timeline
  ui/js/inspector.js the right panel and the speed graph
  ui/js/app.js       wiring, media pool, shortcuts, films, export dialog
app_data/director/   films/, media/ (imported videos and music), renders/ (temporary), director.log
```

To debug from the browser console: `window.__director` has the state and modules.
