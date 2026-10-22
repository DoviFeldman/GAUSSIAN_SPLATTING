"""Import a Gaussian splat .ply into Blender as a colored point cloud (preview).

This is an approximation (each splat becomes a round point, no stretching or
soft falloff); the real splat rendering is the web viewer. Good for looking
around, framing, and lining things up in Blender.

Run inside Blender (Scripting tab, or via the Blender MCP), after setting PLY:
    PLY = "/Users/you/GaussianSplatting/projects/NAME/splat/splat_30000.ply"
    exec(open(".../blender_import_splat.py").read())
Optional: MIN_OPACITY (default 0.3) hides faint splats.
"""
import bpy
import numpy as np

PLY = globals().get("PLY")
MIN_OPACITY = globals().get("MIN_OPACITY", 0.3)
SH_C0 = 0.28209479177387814


def read_splat_ply(path):
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
        data = np.frombuffer(f.read(n * 4 * len(props)), dtype="<f4").reshape(n, len(props))
    return {p: data[:, i] for i, p in enumerate(props)}


v = read_splat_ply(PLY)
opacity = 1 / (1 + np.exp(-v["opacity"]))
keep = opacity > MIN_OPACITY
xyz = np.stack([v["x"], v["y"], v["z"]], 1)[keep]
rgb = np.clip(0.5 + SH_C0 * np.stack([v["f_dc_0"], v["f_dc_1"], v["f_dc_2"]], 1)[keep], 0, 1)
radius = np.exp(np.stack([v["scale_0"], v["scale_1"], v["scale_2"]], 1)[keep]).mean(1)
radius = np.clip(radius, 0, np.percentile(radius, 99))  # tame huge background splats
n = len(xyz)

name = bpy.path.display_name_from_filepath(PLY)
mesh = bpy.data.meshes.new(name)
mesh.vertices.add(n)
mesh.vertices.foreach_set("co", xyz.ravel())
col = mesh.color_attributes.new("splat_color", "FLOAT_COLOR", "POINT")
col.data.foreach_set("color", np.hstack([rgb, np.ones((n, 1))]).astype(np.float32).ravel())
rad = mesh.attributes.new("splat_radius", "FLOAT", "POINT")
rad.data.foreach_set("value", radius.astype(np.float32))
obj = bpy.data.objects.new(name, mesh)
bpy.context.scene.collection.objects.link(obj)
obj.rotation_euler = (np.pi, 0, 0)  # flip y-down/z-forward into Blender's z-up

# geometry nodes: vertices -> points sized by splat radius
ng = bpy.data.node_groups.new(name + "_points", "GeometryNodeTree")
ng.interface.new_socket("Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
ng.interface.new_socket("Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
nodes, links = ng.nodes, ng.links
gin, gout = nodes.new("NodeGroupInput"), nodes.new("NodeGroupOutput")
m2p = nodes.new("GeometryNodeMeshToPoints")
attr = nodes.new("GeometryNodeInputNamedAttribute")
attr.data_type = "FLOAT"
attr.inputs["Name"].default_value = "splat_radius"
mul = nodes.new("ShaderNodeMath")
mul.operation = "MULTIPLY"
mul.inputs[1].default_value = 1.5
setmat = nodes.new("GeometryNodeSetMaterial")
links.new(gin.outputs[0], m2p.inputs["Mesh"])
links.new(attr.outputs["Attribute"], mul.inputs[0])
links.new(mul.outputs[0], m2p.inputs["Radius"])
links.new(m2p.outputs["Points"], setmat.inputs["Geometry"])
links.new(setmat.outputs["Geometry"], gout.inputs[0])

mat = bpy.data.materials.new(name + "_mat")
mat.use_nodes = True
mt = mat.node_tree
bsdf = mt.nodes["Principled BSDF"]
emit_attr = mt.nodes.new("ShaderNodeAttribute")
emit_attr.attribute_name = "splat_color"
emission = mt.nodes.new("ShaderNodeEmission")
mt.links.new(emit_attr.outputs["Color"], emission.inputs["Color"])
mt.links.new(emission.outputs[0], mt.nodes["Material Output"].inputs["Surface"])
mt.nodes.remove(bsdf)
setmat.inputs["Material"].default_value = mat

mod = obj.modifiers.new("SplatPoints", "NODES")
mod.node_group = ng
result = {"object": obj.name, "points": int(n)}
print(result)
