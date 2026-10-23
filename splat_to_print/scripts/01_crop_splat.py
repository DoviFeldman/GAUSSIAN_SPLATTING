"""Crop the ship's splats out of the full scene into a leveled local frame (z = table normal, z=0 = table)."""
import json, sys, numpy as np
from plyfile import PlyData
from common import SPLAT, CAMERA_PATH
TABLE_H = float(sys.argv[1]) if len(sys.argv) > 1 else -0.217   # table height along "up" from target (splat units)
cp = json.load(open(CAMERA_PATH))
up = np.array(cp["up"]); up /= np.linalg.norm(up); target = np.array(cp["target"])
v = PlyData.read(SPLAT)["vertex"].data
xyz = np.stack([v["x"], v["y"], v["z"]], 1).astype(np.float64)
rel = xyz - target
h = rel @ up
r = np.linalg.norm(rel - np.outer(h, up), axis=1)
keep = (h > TABLE_H - 0.03) & (h < 1.5) & (r < 0.9)
# local frame: e3 = up, e1 arbitrary horizontal (fixed later by PCA)
e3 = up; e1 = np.cross(e3, [1, 0, 0]); e1 /= np.linalg.norm(e1); e2 = np.cross(e3, e1)
R = np.stack([e1, e2, e3])  # rows
origin = target + TABLE_H * up
loc = (xyz[keep] - origin) @ R.T
sh0 = 0.28209479177387814
col = np.clip(0.5 + sh0 * np.stack([v["f_dc_0"], v["f_dc_1"], v["f_dc_2"]], 1)[keep], 0, 1)
op = 1 / (1 + np.exp(-v["opacity"][keep]))
sc = np.exp(np.stack([v["scale_0"], v["scale_1"], v["scale_2"]], 1)[keep])
np.savez("work/crop.npz", xyz=loc, col=col, op=op, sc=sc, R=R, origin=origin)
print(keep.sum(), "splats; z range", loc[:, 2].min(), loc[:, 2].max())
