"""camera_stream — standalone MJPEG stream server for the Logitech BRIO 100.

Reads frames from a V4L2 device (USB camera) using OpenCV and serves them as
an MJPEG multipart stream over HTTP on port 9092.

Endpoints:
  GET /         — health check (JSON)
  GET /stream   — multipart/x-mixed-replace MJPEG stream
  GET /snapshot — single JPEG frame

Environment variables:
  CAMERA_DEVICE  — V4L2 device path (default: /dev/video0)
  CAMERA_WIDTH   — capture width  (default: 640)
  CAMERA_HEIGHT  — capture height (default: 480)
  CAMERA_FPS     — target FPS     (default: 15)
  CAMERA_QUALITY — JPEG quality 1-100 (default: 80)
  CAMERA_PORT    — HTTP port      (default: 9092)
"""
from __future__ import annotations

import json
import logging
import os
import signal
import sys
import threading
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from typing import Optional

import cv2
import numpy as np

logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] %(levelname)s %(message)s',
    datefmt='%H:%M:%S',
)
logger = logging.getLogger('camera_stream')

# ── Configuration ──────────────────────────────────────────────────────────────
DEVICE = os.environ.get('CAMERA_DEVICE', '/dev/video0')
WIDTH = int(os.environ.get('CAMERA_WIDTH', '640'))
HEIGHT = int(os.environ.get('CAMERA_HEIGHT', '480'))
FPS = int(os.environ.get('CAMERA_FPS', '15'))
QUALITY = int(os.environ.get('CAMERA_QUALITY', '80'))
PORT = int(os.environ.get('CAMERA_PORT', '9092'))

JPEG_PARAMS = [cv2.IMWRITE_JPEG_QUALITY, QUALITY]

# ── Thread-safe frame buffer ───────────────────────────────────────────────────
_lock = threading.Lock()
_latest_frame: Optional[bytes] = None
_capture_ok = False


def _capture_loop() -> None:
    """Background thread: read frames from V4L2 and encode to JPEG."""
    global _latest_frame, _capture_ok

    while True:
        cap = cv2.VideoCapture(DEVICE)
        if not cap.isOpened():
            logger.warning('Cannot open %s — retrying in 3s...', DEVICE)
            _capture_ok = False
            time.sleep(3)
            continue

        cap.set(cv2.CAP_PROP_FRAME_WIDTH, WIDTH)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, HEIGHT)
        cap.set(cv2.CAP_PROP_FPS, FPS)

        actual_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        actual_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        logger.info(
            'Camera opened: %s %dx%d (target %dx%d @ %d fps)',
            DEVICE, actual_w, actual_h, WIDTH, HEIGHT, FPS,
        )
        _capture_ok = True

        try:
            while True:
                ret, frame = cap.read()
                if not ret:
                    logger.warning('Frame read failed — reopening camera')
                    break
                ok, buf = cv2.imencode('.jpg', frame, JPEG_PARAMS)
                if ok:
                    with _lock:
                        _latest_frame = buf.tobytes()
        finally:
            cap.release()
            _capture_ok = False
            logger.info('Camera released, will retry in 2s...')
            time.sleep(2)


def _get_frame() -> Optional[bytes]:
    with _lock:
        return _latest_frame


# ── HTTP Handlers ──────────────────────────────────────────────────────────────

class CameraHandler(BaseHTTPRequestHandler):
    """Handles /, /stream, /snapshot."""

    def do_GET(self) -> None:
        if self.path == '/':
            self._handle_health()
        elif self.path == '/stream':
            self._handle_stream()
        elif self.path == '/snapshot':
            self._handle_snapshot()
        else:
            self.send_error(404)

    # ── Health ──────────────────────────────────────────────────────────────

    def _handle_health(self) -> None:
        frame = _get_frame()
        body = json.dumps({
            'status': 'ok' if _capture_ok else 'error',
            'camera': _capture_ok,
            'device': DEVICE,
            'resolution': f'{WIDTH}x{HEIGHT}',
            'fps': FPS,
            'quality': QUALITY,
            'port': PORT,
            'has_frame': frame is not None,
        }).encode()

        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    # ── MJPEG Stream ───────────────────────────────────────────────────────

    def _handle_stream(self) -> None:
        self.send_response(200)
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        self.send_header('Connection', 'close')
        self.send_header(
            'Content-Type',
            'multipart/x-mixed-replace; boundary=frame',
        )
        self.end_headers()

        try:
            while True:
                frame = _get_frame()
                if frame is None:
                    time.sleep(0.1)
                    continue

                self.wfile.write(b'--frame\r\n')
                self.wfile.write(b'Content-Type: image/jpeg\r\n')
                self.wfile.write(f'Content-Length: {len(frame)}\r\n'.encode())
                self.wfile.write(b'\r\n')
                self.wfile.write(frame)
                self.wfile.write(b'\r\n')
                self.wfile.flush()

                # Throttle to target FPS
                time.sleep(1.0 / FPS)
        except (BrokenPipeError, ConnectionResetError):
            pass  # client disconnected

    # ── Snapshot ────────────────────────────────────────────────────────────

    def _handle_snapshot(self) -> None:
        frame = _get_frame()
        if frame is None:
            self.send_error(503, 'No frame available')
            return

        self.send_response(200)
        self.send_header('Content-Type', 'image/jpeg')
        self.send_header('Content-Length', str(len(frame)))
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(frame)

    def log_message(self, fmt: str, *args: object) -> None:
        # Suppress default stderr logging for every request
        pass


# ── Entry point ────────────────────────────────────────────────────────────────

def main() -> None:
    # Start capture thread (daemon so it dies with the process)
    t = threading.Thread(target=_capture_loop, daemon=True, name='capture')
    t.start()

    server = HTTPServer(('0.0.0.0', PORT), CameraHandler)
    logger.info('Camera stream server listening on http://0.0.0.0:%d', PORT)

    def _shutdown(signum: int, _frame: object) -> None:
        logger.info('Signal %d received — shutting down', signum)
        threading.Thread(target=server.shutdown).start()

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        logger.info('Camera stream server stopped')
        server.server_close()


if __name__ == '__main__':
    main()
