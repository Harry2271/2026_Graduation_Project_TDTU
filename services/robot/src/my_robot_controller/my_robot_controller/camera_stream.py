"""camera_stream — zero-dependency MJPEG stream server for the Logitech BRIO 100.

Captures MJPEG frames directly from a V4L2 device — no OpenCV, no NumPy,
no external dependencies. The BRIO 100 natively outputs MJPEG so the frames
are grabbed as-is without re-encoding (zero CPU overhead for encoding).

Endpoints:
  GET /         — health check (JSON)
  GET /stream   — multipart/x-mixed-replace MJPEG stream
  GET /snapshot — single JPEG frame

Environment variables:
  CAMERA_DEVICE  — V4L2 device path (default: /dev/video0)
  CAMERA_WIDTH   — capture width  (default: 640)
  CAMERA_HEIGHT  — capture height (default: 480)
  CAMERA_FPS     — target FPS     (default: 15)
  CAMERA_QUALITY — JPEG quality 1-100 (default: 80, used for resolution selection)
  CAMERA_PORT    — HTTP port      (default: 9092)
"""
from __future__ import annotations

import ctypes
import ctypes.util
import fcntl
import json
import logging
import mmap
import os
import signal
import struct
import sys
import threading
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from typing import Optional

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
PORT = int(os.environ.get('CAMERA_PORT', '9092'))

# ── V4L2 constants ─────────────────────────────────────────────────────────────
_VIDIOC_QUERYCAP = 0x80685600
_VIDIOC_S_FMT = 0xC0CC5605
_VIDIOC_G_FMT = 0xC0CC5604
_VIDIOC_REQBUFS = 0xC0145608
_VIDIOC_QUERYBUF = 0xC0445609
_VIDIOC_QBUF = 0x4044560F
_VIDIOC_DQBUF = 0xC0445611
_VIDIOC_STREAMON = 0x40045612
_VIDIOC_STREAMOFF = 0x40045613
_VIDIOC_ENUM_FMT = 0xC0405602
_VIDIOC_ENUM_FRAMESIZES = 0xC02C564A
_V4L2_BUF_TYPE_VIDEO_CAPTURE = 1
_V4L2_MEMORY_MMAP = 1
_V4L2_PIX_FMT_MJPEG = 0x47504A4D  # 'MJPG'

# ioctl helper
libc = ctypes.CDLL(ctypes.util.find_library('c') or 'libc.so.6')


def _ioctl(fd: int, request: int, arg: object) -> int:
    result = fcntl.ioctl(fd, request, arg)
    return result


# ── V4L2 structures (packed to match kernel) ──────────────────────────────────

class V4L2Capability(ctypes.Structure):
    _fields_ = [
        ('driver', ctypes.c_char * 16),
        ('card', ctypes.c_char * 32),
        ('bus_info', ctypes.c_char * 32),
        ('version', ctypes.c_uint32),
        ('capabilities', ctypes.c_uint32),
        ('device_caps', ctypes.c_uint32),
        ('reserved', ctypes.c_uint32 * 3),
    ]


class V4L2Format(ctypes.Structure):
    class _Fmt(ctypes.Union):
        _fields_ = [
            ('pixelformat', ctypes.c_uint32),
            ('bytesperline', ctypes.c_uint32),
            ('sizeimage', ctypes.c_uint32),
            ('colorspace', ctypes.c_uint32),
            ('priv', ctypes.c_uint32),
            ('flags', ctypes.c_uint32),
        ]

    _fields_ = [
        ('type', ctypes.c_uint32),
        ('fmt', _Fmt),
        ('width', ctypes.c_uint32),
        ('height', ctypes.c_uint32),
    ]


class V4L2RequestBuffers(ctypes.Structure):
    _fields_ = [
        ('count', ctypes.c_uint32),
        ('type', ctypes.c_uint32),
        ('memory', ctypes.c_uint32),
        ('capabilities', ctypes.c_uint32),
    ]


class V4L2Buffer(ctypes.Structure):
    _fields_ = [
        ('index', ctypes.c_uint32),
        ('type', ctypes.c_uint32),
        ('bytes_used', ctypes.c_uint32),
        ('flags', ctypes.c_uint32),
        ('field', ctypes.c_uint32),
        ('timestamp', ctypes.c_int64 * 2),
        ('sequence', ctypes.c_uint32),
        ('memory', ctypes.c_uint32),
        ('m', ctypes.c_uint32),  # offset for mmap
        ('length', ctypes.c_uint32),
        ('reserved2', ctypes.c_uint32),
    ]


# ── V4L2 Capture ──────────────────────────────────────────────────────────────

_lock = threading.Lock()
_latest_frame: Optional[bytes] = None
_capture_ok = False
_actual_width = 0
_actual_height = 0


