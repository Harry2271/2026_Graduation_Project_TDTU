"""AprilTag detector — reads from /dev/video0 and publishes detected tags.

Pipeline:
  ffmpeg (V4L2 → MJPEG over pipe) → OpenCV JPEG decode → grayscale →
  pupil-apriltags detector → pose estimation → publish /detected_tags

Why two camera consumers?
  `camera_stream.py` reads the same /dev/video0 via ffmpeg for the MJPEG
  HTTP server.  V4L2 allows multiple open() on the same device, but
  hardware support for that depends on the USB bridge.  For BRIO 100 we
  have observed that two concurrent ffmpeg readers either work fine or
  hit USB bandwidth limits.  If your webcam does not support concurrent
  read, either reduce CAMERA_FPS in camera_stream to a small value (e.g. 5)
  and run this node at 5 Hz, or repurpose camera_stream to push frames
  into a shared buffer that this node reads.

Payload (std_msgs/String, JSON):
  {
    "ts": 1234567890.123,
    "tag_id": 42,
    "x": 0.31, "y": 0.02, "z": 0.85,          # camera-frame tvec (m)
    "yaw": 1.57, "pitch": 0.0, "roll": 0.0,     # rvec → euler (rad)
    "confidence": 0.92,                          # decision_margin
    "size_m": 0.166,                            # tag square size (m)
  }

Environment variables:
  CAMERA_DEVICE    — V4L2 device (default: /dev/video0)
  CAMERA_WIDTH     — capture width  (default: 640)
  CAMERA_HEIGHT    — capture height (default: 480)
  APRILTAG_FAMILY  — tag family name (default: tag36h11)
  APRILTAG_SIZE_M  — tag square side length (m, default: 0.166)
  APRILTAG_HZ      — detection rate (default: 10)
  CAMERA_MATRIX    — flat 9-tuple fx,0,cx, 0,fy,cy, 0,0,1 (default: hub-bubble intrinsic)
  DIST_COEFFS      — flat 5-tuple k1 k2 p1 p2 k3 (default: zeros)
"""
from __future__ import annotations

import json
import math
import os
import subprocess
import threading
import time
from typing import Optional

import cv2
import numpy as np
import rclpy
from rclpy.node import Node
from std_msgs.msg import String


# ── Defaults ────────────────────────────────────────────────
DEVICE = os.environ.get('CAMERA_DEVICE', '/dev/video0')
WIDTH = int(os.environ.get('CAMERA_WIDTH', '640'))
HEIGHT = int(os.environ.get('CAMERA_HEIGHT', '480'))
FAMILY = os.environ.get('APRILTAG_FAMILY', 'tag36h11')
SIZE_M = float(os.environ.get('APRILTAG_SIZE_M', '0.166'))
HZ = float(os.environ.get('APRILTAG_HZ', '10'))

# Camera intrinsics.  When no calibration is supplied, use a sensible
# pinhole default that works well enough for warehouse docking (camera
# FOV ~60°, principal point at image centre).  Replace with a real
# calibration for accurate pose.
FX = float(os.environ.get('CAMERA_FX', '600.0'))
FY = float(os.environ.get('CAMERA_FY', '600.0'))
CX = float(os.environ.get('CAMERA_CX', str(WIDTH / 2.0)))
CY = float(os.environ.get('CAMERA_CY', str(HEIGHT / 2.0)))


def _rvec_to_euler(rvec: np.ndarray) -> tuple[float, float, float]:
    """Convert a Rodrigues rvec to yaw/pitch/roll (radians)."""
    rmat, _ = cv2.Rodrigues(rvec)
    # ZYX (yaw-pitch-roll) extraction, suitable for ground-level tags
    sy = math.sqrt(rmat[0, 0] ** 2 + rmat[1, 0] ** 2)
    singular = sy < 1e-6
    if not singular:
        pitch = math.atan2(-rmat[2, 0], sy)
        yaw = math.atan2(rmat[1, 0], rmat[0, 0])
        roll = math.atan2(rmat[2, 1], rmat[2, 2])
    else:
        pitch = math.atan2(-rmat[2, 0], sy)
        yaw = 0.0
        roll = math.atan2(-rmat[1, 2], rmat[1, 1])
    return yaw, pitch, roll


