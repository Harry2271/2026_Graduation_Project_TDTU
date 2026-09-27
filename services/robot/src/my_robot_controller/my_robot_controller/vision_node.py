"""ROS 2 vision node — YOLOv8n object / obstacle detection.

Pulls JPEG frames from the camera_stream HTTP service (the same snapshot
endpoint april_tag_node uses, so this node never opens /dev/video0 directly)
and runs Ultralytics YOLOv8n inference on them.  Detections are published as
JSON on /detected_objects for the brain, web bridge, and any consumer.

Design goals
------------
* Shared camera — reads http://127.0.0.1:9092/snapshot, so it coexists with
  camera_stream + april_tag_node without contending for the V4L2 device.
* Graceful degradation — if ultralytics / OpenCV are not installed the node
  logs one warning and idles instead of crash-looping under PM2.
* CPU friendly — default 5 Hz inference on yolov8n (nano) keeps the Pi 5 CPU
  budget in check alongside SLAM + Nav2.

Topics
------
  publishes  /detected_objects  std_msgs/String  (JSON)

JSON schema on /detected_objects::

  {"stamp": 1727452800.12, "count": 2, "frame": [640, 480],
   "objects": [{"label": "person", "cls": 0, "conf": 0.91,
                "box": [x1,y1,x2,y2], "cx": .., "cy": ..}],
   "model": "yolov8n.pt", "infer_ms": 42.5}

Params
------
  camera_snapshot_url  (str)   http://127.0.0.1:9092/snapshot
  model_path           (str)   yolov8n.pt
  inference_hz         (float) 5.0
  confidence_threshold (float) 0.5
  device               (str)   "cpu"   ("cpu" | "0" for CUDA)
  publish_topic        (str)   /detected_objects
  classes              (int[]) []      (empty = all COCO classes)
"""
from __future__ import annotations

import json
import time
import urllib.request
from typing import List, Optional

import rclpy
from rclpy.node import Node
from std_msgs.msg import String

# ── Optional heavy deps — import defensively ───────────────────────────
# ultralytics pulls in torch; OpenCV + numpy decode the JPEG snapshot.
# If any are missing we degrade to an idle node rather than crash-loop.
_IMPORT_ERROR: Optional[str] = None
try:
    import numpy as np
    import cv2
    from ultralytics import YOLO
except Exception as exc:  # noqa: BLE001 - report any import failure
    _IMPORT_ERROR = str(exc)
    np = None  # type: ignore
    cv2 = None  # type: ignore
    YOLO = None  # type: ignore


class VisionNode(Node):
    """YOLOv8n detector that consumes the shared camera snapshot."""

    def __init__(self) -> None:
        super().__init__('vision_node')

        self.declare_parameter('camera_snapshot_url',
                               'http://127.0.0.1:9092/snapshot')
        self.declare_parameter('model_path', 'yolov8n.pt')
        self.declare_parameter('inference_hz', 5.0)
        self.declare_parameter('confidence_threshold', 0.5)
        self.declare_parameter('device', 'cpu')
        self.declare_parameter('publish_topic', '/detected_objects')
        self.declare_parameter('classes', [])  # empty → all classes

        self._url = self.get_parameter('camera_snapshot_url').value
        self._model_path = self.get_parameter('model_path').value
        hz = float(self.get_parameter('inference_hz').value)
        self._conf = float(self.get_parameter('confidence_threshold').value)
        self._device = self.get_parameter('device').value
        topic = self.get_parameter('publish_topic').value
        classes = list(self.get_parameter('classes').value or [])
        self._classes: Optional[List[int]] = classes or None

        self._pub = self.create_publisher(String, topic, 10)
        self._model = None
        self._degraded = False
        self._http_fail_logged = False
        if _IMPORT_ERROR is not None:
            self._degraded = True
            self.get_logger().warn(
                'Vision deps unavailable (%s). Node will idle. Run '
                'services/robot/install-ai-deps.sh on the Pi to enable YOLO.'
                % _IMPORT_ERROR)
        else:
            try:
                self.get_logger().info('Loading YOLO model: %s' % self._model_path)
                self._model = YOLO(self._model_path)
                self._model.to(self._device)
                self.get_logger().info(
                    'YOLOv8 ready on device=%s, conf>=%.2f, %.1f Hz'
                    % (self._device, self._conf, hz))
            except Exception as exc:  # noqa: BLE001
                self._degraded = True
                self.get_logger().error('Failed to load YOLO model: %s' % exc)

        # Slow idle timer in degraded mode keeps PM2 seeing a healthy process.
        period = (1.0 / hz) if (hz > 0 and not self._degraded) else 5.0
        self._timer = self.create_timer(period, self._tick)

    # ── snapshot fetch ────────────────────────────────────────────────
    def _fetch_frame(self):
        try:
            with urllib.request.urlopen(self._url, timeout=1.5) as resp:
                buf = resp.read()
        except Exception as exc:  # noqa: BLE001
            if not self._http_fail_logged:
                self.get_logger().warn(
                    'Snapshot fetch failed (%s): %s — is camera_stream up?'
                    % (self._url, exc))
                self._http_fail_logged = True
            return None
        self._http_fail_logged = False
        arr = np.frombuffer(buf, dtype=np.uint8)
        return cv2.imdecode(arr, cv2.IMREAD_COLOR)
    # ── main loop ─────────────────────────────────────────────────────
    def _tick(self) -> None:
        if self._degraded or self._model is None:
            return
        frame = self._fetch_frame()
        if frame is None:
            return
        h, w = frame.shape[:2]
        t0 = time.time()
        try:
            results = self._model.predict(
                frame, conf=self._conf, device=self._device,
                classes=self._classes, verbose=False)
        except Exception as exc:  # noqa: BLE001
            self.get_logger().warn('Inference error: %s' % exc)
            return
        infer_ms = (time.time() - t0) * 1000.0

        objects = []
        if results:
            r = results[0]
            names = r.names
            for b in r.boxes:
                cls_id = int(b.cls[0])
                x1, y1, x2, y2 = [float(v) for v in b.xyxy[0].tolist()]
                objects.append({
                    'label': names.get(cls_id, str(cls_id)),
                    'cls': cls_id,
                    'conf': round(float(b.conf[0]), 3),
                    'box': [round(x1, 1), round(y1, 1), round(x2, 1), round(y2, 1)],
                    'cx': round((x1 + x2) / 2.0, 1),
                    'cy': round((y1 + y2) / 2.0, 1),
                })

        payload = {
            'stamp': time.time(), 'count': len(objects), 'objects': objects,
            'model': self._model_path, 'frame': [w, h],
            'infer_ms': round(infer_ms, 1),
        }
        msg = String()
        msg.data = json.dumps(payload, separators=(',', ':'))
        self._pub.publish(msg)


def main(args=None) -> None:
    rclpy.init(args=args)
    node = VisionNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == '__main__':
    main()
