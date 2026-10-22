"""Tiny local server for the splat viewer.

Serves the repo folder over http://localhost:PORT and accepts recorded
frames from the viewer (POST /frame?i=N), encoding them to an mp4 on POST /done.

usage: python serve.py [--port 8765] [--frames-dir DIR --video OUT.mp4 --fps 30]
"""
import argparse
import glob
import http.server
import os
import urllib.parse

import cv2
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # repo root


def encode(frames_dir, video, fps):
    files = sorted(glob.glob(os.path.join(frames_dir, "*.png")))
    h, w = cv2.imread(files[0]).shape[:2]
    for codec in ("avc1", "mp4v"):  # H.264 if this OpenCV build has it
        out = cv2.VideoWriter(video, cv2.VideoWriter_fourcc(*codec), fps, (w, h))
        if out.isOpened():
            break
    for f in files:
        out.write(cv2.imread(f))
    out.release()
    return f"{len(files)} frames -> {video} ({codec})"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--frames-dir")
    ap.add_argument("--video")
    ap.add_argument("--fps", type=float, default=30)
    args = ap.parse_args()

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=ROOT, **kw)

        def log_message(self, *a):
            pass

        def reply(self, text):
            body = text.encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            url = urllib.parse.urlparse(self.path)
            data = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            if url.path == "/frame":
                i = int(urllib.parse.parse_qs(url.query)["i"][0])
                os.makedirs(args.frames_dir, exist_ok=True)
                img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
                cv2.imwrite(os.path.join(args.frames_dir, f"{i:05d}.png"), img)
                self.reply("ok")
            elif url.path == "/done":
                msg = encode(args.frames_dir, args.video, args.fps)
                print(msg, flush=True)
                self.reply(msg)
            else:
                self.send_error(404)

    print(f"serving {ROOT} on http://localhost:{args.port}", flush=True)
    http.server.ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
