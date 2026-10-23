"""Blender camera defs (in MODEL coordinates) for a few real photos, so renders overlay the real frames.
Usage: python 06_compare_cams.py [image indices 0..N-1 in sorted COLMAP order...]   (default: 6 spread-out views)"""
import json, sys, numpy as np
c = np.load("work/cams.npz"); d = np.load("work/crop.npz"); a = json.load(open("work/align.json"))
R, origin = d["R"], d["origin"]; s, c0 = a["mm_per_unit"], np.array(a["centre_units"])
ya = np.radians(a["yaw_deg"]); Rz = np.array([[np.cos(ya), -np.sin(ya), 0], [np.sin(ya), np.cos(ya), 0], [0, 0, 1]])
to_model = lambda w: Rz @ ((R @ (w - origin) - c0) * s) - np.array([0, a["y_shift_mm"], a["z_shift_mm"]])
n = len(c["names"]); idx = [int(i) for i in sys.argv[1:]] or list(np.linspace(n * 0.05, n * 0.9, 6).astype(int))
out = []
for i in idx:
    K, Rt = c["K"][i], c["Rt"][i]; W, H = map(int, c["wh"][i]); Rc, t = Rt[:, :3], Rt[:, 3]
    ax = [Rz @ R @ Rc[k] for k in range(3)]               # camera x, y(down), z(forward) in model frame
    M = np.eye(4); M[:3, 0] = ax[0]; M[:3, 1] = -ax[1]; M[:3, 2] = -ax[2]; M[:3, 3] = to_model(-Rc.T @ t)
    out.append(dict(name=str(c["names"][i]), W=W, H=H, lens=K[0, 0] * 36 / W,
                    sx=(W / 2 - K[0, 2]) / max(W, H), sy=(K[1, 2] - H / 2) / max(W, H), M=M.tolist()))
json.dump(out, open("work/compare_cams.json", "w"), indent=1); print("frames:", [o["name"] for o in out])