def _capture_loop() -> None:
    """Background thread: grab MJPEG frames from V4L2 via mmap."""
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

    fd = os.open(DEVICE, os.O_RDWR | os.O_NONBLOCK)
    try:
        # Query capabilities
        cap = V4L2Capability()
        _ioctl(fd, _VIDIOC_QUERYCAP, cap)
        logger.info(
            'Camera: %s (driver: %s)',
            cap.card.decode(errors='replace').strip('\x00'),
            cap.driver.decode(errors='replace').strip('\x00'),
        )

        # Set format
        fmt = V4L2Format()
        fmt.type = _V4L2_BUF_TYPE_VIDEO_CAPTURE
        fmt.width = WIDTH
        fmt.height = HEIGHT
        fmt.fmt.pixelformat = _V4L2_PIX_FMT_MJPEG
        try:
            _ioctl(fd, _VIDIOC_S_FMT, fmt)
        except OSError:
            pass  # driver may adjust values

        _ioctl(fd, _VIDIOC_G_FMT, fmt)
        _actual_width = fmt.width
        _actual_height = fmt.height
        pixfmt = fmt.fmt.pixelformat
        bytesperline = fmt.fmt.bytesperline
        sizeimage = fmt.fmt.sizeimage

        fmt_names = {
            0x47504A4D: 'MJPEG',
            0x59565955: 'YUYV',
            0x32315559: 'YU12',
        }
        logger.info(
            'Format: %dx%d %s (stride=%d, buf_size=%d) @ %d fps',
            _actual_width, _actual_height,
            fmt_names.get(pixfmt, f'0x{pixfmt:08X}'),
            bytesperline, sizeimage, FPS,
        )

        # Request mmap buffers
        req = V4L2RequestBuffers()
        req.count = 4
        req.type = _V4L2_BUF_TYPE_VIDEO_CAPTURE
        req.memory = _V4L2_MEMORY_MMAP
        _ioctl(fd, _VIDIOC_REQBUFS, req)

        if req.count < 1:
            raise RuntimeError('V4L2: no buffers allocated')

        # Map buffers
        buffers = []
        for i in range(req.count):
            buf = V4L2Buffer()
            buf.index = i
            buf.type = _V4L2_BUF_TYPE_VIDEO_CAPTURE
            buf.memory = _V4L2_MEMORY_MMAP
            _ioctl(fd, _VIDIOC_QUERYBUF, buf)
            mm = mmap.mmap(fd, buf.length, mmap.MAP_SHARED,
                           mmap.PROT_READ | mmap.PROT_WRITE,
                           offset=buf.m)
            buffers.append((mm, buf.length))

        # Queue all buffers
        for i in range(req.count):
            buf = V4L2Buffer()
            buf.index = i
            buf.type = _V4L2_BUF_TYPE_VIDEO_CAPTURE
            buf.memory = _V4L2_MEMORY_MMAP
            _ioctl(fd, _VIDIOC_QBUF, buf)

        # Start streaming
        buf_type = ctypes.c_int(_V4L2_BUF_TYPE_VIDEO_CAPTURE)
        _ioctl(fd, _VIDIOC_STREAMON, buf_type)
        _capture_ok = True
        logger.info('Streaming started on %s', DEVICE)

        # Capture loop
        interval = 1.0 / FPS
        while True:
            t0 = time.monotonic()

            # Dequeue
            dqbuf = V4L2Buffer()
            dqbuf.type = _V4L2_BUF_TYPE_VIDEO_CAPTURE
            dqbuf.memory = _V4L2_MEMORY_MMAP
            try:
                _ioctl(fd, _VIDIOC_DQBUF, dqbuf)
            except (OSError, BlockingIOError):
                time.sleep(0.01)
                continue

            # Read frame
            mm, _ = buffers[dqbuf.index]
            mm.seek(0)
            frame = mm.read(dqbuf.bytes_used)

            # Re-queue
            _ioctl(fd, _VIDIOC_QBUF, dqbuf)

            # Store latest frame
            with _lock:
                _latest_frame = frame

            # Throttle
            elapsed = time.monotonic() - t0
            if elapsed < interval:
                time.sleep(interval - elapsed)

    finally:
        _capture_ok = False
        try:
            buf_type = ctypes.c_int(_V4L2_BUF_TYPE_VIDEO_CAPTURE)
            _ioctl(fd, _VIDIOC_STREAMOFF, buf_type)
        except Exception:
            pass
        try:
            os.close(fd)
        except Exception:
            pass
        logger.info('Camera released, will retry in 2s...')
        time.sleep(2)


def _get_frame() -> Optional[bytes]:
    with _lock:
        return _latest_frame


# ── HTTP Handlers ──────────────────────────────────────────────────────────────

class CameraHandler(BaseHTTPRequestHandler):
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
        self.end_headers()
        self.wfile.write(frame)

    def log_message(self, fmt: str, *args: object) -> None:
        pass


# ── Entry point ────────────────────────────────────────────────────────────────

def main() -> None:
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
