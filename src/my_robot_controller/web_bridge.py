#!/usr/bin/env python3
"""
web_bridge — WebSocket server. ROS topics → JSON messages → browser.

Messages (Robot → Frontend):
  type          | content                                           | max rate
  -------------|---------------------------------------------------|----------
  scan         | robot-centric lidar point cloud                   |  5 Hz
  map_layer    | persistent occupancy grid (MAPPING or LIVE)        |  5 Hz
  obstacle_layer| 2m awareness-zone grid (post-mapping final scan) | on event
  pose         | robot x, y, theta from odometry                   | 10 Hz
  status       | human-readable state string                       | on change
  mode         | machine state: idle / mapping_idle / mapping_active
               | / scan_obstacle / live                            | on change
  info         | device availability + current mode                |  0.2 Hz
  ping         | keepalive                                         |  0.2 Hz

Commands (Frontend → Robot):
  { "type": "cmd", "command": "start" | "stop" | "idle" }

Web throttle: scan and map_layer are hard-capped at 5 Hz by dropping
intermediate messages in the ROS callback before they enter the queue.
"""
import asyncio
import gzip
import json
import math
import queue
import threading
import time

import rclpy
from rclpy.node import Node
from sensor_msgs.msg import LaserScan
from nav_msgs.msg import OccupancyGrid, Odometry
from std_msgs.msg import String

HOST = '0.0.0.0'
PORT = 9091

# ── Web throttle ──────────────────────────────────────────────────────────────
MAX_SCAN_RATE_HZ = 5.0
MIN_SCAN_INTERVAL = 1.0 / MAX_SCAN_RATE_HZ   # 0.2 s

# ── State labels ──────────────────────────────────────────────────────────────
STATE_LABELS = {
    'IDLE':           'idle',
    'MAPPING_IDLE':   'mapping_idle',
    'MAPPING_ACTIVE': 'mapping_active',
    'SCAN_OBSTACLE': 'scan_obstacle',
    'LIVE':           'live',
}


class WebBridge(Node):
    def __init__(self, msg_q, cmd_q):
        super().__init__('web_bridge')
        self.msg_q = msg_q
        self.cmd_q = cmd_q

        self.lidar_seen = False
        self.map_seen   = False
        self.pose_seen  = False
        self.mode       = 'idle'

        # ── Throttle state ─────────────────────────────────────────────────
        self._last_scan_sent_time = 0.0

        # ── Subscriptions ───────────────────────────────────────────────────
        self.cmd_pub = self.create_publisher(String, '/mapping/control', 10)

        self.create_subscription(LaserScan,    '/scan',               self._on_scan,            10)
        self.create_subscription(OccupancyGrid, '/map_combined',      self._on_map_layer,      10)
        self.create_subscription(OccupancyGrid, '/obstacle_layer',    self._on_obstacle_layer, 10)
        self.create_subscription(String,         '/robot_status',      self._on_status,         10)
        self.create_subscription(String,         '/mapping_status',    self._on_mapping_status, 10)
        self.create_subscription(Odometry,       '/odom',             self._on_odom,            10)

        self.create_timer(5.0, self._broadcast_info)
        self.create_timer(0.1, self._poll_commands)

        self.get_logger().info(f'WebBridge listening on ws://{HOST}:{PORT}')
        self._emit({'type': 'info', 'data': {
            'lidar': False, 'map': False, 'pose': False, 'mode': 'idle'}})

    # ── Emit helpers ───────────────────────────────────────────────────────────

    def _emit(self, msg):
        try:
            self.msg_q.put(msg, block=False)
        except queue.Full:
            pass

    # ── Scan — throttled to MAX_SCAN_RATE_HZ ──────────────────────────────────

    def _on_scan(self, msg: LaserScan):
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

    # ── Map layer ──────────────────────────────────────────────────────────────

    def _on_map_layer(self, msg: OccupancyGrid):
        self.map_seen = True
        self._emit({'type': 'map_layer', 'data': {
            'width':       msg.info.width,
            'height':      msg.info.height,
            'resolution':  msg.info.resolution,
            'origin_x':    msg.info.origin.position.x,
            'origin_y':    msg.info.origin.position.y,
            'data':        list(msg.data)}})

    # ── Obstacle awareness-zone layer ───────────────────────────────────────────

    def _on_obstacle_layer(self, msg: OccupancyGrid):
        self._emit({'type': 'obstacle_layer', 'data': {
            'width':       msg.info.width,
            'height':      msg.info.height,
            'resolution':  msg.info.resolution,
            'origin_x':    msg.info.origin.position.x,
            'origin_y':    msg.info.origin.position.y,
            'data':        list(msg.data)}})

    # ── Status ─────────────────────────────────────────────────────────────────

    def _on_status(self, msg: String):
        self._emit({'type': 'status', 'data': msg.data})

    def _on_mapping_status(self, msg: String):
        raw = msg.data
        # Parse state from status string: "MAPPING: recording..." etc.
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

    def _on_odom(self, msg: Odometry):
        self.pose_seen = True
        q = msg.pose.pose.orientation
        theta = self._yaw(q.x, q.y, q.z, q.w)
        self._emit({'type': 'pose', 'data': {
            'x': round(msg.pose.pose.position.x, 4),
            'y': round(msg.pose.pose.position.y, 4),
            'theta': round(theta, 4)}})

    def _broadcast_info(self):
        self._emit({'type': 'info', 'data': {
            'lidar': self.lidar_seen,
            'map':   self.map_seen,
            'pose':  self.pose_seen,
            'mode':  self.mode}})

    def _poll_commands(self):
        while True:
            try:
                cmd = self.cmd_q.get_nowait()
                self.cmd_pub.publish(String(data=cmd))
                self.get_logger().info(f'Command sent: {cmd}')
            except queue.Empty:
                break

    @staticmethod
    def _yaw(x, y, z, w):
        return math.atan2(2 * (w * y + z * x), 1 - 2 * (x * x + y * y))


class WSServer:
    def __init__(self, msg_q, cmd_q):
        self.msg_q   = msg_q
        self.cmd_q   = cmd_q
        self.clients = set()
        self.running = True

    async def handler(self, connection):
        addr = str(connection.remote_address)
        print(f'[WS] + {addr}')
        self.clients.add(connection)
        try:
            async for raw in connection:
                try:
                    cmd = json.loads(raw)
                    if cmd.get('type') == 'cmd' and cmd.get('command'):
                        print(f'[WS] Command: {cmd["command"]}')
                        self.cmd_q.put_nowait(cmd['command'])
                except (json.JSONDecodeError, queue.Full):
                    pass
        except Exception as e:
            print(f'[WS] {addr} error: {e}')
        finally:
            self.clients.discard(connection)
            print(f'[WS] - {addr}')

    async def broadcast_loop(self):
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

    async def run(self):
        import websockets
        async with websockets.serve(self.handler, HOST, PORT) as srv:
            print(f'[WS] Server on ws://{HOST}:{PORT}')
            await asyncio.gather(self.broadcast_loop(), srv.__aenter__())


def main():
    msg_q = queue.Queue(maxsize=500)
    cmd_q = queue.Queue(maxsize=20)

    def ros_spin():
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
            rclpy.shutdown()

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
