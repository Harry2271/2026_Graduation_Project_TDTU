"""camera_stream — MJPEG stream server using ffmpeg + V4L2.

Reads frames from the Logitech BRIO 100 via ffmpeg (zero Python deps —
ffmpeg is pre-installed on Ubuntu and handles all V4L2 complexity). The
camera outputs MJPEG natively so encoding is near-free.

Endpoints:
  GET /         — health check (JSON)
  GET /stream   — multipart/x-mixed-replace MJPEG stream
  GET /snapshot — single JPEG frame

Environment variables:
  CAMERA_DEVICE  — V4L2 device path (default: /dev/video0)
  CAMERA_WIDTH   — capture width  (default: 640)
  CAMERA_HEIGHT  — capture height (default: 480)
  CAMERA_FPS     — target FPS     (default: 15)
  CAMERA_QUALITY — JPEG quality 1-31 (default: 5, lower = better)
  CAMERA_PORT    — HTTP port      (default: 9092)
"""
from __future__ import annotations

import json
import logging
import os
import select
import signal
import subprocess
import struct
import threading
import time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from typing import Optional

logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] %(levelname)s %(message)s',
    datefmt='%H:%M:%S',
)
logger = logging.getLogger('camera_stream')

# ── Configuration ──────────────────────────────────────────────────────────────
DEVICE = os.environ.get('CAMERA_DEVICE', '/dev/video0')
WIDTH = int(os.environ.get('CAMERA_WIDTH', '1280'))
HEIGHT = int(os.environ.get('CAMERA_HEIGHT', '720'))
FPS = int(os.environ.get('CAMERA_FPS', '30'))
QUALITY = int(os.environ.get('CAMERA_QUALITY', '2'))
PORT = int(os.environ.get('CAMERA_PORT', '9092'))

# ── Thread-safe frame buffer ───────────────────────────────────────────────────
_lock = threading.Lock()
_latest_frame: Optional[bytes] = None
_capture_ok = False
_actual_width = 0
_actual_height = 0

# JPEG markers
_JPG_SOI = b'\xff\xd8'
_JPG_EOI = b'\xff\xd9'


def _extract_jpeg(data: bytes) -> list[bytes]:
    """Extract complete JPEG frames from an MJPEG byte stream."""
    frames = []
    start = 0
    while True:
        # Find SOI (Start Of Image)
        soi_pos = data.find(_JPG_SOI, start)
        if soi_pos == -1:
            break
        # Find EOI (End Of Image)
        eoi_pos = data.find(_JPG_EOI, soi_pos + 2)
        if eoi_pos == -1:
            break
        frames.append(data[soi_pos:eoi_pos + 2])
        start = eoi_pos + 2
    return frames


def _capture_loop() -> None:
    """Background thread: run ffmpeg and extract JPEG frames from its stdout."""
    global _latest_frame, _capture_ok, _actual_width, _actual_height

    while True:
        try:
            _run_capture()
        except Exception as e:
            _capture_ok = False
            logger.warning('Capture error: %s — retrying in 3s', e)
            time.sleep(3)


def _run_capture() -> None:
    global _latest_frame, _capture_ok, _actual_width, _actual_height

    cmd = [
        'ffmpeg',
        '-hide_banner', '-loglevel', 'warning',
        '-f', 'v4l2',
        '-input_format', 'mjpeg',
        '-video_size', f'{WIDTH}x{HEIGHT}',
        '-framerate', str(FPS),
        '-i', DEVICE,
        '-f', 'mjpeg',
        '-q:v', str(QUALITY),
        '-r', str(FPS),
        'pipe:1',
    ]

    logger.info('Starting: %s', ' '.join(cmd))
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=0,
    )

    _capture_ok = True
    _actual_width = WIDTH
    _actual_height = HEIGHT
    logger.info('Streaming from %s @ %dx%d %d fps', DEVICE, WIDTH, HEIGHT, FPS)

    try:
        # Read ffmpeg's stdout in chunks and extract JPEG frames
        buf = b''
        while True:
            # Use select to avoid blocking (allows clean shutdown via SIGTERM)
            if proc.stdout is None:
                break
            ready, _, _ = select.select([proc.stdout], [], [], 1.0)
            if not ready:
                continue

            chunk = os.read(proc.stdout.fileno(), 65536)
            if not chunk:
                break  # ffmpeg exited

            buf += chunk
            frames = _extract_jpeg(buf)
            if frames:
                # Keep only the latest complete frame(s)
                with _lock:
                    _latest_frame = frames[-1]
                # Discard everything up to the last frame's end
                last_frame_end = buf.rfind(_JPG_EOI) + 2
                buf = buf[last_frame_end:]
    finally:
        _capture_ok = False
        try:
            proc.terminate()
            proc.wait(timeout=3)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        logger.info('Capture stopped, retrying in 2s...')
        time.sleep(2)


def _get_frame() -> Optional[bytes]:
    # Never serve a cached frame after ffmpeg has stopped. Serving the last
    # JPEG would let AprilTag keep refreshing a false-positive tag timestamp.
    with _lock:
        if not _capture_ok:
            return None
        return _latest_frame


# ── HTTP Handlers ──────────────────────────────────────────────────────────────

class CameraHandler(BaseHTTPRequestHandler):

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Access-Control-Max-Age', '86400')
        self.end_headers()

    def do_GET(self) -> None:
        if self.path == '/':
            self._handle_health()
        elif self.path == '/stream':
            self._handle_stream()
        elif self.path == '/snapshot':
            self._handle_snapshot()
        else:
            self.send_error(404)

    def _handle_health(self) -> None:
        frame = _get_frame()
        body = json.dumps({
            'status': 'ok' if _capture_ok else 'error',
            'camera': _capture_ok,
            'device': DEVICE,
            'resolution': f'{_actual_width}x{_actual_height}',
            'fps': FPS,
            'port': PORT,
            'has_frame': frame is not None and len(frame) > 0,
            'frame_size': len(frame) if frame else 0,
        }).encode()

        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.end_headers()
        self.wfile.write(body)

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
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.end_headers()

        try:
            while True:
                frame = _get_frame()
                if frame is None or len(frame) == 0:
                    time.sleep(0.1)
                    continue

                self.wfile.write(b'--frame\r\n')
                self.wfile.write(b'Content-Type: image/jpeg\r\n')
                self.wfile.write(f'Content-Length: {len(frame)}\r\n'.encode())
                self.wfile.write(b'\r\n')
                self.wfile.write(frame)
                self.wfile.write(b'\r\n')
                self.wfile.flush()

                time.sleep(1.0 / FPS)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _handle_snapshot(self) -> None:
        frame = _get_frame()
        if frame is None or len(frame) == 0:
            self.send_error(503, 'No frame available')
            return

        self.send_response(200)
        self.send_header('Content-Type', 'image/jpeg')
        self.send_header('Content-Length', str(len(frame)))
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.end_headers()
        self.wfile.write(frame)

    def log_message(self, fmt: str, *args: object) -> None:
        pass


# ── Entry point ────────────────────────────────────────────────────────────────

def main() -> None:
    t = threading.Thread(target=_capture_loop, daemon=True, name='capture')
    t.start()

    server = ThreadingHTTPServer(('0.0.0.0', PORT), CameraHandler)
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
