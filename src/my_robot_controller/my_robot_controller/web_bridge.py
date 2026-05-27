#!/usr/bin/env python3
"""
web_bridge.py
WebSocket bridge node for robot-controller.

Subscribes to:
  /scan          -> cartesian {x, y} points
  /map_combined  -> occupancy grid metadata + flat data
  /pose          -> robot pose from slam_toolbox {x, y, theta} in map frame
  /robot_status  -> robot state string
  /mapping_status -> mapping mode state

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
import threading
import time

import rclpy
from rclpy.node import Node
from rclpy.duration import Duration
from sensor_msgs.msg import LaserScan
from nav_msgs.msg import OccupancyGrid
from geometry_msgs.msg import TransformStamped, PoseWithCovarianceStamped
from std_msgs.msg import String
from tf2_ros import TransformListener, Buffer
from rclpy.time import Time

HOST = '0.0.0.0'
PORT = 9091


class WebBridge(Node):
    def __init__(self, msg_queue: queue.Queue, cmd_queue: queue.Queue):
        super().__init__('web_bridge')
        self.msg_queue = msg_queue
        self.cmd_queue = cmd_queue

        # Publisher for robot commands (web -> robot)
        self.cmd_pub = self.create_publisher(String, '/mapping/control', 10)

        # Device availability tracking
        self.lidar_seen: bool = False
        self.map_seen: bool = False
        self.pose_seen: bool = False
        self.mode: str = 'live'  # 'mapping' | 'live'
        self.coverage_pct: int = 0
        self.last_info_emit: float = 0.0

        # Message counters for logging
        self._msg_counts = {'scan': 0, 'map': 0, 'pose': 0, 'status': 0, 'info': 0}

        # Subscriptions — create them, they'll activate when topics are published
        self.create_subscription(LaserScan, '/scan', self._on_scan, 10)
        self.create_subscription(OccupancyGrid, '/map_combined', self._on_map, 10)
        self.create_subscription(String, '/robot_status', self._on_status, 10)
        self.create_subscription(String, '/mapping_status', self._on_mapping_status, 10)

        # SLAM pose: scan-matched pose estimate in map frame (published by slam_toolbox)
        self.create_subscription(PoseWithCovarianceStamped, '/pose', self._on_slam_pose, 10)

        # TF2 fallback: look up map->base_footprint directly when /pose topic is unavailable
        self.tf_buffer = Buffer()
        self.tf_listener = TransformListener(self.tf_buffer, self)
        self._last_tf_pose_x = 0.0
        self._last_tf_pose_y = 0.0
        self._last_tf_pose_theta = 0.0
        self._slam_pose_x = 0.0
        self._slam_pose_y = 0.0
        self._slam_pose_theta = 0.0
        self._slam_pose_stamp_ns = 0  # nanoseconds of last slam_toolbox /pose

        # Pose fallback from TF (10 Hz) — used when /pose topic is 0,0,0 or not published
        self.create_timer(0.1, self._poll_tf_pose)

        # Device info broadcast (every 5s)
        self.create_timer(5.0, self._broadcast_info)

        # Command queue polling (100 Hz — drain commands quickly)
        self.create_timer(0.01, self._poll_commands)

        self.get_logger().info(f'WebBridge started — serving on ws://{HOST}:{PORT}')
        self.get_logger().info('Subscribed to /scan, /map_combined, /pose, /robot_status, /mapping_status')
        self.get_logger().info('Topics become active when devices are connected')

        # Emit initial info immediately so clients get state on first connect
        self.get_logger().info(
            f'Initial state: lidar={self.lidar_seen} map={self.map_seen} '
            f'pose={self.pose_seen} mode={self.mode}'
        )
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

    def _emit(self, msg: dict):
        """Add a message to the broadcast queue. Blocks if full (up to 2s) so no messages are dropped."""
        msg_type = msg['type']
        try:
            # Use blocking put so high-frequency scan/pose/map messages never get dropped.
            # The broadcast loop drains at ~100 msg/s, so a 100-item queue handles 1s of bursts.
            # If queue is full, block for up to 2s — enough for the broadcast loop to drain it.
            ok = self.msg_queue.put(msg, block=True, timeout=2.0)
            self._msg_counts[msg_type] = self._msg_counts.get(msg_type, 0) + 1
        except queue.Full:
            self.get_logger().warn(f'Message queue full — dropped: {msg_type}')

    def _broadcast_info(self):
        """Timer callback: emit device info every 5s (fires every 5s, not 4.5s)."""
        now = time.time()
        elapsed = now - self.last_info_emit
        self.get_logger().debug(f'_broadcast_info: elapsed={elapsed:.2f}s since last emit')
        if elapsed < 4.5:
            return
        self.last_info_emit = now
        self.get_logger().info(
            f'Broadcasting info: lidar={self.lidar_seen} map={self.map_seen} '
            f'pose={self.pose_seen} mode={self.mode} '
            f'(queue size ~{self.msg_queue.qsize()})'
        )
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

    def _poll_commands(self):
        """Drain command queue and publish to ROS."""
        try:
            while True:
                command = self.cmd_queue.get_nowait()
                ros_cmd = String()
                ros_cmd.data = command
                self.cmd_pub.publish(ros_cmd)
                self.get_logger().info(f'Mapping command published: {command}')
        except queue.Empty:
            pass

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
        """Parse "MAPPING: scanning..." | "LIVE: localizing" | "IDLE" and emit both mode + status."""
        data = msg.data
        self.get_logger().info(f'Received /mapping_status: {data}')
        if 'LIVE' in data or 'live' in data.lower():
            new_mode = 'live'
        elif 'MAPPING' in data or 'mapping' in data.lower():
            new_mode = 'mapping'
        else:
            new_mode = 'idle'

        if new_mode != self.mode:
            self.get_logger().info(f'Mode changed: {self.mode} -> {new_mode}')
            self.mode = new_mode

        self._emit({'type': 'mode', 'data': self.mode})
        self._emit({'type': 'status', 'data': data})

    def _on_slam_pose(self, msg: PoseWithCovarianceStamped):
        """Handle PoseWithCovarianceStamped from slam_toolbox — the scan-matched pose in map frame."""
        self.pose_seen = True
        q = msg.pose.pose.orientation
        theta = self._euler_from_quat(q.x, q.y, q.z, q.w)
        self._slam_pose_x = msg.pose.pose.position.x
        self._slam_pose_y = msg.pose.pose.position.y
        self._slam_pose_theta = theta
        self._slam_pose_stamp_ns = msg.header.stamp.sec * 1e9 + msg.header.stamp.nanosec
        self._emit({
            'type': 'pose',
            'data': {
                'x': round(msg.pose.pose.position.x, 4),
                'y': round(msg.pose.pose.position.y, 4),
                'theta': round(theta, 4),
            }
        })

    def _poll_tf_pose(self):
        """Fallback: look up map->base_footprint transform directly when /pose topic is 0,0,0."""
        try:
            t = self.tf_buffer.lookup_transform(
                'map', 'base_footprint', Time(),
                timeout=Duration(seconds=0.05))
        except Exception:
            return

        tx = t.transform.translation.x
        ty = t.transform.translation.y
        q = t.transform.rotation
        theta = self._euler_from_quat(q.x, q.y, q.z, q.w)

        stamp_ns = t.header.stamp.sec * 1e9 + t.header.stamp.nanosec

        # Use TF pose if /pose topic is stuck at origin (0,0,0) or not updating
        slam_at_origin = (
            abs(self._slam_pose_x) < 0.001 and
            abs(self._slam_pose_y) < 0.001 and
            self._slam_pose_stamp_ns > 0
        )
        tf_newer = stamp_ns > self._slam_pose_stamp_ns
        use_tf = slam_at_origin or (tf_newer and self._slam_pose_stamp_ns == 0)

        if use_tf or (self._slam_pose_stamp_ns == 0 and not self.pose_seen):
            self._emit({
                'type': 'pose',
                'data': {
                    'x': round(tx, 4),
                    'y': round(ty, 4),
                    'theta': round(theta, 4),
                }
            })

    @staticmethod
    def _euler_from_quat(x, y, z, w) -> float:
        siny_cosp = 2.0 * (w * y + z * x)
        cosy_cosp = 1.0 - 2.0 * (x * x + y * y)
        return math.atan2(siny_cosp, cosy_cosp)


# ---------------------------------------------------------------------------
# WebSocket server (runs in a separate thread, communicates via queue)
# ---------------------------------------------------------------------------

class WebSocketServer:
    def __init__(self, msg_queue: queue.Queue, cmd_queue: queue.Queue):
        self.msg_queue = msg_queue
        self.cmd_queue = cmd_queue
        self.clients: set = set()
        self.lock = threading.Lock()
        self.running = True
        self._loop: asyncio.AbstractEventLoop | None = None

    async def _ws_handler(self, ws, path=None):
        client_addr = getattr(ws, 'remote_address', path)
        print(f'[web_bridge] Client connected: {client_addr} (total: {len(self.clients) + 1})')
        with self.lock:
            self.clients.add(ws)
        try:
            async for msg in ws:
                try:
                    cmd = json.loads(msg)
                    print(f'[web_bridge] Received from {client_addr}: {json.dumps(cmd)[:100]}')
                    self._handle_command(cmd)
                except json.JSONDecodeError:
                    pass
        except Exception as e:
            print(f'[web_bridge] Client error ({client_addr}): {e}')
        finally:
            with self.lock:
                self.clients.discard(ws)
            print(f'[web_bridge] Client disconnected: {client_addr} (remaining: {len(self.clients)})')

    def _handle_command(self, cmd: dict):
        """Enqueue commands for WebBridge to publish on ROS topic."""
        t = cmd.get('type', '')
        if t == 'ping':
            print('[web_bridge] Client ping — no action needed')
            return
        if t == 'cmd':
            action = cmd.get('action', '')
            command = cmd.get('command', '')
            if action == 'mapping' and command:
                try:
                    self.cmd_queue.put_nowait(command)
                    print(f'[web_bridge] Queued mapping command: {command}')
                except queue.Full:
                    print('[web_bridge] Command queue full — dropped command')
            else:
                print(f'[web_bridge] Unknown command: action={action} command={command}')
        else:
            print(f'[web_bridge] Unknown message type: {t}')

    async def _broadcast_loop(self):
        """Consume ALL available messages from the queue each cycle and broadcast to clients.

        The queue fills at ~23 msg/s (scan+pose+map) but we can only send ~50 msg/s
        (assuming each send takes ~20ms per client). So we drain in batches to catch up
        during idle periods when no new messages arrive.
        """
        print(f'[web_bridge] Broadcast loop started (queue maxsize={self.msg_queue.maxsize})')
        loop = asyncio.get_running_loop()

        while self.running:
            try:
                # First: drain ALL available messages without blocking
                drained = []
                while True:
                    try:
                        msg = await loop.run_in_executor(
                            None, _queue_get_nowait, self.msg_queue)
                        drained.append(msg)
                    except queue.Empty:
                        break

                # Send all drained messages to all clients
                if drained:
                    clients_count = len(self.clients)
                    if clients_count > 0:
                        data = [json.dumps(m) for m in drained]
                        for ws in list(self.clients):
                            try:
                                for d in data:
                                    await ws.send(d)
                            except Exception as e:
                                print(f'[web_bridge] Send error: {e}')
                        types = [m.get('type', '?') for m in drained]
                        print(f'[web_bridge] Sent {len(drained)} msg(s) ({types}) -> {clients_count} client(s)')
                    else:
                        print(f'[web_bridge] No clients — discarded {len(drained)} msg(s)')

                # No messages available — wait briefly before checking again
                await asyncio.sleep(0.02)

            except Exception as e:
                print(f'[web_bridge] Broadcast loop error: {e}')
                await asyncio.sleep(0.1)
        print('[web_bridge] Broadcast loop stopped')

    async def _ping_loop(self):
        """Send keepalive pings to all connected clients every 5 seconds."""
        print('[web_bridge] Ping loop started')
        while self.running:
            await asyncio.sleep(5)
            if self.clients:
                await self._send_all(json.dumps({'type': 'ping'}))
                print(f'[web_bridge] Ping sent to {len(self.clients)} client(s)')
        print('[web_bridge] Ping loop stopped')

    async def _send_all(self, data: str):
        """Send data to all connected clients, removing dead ones."""
        if not self.clients:
            return
        dead = set()
        for ws in list(self.clients):
            try:
                await ws.send(data)
            except Exception as e:
                print(f'[web_bridge] Send failed, removing client: {e}')
                dead.add(ws)
        with self.lock:
            for ws in dead:
                self.clients.discard(ws)

    async def _serve(self):
        """Start the WebSocket server and background tasks."""
        import websockets
        print(f'[web_bridge] WebSocket server starting on {HOST}:{PORT}')
        async with websockets.serve(self._ws_handler, HOST, PORT) as server:
            print(f'[web_bridge] WebSocket server listening on ws://{HOST}:{PORT}')
            # Start background tasks
            asyncio.create_task(self._broadcast_loop())
            asyncio.create_task(self._ping_loop())
            print('[web_bridge] All background tasks started')
            # Keep server running
            await asyncio.Future()

    def run(self):
        """Run the WebSocket server. Must be called from the main thread."""
        print('[web_bridge] Starting asyncio event loop')
        asyncio.run(self._serve())


def _queue_get_with_timeout(q: queue.Queue, timeout: float):
    """Thread-safe queue get with timeout — used from executor thread."""
    return q.get(block=True, timeout=timeout)


def _queue_get_nowait(q: queue.Queue):
    """Thread-safe non-blocking queue get — used from executor thread."""
    return q.get_nowait()


# ---------------------------------------------------------------------------
# Main: start rclpy node + WebSocket server in parallel threads
# ---------------------------------------------------------------------------

def main():
    # Queue must be large enough to absorb burst traffic between broadcast cycles.
    # At ~23 msg/s incoming (scan+pose+map) vs ~1 msg/s consumed by broadcast loop,
    # we need enough buffer so clients always see recent data when they connect.
    msg_queue: queue.Queue = queue.Queue(maxsize=500)
    cmd_queue: queue.Queue = queue.Queue(maxsize=20)

    # --- ROS 2 node in a daemon thread ---
    def ros_thread():
        print('[web_bridge] Initializing ROS 2...')
        rclpy.init()
        node = WebBridge(msg_queue, cmd_queue)
        executor = rclpy.executors.MultiThreadedExecutor()
        executor.add_node(node)
        print('[web_bridge] ROS 2 node running — spinning...')
        try:
            executor.spin()
        finally:
            print('[web_bridge] ROS 2 shutting down...')
            node.destroy_node()
            rclpy.shutdown()
            print('[web_bridge] ROS 2 shutdown complete')

    ros_t = threading.Thread(target=ros_thread, daemon=True, name='ros-thread')
    ros_t.start()

    # Give ROS 2 a moment to initialize
    print('[web_bridge] Waiting 2s for ROS 2 to initialize...')
    time.sleep(2.0)
    print('[web_bridge] ROS 2 initialization wait done')

    # --- WebSocket server in main thread ---
    ws_server = WebSocketServer(msg_queue, cmd_queue)
    print(f'[web_bridge] WebSocket server ready, listening on ws://{HOST}:{PORT}')
    try:
        ws_server.run()
    except KeyboardInterrupt:
        ws_server.running = False
        print('[web_bridge] Interrupted')


if __name__ == '__main__':
    main()
