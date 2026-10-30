"""Measure a video and save a thumbnail. Runs as its own short-lived process so the
long-running Splat Studio server never loads OpenCV or holds video frames in memory.

usage: python probe_video.py VIDEO THUMB.jpg   (prints JSON; exit 1 if unreadable)
"""
import json
import sys

import cv2

cap = cv2.VideoCapture(sys.argv[1])
n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
fps = cap.get(cv2.CAP_PROP_FPS) or 30
cap.set(cv2.CAP_PROP_POS_FRAMES, n // 3)
ok, frame = cap.read()
cap.release()
if not ok:
    sys.exit(1)
h, w = frame.shape[:2]
cv2.imwrite(sys.argv[2], cv2.resize(frame, (320, int(320 * h / w))), [cv2.IMWRITE_JPEG_QUALITY, 85])
print(json.dumps({"seconds": n / fps, "frames": n, "pixels": w * h, "width": w, "height": h}))
