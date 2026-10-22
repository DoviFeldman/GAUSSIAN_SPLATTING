"""Solve camera positions for a folder of frames with COLMAP (via pycolmap).

Produces a Brush-ready dataset:  PROJECT/dataset/{images, sparse/0}
(undistorted, PINHOLE cameras).

usage: python run_colmap.py PROJECT_DIR      (expects PROJECT_DIR/images/*.jpg)
"""
import os
import shutil
import sys
import time

import pycolmap


def main():
    proj = os.path.abspath(sys.argv[1])
    images = os.path.join(proj, "images")
    work = os.path.join(proj, "colmap")
    db = os.path.join(work, "database.db")
    sparse = os.path.join(work, "sparse")
    dataset = os.path.join(proj, "dataset")
    for d in (work, dataset):
        shutil.rmtree(d, ignore_errors=True)
    os.makedirs(sparse)

    t = time.time()
    reader = pycolmap.ImageReaderOptions()
    reader.camera_model = "OPENCV"  # phone lens: focal + mild distortion
    pycolmap.extract_features(db, images, camera_mode=pycolmap.CameraMode.SINGLE, reader_options=reader)
    print(f"features done {time.time() - t:.0f}s", flush=True)

    # Exhaustive is fine for a few hundred frames and catches the loop closure
    # when the walk-around returns to the start.
    pycolmap.match_exhaustive(db)
    print(f"matching done {time.time() - t:.0f}s", flush=True)

    recs = pycolmap.incremental_mapping(db, images, sparse)
    if not recs:
        sys.exit("COLMAP could not reconstruct any cameras")
    best_id, best = max(recs.items(), key=lambda kv: kv[1].num_reg_images())
    n_img = len(os.listdir(images))
    print(f"mapping done {time.time() - t:.0f}s: {len(recs)} model(s); best has "
          f"{best.num_reg_images()}/{n_img} images, {best.num_points3D()} points", flush=True)

    pycolmap.undistort_images(dataset, os.path.join(sparse, str(best_id)), images)
    # Brush (like most splat trainers) expects sparse/0
    os.makedirs(os.path.join(dataset, "sparse", "0"), exist_ok=True)
    for f in os.listdir(os.path.join(dataset, "sparse")):
        src = os.path.join(dataset, "sparse", f)
        if os.path.isfile(src):
            shutil.move(src, os.path.join(dataset, "sparse", "0", f))
    print(f"dataset ready -> {dataset}  ({time.time() - t:.0f}s total)")


if __name__ == "__main__":
    main()
