"""Colour silhouettes of the (rust-orange) object in the photos, and pinhole projection."""
import numpy as np
from scipy import ndimage as ndi

def hsv(img):
    a = img.astype(np.float32) / 255; mx = a.max(2); mn = a.min(2); d = mx - mn + 1e-6
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    h = np.where(mx == r, ((g - b) / d) % 6, np.where(mx == g, (b - r) / d + 2, (r - g) / d + 4)) * 60
    return h, d / (mx + 1e-6), mx

def ship_mask(img, roi, hue_lo=345, hue_hi=40, min_sat=0.30, min_val=0.10):
    """Object pixels inside roi (bool image). Defaults = rust/orange; change the hue window for other colours."""
    h, s, v = hsv(img)
    m = ((h < hue_hi) | (h > hue_lo)) & (s > min_sat) & (v > min_val) & roi
    m = ndi.binary_closing(m, iterations=2)
    m = ndi.binary_opening(m, iterations=1) | (m & ndi.binary_erosion(m, iterations=1))
    lab, n = ndi.label(m)
    if n:
        sizes = ndi.sum(m, lab, range(1, n + 1))
        m = np.isin(lab, 1 + np.flatnonzero(sizes >= max(30, 0.02 * sizes.max())))
    return m

def project(P_world, K, Rt):
    pc = P_world @ Rt[:, :3].T + Rt[:, 3]
    uv = pc @ K.T
    return uv[:, :2] / uv[:, 2:3], pc[:, 2]
