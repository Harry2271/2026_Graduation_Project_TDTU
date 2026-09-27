"""ROS 2 motor-health node — predictive maintenance / anomaly detection.

Watches the ESP32 encoder + power telemetry and flags motors that are
misbehaving (stall, excessive target/actual RPM error, over-current) before
they fail.  Two detection back-ends:

* **LSTM autoencoder (TensorFlow Lite)** — if a trained model is present at
  ``model_path`` and ``tflite_runtime`` (or full TF) is importable, the node
  feeds a sliding window of feature vectors through it and alerts when the
  reconstruction error exceeds ``recon_threshold``.
* **Rule-based fallback** — always available, no ML deps.  Flags per-motor
  stalls (commanded but not turning) and pack over-current.

A **collection mode** dumps feature rows to CSV so you can gather a healthy
baseline and train the autoencoder offline (see docs/MOTOR_HEALTH_TRAINING.md).

Topics
------
  subscribes /esp32/encoder  std_msgs/String (JSON: [{id,name,tgt,rpm,cnt}...])
  subscribes /esp32/power    std_msgs/String (JSON: {bus_v,current_a,power_w,..})
  publishes  /motor_health_alerts  std_msgs/String (JSON)

Params
------
  collection_mode    (bool)  False  — write CSV instead of alerting
  data_dir           (str)   ~/robot_ws/motor_health  — CSV output dir
  model_path         (str)   ""      — path to .tflite autoencoder (optional)
  window             (int)   20      — sliding window length (timesteps)
  recon_threshold    (float) 0.08    — autoencoder MSE alert threshold
  sample_hz          (float) 5.0     — feature sampling rate
  stall_rpm_frac     (float) 0.25    — |rpm| < frac*|tgt| ⇒ stall candidate
  stall_min_tgt      (float) 40.0    — ignore stalls below this |tgt| rpm
  overcurrent_a      (float) 8.0     — pack current alert threshold (A)
  min_alert_interval (float) 5.0     — seconds between repeated alerts
"""
from __future__ import annotations

import csv
import json
import os
import time
from collections import deque
from typing import Optional

import rclpy
from rclpy.node import Node
from std_msgs.msg import String

# ── Optional TFLite runtime — import defensively ───────────────────────
_TFLITE_ERROR: Optional[str] = None
_Interpreter = None
try:  # prefer the lightweight runtime on the Pi
    from tflite_runtime.interpreter import Interpreter as _Interpreter  # type: ignore
except Exception:  # noqa: BLE001
    try:
        from tensorflow.lite import Interpreter as _Interpreter  # type: ignore
    except Exception as exc:  # noqa: BLE001
        _TFLITE_ERROR = str(exc)

NUM_MOTORS = 4
# Per-timestep feature vector: [tgt, rpm, err] × 4 motors + [current_a, power_w]
FEATURE_LEN = NUM_MOTORS * 3 + 2


