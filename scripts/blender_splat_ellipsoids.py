"""Import a Gaussian splat .ply into Blender as soft, oriented ellipsoids (EEVEE-friendly).

Better than blender_import_splat.py: every splat becomes a small ellipsoid stretched by its
scale_0-2 and turned by its rot_0-3 quaternion, and the material fades its alpha like a
Gaussian (opaque in the middle, soft at the rim), using the splat's own opacity. EEVEE's
"Dithered" transparency + many render samples blends them without sorting.

It can also crop: keep only splats above a plane (e.g. a table) within a radius of a point,
and re-orient the result so the plane normal becomes Blender's +Z.

Run inside Blender (Scripting tab, or via the Blender MCP):
    SPLAT = dict(
        ply="/Users/you/GaussianSplatting/projects/NAME/splat/splat_30000.ply",
        camera_path="/Users/you/GaussianSplatting/projects/NAME/camera_path.json",  # gives target + up
        table_h=-0.217,      # table plane height along "up" relative to target (splat units)
        radius=0.85,         # keep splats within this horizontal distance of the target
        top=1.2,             # ...and below this height
        scale=11.0,          # Blender metres per splat unit
        name="Ship",
    )
    exec(open(".../blender_splat_ellipsoids.py").read())
Optional keys: frame (reuse another import's obj["splat_frame"]), min_opacity (0.03), trim_table_band (0.05, splat units above the table where
table-coloured splats are removed), trim_color_dist (0.12), background (False: if True keep
everything above the table instead of only the radius; "only" keeps just what is outside it), sigma (2.0, ellipsoid radius in std devs).
"""
import json
import bpy
import numpy as np

SH_C0 = 0.28209479177387814
CFG = dict(min_opacity=0.03, trim_table_band=0.05, trim_color_dist=0.12, background=False,
           sigma=2.0, top=1.2, radius=0.85, scale=1.0, name="Splat", subdiv=1, forward=None)
CFG.update(globals().get("SPLAT", {}))


def read_splat_ply(path):
    """Memory-maps the PLY and returns the columns we need (skips the 45 f_rest columns)."""
    cache = bpy.app.driver_namespace.setdefault("_splat_cache", {})
    if path in cache:
        return cache[path]
    with open(path, "rb") as f:
        props, n = [], 0
        while True:
            line = f.readline().decode().strip()
            if line.startswith("element vertex"):
                n = int(line.split()[-1])
            elif line.startswith("property float"):
                props.append(line.split()[-1])
            elif line == "end_header":
                break
        offset = f.tell()
    data = np.memmap(path, dtype="<f4", mode="r", offset=offset, shape=(n, len(props)))
    want = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
            "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]
    cols = {p: np.array(data[:, props.index(p)]) for p in want}
    del data
    cache.clear()
    cache[path] = cols
    return cols


def quat_mul(a, b):  # (…,4) wxyz Hamilton product a*b
    aw, ax, ay, az = np.moveaxis(a, -1, 0)
    bw, bx, by, bz = np.moveaxis(b, -1, 0)
    return np.stack([aw * bw - ax * bx - ay * by - az * bz,
                     aw * bx + ax * bw + ay * bz - az * by,
                     aw * by - ax * bz + ay * bw + az * bx,
                     aw * bz + ax * by - ay * bx + az * bw], -1)


