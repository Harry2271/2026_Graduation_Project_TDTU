"""audio_alerts_node — Sound alerts for ESP32 safety events.

Subscribes to /esp32/safety_event (type 146) and plays audio alerts based on
the safety level:
  - Level 2 (HARD_STOP): espeak "Hard stop activated"
  - Level 3 (EMERGENCY): espeak "Emergency stop" + beep via paplay/aplay

Requires:
  - espeak or espeak-ng installed on the Pi
  - pulseaudio or alsa (for paplay/aplay beep generation)

Usage:
  ros2 run my_robot_controller audio_alerts
  pm2 logs nexus-robot-audio-alerts
"""
from __future__ import annotations

import json
import subprocess
import threading
from typing import Any

import rclpy
from rclpy.node import Node
from std_msgs.msg import String


class AudioAlertsNode(Node):
    """ROS2 node that plays audio alerts for ESP32 safety events."""

    def __init__(self):
        super().__init__('audio_alerts')

        # Subscribe to safety events from ESP32
        self.create_subscription(
            String,
            '/esp32/safety_event',
            self._on_safety_event,
            10
        )

        self.get_logger().info('Audio alerts node started')
        self.get_logger().info('Listening for safety events on /esp32/safety_event')

        # Check if espeak is available
        self._espeak_available = self._check_command('espeak') or self._check_command('espeak-ng')
        if not self._espeak_available:
            self.get_logger().warn('espeak/espeak-ng not found — voice alerts disabled')

        # Check if audio playback is available (paplay or aplay)
        self._paplay_available = self._check_command('paplay')
        self._aplay_available = self._check_command('aplay')
        if not (self._paplay_available or self._aplay_available):
            self.get_logger().warn('paplay/aplay not found — beep alerts disabled')

    def _check_command(self, cmd: str) -> bool:
        """Check if a shell command is available."""
        try:
            subprocess.run(
                ['which', cmd],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=1.0,
                check=True
            )
            return True
        except (subprocess.SubprocessError, FileNotFoundError):
            return False

    def _on_safety_event(self, msg: String) -> None:
        """Handle incoming safety event messages."""
        try:
            data = json.loads(msg.data)
        except json.JSONDecodeError:
            self.get_logger().error(f'Invalid JSON in safety event: {msg.data}')
            return

        level = data.get('level', 0)
        source = data.get('source', 'unknown')
        reason = data.get('reason', '')

        self.get_logger().info(f'Safety event: level={level}, source={source}, reason={reason}')

        # Level 2: HARD_STOP
        if level == 2:
            self._play_alert('Hard stop activated', beep=False)

        # Level 3: EMERGENCY
        elif level == 3:
            self._play_alert('Emergency stop', beep=True)

    def _play_alert(self, message: str, beep: bool = False) -> None:
        """Play voice alert and optional beep (non-blocking)."""
        def _run():
            # Voice alert
            if self._espeak_available:
                espeak_cmd = 'espeak' if self._check_command('espeak') else 'espeak-ng'
                try:
                    subprocess.run(
                        [espeak_cmd, message],
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        timeout=5.0,
                        check=False
                    )
                except subprocess.SubprocessError as e:
                    self.get_logger().error(f'espeak failed: {e}')

            # Beep alert (emergency only)
            if beep:
                self._play_beep()

        # Run in background thread to avoid blocking ROS2 spin
        threading.Thread(target=_run, daemon=True).start()

    def _play_beep(self) -> None:
        """Play a beep sound using paplay or aplay."""
        # Generate a short beep tone using pacat/aplay
        # 440 Hz sine wave for 0.2 seconds
        try:
            if self._paplay_available:
                # Use paplay with inline PCM data generation
                subprocess.run(
                    ['sh', '-c',
                     'paplay --rate=8000 --channels=1 --format=s16le '
                     '--raw /dev/zero 2>/dev/null & '
                     'sleep 0.2 && killall paplay 2>/dev/null'],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    timeout=1.0,
                    check=False
                )
            elif self._aplay_available:
                # Use aplay with /dev/zero fallback
                subprocess.run(
                    ['sh', '-c',
                     'aplay -d 0.2 -r 8000 -c 1 -f S16_LE /dev/zero 2>/dev/null'],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    timeout=1.0,
                    check=False
                )
        except subprocess.SubprocessError as e:
            self.get_logger().error(f'Beep playback failed: {e}')


def main(args=None):
    rclpy.init(args=args)
    node = AudioAlertsNode()

    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
