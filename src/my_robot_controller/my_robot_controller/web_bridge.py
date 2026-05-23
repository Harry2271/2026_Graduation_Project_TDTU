#!/usr/bin/env python3
"""
web_bridge.py
WebSocket bridge node for robot-controller.

Subscribes to:
  /scan          -> cartesian {x, y} points
  /map           -> occupancy grid metadata + flat data
  /tf (map->base_footprint) -> robot pose {x, y, theta}
  /robot_status  -> robot state string

Publishes clean JSON to all connected WebSocket clients on port 9091.

Handles hot-plug gracefully: if lidar is unplugged, no scan messages are
sent; when it reconnects, scan messages resume automatically.

Message types (all JSON):
  { "type": "scan",   "data": { "points": [{x,y}, ...], "count": N } }
  { "type": "map",    "data": { "width", "height", "resolution",
                                 "origin_x", "origin_y", "origin_theta",
                                 "data": [0,0,100,...] } }
  { "type": "pose",   "data": { "x": 0.0, "y": 0.0, "theta": 0.0 } }
  { "type": "status", "data": "STATE=IDLE QR=none ..." }
  { "type": "ping" }                           # keepalive (sent every 5s)
  { "type": "info",   "data": { "lidar": true, "map": false, "pose": false } }
                                             # device availability snapshot
"""

import asyncio
import json
import math
import queue
import socket
import threading
import time
import signal
import sys

import rclpy
from rclpy.node import Node
from sensor_msgs.msg import LaserScan
from nav_msgs.msg import OccupancyGrid
from geometry_msgs.msg import TransformStamped
from std_msgs.msg import String
from tf2_ros import TransformListener, Buffer

HOST = '0.0.0.0'
PORT = 9091


class WebBridge(Node):
    def __init__(self, msg_queue: queue.Queue):
        super().__init__('web_bridge')
        self.msg_queue = msg_queue

        # Publisher for robot commands (web -> robot)
        self.cmd_pub = self.create_publisher(String, '/mapping/control', 10)

        # Device availability tracking
        self.lidar_seen: bool = False
        self.map_seen: bool = False
        self.pose_seen: bool = False
        self.mode: str = 'live'  # 'mapping' | 'live'
        self.coverage_pct: int = 0
        self.last_info_emit: float = 0.0

        # TF2: get robot pose in map frame
        self.tf_buffer = Buffer()
        self.tf_listener = TransformListener(self.tf_buffer, self)

        # Subscriptions — create them, they'll activate when topics are published
        self.create_subscription(LaserScan, '/scan', self._on_scan, 10)
        self.create_subscription(OccupancyGrid, '/map_combined', self._on_map, 10)
        self.create_subscription(String, '/robot_status', self._on_status, 10)
        self.create_subscription(String, '/mapping_status', self._on_mapping_status, 10)

        # Pose polling timer (10 Hz)
        self.create_timer(0.1, self._poll_pose)

        # Device info broadcast (every 5s)
        self.create_timer(5.0, self._broadcast_info)

        self.get_logger().info(f'WebBridge started — serving on ws://{HOST}:{PORT}')
        self.get_logger().info('Subscribed to /scan, /map_combined, /tf, /robot_status, /mapping_status')
        self.get_logger().info('Topics become active when devices are connected')

    def _emit(self, msg: dict):
        try:
            self.msg_queue.put_nowait(msg)
        except queue.Full:
            pass

    def _broadcast_info(self):
        now = time.time()
        if now - self.last_info_emit < 4.5:
            return
        self.last_info_emit = now
        self._emit({
            'type': 'info',
            'data': {
                'lidar': self.lidar_seen,
                'map': self.map_seen,
                'pose': self.pose_seen,
                'mode': self.mode,
                'coverage_pct': self.coverage_pct,
            }
        })

    def _on_scan(self, msg: LaserScan):
        self.lidar_seen = True
        points = []
        angle = msg.angle_min
        for r in msg.ranges:
            if not (math.isinf(r) or math.isnan(r)) and msg.range_min <= r <= msg.range_max:
                x = r * math.cos(angle)
                y = r * math.sin(angle)
                points.append({'x': round(x, 4), 'y': round(y, 4)})
            angle += msg.angle_increment

        self._emit({'type': 'scan', 'data': {'points': points, 'count': len(points)}})

    def _on_map(self, msg: OccupancyGrid):
        self.map_seen = True
        self._emit({
            'type': 'map',
            'data': {
                'width': msg.info.width,
                'height': msg.info.height,
                'resolution': msg.info.resolution,
                'origin_x': msg.info.origin.position.x,
                'origin_y': msg.info.origin.position.y,
                'origin_theta': float(self._euler_from_quat(
                    msg.info.origin.orientation.x,
                    msg.info.origin.orientation.y,
                    msg.info.origin.orientation.z,
                    msg.info.origin.orientation.w)),
                'data': list(msg.data),
            }
        })

    def _on_status(self, msg: String):
        self._emit({'type': 'status', 'data': msg.data})

    def _on_mapping_status(self, msg: String):
        # Parse "MAPPING: scanning..." | "LIVE: localizing" | "IDLE"
        data = msg.data
        if 'LIVE' in data or 'live' in data.lower():
            self.mode = 'live'
        elif 'MAPPING' in data or 'mapping' in data.lower():
            self.mode = 'mapping'
        else:
            self.mode = 'idle'
        self._emit({'type': 'mode', 'data': self.mode})
        self._emit({'type': 'status', 'data': data})

    def _poll_pose(self):
        try:
            t: TransformStamped = self.tf_buffer.lookup_transform(
                'map', 'base_footprint', rclpy.time.Time(), timeout=rclpy.duration.Duration(seconds=0.1))
            q = t.transform.rotation
            theta = self._euler_from_quat(q.x, q.y, q.z, q.w)
            self.pose_seen = True
            self._emit({
                'type': 'pose',
                'data': {
                    'x': round(t.transform.translation.x, 4),
                    'y': round(t.transform.translation.y, 4),
                    'theta': round(theta, 4),
                }
            })
        except Exception:
            # Pose not available — normal before SLAM converges
            pass

    @staticmethod
    def _euler_from_quat(x, y, z, w) -> float:
        siny_cosp = 2.0 * (w * y + z * x)
        cosy_cosp = 1.0 - 2.0 * (x * x + y * y)
        return math.atan2(siny_cosp, cosy_cosp)