def srgb_to_linear(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


v = read_splat_ply(CFG["ply"])
cam = json.load(open(CFG["camera_path"]))
target = np.array(cam["target"])
up = np.array(cam["up"]) / np.linalg.norm(cam["up"])

xyz = np.stack([v["x"], v["y"], v["z"]], 1).astype(np.float64)
rel = xyz - target
h = rel @ up
horiz = rel - np.outer(h, up)
r = np.linalg.norm(horiz, axis=1)
opacity = 1 / (1 + np.exp(-v["opacity"]))
rgb = np.clip(0.5 + SH_C0 * np.stack([v["f_dc_0"], v["f_dc_1"], v["f_dc_2"]], 1), 0, 1)

above = h > CFG["table_h"]
keep = above & (opacity > CFG["min_opacity"]) & (h < CFG["top"])
if CFG["background"] == "only":   # the surroundings without the object (same frame as the object)
    keep &= r >= CFG["radius"]
elif not CFG["background"]:
    keep &= r < CFG["radius"]
# faint, large splats are usually floaters (haze around thin parts); max_faint_size in splat units
if CFG.get("max_faint_size"):
    big = np.exp(np.stack([v["scale_0"], v["scale_1"], v["scale_2"]], 1)).max(1) > CFG["max_faint_size"]
    keep &= ~(big & (opacity < CFG.get("faint_opacity", 0.35)))

# Splats hugging the table that are table-coloured: compare to the median colour of the
# table ring around the ship, and drop close matches within a thin band above the table.
ring = (np.abs(h - CFG["table_h"]) < 0.015) & (r > CFG["radius"]) & (r < CFG["radius"] + 0.5) & (opacity > 0.3)
table_rgb = np.median(rgb[ring], 0) if ring.any() else None
trimmed = 0
if table_rgb is not None and CFG["trim_table_band"] > 0:
    band = keep & (h < CFG["table_h"] + CFG["trim_table_band"])
    close = np.linalg.norm(rgb - table_rgb, axis=1) < CFG["trim_color_dist"]
    drop = band & (close | (h < CFG["table_h"] + 0.012))
    trimmed = int(drop.sum())
    keep &= ~drop

# Wispy table residue around the hull base: below footprint_band (height above the table),
# keep only splats inside the 2D footprint of the solid hull a little higher up.
fp = CFG.get("footprint")  # (from_h, to_h, band_h, cell) in splat units above the table
if fp:
    cell = fp[3]
    hr = h - CFG["table_h"]
    e1 = np.cross(up, [1.0, 0, 0]); e1 /= np.linalg.norm(e1); e2 = np.cross(up, e1)
    gx = np.floor(horiz @ e1 / cell).astype(np.int64); gy = np.floor(horiz @ e2 / cell).astype(np.int64)
    solid = keep & (hr > fp[0]) & (hr < fp[1]) & (opacity > 0.3)
    occ = set(zip(gx[solid], gy[solid]))
    occ = {(x + dx, y + dy) for x, y in occ for dx in (-1, 0, 1) for dy in (-1, 0, 1)}
    low = np.where(keep & (hr < fp[2]))[0]
    inside = np.array([(gx[i], gy[i]) in occ for i in low], bool)
    keep[low[~inside]] = False
    trimmed += int((~inside).sum())

# Frame: Z = up; X = ship's long axis (horizontal PCA of the opaque splats near the target).
# Pass frame=other_obj["splat_frame"] to reuse another import's frame (e.g. its background).
if CFG.get("frame"):
    origin, M = np.array(CFG["frame"]["origin"]), np.array(CFG["frame"]["rows"])
else:
    core = keep & (r < CFG["radius"]) & (opacity > 0.2)
    centre_h = horiz[core].mean(0)
    if CFG["forward"] is not None:
        ax = np.array(CFG["forward"], float)
    else:
        cov = np.cov((horiz[core] - centre_h).T)
        ax = np.linalg.eigh(cov)[1][:, -1]
    ax = ax - (ax @ up) * up
    ax /= np.linalg.norm(ax)
    M = np.stack([ax, np.cross(up, ax), up])          # rows: Blender X, Y, Z in splat coords
    origin = target + centre_h + CFG["table_h"] * up  # table point under the ship's middle

S = CFG["scale"]
pos = ((xyz[keep] - origin) @ M.T) * S
q = np.stack([v["rot_0"], v["rot_1"], v["rot_2"], v["rot_3"]], 1)[keep].astype(np.float64)
q /= np.linalg.norm(q, axis=1, keepdims=True)
import mathutils
qM = np.array(mathutils.Matrix(M.tolist()).to_quaternion())
rot = quat_mul(qM[None], q)
scl = np.exp(np.stack([v["scale_0"], v["scale_1"], v["scale_2"]], 1)[keep]) * S * CFG["sigma"]
scl = np.clip(scl, 1e-5 * S, np.percentile(scl.max(1), 99.5))   # tame giant floaters
col = srgb_to_linear(rgb[keep])
op = opacity[keep]
n = int(keep.sum())

name = CFG["name"]
mesh = bpy.data.meshes.new(name + "_splats")
mesh.vertices.add(n)
mesh.vertices.foreach_set("co", pos.astype(np.float32).ravel())
a = mesh.color_attributes.new("splat_color", "FLOAT_COLOR", "POINT")
a.data.foreach_set("color", np.hstack([col, np.ones((n, 1))]).astype(np.float32).ravel())
a = mesh.attributes.new("splat_opacity", "FLOAT", "POINT")
a.data.foreach_set("value", op.astype(np.float32))
a = mesh.attributes.new("splat_scale", "FLOAT_VECTOR", "POINT")
a.data.foreach_set("vector", scl.astype(np.float32).ravel())
a = mesh.attributes.new("splat_rot", "QUATERNION", "POINT")
a.data.foreach_set("value", rot.astype(np.float32).ravel())
obj = bpy.data.objects.new(name, mesh)
bpy.context.scene.collection.objects.link(obj)

# Shared node group + material (reused if this is run more than once).
ng = bpy.data.node_groups.get("SplatEllipsoids")
if ng is None:
    ng = bpy.data.node_groups.new("SplatEllipsoids", "GeometryNodeTree")
    ng.interface.new_socket("Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    ng.interface.new_socket("Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    N, L = ng.nodes, ng.links
    gin, gout = N.new("NodeGroupInput"), N.new("NodeGroupOutput")
    ico = N.new("GeometryNodeMeshIcoSphere")
    ico.inputs["Radius"].default_value = 1.0
    ico.inputs["Subdivisions"].default_value = CFG["subdiv"]
    smooth = N.new("GeometryNodeSetShadeSmooth")
    L.new(ico.outputs["Mesh"], smooth.inputs["Geometry"])
    inst = N.new("GeometryNodeInstanceOnPoints")
    a_rot = N.new("GeometryNodeInputNamedAttribute")
    a_rot.data_type = "QUATERNION"
    a_rot.inputs["Name"].default_value = "splat_rot"
    a_scl = N.new("GeometryNodeInputNamedAttribute")
    a_scl.data_type = "FLOAT_VECTOR"
    a_scl.inputs["Name"].default_value = "splat_scale"
    real = N.new("GeometryNodeRealizeInstances")
    setmat = N.new("GeometryNodeSetMaterial")
    L.new(gin.outputs[0], inst.inputs["Points"])
    L.new(smooth.outputs[0], inst.inputs["Instance"])
    L.new(a_rot.outputs["Attribute"], inst.inputs["Rotation"])
    L.new(a_scl.outputs["Attribute"], inst.inputs["Scale"])
    L.new(inst.outputs[0], real.inputs[0])
    L.new(real.outputs[0], setmat.inputs["Geometry"])
    L.new(setmat.outputs[0], gout.inputs[0])

mat = bpy.data.materials.get("SplatGaussian")
if mat is None:
    mat = bpy.data.materials.new("SplatGaussian")
    mat.use_nodes = True
    T = mat.node_tree
    T.nodes.clear()
    out = T.nodes.new("ShaderNodeOutputMaterial")
    c = T.nodes.new("ShaderNodeAttribute"); c.attribute_name = "splat_color"
    o = T.nodes.new("ShaderNodeAttribute"); o.attribute_name = "splat_opacity"
    geo = T.nodes.new("ShaderNodeNewGeometry")
    # facing f = |N.I|; on the silhouette rho^2 = 1 - f^2; alpha = opacity * exp(-sigma^2/2 * rho^2)
    dot = T.nodes.new("ShaderNodeVectorMath"); dot.operation = "DOT_PRODUCT"
    T.links.new(geo.outputs["Normal"], dot.inputs[0]); T.links.new(geo.outputs["Incoming"], dot.inputs[1])
    sq = T.nodes.new("ShaderNodeMath"); sq.operation = "MULTIPLY"
    T.links.new(dot.outputs["Value"], sq.inputs[0]); T.links.new(dot.outputs["Value"], sq.inputs[1])
    rho = T.nodes.new("ShaderNodeMath"); rho.operation = "SUBTRACT"; rho.inputs[0].default_value = 1.0
    T.links.new(sq.outputs[0], rho.inputs[1])
    k = T.nodes.new("ShaderNodeMath"); k.operation = "MULTIPLY"; k.inputs[1].default_value = -0.5 * CFG["sigma"] ** 2
    T.links.new(rho.outputs[0], k.inputs[0])
    ex = T.nodes.new("ShaderNodeMath"); ex.operation = "EXPONENT"
    T.links.new(k.outputs[0], ex.inputs[0])
    alpha = T.nodes.new("ShaderNodeMath"); alpha.operation = "MULTIPLY"; alpha.use_clamp = True
    T.links.new(ex.outputs[0], alpha.inputs[0]); T.links.new(o.outputs["Fac"], alpha.inputs[1])
    em = T.nodes.new("ShaderNodeEmission"); em.name = "SplatEmission"
    T.links.new(c.outputs["Color"], em.inputs["Color"])
    tr = T.nodes.new("ShaderNodeBsdfTransparent")
    mix = T.nodes.new("ShaderNodeMixShader")
    T.links.new(alpha.outputs[0], mix.inputs[0])
    T.links.new(tr.outputs[0], mix.inputs[1]); T.links.new(em.outputs[0], mix.inputs[2])
    T.links.new(mix.outputs[0], out.inputs["Surface"])
    mat.surface_render_method = "DITHERED"
setmat = [nd for nd in ng.nodes if nd.bl_idname == "GeometryNodeSetMaterial"][0]
setmat.inputs["Material"].default_value = mat

mod = obj.modifiers.new("SplatEllipsoids", "NODES")
mod.node_group = ng
obj["splat_frame"] = {"origin": origin.tolist(), "rows": M.tolist(), "scale": S}
result = {"object": obj.name, "splats": n, "trimmed_table_splats": trimmed,
          "table_rgb": None if table_rgb is None else table_rgb.round(3).tolist(),
          "bbox_min": pos.min(0).round(2).tolist(), "bbox_max": pos.max(0).round(2).tolist()}
print(result)
