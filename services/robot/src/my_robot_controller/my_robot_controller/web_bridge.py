#!/usr/bin/env python3
"""
web_bridge — WebSocket server. ROS topics → JSON messages → browser.

After refactoring to slam_toolbox:
  - Pose comes from TF (map→base_footprint) instead of /odom.
  - No static TF broadcasting — slam_toolbox owns the full TF chain.
  - Gzip compression for large grid payloads.

Messages (Robot → Frontend):
  type          | content                                           | max rate
  -------------|---------------------------------------------------|----------
  scan         | robot-centric lidar point cloud                   |  5 Hz
  map_layer    | merged slam map + live overlay (LIVE) or raw slam  |  5 Hz
               | map (MAPPING)                                     |
  obstacle_layer| 2m awareness-zone grid (one-shot after stop)     | on event
  pose         | robot x, y, theta from TF                         | 10 Hz
  status       | human-readable state string                       | on change
  mode         | machine state (idle / mapping_active / live / etc)| on change
  esp32_status | raw ESP32 type-131 status frame                   | ~2 Hz
  esp32_encoder| raw ESP32 type-130 encoder snapshot               | on event
  esp32_imu    | BNO055 type-134 quaternion+accel+gyro+heading     |  20 Hz
  esp32_power  | INA226 type-133 voltage/current/power             |  0.2 Hz
  info         | device availability + current mode                |  0.2 Hz
  ping         | keepalive                                         |  0.2 Hz
  ack          | acknowledgment for every received command         | on event

Commands (Frontend → Robot):
  { "type": "cmd", "command": "start" | "stop" | "idle" | "reset" }
"""
from __future__ import annotations

import asyncio
import gzip
import hmac
import json
import math
import os
import queue
import sys
import time
import threading
from typing import Optional

import rclpy
from rclpy.node import Node
from rclpy.time import Time
from sensor_msgs.msg import LaserScan
from nav_msgs.msg import OccupancyGrid
from std_msgs.msg import String
from geometry_msgs.msg import Twist
from tf2_ros import Buffer, TransformListener

HOST = '0.0.0.0'
PORT = 9091

# ── Web throttle ──────────────────────────────────────────────────────────────
MAX_SCAN_RATE_HZ = 5.0
MIN_SCAN_INTERVAL = 1.0 / MAX_SCAN_RATE_HZ

# ── State labels ──────────────────────────────────────────────────────────────
STATE_LABELS = {
    'IDLE':           'idle',
    'MAPPING_IDLE':   'mapping_idle',
    'MAPPING_ACTIVE': 'mapping_active',
    'SCAN_OBSTACLE':  'scan_obstacle',
    'LIVE':           'live',
}


