"""renders/<tag>_previews.jpg (3x2 turntable grid) and renders/<tag>_compare.jpg (photo | model-over-photo pairs).
Usage: python 08_contact_sheets.py [tag=pirate_ship_clean]"""
import glob, json, os, sys, numpy as np
from PIL import Image
from common import DATASET_IMAGES
tag = sys.argv[1] if len(sys.argv) > 1 else "pirate_ship_clean"
tiles = []
for f in sorted(glob.glob(f"renders/{tag}_preview_*.png")):
    im = Image.open(f).convert("RGBA"); bg = Image.new("RGBA", im.size, (232, 232, 232, 255)); bg.alpha_composite(im)
    tiles.append(np.array(bg.convert("RGB").resize((500, 500))))
Image.fromarray(np.concatenate([np.concatenate(tiles[:3], 1), np.concatenate(tiles[3:6], 1)], 0)).save(f"renders/{tag}_previews.jpg", quality=90)
pairs = []
for cdef in json.load(open("work/compare_cams.json")):
    stem = os.path.splitext(cdef["name"])[0]; r = Image.open(f"work/cmp_{tag}_{stem}.png"); a = np.array(r)[..., 3] > 0
    if not a.any(): continue
    ys, xs = np.nonzero(a); cy, cx = (ys.min() + ys.max()) // 2, (xs.min() + xs.max()) // 2; h = int(max(np.ptp(ys), np.ptp(xs)) * 0.65)
    ph = Image.open(os.path.join(DATASET_IMAGES, cdef["name"])).convert("RGB"); ov = ph.copy(); ov.paste(r, (0, 0), r)
    box = (cx - h, cy - h, cx + h, cy + h)
    pairs.append(np.concatenate([np.array(ph.crop(box).resize((360, 360))), np.array(ov.crop(box).resize((360, 360)))], 1))
rows = [np.concatenate(pairs[i:i + 3], 1) for i in range(0, len(pairs) - len(pairs) % 3, 3)]
Image.fromarray(np.concatenate(rows, 0)).save(f"renders/{tag}_compare.jpg", quality=90); print("wrote", f"renders/{tag}_previews.jpg", f"renders/{tag}_compare.jpg")