def _f(value, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


class MotorHealthNode(Node):
    """Encoder/power anomaly detector with optional TFLite autoencoder."""

    def __init__(self) -> None:
        super().__init__('motor_health_node')

        self.declare_parameter('collection_mode', False)
        self.declare_parameter('data_dir',
                               os.path.expanduser('~/robot_ws/motor_health'))
        self.declare_parameter('model_path', '')
        self.declare_parameter('window', 20)
        self.declare_parameter('recon_threshold', 0.08)
        self.declare_parameter('sample_hz', 5.0)
        self.declare_parameter('stall_rpm_frac', 0.25)
        self.declare_parameter('stall_min_tgt', 40.0)
        self.declare_parameter('overcurrent_a', 8.0)
        self.declare_parameter('min_alert_interval', 5.0)

        self._collect = bool(self.get_parameter('collection_mode').value)
        self._data_dir = self.get_parameter('data_dir').value
        self._model_path = self.get_parameter('model_path').value
        self._window = int(self.get_parameter('window').value)
        self._recon_thr = float(self.get_parameter('recon_threshold').value)
        hz = float(self.get_parameter('sample_hz').value)
        self._stall_frac = float(self.get_parameter('stall_rpm_frac').value)
        self._stall_min_tgt = float(self.get_parameter('stall_min_tgt').value)
        self._overcurrent = float(self.get_parameter('overcurrent_a').value)
        self._min_interval = float(self.get_parameter('min_alert_interval').value)
        self._last_encoder: list = []
        self._last_power: dict = {}
        self._buf: deque = deque(maxlen=self._window)
        self._last_alert_t = 0.0
        self._interp = None
        self._csv_fh = None
        self._csv_writer = None

        self._pub = self.create_publisher(String, '/motor_health_alerts', 10)
        self.create_subscription(String, '/esp32/encoder',
                                 self._on_encoder, 10)
        self.create_subscription(String, '/esp32/power', self._on_power, 10)

        if self._collect:
            self._open_csv()
            self.get_logger().info(
                'COLLECTION MODE — writing feature rows to %s' % self._data_dir)
        elif self._model_path:
            self._load_model()
        else:
            self.get_logger().info(
                'No model_path set — using rule-based anomaly detection only.')

        period = 1.0 / hz if hz > 0 else 0.2
        self._timer = self.create_timer(period, self._tick)

    # ── model / csv setup ─────────────────────────────────────────────
    def _load_model(self) -> None:
        if _Interpreter is None:
            self.get_logger().warn(
                'tflite unavailable (%s) — rule-based only. Run '
                'install-motor-health.sh to enable the autoencoder.'
                % _TFLITE_ERROR)
            return
        if not os.path.isfile(self._model_path):
            self.get_logger().warn(
                'model_path %s missing — rule-based only.' % self._model_path)
            return
        try:
            self._interp = _Interpreter(model_path=self._model_path)
            self._interp.allocate_tensors()
            self.get_logger().info('Loaded TFLite autoencoder: %s'
                                   % self._model_path)
        except Exception as exc:  # noqa: BLE001
            self.get_logger().error('Failed to load TFLite model: %s' % exc)
            self._interp = None

    def _open_csv(self) -> None:
        os.makedirs(self._data_dir, exist_ok=True)
        path = os.path.join(
            self._data_dir, time.strftime('motor_%Y%m%d_%H%M%S.csv'))
        self._csv_fh = open(path, 'w', newline='')
        self._csv_writer = csv.writer(self._csv_fh)
        header = ['t']
        for i in range(NUM_MOTORS):
            header += ['tgt%d' % i, 'rpm%d' % i, 'err%d' % i]
        header += ['current_a', 'power_w']
        self._csv_writer.writerow(header)
        self._csv_path = path
    # ── telemetry callbacks ───────────────────────────────────────────
    def _on_encoder(self, msg: String) -> None:
        try:
            payload = json.loads(msg.data)
        except (ValueError, TypeError):
            return
        if isinstance(payload, dict):
            motors = payload.get('motors', [])
        elif isinstance(payload, list):
            motors = payload
        else:
            motors = []
        if isinstance(motors, list):
            self._last_encoder = motors

    def _on_power(self, msg: String) -> None:
        try:
            payload = json.loads(msg.data)
        except (ValueError, TypeError):
            return
        if isinstance(payload, dict):
            self._last_power = payload

    # ── feature extraction ────────────────────────────────────────────
    def _build_features(self) -> list:
        feats = []
        by_id = {}
        for m in self._last_encoder:
            if isinstance(m, dict):
                by_id[int(m.get('id', len(by_id)))] = m
        for i in range(NUM_MOTORS):
            m = by_id.get(i, {})
            tgt = _f(m.get('tgt'))
            rpm = _f(m.get('rpm'))
            feats += [tgt, rpm, tgt - rpm]
        p = self._last_power
        current = _f(p.get('current_a', p.get('current_ma', 0.0)))
        power = _f(p.get('power_w', p.get('power_mw', 0.0)))
        feats += [current, power]
        return feats

    # ── main loop ─────────────────────────────────────────────────────
    def _tick(self) -> None:
        if not self._last_encoder and not self._last_power:
            return
        feats = self._build_features()
        self._buf.append(feats)

        if self._collect:
            if self._csv_writer is not None:
                self._csv_writer.writerow([round(time.time(), 3)]
                                          + [round(x, 3) for x in feats])
                self._csv_fh.flush()
            return

        alerts = self._detect_rules(feats)
        recon = self._detect_autoencoder()
        if recon is not None and recon > self._recon_thr:
            alerts.append({'motor': -1, 'type': 'anomaly',
                           'detail': 'autoencoder recon error high',
                           'score': round(recon, 4)})
        if alerts:
            self._maybe_publish(alerts, recon)
    # ── detectors ─────────────────────────────────────────────────────
    def _detect_rules(self, feats: list) -> list:
        alerts = []
        for i in range(NUM_MOTORS):
            tgt, rpm, _err = feats[i * 3], feats[i * 3 + 1], feats[i * 3 + 2]
            if abs(tgt) >= self._stall_min_tgt and \
                    abs(rpm) < self._stall_frac * abs(tgt):
                alerts.append({
                    'motor': i, 'type': 'stall',
                    'detail': 'commanded %.0f rpm, measured %.0f' % (tgt, rpm),
                    'tgt': round(tgt, 1), 'rpm': round(rpm, 1),
                })
        current = feats[NUM_MOTORS * 3]
        if current >= self._overcurrent:
            alerts.append({'motor': -1, 'type': 'overcurrent',
                           'detail': 'pack current %.2f A' % current,
                           'current_a': round(current, 2)})
        return alerts

    def _detect_autoencoder(self) -> Optional[float]:
        if self._interp is None or len(self._buf) < self._window:
            return None
        try:
            import numpy as np  # local: only needed when a model is loaded
            seq = np.array(self._buf, dtype=np.float32)
            inp = self._interp.get_input_details()[0]
            out = self._interp.get_output_details()[0]
            x = seq.reshape(inp['shape']).astype(np.float32)
            self._interp.set_tensor(inp['index'], x)
            self._interp.invoke()
            recon = self._interp.get_tensor(out['index'])
            return float(np.mean((recon.flatten() - x.flatten()) ** 2))
        except Exception as exc:  # noqa: BLE001
            self.get_logger().warn('Autoencoder inference failed: %s' % exc)
            return None

    def _maybe_publish(self, alerts: list, recon: Optional[float]) -> None:
        now = time.time()
        if now - self._last_alert_t < self._min_interval:
            return
        self._last_alert_t = now
        payload = {'stamp': now, 'alerts': alerts,
                   'recon_error': round(recon, 4) if recon is not None else None}
        self._pub.publish(String(data=json.dumps(payload, separators=(',', ':'))))
        self.get_logger().warn('Motor health: %s'
                               % json.dumps(alerts, separators=(',', ':')))


def main(args=None) -> None:
    rclpy.init(args=args)
    node = MotorHealthNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        if node._csv_fh is not None:
            node._csv_fh.close()
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == '__main__':
    main()
