"""esp32_telemetry_node — bridges ESP32 UART frames into ROS 2 topics.

Sits on the Pi 5 next to web_bridge.py and forwards ESP32 type-131 (status)
and type-130 (encoder) frames to `/esp32/status` and `/esp32/encoder` so any
ROS node (in particular web_bridge.py) can re-publish them to the browser.

Why a separate node instead of reusing RealEsp32Bridge from brain_node.py?
The brain currently uses FakeEsp32Bridge; coupling this telemetry to the
brain would force us to flip that switch before any of this can run. The
telemetry bridge is read-only — it never sends movement commands to ESP32 —
so it can run independently without affecting brain state.

Architecture:
  - Main thread: asyncio event loop running RealEsp32Bridge reader/heartbeat.
  - Background thread: rclpy SingleThreadedExecutor spinning this node.
  - Bridge callbacks (called from asyncio) call `node.publish()` which is
    thread-safe in rclpy.

Environment variables:
  ESP32_PORT   — device path (default: /dev/ttyACM0)
  ESP32_BAUD   — baud rate (default: 115200, ignored for USB CDC)

Verify on Pi:
  pm2 logs nexus-robot-esp32-telemetry
  ros2 topic list        → should include /esp32/status and /esp32/encoder
  ros2 topic echo /esp32/status --once
"""
from __future__ import annotations

import asyncio
import json
import os
import threading

import rclpy
from rclpy.executors import SingleThreadedExecutor
from rclpy.node import Node
from std_msgs.msg import String

from my_robot_controller.esp32_bridge import open_esp32_bridge


class Esp32TelemetryNode(Node):
    """ROS 2 node that publishes ESP32 status / encoder frames.

    Publishers are created in __init__. The actual serial work runs in
    an asyncio loop on the main thread; bridge callbacks invoke publish()
    on this node, which rclpy serializes safely across threads.
    """

    def __init__(self) -> None:
        super().__init__('esp32_telemetry')
        self._status_pub = self.create_publisher(String, '/esp32/status', 10)
        self._encoder_pub = self.create_publisher(String, '/esp32/encoder', 10)
        self._e_stop_pub = self.create_publisher(String, '/esp32/e_stop', 10)
        self.get_logger().info('esp32_telemetry_node ready')

    # ── Bridge callbacks (called from asyncio thread) ──────────────────────

    def on_status_update(self, data: dict) -> None:
        """Forward type-131 status JSON to /esp32/status."""
        self._status_pub.publish(String(data=json.dumps(data)))
        if data.get('e_stop'):
            # Fire a separate lightweight event so consumers don't have to
            # parse the full status payload to detect e-stop edges.
            self._e_stop_pub.publish(String(data=json.dumps({'ts': data.get('ts')})))

    def on_encoder_update(self, motors: list[dict]) -> None:
        """Forward type-130 encoder list to /esp32/encoder."""
        self._encoder_pub.publish(String(data=json.dumps(motors)))

    def on_error(self, msg: str) -> None:
        """Surface bridge-side errors to the ROS log."""
        self.get_logger().warning(f'esp32 bridge: {msg}')


def _start_executor(node: Node) -> tuple[SingleThreadedExecutor, threading.Thread]:
    """Spin the node on a background thread; return (executor, thread)."""
    executor = SingleThreadedExecutor()
    executor.add_node(node)
    thread = threading.Thread(target=executor.spin, daemon=True, name='ros-spin')
    thread.start()
    return executor, thread


async def _run_bridge(node: Esp32TelemetryNode) -> None:
    """Open serial, wire callbacks, hold until ROS is shut down."""
    port = os.environ.get('ESP32_PORT', '/dev/ttyACM0')
    baud = int(os.environ.get('ESP32_BAUD', '115200'))
    node.get_logger().info(f'opening ESP32 bridge on {port} @ {baud}')

    bridge = await open_esp32_bridge(port=port, baudrate=baud)
    bridge.on_status_update = node.on_status_update
    bridge.on_encoder_update = node.on_encoder_update
    bridge.on_error = node.on_error

    await bridge.connect()
    node.get_logger().info('ESP32 telemetry bridge connected')

    try:
        while rclpy.ok():
            await asyncio.sleep(1.0)
    finally:
        await bridge.disconnect()


def main() -> None:
    rclpy.init()
    node = Esp32TelemetryNode()
    executor, _thread = _start_executor(node)
    try:
        asyncio.run(_run_bridge(node))
    except KeyboardInterrupt:
        pass
    finally:
        executor.shutdown()
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == '__main__':
    main()