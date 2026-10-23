"""Turn the visual hull into print-scale measurements for hand-modelling.
Scales to LENGTH_MM, squares the hull up (yaw search), centres it, prints station / mast / sail tables and
saves work/scan_aligned.npy (points, mm) + work/align.json (scan -> model transform, used for photo comparisons).
Usage: python 04_measure_scan.py [LENGTH_MM=90]"""
import json, sys, numpy as np
LENGTH_MM = float(sys.argv[1]) if len(sys.argv) > 1 else 90.0
o = np.load("work/occ.npz"); occ = o["occ"] & (o["dist"] < 0.06); lo, vox = o["lo"], float(o["vox"])
occ[:, :, :3] = False                                   # table-contact noise
local = lo + (np.argwhere(occ) + 0.5) * vox             # scan local units (z = table normal, z=0 = table)
s = LENGTH_MM / np.ptp(local[:, 0])                      # mm per scan unit (x = long axis after 01_crop_splat)
c0 = np.array([(local[:, 0].min() + local[:, 0].max()) / 2, (local[:, 1].min() + local[:, 1].max()) / 2, 0.0])
P = (local - c0) * s

def rz(a):
    a = np.radians(a); return np.array([[np.cos(a), -np.sin(a), 0], [np.sin(a), np.cos(a), 0], [0, 0, 1]])
best = None
for a in np.arange(-25, 25.01, 0.5):                     # yaw that makes the hull's centre line straight
    Q = P @ rz(a).T; h = Q[(Q[:, 2] > 3) & (Q[:, 2] < 18)]
    xs = np.linspace(np.percentile(h[:, 0], 15), np.percentile(h[:, 0], 85), 12)
    cs = [(lambda t: (t.min() + t.max()) / 2)(h[np.abs(h[:, 0] - x) < 1.5, 1]) for x in xs]
    best = min(best or (1e9, 0, 0), (np.std(cs), a, np.mean(cs)))
_, yaw, yc = best
Q = P @ rz(yaw).T; Q[:, 1] -= yc; zs = Q[:, 2].min(); Q[:, 2] -= zs; X, Y, Z = Q.T     # trimmed base -> z=0
np.save("work/scan_aligned.npy", Q.astype(np.float32))
json.dump(dict(mm_per_unit=s, centre_units=c0.tolist(), yaw_deg=yaw, y_shift_mm=yc, z_shift_mm=zs, length_mm=LENGTH_MM), open("work/align.json", "w"), indent=1)
print(f"yaw {yaw} deg, y shift {yc:.2f} mm; bounds mm {Q.min(0).round(1)} {Q.max(0).round(1)}")
print("NOTE: the visual hull runs ~1-2 mm fat, fills the deck/concave pockets and is too full under the hull.")
print("\nHULL STATIONS  x | keel z | top z of walls (|y|>8) | half-width at z=3,8,14,20,26")
for x in np.arange(np.floor(X.min() / 4) * 4, X.max() + 4, 4):
    t = Q[np.abs(X - x) < 1]
    if not len(t): continue
    w = t[np.abs(t[:, 1]) > 8]; hw = []
    for z in (3, 8, 14, 20, 26):
        u = t[np.abs(t[:, 2] - z) < 0.8]; hw.append(f"{np.abs(u[:, 1]).max():4.1f}" if len(u) else "  - ")
    print(f"{x:5.0f} | {t[:, 2].min():5.1f} | {w[:, 2].max() if len(w) else float('nan'):5.1f} | " + " ".join(hw))
print("\nVERTICAL PROFILE above z=20 (find masts/sails/nests: narrow y = mast, wide y = sail)")
print("   z | x-range of occupied | y-range")
for z in range(20, int(Z.max()) + 1, 3):
    t = Q[np.abs(Z - z) < 0.8]
    if len(t): print(f"{z:4d} | {t[:, 0].min():6.1f} {t[:, 0].max():6.1f} | {t[:, 1].min():6.1f} {t[:, 1].max():6.1f}")
print("\nTip: slice per mast with an x window, e.g. Q[(X>-28)&(X<2)], to get each sail's z range and widths;")
print("sail yaw = PCA of the sail's (x,y) points in its z band.")
