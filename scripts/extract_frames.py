"""Pick the sharpest frames from a video for Gaussian Splatting.

Splits the video into N equal time windows and keeps the sharpest frame
(highest Laplacian variance) from each, so blurry moments while walking
are skipped automatically. Frames are resized so the long edge <= --max-size.

usage: python extract_frames.py VIDEO OUT_DIR [--frames 150] [--max-size 1600]
"""
import argparse
import os

import cv2


def sharpness(frame):
    small = cv2.resize(frame, (640, int(640 * frame.shape[0] / frame.shape[1])))
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    return cv2.Laplacian(gray, cv2.CV_64F).var()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("out_dir")
    ap.add_argument("--frames", type=int, default=150)
    ap.add_argument("--max-size", type=int, default=1600)
    args = ap.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)
    cap = cv2.VideoCapture(args.video)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS)
    print(f"video: {total} frames @ {fps:.1f} fps")
    window = max(1, total / args.frames)

    def save(w, frame):
        h, wd = frame.shape[:2]
        scale = args.max_size / max(h, wd)
        if scale < 1:
            frame = cv2.resize(frame, (int(wd * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
        path = os.path.join(args.out_dir, f"frame_{w:04d}.jpg")
        cv2.imwrite(path, frame, [cv2.IMWRITE_JPEG_QUALITY, 95])
        return path

    saved = []  # (score, path)
    cur_w, cur_s, cur_f = -1, -1.0, None
    idx = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        w = int(idx / window)
        if w != cur_w:
            if cur_f is not None:
                saved.append((cur_s, save(cur_w, cur_f)))
            cur_w, cur_s, cur_f = w, -1.0, None
        s = sharpness(frame)
        if s > cur_s:
            cur_s, cur_f = s, frame
        idx += 1
    if cur_f is not None:
        saved.append((cur_s, save(cur_w, cur_f)))
    cap.release()

    median = sorted(s for s, _ in saved)[len(saved) // 2]
    kept = 0
    for s, path in saved:
        if s < 0.3 * median:  # whole window was blurry; drop it
            os.remove(path)
        else:
            kept += 1
    print(f"kept {kept} frames (median sharpness {median:.0f}) -> {args.out_dir}")


if __name__ == "__main__":
    main()
