"""ROS 2 voice-control node — offline Vietnamese speech commands.

Records short clips from the microphone (``arecord``), transcribes them with
a local **whisper.cpp** binary (fully offline, no cloud), parses simple
Vietnamese driving commands, and:

* publishes the recognised intent as JSON on ``/voice_commands`` (for the
  brain / web UI / logging), and
* optionally drives the robot directly by republishing a ``geometry_msgs/Twist``
  on ``/cmd_vel`` for a short burst (``motion_duration`` s) so teleop_node
  turns it into ESP32 motion.

Everything is offline and CPU-only — suitable for the Pi 5.  If ``arecord`` or
the whisper binary are missing, the node logs one warning and idles rather
than crash-looping under PM2.

Vietnamese grammar (substring match, diacritics-insensitive)::

  tiến / đi thẳng / đi tới / tới      → forward
  lùi / lùi lại / đi lùi              → backward
  sang trái / rẽ trái / quay trái     → turn left
  sang phải / rẽ phải / quay phải     → turn right
  dừng / dừng lại / đứng lại / stop   → stop
  về home / về trạm / về nhà          → go_home (intent only)
  tăng tốc / nhanh                    → speed up
  giảm tốc / chậm                     → slow down

Topics
------
  publishes /voice_commands  std_msgs/String (JSON)
  publishes /cmd_vel         geometry_msgs/Twist (when drive enabled)

Params
------
  whisper_bin       (str)  whisper-cli   — whisper.cpp CLI (or 'main')
  model_path        (str)  ~/whisper.cpp/models/ggml-small.bin
  language          (str)  vi
  mic_device        (str)  default       — arecord -D value
  record_seconds    (float) 3.0
  sample_rate       (int)  16000
  publish_cmd_vel   (bool) True
  linear_speed      (float) 0.25         — m/s for forward/back
  angular_speed     (float) 0.8          — rad/s for turns
  motion_duration   (float) 1.5          — seconds to hold a motion burst
"""
from __future__ import annotations

import json
import os
import queue
import shutil
import subprocess
import tempfile
import threading
import time
import unicodedata

import rclpy
from geometry_msgs.msg import Twist
from rclpy.node import Node
from std_msgs.msg import String

def _strip_accents(text: str) -> str:
    """Lower-case + remove Vietnamese diacritics for robust matching."""
    text = text.lower().replace('đ', 'd')
    nfkd = unicodedata.normalize('NFKD', text)
    return ''.join(c for c in nfkd if not unicodedata.combining(c))


# Intent table: (list of accent-free trigger substrings) → intent name.
# Order matters — more specific / stop first.
_INTENTS = [
    (['dung lai', 'dung', 'stop', 'dung xe'], 'stop'),
    (['ve home', 've tram', 've nha', 've diem'], 'go_home'),
    (['re trai', 'quay trai', 'sang trai', 'trai'], 'left'),
    (['re phai', 'quay phai', 'sang phai', 'phai'], 'right'),
    (['di lui', 'lui lai', 'lui'], 'backward'),
    (['di thang', 'di toi', 'tien len', 'tien', 'toi'], 'forward'),
    (['tang toc', 'nhanh hon', 'nhanh'], 'speed_up'),
    (['giam toc', 'cham lai', 'cham'], 'slow_down'),
]


def parse_intent(text: str) -> str:
    norm = _strip_accents(text)
    for triggers, intent in _INTENTS:
        if any(t in norm for t in triggers):
            return intent
    return 'unknown'


