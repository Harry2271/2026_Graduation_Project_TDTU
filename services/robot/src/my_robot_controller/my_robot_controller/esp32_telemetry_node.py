"""esp32_telemetry_node — ESP32 serial gateway for the robot stack.

Sits on the Pi 5 and acts as the **sole owner** of the ESP32 UART link
(`/dev/robot-esp32` or `/dev/ttyACM0`).  This node runs two jobs:

1. **Telemetry mirror (read side).**  ESP32 type-130/131/133/134/140/144/145
   frames received from the bridge are republished as ROS `std_msgs/String`
   JSON messages on `/esp32/status`, `/esp32/encoder`, `/esp32/imu`,
   `/esp32/power`, `/esp32/unload_state`, `/esp32/cargo`, `/esp32/alive`
   so any ROS node can subscribe.

2. **Command gateway (write side).**  ROS clients (brain, teleop, web_bridge)
   publish JSON commands on `/esp32/cmd`.  This node validates them,
   applies a bounded/latest-wins queue policy for `move`, and forwards
   accepted commands to the ESP32 via `RealEsp32Bridge.send_command()`.
   Rejections, queue overflow, and disconnections are reported on
   `/esp32/cmd_status`.

Direction A architecture means no other process opens `/dev/ttyACM0`.
Only this node holds the serial file descriptor.

Environment variables:
  ESP32_PORT   — device path (default: /dev/robot-esp32)
  ESP32_BAUD   — baud rate (default: 115200, ignored for USB CDC)

Verify on Pi:
  pm2 logs nexus-robot-esp32-telemetry
  ros2 node list             → esp32_telemetry is the only ESP32 owner
  ros2 topic echo /esp32/status --once
  ros2 topic echo /esp32/cmd_status --once
"""
from __future__ import annotations

import asyncio
import json
import os
import threading
import time
from collections import deque
from typing import Any

import rclpy
from rclpy.executors import SingleThreadedExecutor
from rclpy.node import Node
from std_msgs.msg import String

from my_robot_controller.esp32_bridge import open_esp32_bridge


# ── Whitelisted commands accepted via /esp32/cmd ────────────────────────
ALLOWED_COMMANDS = frozenset({
    'move', 'stop', 'e_stop', 'e_stop_clear', 'heartbeat',
    'cylinder_extend', 'cylinder_retract', 'cylinder_stop',
    'begin_dock', 'cancel_dock', 'get_cargo', 'get_imu', 'get_power',
    'set_speed', 'set_all_speed', 'set_pid',
    'individual', 'reset_encoder', 'get_encoder',
    'obstacle_front', 'obstacle_left', 'obstacle_right',
    'obstacle_front_left', 'obstacle_front_right',
    'obstacle_rear', 'obstacle_rear_left', 'obstacle_rear_right',
    'obstacle_clear',
})

# Commands that must NEVER be dropped, even under heavy back-pressure.
PRIORITY_COMMANDS = frozenset({
    'stop', 'e_stop', 'e_stop_clear', 'cancel_dock', 'cylinder_stop',
})

# High-rate commands — coalesce to latest frame under sustained overload.
COALESCE_COMMANDS = frozenset({'move'})

# Per-tick queue drain limits
_MAX_DRAIN_PER_TICK = 8

# Sustained-overload thresholds
_OVERLOAD_DEQUE_WINDOW = 5.0      # seconds of high watermark to consider sustained
_OVERLOAD_WARN_PERIOD_S = 2.0     # min interval between warn logs
_OVERLOAD_DROP_RATIO = 0.4        # drops per enqueue ratio that triggers warning
_RECOVERY_BELOW_WATERMARK = 2     # queue depth to clear sustained overload


