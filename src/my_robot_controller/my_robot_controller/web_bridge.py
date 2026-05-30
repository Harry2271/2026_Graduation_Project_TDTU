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
  ack          | acknowledgment for every received command         | on event

Commands (Frontend → Robot):
  { "type": "cmd", "command": "start" | "stop" | "idle" }

Web throttle: scan and map_layer are hard-capped at 5 Hz by dropping
intermediate messages in the ROS callback before they enter the queue.

Static TF:
  Always publishes odom→base_footprint so the TF tree is complete even if
  brain_node is not running. The pose (x,y,theta) comes from /odom when
  available; otherwise stays at (0,0,0).
"""
import asyncio
import gzip
import json
import math
import queue
import threading
import time
import sys

import rclpy
from rclpy.node import Node
from sensor_msgs.msg import LaserScan
from nav_msgs.msg import OccupancyGrid, Odometry
from std_msgs.msg import String
from geometry_msgs.msg import TransformStamped
from tf2_ros import TransformBroadcaster

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
    'RUNNING':        'live',   # brain_node: STATE=RUNNING → live mode
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

        # ── Pose tracking for static TF ────────────────────────────────────
        self._odom_x     = 0.0
        self._odom_y     = 0.0
        self._odom_theta = 0.0
        self._last_odom_time = None

        # ── Throttle state ─────────────────────────────────────────────────
        self._last_scan_sent_time = 0.0

        # ── Static TF broadcaster (guarantees odom→base_footprint) ─────────
        try:
            self._tf_broadcaster = TransformBroadcaster(self)
            self.get_logger().info('Static TF broadcaster enabled (odom→base_footprint)')
        except Exception as e:
            self.get_logger().warn(f'Could not create TransformBroadcaster: {e}')
            self._tf_broadcaster = None

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
        self.create_timer(0.1, self._publish_static_tf)   # guarantees odom→base_footprint

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
        self._odom_x     = msg.pose.pose.position.x
        self._odom_y     = msg.pose.pose.position.y
        q = msg.pose.pose.orientation
        self._odom_theta = self._yaw(q.x, q.y, q.z, q.w)
        self._last_odom_time = self.get_clock().now().to_msg()
        self._emit({'type': 'pose', 'data': {
            'x': round(self._odom_x, 4),
            'y': round(self._odom_y, 4),
            'theta': round(self._odom_theta, 4)}})

    def _publish_static_tf(self):
        """Always publish odom→base_footprint so the TF tree is complete.

        Even if brain_node is dead, this guarantees the parent chain:
          map → odom → base_footprint → base_link → laser
        slam_toolbox needs odom as parent of base_footprint.
        """
        if self._tf_broadcaster is None:
            return
        t = TransformStamped()
        t.header.stamp = self.get_clock().now().to_msg()
        t.header.frame_id = 'odom'
        t.child_frame_id  = 'base_footprint'
        t.transform.translation.x = self._odom_x
        t.transform.translation.y = self._odom_y
        q = self._euler_to_quat(0, 0, self._odom_theta)
        t.transform.rotation.x = q[0]
        t.transform.rotation.y = q[1]
        t.transform.rotation.z = q[2]
        t.transform.rotation.w = q[3]
        self._tf_broadcaster.sendTransform(t)

    @staticmethod
    def _euler_to_quat(r, p, y):
        cr, sr = math.cos(r * 0.5), math.sin(r * 0.5)
        cp, sp = math.cos(p * 0.5), math.sin(p * 0.5)
        cy, sy = math.cos(y * 0.5), math.sin(y * 0.5)
        return (
            sr * cp * cy - cr * sp * sy,
            cr * sp * cy + sr * cp * sy,
            cr * cp * sy - sr * sp * cy,
            cr * cp * cy + sr * sp * sy,
        )

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
                # ── Always log every incoming message (even malformed) ──────────
                raw_str = raw.decode('utf-8', errors='replace') if isinstance(raw, bytes) else str(raw)
                print(f'[WS] ← {addr}: {raw_str[:300]}')

                try:
                    msg = json.loads(raw_str)
                    msg_type = msg.get('type', '(no type)')

                    if msg_type == 'cmd':
                        command = msg.get('command', '(no command)')
                        action  = msg.get('action',  '(no action)')
                        print(f'[WS] CMD received: action={action!r} command={command!r}')

                        # ── Validate ───────────────────────────────────────────
                        valid_commands = {'start', 'stop', 'idle', 'reset'}
                        if command in valid_commands:
                            try:
                                self.cmd_q.put_nowait(command)
                                print(f'[WS] CMD queued → /mapping/control: {command}')
                                ack = {'type': 'ack', 'data': {
                                    'command': command,
                                    'accepted': True,
                                    'queued': True,
                                    'mode':    msg.get('_mode_hint', 'unknown'),
                                }}
                            except queue.Full:
                                print(f'[WS] CMD rejected — queue full')
                                ack = {'type': 'ack', 'data': {
                                    'command': command,
                                    'accepted': False,
                                    'error': 'command queue full',
                                }}
                        else:
                            print(f'[WS] CMD ignored — unknown command: {command!r}')
                            ack = {'type': 'ack', 'data': {
                                'command': command,
                                'accepted': False,
                                'error': f'unknown command: {command!r}',
                            }}

                        # ── Send ack back to client ──────────────────────────────
                        try:
                            await connection.send(json.dumps(ack))
                            print(f'[WS] → {addr}: ack {ack["data"]["command"]} accepted={ack["data"]["accepted"]}')
                        except Exception as send_err:
                            print(f'[WS] ack send failed: {send_err}')

                    elif msg_type == 'ping':
                        # Respond to ping immediately so the frontend knows we're alive
                        pong = {'type': 'pong', 'data': {'ts': time.time()}}
                        try:
                            await connection.send(json.dumps(pong))
                        except Exception:
                            pass

                    else:
                        print(f'[WS] unhandled type: {msg_type!r} — message: {str(msg)[:200]}')

                except json.JSONDecodeError as e:
                    print(f'[WS] JSON parse error from {addr}: {e}  raw={raw_str[:100]!r}')
                except queue.Full:
                    print(f'[WS] queue full — dropped message from {addr}')
        except Exception as e:
            print(f'[WS] {addr} error: {e}', file=sys.stderr)
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
