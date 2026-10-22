"""Convert a trained splat .ply into the compact .splat format for sharing.

.splat = 32 bytes per splat (position, scale, color+opacity, rotation); it drops
the view-dependent color terms, so it's ~7x smaller than the .ply but looks
nearly the same. Nearly-invisible splats are dropped too.

usage: python ply_to_splat.py IN.ply OUT.splat [--min-opacity 0.02]
"""
import argparse

import numpy as np

SH_C0 = 0.28209479177387814


def read_ply(path):
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ply")
    ap.add_argument("out")
    ap.add_argument("--min-opacity", type=float, default=0.02)
    args = ap.parse_args()

    v = read_ply(args.ply)
    alpha = 1 / (1 + np.exp(-v["opacity"]))
    scale = np.exp(np.stack([v["scale_0"], v["scale_1"], v["scale_2"]], 1))
    keep = alpha >= args.min_opacity
    order = np.argsort(-(alpha * scale.prod(1))[keep])  # most important first
    idx = np.nonzero(keep)[0][order]

    rgb = 0.5 + SH_C0 * np.stack([v["f_dc_0"], v["f_dc_1"], v["f_dc_2"]], 1)
    rgba = np.clip(np.hstack([rgb, alpha[:, None]]) * 255, 0, 255).astype(np.uint8)
    q = np.stack([v["rot_0"], v["rot_1"], v["rot_2"], v["rot_3"]], 1)
    q /= np.linalg.norm(q, axis=1, keepdims=True)
    rot = np.clip(q * 128 + 128, 0, 255).astype(np.uint8)
    pos = np.stack([v["x"], v["y"], v["z"]], 1).astype(np.float32)

    rec = np.zeros(len(idx), dtype=[("pos", "<f4", 3), ("scale", "<f4", 3), ("rgba", "u1", 4), ("rot", "u1", 4)])
    rec["pos"], rec["scale"], rec["rgba"], rec["rot"] = pos[idx], scale[idx], rgba[idx], rot[idx]
    rec.tofile(args.out)
    print(f"{len(idx)}/{len(alpha)} splats -> {args.out} ({rec.nbytes / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