class Esp32TelemetryNode(Node):
    """ROS 2 node that owns ESP32 serial and mirrors telemetry / forwards commands.

    Publishers are created in __init__. The actual serial work runs in
    an asyncio loop on the main thread; bridge callbacks invoke publish()
    on this node, which rclpy serializes safely across threads.
    """

    def __init__(self) -> None:
        super().__init__('esp32_telemetry')

        # ── Telemetry publishers (ESP32 → ROS) ─────────────────────────────
        self._status_pub        = self.create_publisher(String, '/esp32/status', 10)
        self._encoder_pub       = self.create_publisher(String, '/esp32/encoder', 10)
        self._e_stop_pub        = self.create_publisher(String, '/esp32/e_stop', 10)
        self._imu_pub           = self.create_publisher(String, '/esp32/imu', 10)
        self._power_pub         = self.create_publisher(String, '/esp32/power', 10)
        self._unload_state_pub  = self.create_publisher(String, '/esp32/unload_state', 10)
        self._cargo_pub         = self.create_publisher(String, '/esp32/cargo', 10)
        self._alive_pub         = self.create_publisher(String, '/esp32/alive', 10)

        # ── Command gateway publishers (status back to clients) ────────────
        self._cmd_status_pub    = self.create_publisher(String, '/esp32/cmd_status', 10)

        # ── Command gateway subscriber (ROS → ESP32) ───────────────────────
        self._cmd_sub = self.create_subscription(
            String, '/esp32/cmd', self._on_cmd, 10)

        # ── Gateway state ──────────────────────────────────────────────────
        self._cmd_q: deque[dict] = deque(maxlen=32)
        self._dropped_total = 0
        self._accepted_total = 0
        self._rejected_total = 0
        self._overflow_active = False
        self._last_overload_warn = 0.0
        self._overload_history: deque[float] = deque(maxlen=64)
        self._last_pending_move: dict | None = None
        self._bridge = None  # set later by _run_bridge

        # ── CPS watchdog (on-robot) ───────────────────────────────────────
        # Publishes /esp32/bridge_health periodically so consumers can react
        # without parsing /esp32/status themselves.  Requires field validation
        # by timing real serial drops / reconnects on the Pi.
        self._last_alive_time: float = 0.0
        self._last_status_time: float = 0.0
        self._health_pub = self.create_publisher(String, '/esp32/bridge_health', 10)
        self._health_timer = self.create_timer(0.5, self._publish_health_status)

        self.get_logger().info('esp32_telemetry_node ready (serial gateway)')

    # ── Bridge callbacks (called from asyncio thread) ──────────────────────

    def on_status_update(self, data: dict) -> None:
        """Forward type-131 status JSON to /esp32/status."""
        self._status_pub.publish(String(data=json.dumps(data)))
        # CPS freshness heartbeat: update last-seen timestamp.
        now = time.time()
        self._last_status_time = now
        # Edge event retained for backward compatibility.  Consumers should
        # now prefer /esp32/bridge_health for lifecycle monitoring, but keep
        # publishing e_stop edge for legacy subscribers.
        if data.get('e_stop'):
            self._e_stop_pub.publish(String(data=json.dumps({
                'ts': data.get('ts'),
                'now': now,
            })))

    def on_encoder_update(self, motors: list[dict]) -> None:
        """Forward type-130 encoder list to /esp32/encoder."""
        self._encoder_pub.publish(String(data=json.dumps(motors)))

    def on_imu(self, data: dict) -> None:
        """Forward type-134 BNO055 telemetry to /esp32/imu."""
        self._imu_pub.publish(String(data=json.dumps(data)))

    def on_power(self, data: dict) -> None:
        """Forward type-133 INA226 telemetry to /esp32/power."""
        self._power_pub.publish(String(data=json.dumps(data)))

    def on_unload_state(self, data: dict) -> None:
        """Forward type-140 unload sequence state to /esp32/unload_state."""
        self._unload_state_pub.publish(String(data=json.dumps(data)))

    def on_cargo(self, data: dict) -> None:
        """Forward type-145 cargo microswitch state to /esp32/cargo."""
        self._cargo_pub.publish(String(data=json.dumps(data)))

    def on_alive(self, data: dict) -> None:
        """Forward type-144 alive heartbeat to /esp32/alive."""
        self._alive_pub.publish(String(data=json.dumps(data)))
        # CPS freshness heartbeat: alive message from firmware means serial
        # link is still up.  This is the canonical "CPS alive" indicator
        # used by the health watchdog below.
        self._last_alive_time = time.time()

    def on_error(self, msg: str) -> None:
        """Surface bridge-side errors to the ROS log."""
        self.get_logger().warning(f'esp32 bridge: {msg}')

    # ── CPS watchdog timer (on-robot health) ───────────────────────────────────

    def _publish_health_status(self) -> None:
        """Publish periodic bridge health snapshot.

        Health semantics (on-robot tuned, NOT code-tunable):
          HEALTHY  — alive message OR fresh status frame within last 2.0 s
          STALE    — firmware link appears down (timeout reached)

        Timeout value MUST be set from real robot telemetry:
          - Alive messages: typically 2 Hz from firmware (500 ms).
          - Status messages: type-131 @ ~2 Hz.
          - Serial reconnect attempts: measure actual drop/recovery latency.

        On field test:
          1. Capture healthy baseline: `ros2 topic echo /esp32/bridge_health`
          2. Unplug ESP32 USB for 3 s, confirm STALE published within 2.5 s.
          3. Re-plug USB, confirm HEALTHY re-published within 5 s.
        """
        now = time.time()
        freshness_window_s = 2.0  # @field-tune: set from alive/status publish rate
        alive_age = now - self._last_alive_time if self._last_alive_time else float('inf')
        status_age = now - self._last_status_time if self._last_status_time else float('inf')
        health = 'HEALTHY' if (alive_age < freshness_window_s or status_age < freshness_window_s) else 'STALE'
        self._health_pub.publish(String(data=json.dumps({
            'health': health,
            'last_alive_age_s': round(alive_age, 2),
            'last_status_age_s': round(status_age, 2),
            'ts': now,
        })))

    # ── Command gateway (ROS → ESP32) ──────────────────────────────────────

    def _on_cmd(self, msg: String) -> None:
        """Receive a command from /esp32/cmd, validate, and enqueue."""
        try:
            cmd = json.loads(msg.data)
        except json.JSONDecodeError:
            self.get_logger().warn(f'malformed cmd: {msg.data[:80]!r}')
            self._rejected_total += 1
            return

        command = cmd.get('cmd')
        if command not in ALLOWED_COMMANDS:
            self.get_logger().warn(f'unknown command {command!r}')
            self._rejected_total += 1
            self._emit_cmd_status('rejected', command, reason='unknown command')
            return

        # Priority commands go directly to front of queue
        if command in PRIORITY_COMMANDS:
            self._cmd_q.appendleft(cmd)
            self._accepted_total += 1
            return

        # Coalesce `move` — keep only the latest pending move frame
        if command in COALESCE_COMMANDS:
            self._last_pending_move = cmd
            return

        # Everything else goes to the back
        if len(self._cmd_q) >= self._cmd_q.maxlen:
            # Non-move, non-priority overflow — drop oldest
            self._cmd_q.popleft()
            self._dropped_total += 1

        self._cmd_q.append(cmd)
        self._accepted_total += 1

    def _drain_commands(self) -> list[dict]:
        """Drain up to _MAX_DRAIN_PER_TICK commands, coalescing pending move.

        Called by _poll_commands every timer tick.
        Returns the commands to send this tick.
        """
        out: list[dict] = []

        # Drain normal queue (FIFO)
        drained = 0
        while self._cmd_q and drained < _MAX_DRAIN_PER_TICK:
            cmd = self._cmd_q.popleft()
            if cmd.get('cmd') in COALESCE_COMMANDS:
                # Replace with the latest pending move (if any)
                self._last_pending_move = cmd
                continue
            out.append(cmd)
            drained += 1

        # Coalesce: append only the single latest `move` at the end
        if self._last_pending_move is not None:
            out.append(self._last_pending_move)
            self._last_pending_move = None

        # Overflow tracking
        q_depth = len(self._cmd_q)
        now = time.time()
        if q_depth > 2:
            self._overload_history.append(now)
        # Trim old entries
        while self._overload_history and (now - self._overload_history[0]) > _OVERLOAD_DEQUE_WINDOW:
            self._overload_history.popleft()

        recent = len(self._overload_history)
        sustained = recent > 4

        if sustained and not self._overflow_active:
            self._overflow_active = True
            self.get_logger().error(
                f'SUSTAINED OVERLOAD: queue depth={q_depth} — motion paused')
        elif not sustained and self._overflow_active and q_depth <= _RECOVERY_BELOW_WATERMARK:
            self._overflow_active = False
            self.get_logger().info('Overload cleared — motion resumed')

        return out

    def _publish_cmd_status(self, status: str, cmd: str, reason: str = '',
                            overflow: bool = False) -> None:
        payload = {
            'ts': time.time(),
            'status': status,
            'cmd': cmd,
            'queue_depth': len(self._cmd_q),
            'dropped_total': self._dropped_total,
            'accepted_total': self._accepted_total,
            'overflow': overflow or self._overflow_active,
        }
        if reason:
            payload['reason'] = reason
        self._cmd_status_pub.publish(String(data=json.dumps(payload)))

    def _emit_cmd_status(self, status: str, cmd: str, reason: str = '') -> None:
        self._publish_cmd_status(status, cmd, reason=reason, overflow=self._overflow_active)

    def _poll_commands(self) -> None:
        """Drain queued commands and forward to bridge via asyncio."""
        if self._bridge is None:
            return

        commands = self._drain_commands()

        loop = asyncio.get_event_loop()
        for cmd in commands:
            command = cmd.get('cmd', '?')
            if self._overflow_active and command in COALESCE_COMMANDS:
                self.get_logger().warn(f'dropping {command} during sustained overload')
                self._dropped_total += 1
                continue
            try:
                loop.create_task(self._bridge.send_command(cmd))
                self._emit_cmd_status('accepted', command)
            except Exception as exc:
                self.get_logger().error(f'failed to send {command}: {exc}')
                self._rejected_total += 1


