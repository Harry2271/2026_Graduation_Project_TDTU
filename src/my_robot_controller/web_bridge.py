#!/usr/bin/env python3
"""web_bridge — WebSocket server. ROS topics -> JSON messages."""
import asyncio
import json
import math
import queue
import threading
import time

import rclpy
from rclpy.node import Node
from sensor_msgs.msg import LaserScan
from nav_msgs.msg import OccupancyGrid
from geometry_msgs.msg import PoseWithCovarianceStamped
from std_msgs.msg import String

HOST = '0.0.0.0'
PORT = 9091


class WebBridge(Node):
    def __init__(self, msg_q, cmd_q):
        super().__init__('web_bridge')
        self.msg_q = msg_q
        self.cmd_q = cmd_q
        self.cmd_pub = self.create_publisher(String, '/mapping/control', 10)

        self.lidar_seen = False
        self.map_seen   = False
        self.pose_seen  = False
        self.mode       = 'live'

        self.create_subscription(LaserScan, '/scan',                 self._on_scan,  10)
        self.create_subscription(OccupancyGrid, '/map_combined',  self._on_map,   10)
        self.create_subscription(String, '/robot_status',         self._on_status, 10)
        self.create_subscription(String, '/mapping_status',        self._on_mapping_status, 10)
        self.create_subscription(PoseWithCovarianceStamped, '/pose', self._on_pose, 10)

        self.create_timer(5.0, self._broadcast_info)
        self.create_timer(0.1, self._poll_commands)

        self.get_logger().info(f'WebBridge listening on ws://{HOST}:{PORT}')
        self._emit({'type': 'info', 'data': {
            'lidar': False, 'map': False, 'pose': False, 'mode': 'live'}})

    def _emit(self, msg):
        try:
            self.msg_q.put(msg, block=False)
        except queue.Full:
            pass

    def _on_scan(self, msg: LaserScan):
        self.lidar_seen = True
        pts = []
        angle = msg.angle_min
        for r in msg.ranges:
            if not (math.isinf(r) or math.isnan(r)) and msg.range_min <= r <= msg.range_max:
                pts.append({'x': round(r * math.cos(angle), 4),
                           'y': round(r * math.sin(angle), 4)})
            angle += msg.angle_increment
        self._emit({'type': 'scan', 'data': {'points': pts, 'count': len(pts)}})

    def _on_map(self, msg: OccupancyGrid):
        self.map_seen = True
        self._emit({'type': 'map', 'data': {
            'width': msg.info.width,
            'height': msg.info.height,
            'resolution': msg.info.resolution,
            'origin_x': msg.info.origin.position.x,
            'origin_y': msg.info.origin.position.y,
            'data': list(msg.data)}})

    def _on_status(self, msg: String):
        self._emit({'type': 'status', 'data': msg.data})

    def _on_mapping_status(self, msg: String):
        data = msg.data
        new_mode = ('live' if 'LIVE' in data else
                    'mapping' if 'MAPPING' in data else 'idle')
        if new_mode != self.mode:
            self.mode = new_mode
            self.get_logger().info(f'Mode changed to {self.mode}')
        self._emit({'type': 'mode', 'data': self.mode})
        self._emit({'type': 'status', 'data': data})

    def _on_pose(self, msg: PoseWithCovarianceStamped):
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

    async def handler(self, ws, path):
        addr = getattr(ws.remote_address, '__str__', lambda: path)()
        print(f'[WS] + {addr}')
        self.clients.add(ws)
        try:
            async for raw in ws:
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
            self.clients.discard(ws)
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
                            await ws.send(json.dumps(m))
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
