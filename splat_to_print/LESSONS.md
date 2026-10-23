# Lessons learned (splat → printable model, pirate ship, Oct 2026)

## What worked, what didn't
| Approach | Result |
|---|---|
| Dense multi-view stereo (pycolmap `patch_match_stereo`) | **Not possible on Mac**: pycolmap has no CUDA (`pycolmap.has_cuda == False`). |
| Mesh straight from splat centres | Splats only sit on the surface and are noisy. Cutting the hull down to "near a splat" made it hollow and full of holes. |
| Visual hull from photo silhouettes, then marching cubes | Watertight, prints, and the silhouette matches. But it's **lumpy**: concave pockets (deck, gaps between stacked sails) fill in, sails come out thick, and the space under the hull's overhang is solid. See `images/rejected_visual_hull_*.jpg`. |
| **Hand-modelled CSG using the visual hull as a measuring guide** | **Chosen.** Clean, crisp, correct proportions, and it lines up with the photos from their real camera poses. ~37k triangles instead of 300k. |

## Scan / masking
- The object's colour against a grey table makes silhouettes easy. Use HSV: hue < 40 or > 345, saturation > 0.30,
  value > 0.10. Keep value low so the dark, shadowed side still counts as the object.
- Limit each mask to a region around the projected splat points. Otherwise other orange things (umbrella, the
  yellow end-grain of the wood, leaves) get in.
- **Use tolerant voting, not strict carving.** Keep a voxel if ≤ 6 % of the views that see it disagree. A strict
  hull loses thin masts whenever a single mask has a hole in it (dark sails had holes in some frames).
- Drop broken views by IoU between the mask and the projected splat footprint. 0.55 was far too strict (it dropped
  half the good views); 0.3 only drops the real failures (e.g. the first, far-away frame).
- Run coarse-to-fine (2× voxel first, then refine near survivors): 45M voxels × 125 views in about 90 s.
- The splat crop needs `opacity > 0.3` plus a colour test (r − b > 0.15, r > g). Dark hull bottoms are missed by
  colour, so never use the splat alone to bound the volume.
- COLMAP poses and the splat share one coordinate frame (Brush trains on the COLMAP dataset). Projecting splat points
  into the photos lines up to the pixel. Use this to check everything.

## Measuring
- In print mm, the visual hull is ~1–2 mm fat and solid in every hollow, and solid under overhangs (no camera sees
  under the hull). Slim the measured widths and model hollows from the photos.
- Square the object up with a yaw search that makes the hull's centre line straight. PCA of the hull points gave a
  wrong 13° (the stern castle skews it); the search found 5.5–6°.
- Sail yaw: PCA of each sail's (x, y) points in its z band. The mizzen looked twisted in one photo, but the scan
  said ~5°, same as the other sails.

## CSG modelling with manifold3d
- Loft = rings of (y, z) cross-sections + fan caps. **Cap winding must be the opposite of the side quads**,
  or manifold3d returns `NotManifold`.
- Keep loft stations off the x positions where deck levels change. A station exactly on a break gave two
  vertices at the same position: fine inside manifold3d, but after STL vertex merging that became 2
  non-manifold edges. A 0.137 mm offset of the stations fixed it. `simplify()` and dropping the sliver did not.
- Decks: cut the inside with a separate inner loft per deck level. End each cut **≥ 2 mm before a level change**,
  or the last station's tall cut eats into the castle's front wall.
- Sails: a thick parametric panel (back and front faces + side strips), billowing forward as `sag·(1−u²)·sin(πv)`
  so the top and bottom edges stay straight on the yards. Put the back face 0.6 mm inside the mast so they fuse.
- Raised emblems: (same panel with its front face offset 0.7 mm) ∩ (emblem prism along x), then union. That
  follows the curved sail exactly.
- Check thickness with Open3D ray casting (trimesh's ray module needs `rtree`; its section area needs `shapely`).
  The thin spots it found were all features I added: crow's-nest cup 0.4 mm, window recesses leaving ~1 mm,
  flared bow walls. Fixed with a 2.3 mm wall, shallower recesses, and a thicker cup.
- 3MF export from trimesh needs `lxml` (+ `networkx`).

## Rendering / comparing
- Headless Blender (`--background --factory-startup`) renders 12 images in ~7 s. Never use the Blender MCP or a
  running Blender UI, because another session may own it.
- COLMAP → Blender camera: columns = (x, −y, −z) of the camera axes; `lens = fx·36/W`, `sensor_fit=HORIZONTAL`,
  `shift = offset / max(W, H)`. The model-frame transform is saved in `work/align.json`.
- `magick montage` fails here (no default font): use `+append` / `-append` or PIL. Don't `-flatten` a
  multi-image list (it collapses the grid into one image).
- `np.ndarray.ptp` is gone in NumPy 2: use `np.ptp(a)`.

## Shell gotchas
- Never put `cat > file` without a heredoc before a `python - <<EOF` in the same command: the `cat` swallows the
  heredoc and the shell hangs.

## What would make the scan better
A low orbit at table height and a high (60–80°) orbit, slow passes over hollows, and the object on a small raised
stand so cameras see under it. Fewer blurred frames (slower orbit or photos). Dense MVS on a CUDA machine
(COLMAP / OpenMVS) would capture concave detail the silhouettes can't.