class WebBridge(Node):
    def __init__(self, msg_q: queue.Queue, cmd_q: queue.Queue,
                 teleop_q: queue.Queue, cylinder_q: queue.Queue,
                 demo_q: queue.Queue, esp32_cmd_q: queue.Queue,
                 navigate_q: queue.Queue) -> None:
        super().__init__('web_bridge')
        self.msg_q = msg_q
        self.cmd_q = cmd_q
        self.teleop_q = teleop_q
        self.cylinder_q = cylinder_q
        self.demo_q = demo_q
        self.esp32_cmd_q = esp32_cmd_q
        self.navigate_q = navigate_q

        self.lidar_seen = False
        self.map_seen = False
        self.pose_seen = False
        self.mode = 'idle'
        self._control_mode = 'MANUAL'
        self._control_mode_pub = self.create_publisher(String, '/control/mode', 10)
        self._control_mode_status_pub = self.create_publisher(String, '/control/mode_status', 10)
        self.create_subscription(String, '/control/mode_status', self._on_control_mode_status, 10)

        # ── TF2 for pose extraction (replaces /odom subscription) ──────
        self.tf_buffer = Buffer()
        self.tf_listener = TransformListener(self.tf_buffer, self)

        # ── Throttle state ─────────────────────────────────────────────
        self._last_scan_sent_time: float = 0.0

        # ── Subscriptions ───────────────────────────────────────────────
        self.cmd_pub = self.create_publisher(String, '/mapping/control', 10)
        # Keyboard teleop from map page: web_bridge Twists → teleop_node → ESP32
        self.teleop_pub = self.create_publisher(Twist, '/cmd_vel', 10)
        # Cylinder commands: web_bridge → teleop_node (which owns serial port)
        self.cylinder_pub = self.create_publisher(String, '/cylinder_cmd', 10)
        # Direct ESP32 commands from web/desktop clients (stop, e_stop).
        self.esp32_cmd_pub = self.create_publisher(String, '/esp32/cmd', 10)
        # Demo commands/status for the four delivery zones.
        self.demo_cmd_pub = self.create_publisher(String, '/demo/cmd', 10)
        self.create_subscription(String, '/demo/status', self._on_demo_status, 10)
        # Navigate commands: web_bridge → brain_node, and brain_node → results back.
        self._navigate_cmd_pub = self.create_publisher(String, '/brain/navigate_cmd', 10)
        self.create_subscription(String, '/brain/navigate_status', self._on_navigate_status, 10)
        self.create_subscription(String, '/brain/navigate_result', self._on_navigate_result, 10)
        self.create_subscription(LaserScan, '/scan', self._on_scan, 10)
        self.create_subscription(OccupancyGrid, '/map_combined', self._on_map_layer, 10)
        self.create_subscription(OccupancyGrid, '/obstacle_layer', self._on_obstacle_layer, 10)
        self.create_subscription(String, '/robot_status', self._on_status, 10)
        self.create_subscription(String, '/mapping_status', self._on_mapping_status, 10)
        self.create_subscription(String, '/esp32/status', self._on_esp32_status, 10)
        self.create_subscription(String, '/esp32/encoder', self._on_esp32_encoder, 10)
        self.create_subscription(String, '/esp32/imu', self._on_esp32_imu, 10)
        self.create_subscription(String, '/esp32/power', self._on_esp32_power, 10)
        self.create_subscription(String, '/detected_tags', self._on_detected_tags, 10)
        self.create_subscription(String, '/robot/errors', self._on_robot_errors, 10)

        # ── Timers ──────────────────────────────────────────────────────
        self.create_timer(5.0, self._broadcast_info)
        self.create_timer(0.1, self._poll_commands)
        self.create_timer(0.05, self._poll_teleop)
        self.create_timer(0.05, self._poll_cylinder)
        self.create_timer(0.1, self._poll_demo)
        self.create_timer(0.05, self._poll_esp32_cmd)
        self.create_timer(0.1, self._poll_navigate)
        self.create_timer(0.1, self._extract_and_emit_pose)  # 10 Hz pose from TF

        self.get_logger().info(f'WebBridge listening on ws://{HOST}:{PORT}')
        self._emit({'type': 'info', 'data': {
            'lidar': False, 'map': False, 'pose': False, 'mode': 'idle'}})

    def _poll_navigate(self) -> None:
        """Publish the newest operator navigation goal to brain_node."""
        command = None
        while True:
            try:
                command = self.navigate_q.get_nowait()
            except queue.Empty:
                break
        if command is not None:
            self._navigate_cmd_pub.publish(String(data=json.dumps(command)))
            self.get_logger().info(f'Navigate command → /brain/navigate_cmd: {command}')

    def _on_navigate_status(self, msg: String) -> None:
        """Forward navigation progress from brain_node to WebSocket clients."""
        try:
            data = json.loads(msg.data)
        except json.JSONDecodeError:
            data = {'state': msg.data}
        self._emit({'type': 'navigate_status', 'data': data})

    def _on_navigate_result(self, msg: String) -> None:
        """Forward the terminal navigation result from brain_node."""
        try:
            data = json.loads(msg.data)
        except json.JSONDecodeError:
            data = {'success': False, 'error': msg.data}
        self._emit({'type': 'navigate_result', 'data': data})

    # ── Emit helpers ───────────────────────────────────────────────────────────

    def _emit(self, msg: dict) -> None:
        try:
            self.msg_q.put(msg, block=False)
        except queue.Full:
            pass

    def _on_control_mode_status(self, msg: String) -> None:
        """Forward mode status from brain/teleop to WebSocket clients."""
        try:
            data = json.loads(msg.data)
        except json.JSONDecodeError:
            data = {'mode': msg.data}
        mode = data.get('mode') if isinstance(data, dict) else None
        if isinstance(mode, str):
            self._control_mode = mode.upper()
        self._emit({'type': 'control_mode_status', 'data': data})

    # ── Pose extraction from TF (replaces /odom subscription) ─────────────────

    def _extract_and_emit_pose(self) -> None:
        """Look up map→base_footprint from slam_toolbox's TF tree."""
        try:
            tf = self.tf_buffer.lookup_transform(
                'map', 'base_footprint', Time())
            self.pose_seen = True
            x = tf.transform.translation.x
            y = tf.transform.translation.y
            q = tf.transform.rotation
            # Correct yaw formula: siny_cosp = 2*(qw*qz + qx*qy)
            siny_cosp = 2.0 * (q.w * q.z + q.x * q.y)
            cosy_cosp = 1.0 - 2.0 * (q.y * q.y + q.z * q.z)
            theta = math.atan2(siny_cosp, cosy_cosp)
            self._emit({'type': 'pose', 'data': {
                'x': round(x, 4),
                'y': round(y, 4),
                'theta': round(theta, 4),
            }})
        except Exception:
            pass  # TF not yet available — slam_toolbox may not have started

    # ── Scan — throttled to MAX_SCAN_RATE_HZ ──────────────────────────────────

    def _on_scan(self, msg: LaserScan) -> None:
        self.lidar_seen = True

        now = time.monotonic()
        if now - self._last_scan_sent_time < MIN_SCAN_INTERVAL:
            return
        self._last_scan_sent_time = now

        pts = []
        angle = msg.angle_min
        for r in msg.ranges:
            if not (math.isinf(r) or math.isnan(r)) and msg.range_min <= r <= msg.range_max:
                pts.append({'x': round(r * math.cos(angle), 4),
                            'y': round(r * math.sin(angle), 4)})
            angle += msg.angle_increment
        self._emit({'type': 'scan', 'data': {'points': pts, 'count': len(pts)}})

    # ── Map layer ─────────────────────────────────────────────────────────────

    def _on_map_layer(self, msg: OccupancyGrid) -> None:
        self.map_seen = True
        q = msg.info.origin.orientation
        # Correct yaw formula: siny_cosp = 2*(qw*qz + qx*qy)
        siny_cosp = 2.0 * (q.w * q.z + q.x * q.y)
        cosy_cosp = 1.0 - 2.0 * (q.y * q.y + q.z * q.z)
        origin_theta = math.atan2(siny_cosp, cosy_cosp)
        data_list = list(msg.data)
        self.get_logger().debug(
            f'map_layer: {msg.info.width}x{msg.info.height} '
            f'res={msg.info.resolution} cells={len(data_list)}')
        self._emit({'type': 'map_layer', 'data': {
            'width':        msg.info.width,
            'height':       msg.info.height,
            'resolution':   msg.info.resolution,
            'origin_x':     msg.info.origin.position.x,
            'origin_y':     msg.info.origin.position.y,
            'origin_theta': round(origin_theta, 6),
            'data':         data_list,
        }})

    # ── Obstacle awareness-zone layer ──────────────────────────────────────────

    def _on_obstacle_layer(self, msg: OccupancyGrid) -> None:
        self._emit({'type': 'obstacle_layer', 'data': {
            'width':       msg.info.width,
            'height':      msg.info.height,
            'resolution':  msg.info.resolution,
            'origin_x':    msg.info.origin.position.x,
            'origin_y':    msg.info.origin.position.y,
            'data':        list(msg.data),
        }})

    # ── Status ────────────────────────────────────────────────────────────────

    def _on_status(self, msg: String) -> None:
        self._emit({'type': 'status', 'data': msg.data})

    def _on_mapping_status(self, msg: String) -> None:
        raw = msg.data
        # Status strings are formatted as "STATE_NAME: <description>" by
        # map_manager_node._publish_status. Parse the underscored state name
        # from the prefix (substring match on the raw string used to break on
        # the colon, e.g. "MAPPING_IDLE" never appeared inside
        # "MAPPING: waiting...").
        prefix = raw.split(':', 1)[0].strip().upper()
        new_mode = STATE_LABELS.get(prefix, 'idle')

        if new_mode != self.mode:
            self.mode = new_mode
            self.get_logger().info(f'Mode changed → {self.mode}')
        self._emit({'type': 'mode', 'data': self.mode})
        self._emit({'type': 'status', 'data': raw})

    # ── ESP32 telemetry (from esp32_telemetry_node) ───────────────────────

    def _on_esp32_status(self, msg: String) -> None:
        """Forward ESP32 type-131 status to all WebSocket clients."""
        try:
            data = json.loads(msg.data)
        except json.JSONDecodeError:
            return
        self._emit({'type': 'esp32_status', 'data': data})

    def _on_esp32_encoder(self, msg: String) -> None:
        """Forward ESP32 type-130 encoder snapshot to all WebSocket clients."""
        try:
            data = json.loads(msg.data)
        except json.JSONDecodeError:
            return
        self._emit({'type': 'esp32_encoder', 'data': data})

    def _on_esp32_imu(self, msg: String) -> None:
        """Forward BNO055 type-134 telemetry to all WebSocket clients.

        The trajectory page consumes this as ``esp32_imu``.  Keep the
        payload unchanged so quaternion, acceleration, gyro and calibration
        fields remain available for the browser-side 3D integrator.
        """
        try:
            data = json.loads(msg.data)
        except json.JSONDecodeError:
            return
        self._emit({'type': 'esp32_imu', 'data': data})

    def _on_esp32_power(self, msg: String) -> None:
        """Forward INA226 type-133 power telemetry to all WebSocket clients.

        Payload includes bus_v (mV), current_ma (mA), power_mw (mW).
        Browser computes battery % from bus_v using a Li-ion 3S curve.
        """
        try:
            data = json.loads(msg.data)
        except json.JSONDecodeError:
            return
        self._emit({'type': 'esp32_power', 'data': data})

    def _on_detected_tags(self, msg: String) -> None:
        """Forward AprilTag detection to all WebSocket clients.

        The ``april_tag_node`` publishes JSON on ``/detected_tags`` with
        a root timestamp and a ``tags`` array.  Each item contains the
        camera-frame pose (tag_id, x, y, z, yaw, pitch, roll, confidence,
        size_m).  Legacy single-tag payloads are forwarded unchanged too.
        """
        try:
            data = json.loads(msg.data)
        except json.JSONDecodeError:
            return
        self._emit({'type': 'detected_tags', 'data': data})

    def _on_robot_errors(self, msg: String) -> None:
        """Forward brain error/warning events to all WebSocket clients."""
        try:
            data = json.loads(msg.data)
        except json.JSONDecodeError:
            data = {'severity': 'error', 'code': 'UNKNOWN', 'message': msg.data}
        self._emit({'type': 'robot_error', 'data': data})

    # ── Info ───────────────────────────────────────────────────────────────────

    def _broadcast_info(self) -> None:
        self._emit({'type': 'info', 'data': {
            'lidar': self.lidar_seen,
            'map':   self.map_seen,
            'pose':  self.pose_seen,
            'mode':  self.mode,
        }})

    # ── Commands ───────────────────────────────────────────────────────────────

    def _poll_commands(self) -> None:
        while True:
            try:
                cmd = self.cmd_q.get_nowait()
                self.cmd_pub.publish(String(data=cmd))
                self.get_logger().info(f'Command sent to /mapping/control: {cmd}')
            except queue.Empty:
                break
            except Exception as e:
                self.get_logger().error(f'Failed to publish command {cmd!r}: {e}')

    def _poll_teleop(self) -> None:
        """Drain teleop queue (latest-wins) and publish a single Twist on /cmd_vel."""
        vx = vy = omega = 0
        has_frame = False
        while True:
            try:
                vx, vy, omega = self.teleop_q.get_nowait()
                has_frame = True
            except queue.Empty:
                break
        if has_frame:
            t = Twist()
            t.linear.x = float(vx) / 200.0   # teleop_node scales: vx = msg.linear.x * max_vx(200)
            t.linear.y = float(vy) / 200.0
            t.angular.z = float(omega) * math.pi / 200.0
            self.teleop_pub.publish(t)

    def _poll_cylinder(self) -> None:
        """Drain cylinder queue (latest-wins) and publish String on /cylinder_cmd."""
        action = None
        while True:
            try:
                action = self.cylinder_q.get_nowait()
            except queue.Empty:
                break
        if action is not None:
            self.cylinder_pub.publish(String(data=action))
            self.get_logger().info(f'Cylinder command → /cylinder_cmd: {action}')

    def _on_demo_status(self, msg: String) -> None:
        """Forward brain demo status to WebSocket clients."""
        try:
            self._emit({'type': 'demo_status', 'data': json.loads(msg.data)})
        except json.JSONDecodeError:
            self._emit({'type': 'demo_status', 'data': {'state': msg.data}})

    def _poll_demo(self) -> None:
        """Publish the latest demo command to brain_node."""
        command = None
        while True:
            try:
                command = self.demo_q.get_nowait()
            except queue.Empty:
                break
        if command is not None:
            self.demo_cmd_pub.publish(String(data=command))
            self.get_logger().info(f'Demo command → /demo/cmd: {command}')

    def _poll_esp32_cmd(self) -> None:
        """Drain esp32 command queue and publish to /esp32/cmd."""
        cmd = None
        while True:
            try:
                cmd = self.esp32_cmd_q.get_nowait()
            except queue.Empty:
                break
        if cmd is not None:
            self.esp32_cmd_pub.publish(String(data=cmd))
            self.get_logger().info(f'ESP32 command → /esp32/cmd: {cmd}')


