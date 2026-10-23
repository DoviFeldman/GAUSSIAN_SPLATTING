"""Draw the Splat Studio icon (soft Gaussian blobs on a dark rounded square).

usage: python make_icon.py OUT.png   (1024x1024 RGBA)
"""
import sys

import cv2
import numpy as np

S = 1024
yy, xx = np.mgrid[0:S, 0:S].astype(np.float32) / S

# dark rounded-square background with a subtle vertical gradient
bg = np.zeros((S, S, 3), np.float32)
bg[:] = np.array([0.075, 0.07, 0.09])
bg += (1 - yy[..., None]) * np.array([0.05, 0.045, 0.06])
r, m = 0.2, 0.06  # corner radius, margin (fractions of the size)
dx = np.maximum(np.abs(xx - 0.5) - (0.5 - m - r), 0)
dy = np.maximum(np.abs(yy - 0.5) - (0.5 - m - r), 0)
alpha = np.clip((r - np.sqrt(dx * dx + dy * dy)) * S / 2.0, 0, 1)

# anisotropic gaussian "splats": (x, y, sx, sy, angle, color BGR, strength)
blobs = [
    (0.50, 0.47, 0.20, 0.13, -25, (0.24, 0.54, 1.00), 1.00),  # orange
    (0.37, 0.60, 0.12, 0.07, 30, (0.55, 0.85, 0.30), 0.85),  # teal
    (0.63, 0.62, 0.11, 0.065, -55, (0.95, 0.45, 0.70), 0.85),  # violet
    (0.58, 0.33, 0.08, 0.05, 15, (0.45, 0.80, 1.00), 0.75),  # warm yellow
    (0.33, 0.38, 0.06, 0.04, 70, (1.00, 0.70, 0.40), 0.60),  # sky blue
    (0.70, 0.45, 0.05, 0.03, 40, (0.50, 0.65, 1.00), 0.55),
    (0.46, 0.72, 0.05, 0.03, -10, (0.35, 0.60, 1.00), 0.55),
]
img = bg.copy()
for x, y, sx, sy, ang, col, k in blobs:
    a = np.deg2rad(ang)
    u = (xx - x) * np.cos(a) + (yy - y) * np.sin(a)
    v = -(xx - x) * np.sin(a) + (yy - y) * np.cos(a)
    sx, sy = sx * 1.5, sy * 1.5
    g = np.exp(-0.5 * ((u / (sx / 2.4)) ** 2 + (v / (sy / 2.4)) ** 2) ** 1.6) * k  # flatter top = bolder blob
    img = img * (1 - g[..., None] * 0.85) + np.array(col) * g[..., None]
img = np.clip(img, 0, 1)

out = np.dstack([img * 255, alpha * 255]).astype(np.uint8)
cv2.imwrite(sys.argv[1], out)
