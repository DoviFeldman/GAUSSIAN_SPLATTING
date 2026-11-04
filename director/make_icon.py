"""Draw the Splat Director icon: Splat Studio's soft splats with a camera path and keyframes over them.

usage: python make_icon.py OUT.png   (1024x1024 RGBA)
"""
import sys

import cv2
import numpy as np

S = 1024
yy, xx = np.mgrid[0:S, 0:S].astype(np.float32) / S

bg = np.zeros((S, S, 3), np.float32)
bg[:] = np.array([0.07, 0.065, 0.075])
bg += (1 - yy[..., None]) * np.array([0.045, 0.04, 0.05])
r, m = 0.2, 0.06  # corner radius, margin (fractions of the size)
dx = np.maximum(np.abs(xx - 0.5) - (0.5 - m - r), 0)
dy = np.maximum(np.abs(yy - 0.5) - (0.5 - m - r), 0)
alpha = np.clip((r - np.sqrt(dx * dx + dy * dy)) * S / 2.0, 0, 1)

# dim splats in the background (x, y, sx, sy, angle, color BGR, strength)
blobs = [
    (0.50, 0.55, 0.22, 0.14, -20, (0.75, 0.55, 0.30), 0.55),
    (0.36, 0.64, 0.12, 0.07, 30, (0.55, 0.80, 0.35), 0.45),
    (0.66, 0.66, 0.11, 0.06, -50, (0.90, 0.45, 0.65), 0.45),
    (0.58, 0.40, 0.08, 0.05, 15, (0.55, 0.75, 0.95), 0.40),
]
img = bg.copy()
for x, y, sx, sy, ang, col, k in blobs:
    a = np.deg2rad(ang)
    u = (xx - x) * np.cos(a) + (yy - y) * np.sin(a)
    v = -(xx - x) * np.sin(a) + (yy - y) * np.cos(a)
    sx, sy = sx * 1.5, sy * 1.5
    g = np.exp(-0.5 * ((u / (sx / 2.4)) ** 2 + (v / (sy / 2.4)) ** 2) ** 1.6) * k
    img = img * (1 - g[..., None] * 0.85) + np.array(col) * g[..., None]
img = np.clip(img, 0, 1)
out = (img * 255).astype(np.uint8).copy()

# the camera path: a Bezier sweep in Resolve orange, with keyframe diamonds
t = np.linspace(0, 1, 400)[:, None]
P = np.array([[0.17, 0.72], [0.30, 0.18], [0.72, 0.95], [0.84, 0.30]]) * S
curve = ((1 - t) ** 3 * P[0] + 3 * (1 - t) ** 2 * t * P[1] + 3 * (1 - t) * t * t * P[2] + t ** 3 * P[3]).astype(np.int32)
orange = (58, 129, 232)  # BGR of #e8813a
cv2.polylines(out, [curve], False, (20, 20, 24), 46, cv2.LINE_AA)
cv2.polylines(out, [curve], False, orange, 26, cv2.LINE_AA)
for f in (0.0, 0.38, 0.7, 1.0):
    i = int(f * (len(curve) - 1))
    cx, cy = curve[i]
    d = 44
    pts = np.array([[cx, cy - d], [cx + d, cy], [cx, cy + d], [cx - d, cy]], np.int32)
    cv2.fillConvexPoly(out, pts, (20, 20, 24), cv2.LINE_AA)
    d = 30
    pts = np.array([[cx, cy - d], [cx + d, cy], [cx, cy + d], [cx - d, cy]], np.int32)
    cv2.fillConvexPoly(out, pts, (74, 207, 255), cv2.LINE_AA)  # keyframe yellow

cv2.imwrite(sys.argv[1], np.dstack([out, (alpha * 255).astype(np.uint8)]))
