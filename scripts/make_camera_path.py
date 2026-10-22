"""Build a new fly-around camera path from the COLMAP poses.

Finds the subject (the point all the phone's views were aimed at), the "up"
direction and the typical filming distance, then writes a smooth orbit that
sweeps from high above down to a low angle - views the phone never filmed.

usage: python make_camera_path.py PROJECT_DIR [--seconds 10] [--fps 30]
       [--width 1280] [--height 720] [--elev-high 55] [--elev-low 8] [--zoom 0.8]
writes PROJECT_DIR/camera_path.json
"""
import argparse
import json
import math
import os

import numpy as np
import pycolmap


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("project")
    ap.add_argument("--seconds", type=float, default=10)
    ap.add_argument("--fps", type=float, default=30)
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--height", type=int, default=720)
    ap.add_argument("--fov", type=float, default=50)
    ap.add_argument("--elev-high", type=float, default=55, help="degrees above the table at the start")
    ap.add_argument("--elev-low", type=float, default=15, help="degrees above the table halfway round")
    ap.add_argument("--zoom", type=float, default=0.8, help="orbit radius as a fraction of filming distance")
    args = ap.parse_args()

    rec = pycolmap.Reconstruction(os.path.join(args.project, "dataset", "sparse", "0"))
    centers, dirs, ups = [], [], []
    for img in rec.images.values():
        R = img.cam_from_world().rotation.matrix()
        t = img.cam_from_world().translation
        centers.append(-R.T @ t)
        dirs.append(R.T @ np.array([0, 0, 1.0]))
        ups.append(R.T @ np.array([0, -1.0, 0]))
    C, D = np.array(centers), np.array(dirs)

    # point closest (least squares) to every camera's line of sight = the subject
    A, b = np.zeros((3, 3)), np.zeros(3)
    for c, d in zip(C, D):
        P = np.eye(3) - np.outer(d, d)
        A += P
        b += P @ c
    target = np.linalg.solve(A, b)

    offs = C - target
    dist = np.median(np.linalg.norm(offs, axis=1))

    # "up": normal of the surface the subject sits on (RANSAC plane through the
    # sparse points near the subject), so the horizon stays level
    pts = np.array([p.xyz for p in rec.points3D.values()])
    pts = pts[np.linalg.norm(pts - target, axis=1) < 1.5 * dist]
    rng = np.random.default_rng(0)
    best_n, best_count = None, 0
    for _ in range(1000):
        a, b2, c = pts[rng.choice(len(pts), 3, replace=False)]
        nrm = np.cross(b2 - a, c - a)
        if np.linalg.norm(nrm) < 1e-9:
            continue
        nrm /= np.linalg.norm(nrm)
        count = np.sum(np.abs((pts - a) @ nrm) < 0.01 * dist)
        if count > best_count:
            best_n, best_count = nrm, count
    phone_up = np.mean(ups, 0)
    up = best_n if best_n @ phone_up > 0 else -best_n
    if abs(up @ phone_up / np.linalg.norm(phone_up)) < 0.5:
        # plane fit found something odd (e.g. a wall); fall back to the camera-motion plane
        _, _, vt = np.linalg.svd(C - C.mean(0))
        up = vt[2] if vt[2] @ phone_up > 0 else -vt[2]
    print(f"table plane: {best_count}/{len(pts)} points, agreement with phone-up {up @ phone_up / np.linalg.norm(phone_up):.2f}")
    height = offs @ up
    elev_capture = math.degrees(math.asin(np.median(height / np.linalg.norm(offs, axis=1))))
    # the table plane sits below the subject; measure elevation from the camera-plane normal
    e1 = offs[0] - (offs[0] @ up) * up
    e1 /= np.linalg.norm(e1)
    e2 = np.cross(up, e1)

    n = int(args.seconds * args.fps)
    frames = []
    for i in range(n):
        s = i / n
        az = 2 * math.pi * s
        elev = math.radians(args.elev_low + (args.elev_high - args.elev_low) * (0.5 + 0.5 * math.cos(az)))
        r = dist * args.zoom * (1 - 0.15 * math.sin(az) ** 2)
        horiz = math.cos(az) * e1 + math.sin(az) * e2
        pos = target + r * (math.cos(elev) * horiz + math.sin(elev) * up)
        frames.append({"pos": pos.tolist(), "look": target.tolist()})

    out = {"width": args.width, "height": args.height, "fov": args.fov, "fps": args.fps,
           "up": up.tolist(), "target": target.tolist(), "frames": frames}
    path = os.path.join(args.project, "camera_path.json")
    with open(path, "w") as f:
        json.dump(out, f)
    print(f"{len(rec.images)} cams, filming distance {dist:.2f}, capture elevation {elev_capture:.0f} deg")
    print(f"wrote {n} poses -> {path}")


if __name__ == "__main__":
    main()