class AprilTagNode(Node):
    def __init__(self) -> None:
        super().__init__('april_tag_node')

        # Camera intrinsics — used for pose estimation
        self._camera_matrix = np.array([[FX, 0.0, CX],
                                        [0.0, FY, CY],
                                        [0.0, 0.0, 1.0]], dtype=np.float64)
        self._dist_coeffs = np.zeros((5, 1), dtype=np.float64)
        self._tag_size_m = SIZE_M

        # Lazy-load the detector so a missing library doesn't kill the node
        self._detector = None
        try:
            self._detector = self._init_detector()
        except Exception as e:
            self.get_logger().error(f'Failed to init AprilTag detector: {e}')
            self.get_logger().warn('april_tag_node running with detector disabled')

        # Publish /detected_tags (std_msgs/String JSON) — keep_last=10 so
        # a slow listener doesn't queue up old detections.
        self._pub = self.create_publisher(String, '/detected_tags', 10)

        # Run detection loop on a background thread so the ROS executor
        # stays responsive (no blocking cv2 calls inside spin).
        self._stop_event = threading.Event()
        self._thread = threading.Thread(target=self._detect_loop,
                                         daemon=True, name='apriltag')
        self._thread.start()

        self.get_logger().info(
            f'april_tag_node ready: device={DEVICE} {WIDTH}x{HEIGHT} '
            f'family={FAMILY} size={SIZE_M}m @ {HZ}Hz')

    def _init_detector(self):
        """Lazy import of pupil-apriltags (preferred). Falls back to dt_apriltags."""
        try:
            from pupil_apriltags import Detector  # type: ignore
            return Detector(families=FAMILY, nthreads=2,
                            quad_decimate=1.0, quad_sigma=0.0,
                            refine_edges=True, decode_sharpening=0.25)
        except ImportError:
            from dt_apriltags import Detector  # type: ignore
            return Detector(families=FAMILY, nthreads=2,
                            quad_decimate=1.0, quad_sigma=0.0,
                            refine_edges=True, decode_sharpening=0.25)

    def destroy_node(self):
        self._stop_event.set()
        if self._thread.is_alive():
            self._thread.join(timeout=2.0)
        super().destroy_node()

    def _detect_loop(self) -> None:
        """Run ffmpeg → OpenCV → AprilTag → publish.  Runs forever."""
        if self._detector is None:
            return

        dt = 1.0 / HZ
        proc: Optional[subprocess.Popen] = None

        while not self._stop_event.is_set():
            try:
                if proc is None or proc.poll() is not None:
                    proc = self._start_ffmpeg()
                    if proc is None:
                        time.sleep(2.0)
                        continue

                raw = proc.stdout.read(4096) if proc.stdout else b''
                if not raw:
                    self._get_logger().debug('ffmpeg returned empty frame')
                    time.sleep(0.05)
                    continue

                # Decode one JPEG frame from the buffer
                np_arr = np.frombuffer(raw, dtype=np.uint8)
                img = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
                if img is None:
                    continue

                gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
                self._process_frame(gray)
                time.sleep(dt)

            except Exception as e:
                self.get_logger().warn(f'detect loop error: {e}')
                if proc is not None:
                    try:
                        proc.terminate()
                    except Exception:
                        pass
                proc = None
                time.sleep(1.0)

        if proc is not None:
            try:
                proc.terminate()
            except Exception:
                pass

    def _start_ffmpeg(self) -> Optional[subprocess.Popen]:
        """Boot ffmpeg as a stream of JPEG frames on stdout."""
        cmd = [
            'ffmpeg',
            '-hide_banner', '-loglevel', 'warning',
            '-f', 'v4l2',
            '-input_format', 'mjpeg',
            '-video_size', f'{WIDTH}x{HEIGHT}',
            '-framerate', str(int(HZ)),
            '-i', DEVICE,
            '-f', 'image2pipe',
            '-vcodec', 'mjpeg',
            '-q:v', '5',
            '-r', str(int(HZ)),
            '-',
        ]
        try:
            return subprocess.Popen(cmd, stdout=subprocess.PIPE,
                                    stderr=subprocess.DEVNULL, bufsize=0)
        except FileNotFoundError:
            self.get_logger().error('ffmpeg not found — install with: '
                                    'sudo apt install ffmpeg')
            return None
        except Exception as e:
            self.get_logger().warn(f'Failed to start ffmpeg: {e}')
            return None

    def _process_frame(self, gray: np.ndarray) -> None:
        """Detect tags in a grayscale frame and publish the best one."""
        try:
            detections = self._detector.detect(gray, estimate_tag_pose=True,
                                                camera_params=[FX, FY, CX, CY],
                                                tag_size=self._tag_size_m)
        except Exception as e:
            self.get_logger().warn(f'Detector raised: {e}')
            return

        if not detections:
            return

        # Pick the most confident detection (highest decision_margin)
        best = max(detections, key=lambda d: d.decision_margin)
        tvec = best.pose_t.flatten()  # [x, y, z] in camera frame, metres
        rvec = best.pose_R.flatten()
        yaw, pitch, roll = _rvec_to_euler(best.pose_R)

        msg = String()
        msg.data = json.dumps({
            'ts': time.time(),
            'tag_id': int(best.tag_id),
            'x': float(tvec[0]),
            'y': float(tvec[1]),
            'z': float(tvec[2]),
            'yaw': float(yaw),
            'pitch': float(pitch),
            'roll': float(roll),
            'confidence': float(best.decision_margin),
            'size_m': self._tag_size_m,
        })
        self._pub.publish(msg)
        self.get_logger().info(
            f'tag {best.tag_id} x={tvec[0]:.2f} y={tvec[1]:.2f} z={tvec[2]:.2f} '
            f'confidence={best.decision_margin:.1f}',
            throttle_duration_sec=1.0)


def main(args=None) -> None:
    rclpy.init(args=args)
    node = AprilTagNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
