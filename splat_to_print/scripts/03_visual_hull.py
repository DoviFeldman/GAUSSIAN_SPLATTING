"""MEASURING AID ONLY (the printed model is built by 05_model_clean.py).
Visual hull of the ship from photo silhouettes (coarse-to-fine voting) -> work/occ.npz.
Also stores the distance to the nearest opaque splat so later steps can trim hull 'ghost' volume."""
import numpy as np, sys
from PIL import Image
from scipy import ndimage as ndi
from scipy.spatial import cKDTree
from masks import ship_mask, project
from common import DATASET_IMAGES
import os
VOX = float(sys.argv[1]) if len(sys.argv) > 1 else 0.003
TOL = float(sys.argv[2]) if len(sys.argv) > 2 else 0.06   # fraction of views allowed to disagree
c = np.load("work/cams.npz"); d = np.load("work/crop.npz")
xyz, col, op = d["xyz"], d["col"], d["op"]; R, origin = d["R"], d["origin"]
r, g, b = col.T
ship = xyz[(op > 0.3) & (r - b > 0.15) & (r > g) & (xyz[:, 2] > 0.01)]
cnt = np.array([len(n) for n in cKDTree(ship).query_ball_point(ship, 0.02)]); ship = ship[cnt >= 8]
lo = np.percentile(ship, 0.2, 0) - 0.06; hi = np.percentile(ship, 99.8, 0) + 0.06; lo[2] = 0.0

# silhouettes once
views = []
world_ship = ship @ R + origin
for i, name in enumerate(c["names"]):
    img = np.array(Image.open(os.path.join(DATASET_IMAGES, name)).convert("RGB")); H, W = img.shape[:2]
    uv, z = project(world_ship, c["K"][i], c["Rt"][i]); u = uv.astype(int)
    ok = (z > 0) & (u[:, 0] >= 0) & (u[:, 0] < W) & (u[:, 1] >= 0) & (u[:, 1] < H)
    if ok.mean() < 0.98: continue
    fp = np.zeros((H, W), bool); fp[u[ok, 1], u[ok, 0]] = True
    fp = ndi.binary_closing(ndi.binary_dilation(fp, iterations=3), iterations=4)
    m = ship_mask(img, ndi.binary_dilation(fp, iterations=40))
    iou = (m & fp).sum() / max(1, (m | fp).sum())
    if iou < 0.3: print("skip", name, round(iou, 2)); continue
    views.append((ndi.binary_dilation(m, iterations=1), c["K"][i], c["Rt"][i]))
print("views", len(views))

def carve(P):
    n_vis = np.zeros(len(P), np.int16); n_out = np.zeros(len(P), np.int16)
    W_ = P @ R + origin
    for m, K, Rt in views:
        H, W = m.shape
        uv, z = project(W_, K, Rt); u = np.round(uv).astype(int)
        ins = (z > 0) & (u[:, 0] >= 0) & (u[:, 0] < W) & (u[:, 1] >= 0) & (u[:, 1] < H)
        n_vis += ins; n_out[ins] += ~m[u[ins, 1], u[ins, 0]]
    return (n_out <= np.maximum(2, TOL * n_vis)) & (n_vis > 20)

def grid(v):
    shape = np.ceil((hi - lo) / v).astype(int)
    gi = np.stack(np.meshgrid(*[np.arange(n) for n in shape], indexing="ij"), -1).reshape(-1, 3)
    return shape, gi, lo + (gi + 0.5) * v

# coarse pass at 2x voxel
cs, cgi, cP = grid(2 * VOX)
cocc = np.zeros(cs, bool); cocc[tuple(cgi[carve(cP)].T)] = True
cocc = ndi.binary_dilation(cocc, iterations=1)
shape, gi, P = grid(VOX)
cand = cocc[tuple(np.minimum(gi // 2, np.array(cs) - 1).T)]
occ = np.zeros(shape, bool); occ[tuple(gi[cand][carve(P[cand])].T)] = True
# distance to nearest opaque splat (any colour), for trimming ghost volume later
allpts = xyz[(op > 0.5) & (xyz[:, 2] > 0.004)]
dist = np.full(shape, np.inf, np.float32)
idx = np.argwhere(occ); dd, _ = cKDTree(allpts).query(lo + (idx + 0.5) * VOX); dist[tuple(idx.T)] = dd
print("occupied", occ.sum(), "grid", shape)
np.savez_compressed("work/occ.npz", occ=occ, dist=dist, lo=lo, vox=VOX)
