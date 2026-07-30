"""ROS 2 teleop bridge — bridges /cmd_vel to ESP32 motor commands.

Subscribes to /cmd_vel (geometry_msgs/Twist), converts to ESP32
{"cmd":"move","vx":N,"vy":N,"omega":N} JSON, and sends via
RealEsp32Bridge over USB CDC.

Also sends heartbeat every 50 ms to keep the ESP32 in MODE_NAV
(rather than AUTO_ROAM).

Safety:
  - CMD_VEL_TIMEOUT_S (default 1.0): if no Twist arrives within this
    window, the node sends {"cmd":"stop"} to prevent runaway.
  - E-STOP topic: subscribe to /e_stop (std_msgs/Bool) or send
    SIGINT to gracefully disconnect.

Usage:
  # Terminal 1 — keyboard teleop
  ros2 run teleop_twist_keyboard teleop_twist_keyboard

  # Terminal 2 — this bridge
  ros2 run my_robot_controller teleop_node

  # Optional: limit max speed
  ros2 run my_robot_controller teleop_node --ros-args -p max_vx:=120
"""
from __future__ import annotations

import asyncio
import math
import os
import signal
import sys

import rclpy
from geometry_msgs.msg import Twist
from rclpy.executors import SingleThreadedExecutor
from rclpy.node import Node
from std_msgs.msg import Bool

from my_robot_controller.esp32_bridge import RealEsp32Bridge, open_esp32_bridge

# ── Scale factors ───────────────────────────────────────────────────
# Twist linear.x/y are in m/s (default teleop_twist_keyboard max ~0.5 m/s).
# ESP32 move accepts vx/vy/omega in [-255, 255] (PWM units).
# We map: 1.0 m/s → max_vx (default 200 PWM).
# omega: Twist angular.z is rad/s; we map π rad/s → max_omega.
DEFAULT_MAX_VX = 200
DEFAULT_MAX_VY = 200
DEFAULT_MAX_OMEGA = 200

CMD_VEL_TIMEOUT_S = 1.0  # seconds without Twist → stop