def _start_executor(node: Node) -> tuple[SingleThreadedExecutor, threading.Thread]:
    """Spin the node on a background thread; return (executor, thread)."""
    executor = SingleThreadedExecutor()
    executor.add_node(node)
    thread = threading.Thread(target=executor.spin, daemon=True, name='ros-spin')
    thread.start()
    return executor, thread


async def _heartbeat_loop(bridge: Any) -> None:
    """Keep the firmware watchdog alive from the sole serial owner."""
    while True:
        await asyncio.sleep(0.05)
        try:
            await bridge.heartbeat()
        except asyncio.CancelledError:
            raise
        except Exception:
            # Read/health paths report link failures; keep retrying writes.
            pass


async def _run_bridge(node: Esp32TelemetryNode) -> None:
    """Open serial, wire callbacks, hold until ROS is shut down.

    Command polling runs at 20 Hz to drain queued commands from /esp32/cmd
    and forward them to the bridge with overflow handling.
    """
    port = os.environ.get('ESP32_PORT', '/dev/robot-esp32')
    baud = int(os.environ.get('ESP32_BAUD', '115200'))
    node.get_logger().info(f'opening ESP32 bridge on {port} @ {baud}')

    bridge = await open_esp32_bridge(port=port, baudrate=baud)
    bridge.on_status_update = node.on_status_update
    bridge.on_encoder_update = node.on_encoder_update
    bridge.on_error = node.on_error
    bridge.on_imu = node.on_imu
    bridge.on_power = node.on_power
    bridge.on_unload_state = node.on_unload_state
    bridge.on_cargo = node.on_cargo
    bridge.on_alive = node.on_alive

    await bridge.connect()
    node._bridge = bridge
    heartbeat_task = asyncio.create_task(_heartbeat_loop(bridge))
    node.get_logger().info('ESP32 telemetry bridge connected — gateway active')

    try:
        while rclpy.ok():
            await asyncio.sleep(0.05)  # 20 Hz command drain
            node._poll_commands()
    finally:
        heartbeat_task.cancel()
        try:
            await heartbeat_task
        except asyncio.CancelledError:
            pass
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