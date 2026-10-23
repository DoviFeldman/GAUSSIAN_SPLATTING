# Prompt: turn a splat of a small object into a clean 3D-printable model

Copy everything in the box below into a new Claude Code session. Replace the `<…>` parts.
It describes exactly how `model/pirate_ship_clean.stl` was made, so a later session can repeat it on the
same ship or on a new object.

```text
I have a 3D Gaussian splat of a small object (<what it is, its colour, what it sits on>), made from a
phone video with the pipeline in ~/GaussianSplatting. Please make a CLEAN, HAND-MODELLED, 3D-printable
version of it (STL + 3MF for Bambu Studio), following ~/GaussianSplatting/splat_to_print/ exactly:
read splat_to_print/README.md, PROMPT.md and LESSONS.md first, and reuse the scripts in
splat_to_print/scripts/.

Use the hand-modelled (parametric CSG) method ONLY. Do NOT deliver a mesh made directly from the scan
(no Poisson / marching-cubes / visual-hull mesh as the final model). We tried that: it prints, but it
comes out lumpy and blobby. The scan is only a measuring guide.

Inputs (in ~/GaussianSplatting/projects/<NAME>/):
- splat/splat_30000.ply (standard 3DGS PLY, COLMAP coordinates, y points down)
- dataset/images + dataset/sparse/0 (undistorted COLMAP photos and poses), images/ (original frames)
- camera_path.json: "target" = object centre, "up" = table normal

Rules:
- Put everything in ~/GaussianSplatting/projects/<NAME>/print/ (make a venv there from
  splat_to_print/scripts/requirements.txt, Python 3.12). Don't modify or delete other files.
- Never use the Blender MCP tools or a running Blender window (another session may be using it).
  For renders, run a separate headless Blender:
  /Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup --python <script> -- <model>
- Don't commit or push unless I ask.

Steps (run from projects/<NAME>/print/, export SPLAT_PROJECT=~/GaussianSplatting/projects/<NAME>):
1. Look at ~8 photos (a contact sheet) to understand the object's parts.
2. 01_crop_splat.py [table_h]: crop the splat above the table, around "target", into a levelled frame
   (z = table normal, z=0 = table). Check the plots: the object's long axis may need a rotation.
3. 02_export_cams.py (with ~/GaussianSplatting/venv/bin/python, which has pycolmap): dump cameras.
4. 03_visual_hull.py 0.003 0.06: colour silhouettes from all photos, tolerant voting -> voxel hull.
   Check the masks first. masks.ship_mask defaults to rust/orange; change the hue window for other colours.
   Make sure the colour mask covers shadowed parts (dark brown), and drop views where the mask is broken
   (IoU < 0.3 against the projected splat).
5. 04_measure_scan.py <length_mm>: scale, square up and centre, then print station / mast / sail tables.
   Remember the hull runs 1-2 mm fat and is over-full under overhangs and in concave pockets (decks, gaps).
6. Write/adapt 05_model_clean.py: build the object from clean primitives with manifold3d
   (lofted hull from cross-sections, recessed decks, cylinders for masts and spars, curved sail panels
   with thickness, relief emblems by intersecting an offset copy of the panel with an emblem prism,
   flat base via trim_by_plane at z=0). Take every dimension from the step-5 tables and the photos.
7. 06_compare_cams.py, then 07_render_blender.py, then 08_contact_sheets.py: render 6 preview angles and
   overlay the model on real photos from their exact camera poses. Compare and fix proportions.
8. 09_check_print.py <stl>: must report watertight True, 1 body, manifold3d NoError, 0 non-manifold edges,
   z min 0, and no dense clusters thinner than 1.2 mm (sails/masts at least ~1.2 mm, walls 2+ mm).
9. Target 80-100 mm long. Report final dimensions, show me the preview and photo-overlay images, and be
   honest about what is simplified.
```

For the pirate ship, the numbers and parts in `scripts/05_model_clean.py` are the finished answer, so you
can just re-run it. For a new object, keep its helper functions and rewrite the part list.