class TeleopNode(Node):
    """ROS 2 node that bridges /cmd_vel to ESP32 move commands."""

    def __init__(self) -> None:
        super().__init__('teleop')

        # Parameters
        self.declare_parameter('max_vx', DEFAULT_MAX_VX)
        self.declare_parameter('max_vy', DEFAULT_MAX_VY)
        self.declare_parameter('max_omega', DEFAULT_MAX_OMEGA)
        self.declare_parameter('cmd_vel_timeout', CMD_VEL_TIMEOUT_S)

        self._max_vx: int = int(self.get_parameter('max_vx').value)
        self._max_vy: int = int(self.get_parameter('max_vy').value)
        self._max_omega: int = int(self.get_parameter('max_omega').value)
        self._timeout: float = float(self.get_parameter('cmd_vel_timeout').value)

        self._bridge: RealEsp32Bridge | None = None
        self._last_cmd_vel_time: float = 0.0
        self._connected = False
        self._stopping = False

        # Subscribers
        self._cmd_vel_sub = self.create_subscription(
            Twist, '/cmd_vel', self._on_cmd_vel, 10)
        self._e_stop_sub = self.create_subscription(
            Bool, '/e_stop', self._on_e_stop, 10)

        self.get_logger().info(
            f'teleop_node ready — max_vx={self._max_vx} '
            f'max_vy={self._max_vy} max_omega={self._max_omega} '
            f'timeout={self._timeout}s')

    # ── Callbacks ───────────────────────────────────────────────────

    def _on_cmd_vel(self, msg: Twist) -> None:
        """Convert Twist to ESP32 move command."""
        if self._bridge is None or not self._connected:
            return

        # Scale: m/s → PWM units
        vx = int(msg.linear.x * self._max_vx)
        vy = int(msg.linear.y * self._max_vy)
        omega = int(msg.angular.z * self._max_omega / math.pi)

        # Clamp to [-255, 255]
        vx = max(-255, min(255, vx))
        vy = max(-255, min(255, vy))
        omega = max(-255, min(255, omega))

        self._last_cmd_vel_time = self.get_clock().now().nanoseconds / 1e9
        self._stopping = False

        loop = asyncio.get_event_loop()
        loop.create_task(self._send_move(vx, vy, omega))

    def _on_e_stop(self, msg: Bool) -> None:
        """Handle explicit e_stop from another node."""
        if self._bridge is None or not self._connected:
            return
        loop = asyncio.get_event_loop()
        if msg.data:
            loop.create_task(self._bridge.e_stop())
            self.get_logger().warn('E-STOP received from /e_stop topic')
        else:
            loop.create_task(self._bridge.clear_e_stop())
            self.get_logger().info('E-STOP cleared')

    # ── Async bridge lifecycle ──────────────────────────────────────

    async def _run(self) -> None:
        """Open serial, wire callbacks, run until shutdown."""
        port = os.environ.get('ESP32_PORT', '/dev/robot-esp32')
        baud = int(os.environ.get('ESP32_BAUD', '115200'))
        self.get_logger().info(f'opening ESP32 bridge on {port} @ {baud}')

        try:
            self._bridge = await open_esp32_bridge(port=port, baudrate=baud)
        except Exception as e:
            self.get_logger().error(f'failed to open ESP32 bridge: {e}')
            return

        self._bridge.on_status_update = self._on_status
        self._bridge.on_encoder_update = self._on_encoder
        self._bridge.on_e_stop = self._on_e_stop_event
        self._bridge.on_error = self._on_error
        self._bridge.on_alive = self._on_alive

        await self._bridge.connect()
        self._connected = True
        self.get_logger().info('ESP32 bridge connected — sending heartbeat')

        try:
            while rclpy.ok():
                await asyncio.sleep(0.05)  # 20 Hz loop
                await self._check_timeout()
        finally:
            # Graceful shutdown: stop motors before disconnecting
            try:
                await self._bridge.stop()
                self.get_logger().info('sent stop on shutdown')
            except Exception:
                pass
            await self._bridge.disconnect()
            self._connected = False

    async def _send_move(self, vx: int, vy: int, omega: int) -> None:
        if self._bridge and self._connected:
            try:
                await self._bridge.move(vx, vy, omega)
            except Exception as e:
                self.get_logger().error(f'move failed: {e}')

    async def _check_timeout(self) -> None:
        """Send stop if no cmd_vel received within timeout window."""
        if self._stopping or self._bridge is None or not self._connected:
            return
        if self._last_cmd_vel_time == 0.0:
            return
        now = self.get_clock().now().nanoseconds / 1e9
        if (now - self._last_cmd_vel_time) > self._timeout:
            self._stopping = True
            self.get_logger().warn(
                f'no cmd_vel for {self._timeout}s — sending stop')
            try:
                await self._bridge.stop()
            except Exception as e:
                self.get_logger().error(f'stop failed: {e}')

    # ── Bridge callbacks ────────────────────────────────────────────

    def _on_status(self, data: dict) -> None:
        pass  # Telemetry node handles status publishing

    def _on_encoder(self, motors: list[dict]) -> None:
        pass

    def _on_e_stop_event(self) -> None:
        self.get_logger().warn('ESP32 entered E-STOP state')

    def _on_error(self, msg: str) -> None:
        self.get_logger().error(f'esp32 bridge: {msg}')

    def _on_alive(self, data: dict) -> None:
        pass  # Silent — keep log clean


def main(args: list[str] | None = None) -> None:
    rclpy.init(args=args)
    node = TeleopNode()
    executor = SingleThreadedExecutor()
    executor.add_node(node)

    # Run asyncio event loop for bridge I/O alongside ROS spin
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    # Schedule the bridge runner
    bridge_task = loop.create_task(node._run())

    try:
        # Spin ROS + drive async bridge concurrently
        while rclpy.ok():
            executor.spin_once(timeout_sec=0.01)
            loop.call_soon_once(lambda: None)
            # Let asyncio run pending callbacks
            loop._run_once()  # noqa: SLF001
    except KeyboardInterrupt:
        pass
    finally:
        bridge_task.cancel()
        try:
            loop.run_until_complete(bridge_task)
        except (asyncio.CancelledError, RuntimeError):
            pass
        loop.close()
        executor.shutdown()
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == '__main__':
    main()