def _unauthorized(reason: str = 'Unauthorized'):
    """Return a websockets 13+ HTTP response object rejecting the handshake."""
    from websockets.datastructures import Headers
    from websockets.http11 import Response
    return Response(
        status_code=401,
        reason_phrase='Unauthorized',
        headers=Headers(),
        body=reason.encode('utf-8'),
    )


class WSServer:
    def __init__(self, msg_q: queue.Queue, cmd_q: queue.Queue,
                 teleop_q: queue.Queue, cylinder_q: queue.Queue,
                 demo_q: queue.Queue, esp32_cmd_q: queue.Queue,
                 navigate_q: queue.Queue) -> None:
        self.msg_q = msg_q
        self.cmd_q = cmd_q
        self.teleop_q = teleop_q      # (vx, vy, omega) tuples from browser keyboard
        self.cylinder_q = cylinder_q   # 'extend'|'retract'|'stop' strings
        self.demo_q = demo_q            # 'A'|'B'|'C'|'D'|'full'|'stop' strings
        self.esp32_cmd_q = esp32_cmd_q  # direct ESP32 commands (JSON strings)
        self.navigate_q = navigate_q    # {'x': float, 'y': float, 'theta': float}
        self.clients: set = set()
        self.running = True

    async def handler(self, connection) -> None:
        addr = str(connection.remote_address)
        print(f'[WS] + {addr}')
        self.clients.add(connection)
        try:
            async for raw in connection:
                raw_str = raw.decode('utf-8', errors='replace') if isinstance(raw, bytes) else str(raw)
                print(f'[WS] ← {addr}: {raw_str[:300]}')

                try:
                    msg = json.loads(raw_str)
                    msg_type = msg.get('type', '(no type)')

                    if msg_type == 'cmd':
                        command = msg.get('command', '(no command)')
                        print(f'[WS] CMD received: command={command!r}')

                        valid_commands = {'start', 'stop', 'idle', 'reset'}
                        if command in valid_commands:
                            try:
                                self.cmd_q.put_nowait(command)
                                print(f'[WS] CMD queued → /mapping/control: {command}')
                                ack = {'type': 'ack', 'data': {
                                    'command': command, 'accepted': True, 'queued': True,
                                }}
                            except queue.Full:
                                ack = {'type': 'ack', 'data': {
                                    'command': command, 'accepted': False,
                                    'error': 'command queue full',
                                }}
                        else:
                            ack = {'type': 'ack', 'data': {
                                'command': command, 'accepted': False,
                                'error': f'unknown command: {command!r}',
                            }}

                        try:
                            await connection.send(json.dumps(ack))
                        except Exception as send_err:
                            print(f'[WS] ack send failed: {send_err}')

                    elif msg_type == 'teleop':
                        # Keyboard teleop from /map page.
                        # Only accepted in MANUAL mode.
                        if self._control_mode != 'MANUAL':
                            continue
                        # Expect: { type: "teleop", vx, vy, omega }  (all numbers, may be floats)
                        # We coerce to ints in [-255, 255] and queue them.
                        # Latest-wins semantics: pollers drain the queue once per
                        # tick, so a backlog of stale keyframes is dropped.
                        try:
                            vx = int(msg.get('vx', 0))
                            vy = int(msg.get('vy', 0))
                            omega = int(msg.get('omega', 0))
                        except (TypeError, ValueError):
                            vx, vy, omega = 0, 0, 0
                        vx = max(-255, min(255, vx))
                        vy = max(-255, min(255, vy))
                        omega = max(-255, min(255, omega))
                        # Drop everything except the freshest frame
                        while True:
                            try:
                                self.teleop_q.get_nowait()
                            except queue.Empty:
                                break
                        try:
                            self.teleop_q.put_nowait((vx, vy, omega))
                        except queue.Full:
                            pass
                        # No ack — keyboard teleop is fire-and-forget

                    elif msg_type == 'cylinder':
                        # Cylinder keyboard control from /map page.
                        # Expect: { type: "cylinder", action: "extend"|"retract"|"stop" }
                        action = msg.get('action', '')
                        if action in ('extend', 'retract', 'stop'):
                            # Drop stale frames; only keep the latest
                            while True:
                                try:
                                    self.cylinder_q.get_nowait()
                                except queue.Empty:
                                    break
                            try:
                                self.cylinder_q.put_nowait(action)
                            except queue.Full:
                                pass
                        else:
                            print(f'[WS] cylinder: unknown action {action!r}')

                    elif msg_type == 'control_mode':
                        # Auto/Manual switch from /map page.
                        # Payload: { type: 'control_mode', mode: 'AUTO'|'MANUAL' }
                        requested = str(msg.get('mode', '')).strip().upper()
                        if requested in ('AUTO', 'MANUAL'):
                            self._control_mode = requested
                            self._control_mode_pub.publish(String(data=requested))
                            ack = {'type': 'ack', 'data': {
                                'command': f'mode:{requested}', 'accepted': True}}
                        else:
                            ack = {'type': 'ack', 'data': {
                                'command': f'mode:{requested}', 'accepted': False,
                                'error': 'invalid mode'}}
                        try:
                            await connection.send(json.dumps(ack))
                        except Exception as send_err:
                            print(f'[WS] control_mode ack send failed: {send_err}')

                    elif msg_type == 'demo':
                        # Four-zone delivery demo commands.
                        # Only accepted in AUTO mode.
                        # Payload: { type: 'demo', action: 'A'|'B'|'C'|'D'|'full'|'stop' }
                        #         { type: 'demo', action: 'warehouse' }
                        #         { type: 'demo', action: 'warehouse 0 1 2' }
                        if self._control_mode != 'AUTO':
                            ack = {'type': 'ack', 'data': {
                                'command': 'demo', 'accepted': False,
                                'error': f'mode is {self._control_mode}, not AUTO'}}
                            try:
                                await connection.send(json.dumps(ack))
                            except Exception:
                                pass
                            continue
                        action = str(msg.get('action', '')).strip()
                        normalized_action = action.upper()
                        valid_demo = {'A', 'B', 'C', 'D', 'FULL', 'STOP',
                                      'WAREHOUSE'}
                        warehouse_command = normalized_action == 'WAREHOUSE' or normalized_action.startswith('WAREHOUSE ')
                        if normalized_action in valid_demo or warehouse_command:
                            action = normalized_action
                            while True:
                                try:
                                    self.demo_q.get_nowait()
                                except queue.Empty:
                                    break
                            try:
                                self.demo_q.put_nowait(action)
                                ack = {'type': 'ack', 'data': {
                                    'command': f'demo:{action}', 'accepted': True}}
                            except queue.Full:
                                ack = {'type': 'ack', 'data': {
                                    'command': f'demo:{action}', 'accepted': False,
                                    'error': 'queue full'}}
                        else:
                            ack = {'type': 'ack', 'data': {
                                'command': f'demo:{action}', 'accepted': False,
                                'error': f'invalid demo action {action!r}'}}
                        try:
                            await connection.send(json.dumps(ack))
                        except Exception as send_err:
                            print(f'[WS] demo ack send failed: {send_err}')

                    elif msg_type == 'esp32':
                        # Direct ESP32 command from operator (desktop app or web).
                        # Payload: { type: 'esp32', cmd: {cmd: 'stop'|'e_stop'|...} }
                        # Always accepted regardless of mode (safety override).
                        allowed = {'stop', 'e_stop', 'e_stop_clear',
                                   'heartbeat', 'get_encoder'}
                        cmd_obj = msg.get('cmd')
                        if not isinstance(cmd_obj, dict):
                            ack = {'type': 'ack', 'data': {
                                'command': 'esp32', 'accepted': False,
                                'error': 'cmd must be a JSON object'}}
                        elif cmd_obj.get('cmd') not in allowed:
                            ack = {'type': 'ack', 'data': {
                                'command': 'esp32', 'accepted': False,
                                'error': f'cmd not allow-listed: {cmd_obj.get("cmd")!r}'}}
                        else:
                            # Drop stale frames; only keep the latest
                            while True:
                                try:
                                    self.esp32_cmd_q.get_nowait()
                                except queue.Empty:
                                    break
                            try:
                                self.esp32_cmd_q.put_nowait(
                                    json.dumps(cmd_obj))
                                ack = {'type': 'ack', 'data': {
                                    'command': f'esp32:{cmd_obj.get("cmd")}',
                                    'accepted': True}}
                            except queue.Full:
                                ack = {'type': 'ack', 'data': {
                                    'command': f'esp32:{cmd_obj.get("cmd")}',
                                    'accepted': False,
                                    'error': 'queue full'}}
                        try:
                            await connection.send(json.dumps(ack))
                        except Exception as send_err:
                            print(f'[WS] esp32 ack send failed: {send_err}')

                    elif msg_type == 'ping':
                        pong = {'type': 'pong', 'data': {'ts': time.time()}}
                        try:
                            await connection.send(json.dumps(pong))
                        except Exception:
                            pass

                    elif msg_type in ('navigate', 'navigate_home'):
                        # Operator-initiated Nav2 goal from desktop / browser.
                        # Only accepted in AUTO mode.
                        # Payload (navigate): { x, y, theta }
                        # Payload (navigate_home): { } — brain_node uses its captured home pose
                        if self._control_mode != 'AUTO':
                            ack = {'type': 'ack', 'data': {
                                'command': msg_type, 'accepted': False,
                                'error': f'mode is {self._control_mode}, not AUTO'}}
                            try:
                                await connection.send(json.dumps(ack))
                            except Exception:
                                pass
                            continue

                        if msg_type == 'navigate':
                            try:
                                x = float(msg.get('x', 0.0))
                                y = float(msg.get('y', 0.0))
                                theta = float(msg.get('theta', 0.0))
                            except (TypeError, ValueError):
                                x, y, theta = 0.0, 0.0, 0.0
                            command = {'action': 'navigate',
                                       'x': x, 'y': y, 'theta': theta}
                        else:
                            command = {'action': 'navigate_home'}

                        # Drop stale frames so latest-wins applies
                        while True:
                            try:
                                self.navigate_q.get_nowait()
                            except queue.Empty:
                                break
                        try:
                            self.navigate_q.put_nowait(command)
                            ack = {'type': 'ack', 'data': {
                                'command': msg_type, 'accepted': True,
                                'queued': True,
                                'goal': command}}
                        except queue.Full:
                            ack = {'type': 'ack', 'data': {
                                'command': msg_type, 'accepted': False,
                                'error': 'navigate queue full'}}
                        try:
                            await connection.send(json.dumps(ack))
                        except Exception as send_err:
                            print(f'[WS] {msg_type} ack send failed: {send_err}')

                    elif msg_type == 'custom_map':
                        # Client-side visualisation map: lines + grid.
                        # Stored by web_bridge as a forward to subscribers
                        # (e.g. brain_node could choose to display it on a
                        # debug topic). We accept and ack — data is preserved
                        # locally by the desktop app.
                        data = msg.get('data', {}) if isinstance(msg, dict) else {}
                        if not isinstance(data, dict):
                            data = {}
                        ack = {'type': 'ack', 'data': {
                            'command': 'custom_map', 'accepted': True,
                            'lines': len(data.get('lines', []))}}
                        try:
                            await connection.send(json.dumps(ack))
                        except Exception:
                            pass

                    else:
                        print(f'[WS] unhandled type: {msg_type!r}')

                except json.JSONDecodeError as e:
                    print(f'[WS] JSON parse error: {e}')
                except queue.Full:
                    print('[WS] queue full — dropped message')
        except Exception as e:
            print(f'[WS] {addr} error: {e}', file=sys.stderr)
        finally:
            self.clients.discard(connection)
            print(f'[WS] - {addr}')

    async def broadcast_loop(self) -> None:
        while self.running:
            batch = []
            while True:
                try:
                    batch.append(self.msg_q.get_nowait())
                except queue.Empty:
                    break
            if batch and self.clients:
                for ws in list(self.clients):
                    for m in batch:
                        try:
                            payload = json.dumps(m)
                            # Compress grid messages (~1.5 MB raw → ~50 KB compressed)
                            if m.get('type') in ('map_layer', 'obstacle_layer'):
                                payload = gzip.compress(payload.encode(), compresslevel=1)
                            await ws.send(payload)
                        except Exception:
                            self.clients.discard(ws)
            await asyncio.sleep(0.05)

    async def run(self) -> None:
        import websockets

        expected_token = os.environ.get('WS_AUTH_TOKEN') \
            or os.environ.get('ROBOT_BRAIN_TOKEN', '')

        if not expected_token:
            print(
                '[WS] FATAL: WS_AUTH_TOKEN/ROBOT_BRAIN_TOKEN not set — '
                'rejecting ALL connections (port 9091 will not accept '
                'handshakes). Set WS_AUTH_TOKEN in deploy.sh before boot.',
                file=sys.stderr,
            )

        async def process_request(connection, request):
            """Reject the WebSocket handshake unless a valid token is supplied.

            Reads the token from (in order):
              1. URL query parameter ``?token=<value>``
              2. ``Authorization: Bearer <token>`` header
              3. ``Sec-WebSocket-Protocol: bearer, <token>`` subprotocol

            If ``WS_AUTH_TOKEN`` / ``ROBOT_BRAIN_TOKEN`` is unset the server
            rejects every connection — fail-closed rather than fail-open.
            """
            addr = str(connection.remote_address)

            if not expected_token:
                print(f'[WS] + rejected {addr} — no auth token configured',
                      file=sys.stderr)
                return _unauthorized('auth token not configured')

            # 1. Query string
            provided = self._extract_token_from_query(request.path)
            # 2. Authorization header
            if not provided:
                auth_header = self._get_header(request.headers, 'authorization')
                if auth_header and auth_header.lower().startswith('bearer '):
                    provided = auth_header[7:].strip()
            # 3. Sec-WebSocket-Protocol
            if not provided:
                proto = self._get_header(request.headers, 'sec-websocket-protocol')
                provided = self._extract_token_from_subprotocol(proto)

            if provided and hmac.compare_digest(provided, expected_token):
                return None  # accept

            print(f'[WS] + rejected {addr} — invalid or missing token',
                  file=sys.stderr)
            return _unauthorized('invalid or missing auth token')

        async with websockets.serve(
            self.handler,
            HOST,
            PORT,
            process_request=process_request,
        ) as srv:
            print(f'[WS] Server on ws://{HOST}:{PORT} (auth={("on" if expected_token else "OFF — REJECTING")})')
            await asyncio.gather(self.broadcast_loop(), srv.__aenter__())

    @staticmethod
    def _get_header(headers, name: str) -> Optional[str]:
        """Case-insensitive header lookup over websockets Headers / list of tuples."""
        if headers is None:
            return None
        try:
            return headers.get(name)
        except Exception:
            pass
        for k, v in headers:
            if k.lower() == name.lower():
                return v
        return None

    @staticmethod
    def _extract_token_from_query(path: str) -> Optional[str]:
        """Pull ?token=... from a request path (handles ?token=a&other=b)."""
        if not path:
            return None
        query_start = path.find('?')
        if query_start < 0:
            return None
        from urllib.parse import parse_qs
        qs = parse_qs(path[query_start + 1:])
        vals = qs.get('token') or []
        return vals[0] if vals else None

    @staticmethod
    def _extract_token_from_subprotocol(header: Optional[str]) -> Optional[str]:
        """Read the token from ``Sec-WebSocket-Protocol: bearer, <token>``."""
        if not header:
            return None
        for raw in header.split(','):
            part = raw.strip()
            if part.lower().startswith('bearer '):
                return part[7:].strip()
        return None


