"""Dump COLMAP undistorted camera intrinsics/extrinsics to npz (run with the GaussianSplatting venv: it has pycolmap)."""
import numpy as np, pycolmap
from common import SPARSE
rec = pycolmap.Reconstruction(SPARSE)
names, K, Rt, wh = [], [], [], []
for iid, im in sorted(rec.images.items(), key=lambda kv: kv[1].name):
    cam = rec.cameras[im.camera_id]
    names.append(im.name); K.append(cam.calibration_matrix()); wh.append((cam.width, cam.height))
    Rt.append(im.cam_from_world().matrix() if callable(im.cam_from_world) else im.cam_from_world.matrix())
print(rec.summary()); print(set(c.model.name for c in rec.cameras.values()))
np.savez("work/cams.npz", names=np.array(names), K=np.array(K), Rt=np.array(Rt), wh=np.array(wh))