class VoiceControlNode(Node):
    """Offline whisper.cpp Vietnamese voice control."""

    def __init__(self) -> None:
        super().__init__('voice_control_node')

        self.declare_parameter('whisper_bin', 'whisper-cli')
        self.declare_parameter(
            'model_path',
            os.path.expanduser('~/whisper.cpp/models/ggml-small.bin'))
        self.declare_parameter('language', 'vi')
        self.declare_parameter('mic_device', 'default')
        self.declare_parameter('record_seconds', 3.0)
        self.declare_parameter('sample_rate', 16000)
        self.declare_parameter('publish_cmd_vel', True)
        self.declare_parameter('linear_speed', 0.25)
        self.declare_parameter('angular_speed', 0.8)
        self.declare_parameter('motion_duration', 1.5)

        self._whisper = self.get_parameter('whisper_bin').value
        self._model = self.get_parameter('model_path').value
        self._lang = self.get_parameter('language').value
        self._mic = self.get_parameter('mic_device').value
        self._rec_s = float(self.get_parameter('record_seconds').value)
        self._rate = int(self.get_parameter('sample_rate').value)
        self._drive = bool(self.get_parameter('publish_cmd_vel').value)
        self._lin = float(self.get_parameter('linear_speed').value)
        self._ang = float(self.get_parameter('angular_speed').value)
        self._motion_dur = float(self.get_parameter('motion_duration').value)
        self._cmd_pub = self.create_publisher(String, '/voice_commands', 10)
        self._twist_pub = self.create_publisher(Twist, '/cmd_vel', 10)

        self._speed_scale = 1.0
        self._active_twist = None
        self._motion_deadline = 0.0
        self._text_q: queue.Queue = queue.Queue()
        self._stop_flag = threading.Event()

        # Resolve the whisper binary (whisper.cpp renamed 'main' → 'whisper-cli').
        self._whisper_path = shutil.which(self._whisper) or shutil.which('main')
        self._degraded = False
        if shutil.which('arecord') is None:
            self._degraded = True
            self.get_logger().warn(
                'arecord not found — install alsa-utils. Voice node idling.')
        elif self._whisper_path is None:
            self._degraded = True
            self.get_logger().warn(
                'whisper binary not found — run install-voice-control.sh. Idling.')
        elif not os.path.isfile(self._model):
            self._degraded = True
            self.get_logger().warn(
                'whisper model %s missing — run install-voice-control.sh. Idling.'
                % self._model)

        if not self._degraded:
            self.get_logger().info(
                'Voice control ready (whisper=%s, model=%s, lang=%s)'
                % (self._whisper_path, os.path.basename(self._model), self._lang))
            self._worker = threading.Thread(target=self._record_loop, daemon=True)
            self._worker.start()

        # Dispatch recognised text + republish motion bursts on the main thread.
        self._timer = self.create_timer(0.1, self._tick)

    # ── background record → transcribe loop ───────────────────────────
    def _record_loop(self) -> None:
        while not self._stop_flag.is_set() and rclpy.ok():
            text = self._record_and_transcribe()
            if text:
                self._text_q.put(text)

    def _record_and_transcribe(self):
        wav = os.path.join(tempfile.gettempdir(), 'voice_cmd.wav')
        try:
            subprocess.run(
                ['arecord', '-q', '-D', self._mic, '-f', 'S16_LE',
                 '-r', str(self._rate), '-c', '1', '-d', str(self._rec_s), wav],
                check=True, timeout=self._rec_s + 5)
        except Exception as exc:  # noqa: BLE001
            self.get_logger().warn('arecord failed: %s' % exc)
            time.sleep(1.0)
            return None
        try:
            proc = subprocess.run(
                [self._whisper_path, '-m', self._model, '-f', wav,
                 '-l', self._lang, '-nt', '-np'],
                capture_output=True, text=True, timeout=60)
            return proc.stdout.strip()
        except Exception as exc:  # noqa: BLE001
            self.get_logger().warn('whisper failed: %s' % exc)
            return None
    # ── main-thread dispatch + motion burst ───────────────────────────
    def _tick(self) -> None:
        try:
            while True:
                text = self._text_q.get_nowait()
                self._dispatch(text)
        except queue.Empty:
            pass
        # Republish the active motion burst (teleop stops on 1 s silence).
        now = time.time()
        if self._active_twist is not None:
            if now < self._motion_deadline:
                self._twist_pub.publish(self._active_twist)
            else:
                self._twist_pub.publish(Twist())  # explicit stop
                self._active_twist = None

    def _dispatch(self, text: str) -> None:
        intent = parse_intent(text)
        payload = {'stamp': time.time(), 'text': text, 'intent': intent,
                   'speed_scale': round(self._speed_scale, 2)}
        self._cmd_pub.publish(String(data=json.dumps(payload, ensure_ascii=False)))
        self.get_logger().info('Voice: "%s" → %s' % (text, intent))
        if intent in ('unknown', 'go_home'):
            return  # go_home is an intent for the brain; no direct motion
        if intent == 'speed_up':
            self._speed_scale = min(2.0, self._speed_scale + 0.25)
            return
        if intent == 'slow_down':
            self._speed_scale = max(0.25, self._speed_scale - 0.25)
            return
        if not self._drive:
            return
        self._apply_motion(intent)

    def _apply_motion(self, intent: str) -> None:
        t = Twist()
        lin = self._lin * self._speed_scale
        ang = self._ang * self._speed_scale
        if intent == 'forward':
            t.linear.x = lin
        elif intent == 'backward':
            t.linear.x = -lin
        elif intent == 'left':
            t.angular.z = ang
        elif intent == 'right':
            t.angular.z = -ang
        elif intent == 'stop':
            self._active_twist = None
            self._twist_pub.publish(Twist())
            return
        self._active_twist = t
        self._motion_deadline = time.time() + self._motion_dur

    def destroy_node(self) -> bool:
        self._stop_flag.set()
        return super().destroy_node()


def main(args=None) -> None:
    rclpy.init(args=args)
    node = VoiceControlNode()
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
