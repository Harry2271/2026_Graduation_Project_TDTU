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
  info         | device availability + current mode                |  0.2 Hz
  ping         | keepalive                                         |  0.2 Hz
  ack          | acknowledgment for every received command         | on event

Commands (Frontend → Robot):
  { "type": "cmd", "command": "start" | "stop" | "idle" | "reset" }
"""
from __future__ import annotations

import asyncio
import gzip
import json
import math
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
    def __init__(self, msg_q: queue.Queue, cmd_q: queue.Queue) -> None:
        super().__init__('web_bridge')
        self.msg_q = msg_q
        self.cmd_q = cmd_q

        self.lidar_seen = False
        self.map_seen = False
        self.pose_seen = False
        self.mode = 'idle'

        # ── TF2 for pose extraction (replaces /odom subscription) ──────
        self.tf_buffer = Buffer()
        self.tf_listener = TransformListener(self.tf_buffer, self)

        # ── Throttle state ─────────────────────────────────────────────
        self._last_scan_sent_time: float = 0.0

        # ── Subscriptions ───────────────────────────────────────────────
        self.cmd_pub = self.create_publisher(String, '/mapping/control', 10)
        self.create_subscription(LaserScan, '/scan', self._on_scan, 10)
        self.create_subscription(OccupancyGrid, '/map_combined', self._on_map_layer, 10)
        self.create_subscription(OccupancyGrid, '/obstacle_layer', self._on_obstacle_layer, 10)
        self.create_subscription(String, '/robot_status', self._on_status, 10)
        self.create_subscription(String, '/mapping_status', self._on_mapping_status, 10)

        # ── Timers ──────────────────────────────────────────────────────
        self.create_timer(5.0, self._broadcast_info)
        self.create_timer(0.1, self._poll_commands)
        self.create_timer(0.1, self._extract_and_emit_pose)  # 10 Hz pose from TF

        self.get_logger().info(f'WebBridge listening on ws://{HOST}:{PORT}')
        self._emit({'type': 'info', 'data': {
            'lidar': False, 'map': False, 'pose': False, 'mode': 'idle'}})

    # ── Emit helpers ───────────────────────────────────────────────────────────

    def _emit(self, msg: dict) -> None:
        try:
            self.msg_q.put(msg, block=False)
        except queue.Full:
            pass

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
            theta = math.atan2(2.0 * (q.w * q.z + q.x * q.x),
                               1.0 - 2.0 * (q.y * q.y + q.z * q.z))
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
        self._emit({'type': 'map_layer', 'data': {
            'width':       msg.info.width,
            'height':      msg.info.height,
            'resolution':  msg.info.resolution,
            'origin_x':    msg.info.origin.position.x,
            'origin_y':    msg.info.origin.position.y,
            'data':        list(msg.data),
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
        for ros_state, label in STATE_LABELS.items():
            if ros_state in raw.upper():
                new_mode = label
                break
        else:
            new_mode = 'idle'

        if new_mode != self.mode:
            self.mode = new_mode
            self.get_logger().info(f'Mode changed → {self.mode}')
        self._emit({'type': 'mode', 'data': self.mode})
        self._emit({'type': 'status', 'data': raw})

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
                self.get_logger().info(f'Command sent: {cmd}')
            except queue.Empty:
                break


class WSServer:
    def __init__(self, msg_q: queue.Queue, cmd_q: queue.Queue) -> None:
        self.msg_q = msg_q
        self.cmd_q = cmd_q
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

                    elif msg_type == 'ping':
                        pong = {'type': 'pong', 'data': {'ts': time.time()}}
                        try:
                            await connection.send(json.dumps(pong))
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
        async with websockets.serve(self.handler, HOST, PORT) as srv:
            print(f'[WS] Server on ws://{HOST}:{PORT}')
            await asyncio.gather(self.broadcast_loop(), srv.__aenter__())


def main() -> None:
    msg_q: queue.Queue = queue.Queue(maxsize=500)
    cmd_q: queue.Queue = queue.Queue(maxsize=20)

    def ros_spin() -> None:
        if rclpy.ok():
            rclpy.try_shutdown()
            time.sleep(0.5)
        rclpy.init()
        node = WebBridge(msg_q, cmd_q)
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

    srv = WSServer(msg_q, cmd_q)
    try:
        asyncio.run(srv.run())
    except KeyboardInterrupt:
        srv.running = False


if __name__ == '__main__':
    main()
