#!/usr/bin/env python3
"""auto_capture_training_data.py — grab camera frames for YOLO labelling.

Pulls JPEG snapshots from the robot camera service and saves them to disk so
you can build a custom dataset (see docs/YOLOV8_CUSTOM_TRAINING.md).  Optional
frame-difference gating skips near-duplicate frames so a stationary robot does
not fill the disk with identical images.

Examples
--------
  # 1 frame/sec into ./dataset/raw for 5 minutes
  python3 auto_capture_training_data.py --out dataset/raw --interval 1 --max 300

  # only save when the scene changes noticeably
  python3 auto_capture_training_data.py --out dataset/raw --min-diff 8
"""
from __future__ import annotations

import argparse
import os
import time
import urllib.request

try:
    import cv2
    import numpy as np
    _HAVE_CV = True
except Exception:  # noqa: BLE001
    _HAVE_CV = False


def fetch(url: str, timeout: float = 2.0):
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return resp.read()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--url', default='http://127.0.0.1:9092/snapshot')
    ap.add_argument('--out', default='dataset/raw', help='output directory')
    ap.add_argument('--interval', type=float, default=1.0, help='seconds between grabs')
    ap.add_argument('--max', type=int, default=0, help='stop after N frames (0 = infinite)')
    ap.add_argument('--min-diff', type=float, default=0.0,
                    help='skip frames whose mean abs diff vs last kept frame is below this (0 = keep all; needs OpenCV)')
    ap.add_argument('--prefix', default='cap', help='filename prefix')
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    if args.min_diff > 0 and not _HAVE_CV:
        print('⚠️  --min-diff needs OpenCV/NumPy; keeping all frames instead.')

    saved = 0
    last_gray = None
    print(f'Capturing from {args.url} → {args.out} (Ctrl-C to stop)')
    try:
        while args.max == 0 or saved < args.max:
            t0 = time.time()
            try:
                buf = fetch(args.url)
            except Exception as exc:  # noqa: BLE001
                print(f'  fetch failed: {exc}; retrying...')
                time.sleep(args.interval)
                continue

            keep = True
            if args.min_diff > 0 and _HAVE_CV:
                arr = np.frombuffer(buf, dtype=np.uint8)
                img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
                gray = cv2.cvtColor(cv2.resize(img, (160, 120)), cv2.COLOR_BGR2GRAY)
                if last_gray is not None:
                    diff = float(np.mean(cv2.absdiff(gray, last_gray)))
                    keep = diff >= args.min_diff
                if keep:
                    last_gray = gray

            if keep:
                fname = os.path.join(
                    args.out, f'{args.prefix}_{int(time.time()*1000)}.jpg')
                with open(fname, 'wb') as fh:
                    fh.write(buf)
                saved += 1
                if saved % 10 == 0:
                    print(f'  saved {saved} frames')

            dt = time.time() - t0
            time.sleep(max(0.0, args.interval - dt))
    except KeyboardInterrupt:
        pass
    print(f'Done. Saved {saved} frames to {args.out}')


if __name__ == '__main__':
    main()