def main() -> None:
    msg_q: queue.Queue = queue.Queue(maxsize=500)
    cmd_q: queue.Queue = queue.Queue(maxsize=20)
    teleop_q: queue.Queue = queue.Queue(maxsize=4)
    cylinder_q: queue.Queue = queue.Queue(maxsize=4)
    demo_q: queue.Queue = queue.Queue(maxsize=4)
    esp32_cmd_q: queue.Queue = queue.Queue(maxsize=4)
    navigate_q: queue.Queue = queue.Queue(maxsize=4)

    def ros_spin() -> None:
        if rclpy.ok():
            rclpy.try_shutdown()
            time.sleep(0.5)
        rclpy.init()
        node = WebBridge(msg_q, cmd_q, teleop_q, cylinder_q, demo_q, esp32_cmd_q, navigate_q)
        executor = rclpy.executors.MultiThreadedExecutor()
        executor.add_node(node)
        try:
            executor.spin()
        finally:
            node.destroy_node()
            try:
                rclpy.shutdown()
            except Exception:
                pass

    t = threading.Thread(target=ros_spin, daemon=True, name='ros-spin')
    t.start()
    time.sleep(2)

    srv = WSServer(msg_q, cmd_q, teleop_q, cylinder_q, demo_q, esp32_cmd_q, navigate_q)

    # UDP discovery beacon — replies to desktop apps asking "find_pi" on port 9090.
    async def _run_beacon() -> None:
        try:
            from .udp_beacon import DiscoveryBeacon
            async def _info() -> dict:
                return {'ws_port': 9091}
            beacon = DiscoveryBeacon(get_info=_info)
            await beacon.start()
        except Exception as exc:
            print(f'[UDP beacon] skipped: {exc}')

    asyncio.create_task(_run_beacon())

    try:
        asyncio.run(srv.run())
    except KeyboardInterrupt:
        srv.running = False


if __name__ == '__main__':
    main()