# ---------------------------------------------------------------------------
# WebSocket server (runs in a separate thread, communicates via queue)
# ---------------------------------------------------------------------------

class WebSocketServer:
    def __init__(self, msg_queue: queue.Queue):
        self.msg_queue = msg_queue
        self.clients: set = set()
        self.lock = threading.Lock()
        self.running = True

    async def _ws_handler(self, ws, path=None):
        with self.lock:
            self.clients.add(ws)
        try:
            async for msg in ws:
                try:
                    cmd = json.loads(msg)
                    self._handle_command(cmd)
                except json.JSONDecodeError:
                    pass
        except Exception:
            pass
        finally:
            with self.lock:
                self.clients.discard(ws)

    def _handle_command(self, cmd: dict):
        """Forward commands from web client to ROS topics."""
        t = cmd.get('type', '')
        if t == 'ping':
            return
        if t == 'cmd':
            action = cmd.get('action', '')
            command = cmd.get('command', '')
            if action == 'mapping' and command:
                ros_cmd = String()
                ros_cmd.data = command
                self.cmd_pub.publish(ros_cmd)
                self.get_logger().info(f'Mapping command: {command}')

    async def _broadcast_loop(self):
        while self.running:
            try:
                msg = await asyncio.get_event_loop().run_in_executor(
                    None, self.msg_queue.get, True, 1.0)
                await self._send_all(json.dumps(msg))
            except queue.Empty:
                await asyncio.sleep(0.01)

    async def _ping_loop(self):
        while self.running:
            await asyncio.sleep(5)
            await self._send_all(json.dumps({'type': 'ping'}))

    async def _send_all(self, data: str):
        if not self.clients:
            return
        dead = set()
        for ws in list(self.clients):
            try:
                await ws.send(data)
            except Exception:
                dead.add(ws)
        with self.lock:
            for ws in dead:
                self.clients.discard(ws)

    async def _serve(self):
        import websockets
        async with websockets.serve(self._ws_handler, HOST, PORT) as server:
            asyncio.create_task(self._broadcast_loop())
            asyncio.create_task(self._ping_loop())
            # Keep server running — websockets.serve() keeps the context open
            await asyncio.Future()

    def run(self):
        asyncio.run(self._serve())


# ---------------------------------------------------------------------------
# Main: start rclpy node + WebSocket server in parallel threads
# ---------------------------------------------------------------------------

def main():
    msg_queue: queue.Queue = queue.Queue(maxsize=100)

    # --- ROS 2 node in a daemon thread ---
    def ros_thread():
        rclpy.init()
        node = WebBridge(msg_queue)
        executor = rclpy.executors.MultiThreadedExecutor()
        executor.add_node(node)
        try:
            executor.spin()
        finally:
            node.destroy_node()
            rclpy.shutdown()

    ros_t = threading.Thread(target=ros_thread, daemon=True)
    ros_t.start()

    # Give ROS 2 a moment to initialize
    time.sleep(1.0)

    # --- WebSocket server in main thread ---
    ws_server = WebSocketServer(msg_queue)
    print(f'[web_bridge] WebSocket server listening on ws://{HOST}:{PORT}')
    try:
        ws_server.run()
    except KeyboardInterrupt:
        ws_server.running = False


if __name__ == '__main__':
    main()
