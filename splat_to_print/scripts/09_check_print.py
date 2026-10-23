"""Printability report for an STL/3MF: watertight, manifold (manifold3d), bodies, size, base area, thin spots.
Usage: python 09_check_print.py pirate_ship_clean.stl [min_mm=1.2]"""
import sys, collections, numpy as np, trimesh, open3d as o3d, manifold3d as mf
f = sys.argv[1]; MIN = float(sys.argv[2]) if len(sys.argv) > 2 else 1.2
t = trimesh.load(f, force="mesh")
M = mf.Manifold(mf.Mesh(vert_properties=t.vertices.astype(np.float32), tri_verts=t.faces.astype(np.uint32)))
print(f"{f}: extents mm {t.extents.round(1)}, volume {t.volume / 1000:.1f} cm3, tris {len(t.faces)}")
print("watertight", t.is_watertight, "| bodies", len(t.split(only_watertight=False)), "| manifold3d", M.status(),
      "| non-manifold edges", int((np.bincount(t.edges_unique_inverse) != 2).sum()), "| z min", round(t.bounds[0][2], 3))
print("base area at z=0.05:", round(M.slice(0.05).area(), 0), "mm2")
pts, fi = trimesh.sample.sample_surface(t, 30000, seed=1); n = t.face_normals[fi]; o = pts - n * 0.01
sc = o3d.t.geometry.RaycastingScene()
sc.add_triangles(o3d.t.geometry.TriangleMesh.from_legacy(o3d.geometry.TriangleMesh(o3d.utility.Vector3dVector(t.vertices), o3d.utility.Vector3iVector(t.faces))))
d = sc.cast_rays(o3d.core.Tensor(np.hstack([o, -n]).astype(np.float32)))["t_hit"].numpy()
print(f"thickness (inward ray) p1/p5/p50 mm: {np.percentile(d, [1, 5, 50]).round(2)}; fraction < {MIN}: {(d < MIN).mean():.3f}")
print("clusters of thin samples (4 mm cells; scattered edge samples are normal, dense clusters are real):")
print(collections.Counter(map(tuple, (np.round(pts[d < MIN] / 4) * 4).astype(int))).most_common(8))
