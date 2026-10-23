"""Headless Blender renders of a model: 6 turntable previews + renders from real photo poses (work/compare_cams.json).
Run from <project>/print:  /Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup \
     --python /path/to/07_render_blender.py -- pirate_ship_clean.stl
Never use the Blender MCP / a running Blender UI for this (another session may own it)."""
import bpy, json, math, os, sys
from mathutils import Matrix, Vector
model = os.path.abspath(sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else "pirate_ship_clean.stl")
D = os.getcwd(); tag = os.path.splitext(os.path.basename(model))[0]
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
engines = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
sc.render.engine = "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in engines else "BLENDER_EEVEE"
bpy.ops.wm.stl_import(filepath=model)
ship = bpy.context.selected_objects[0]
mat = bpy.data.materials.new("rust"); mat.use_nodes = True
bsdf = mat.node_tree.nodes["Principled BSDF"]; bsdf.inputs["Base Color"].default_value = (0.42, 0.13, 0.04, 1); bsdf.inputs["Roughness"].default_value = 0.8
ship.data.materials.append(mat)
world = bpy.data.worlds.new("w"); sc.world = world; world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0.8, 0.85, 0.95, 1); world.node_tree.nodes["Background"].inputs[1].default_value = 0.6
sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN")); sun.data.energy = 4
sun.rotation_euler = (math.radians(40), 0, math.radians(30)); sc.collection.objects.link(sun)
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam")); sc.collection.objects.link(cam); sc.camera = cam
sc.render.film_transparent = True; sc.render.image_settings.file_format = "PNG"; sc.render.image_settings.color_mode = "RGBA"
sc.render.resolution_x = sc.render.resolution_y = 900; cam.data.lens = 85; cam.data.clip_end = 5000
zc = max(v.co.z for v in ship.data.vertices) / 2
for k, (az, el) in enumerate([(35, 20), (90, 5), (150, 25), (215, 15), (270, 10), (0, 75)]):
    r = 330; a, e = math.radians(az), math.radians(el)
    cam.location = Vector((r * math.cos(e) * math.cos(a), r * math.cos(e) * math.sin(a), zc + r * math.sin(e)))
    cam.rotation_euler = (Vector((0, 0, zc)) - cam.location).to_track_quat("-Z", "Y").to_euler()
    sc.render.filepath = os.path.join(D, "renders", f"{tag}_preview_{k}_az{az}_el{el}.png"); bpy.ops.render.render(write_still=True)
cams = os.path.join(D, "work", "compare_cams.json")
if os.path.exists(cams):
    for cdef in json.load(open(cams)):
        sc.render.resolution_x, sc.render.resolution_y = cdef["W"], cdef["H"]
        cam.data.sensor_fit = "HORIZONTAL"; cam.data.sensor_width = 36; cam.data.lens = cdef["lens"]
        cam.data.shift_x, cam.data.shift_y = cdef["sx"], cdef["sy"]; cam.data.clip_end = 1e5
        cam.matrix_world = Matrix(cdef["M"])
        sc.render.filepath = os.path.join(D, "work", f"cmp_{tag}_" + os.path.splitext(cdef["name"])[0] + ".png"); bpy.ops.render.render(write_still=True)
