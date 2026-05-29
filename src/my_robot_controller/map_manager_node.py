#!/usr/bin/env python3
"""
map_manager_node — Lidar occupancy grid builder.
Two modes:
  MAPPING  — build full map. Robot pose from /odom.
  LIVE     — show only 2m radius around robot (dynamic obstacles).
Commands via /mapping/control: "start" (MAPPING), "stop" (LIVE).
"""
import math
import numpy as np
import rclpy
from rclpy.node import Node
from sensor_msgs.msg import LaserScan
from nav_msgs.msg import Odometry
from nav_msgs.msg import OccupancyGrid
from std_msgs.msg import String

RESOLUTION = 0.05          # meters per cell
GRID_SIZE  = 800          # 40m x 40m world
ORIGIN     = -GRID_SIZE * RESOLUTION / 2.0  # -20.0
MAX_RANGE  = 8.0
TEMP_RADIUS = 2.0          # meters — LIVE mode radius
TRAVEL_THRESHOLD = 0.15    # minimum movement to update persistent map
CELL_UNKNOWN  = -1
CELL_FREE    = 0
CELL_OCCUPIED = 100


class MapManager(Node):
    def __init__(self):
        super().__init__('map_manager')
        self.mode = 'LIVE'   # 'MAPPING' or 'LIVE'
        self.persistent_grid = np.full(GRID_SIZE * GRID_SIZE, CELL_UNKNOWN, dtype=np.int8)
        self.temp_grid      = np.full(GRID_SIZE * GRID_SIZE, CELL_UNKNOWN, dtype=np.int8)

        # Odometry (from brain_node or simulated)
        self.odom_x = 0.0
        self.odom_y = 0.0
        self.odom_theta = 0.0
        self.last_odom_x = 0.0
        self.last_odom_y = 0.0

        self._scan_count = 0

        self.scan_sub   = self.create_subscription(LaserScan, '/scan',      self._on_scan, 10)
        self.odom_sub   = self.create_subscription(Odometry, '/odom',     self._on_odom, 10)
        self.ctrl_sub   = self.create_subscription(String,  '/mapping/control', self._on_control, 10)
        self.map_pub    = self.create_publisher(OccupancyGrid, '/map_combined', 1)
        self.status_pub = self.create_publisher(String, '/mapping_status', 1)

        self.create_timer(1.0, self._publish)
        self._publish_status()
        self.get_logger().info(f'MapManager started in {self.mode} mode')

    # -------------------------------------------------------------------------
    # Subscriptions
    # -------------------------------------------------------------------------
    def _on_odom(self, msg: Odometry):
        self.odom_x     = msg.pose.pose.position.x
        self.odom_y     = msg.pose.pose.position.y
        q = msg.pose.pose.orientation
        self.odom_theta = self._yaw(q.x, q.y, q.z, q.w)

    def _on_control(self, msg: String):
        cmd = msg.data.strip().lower()
        if cmd == 'start' and self.mode != 'MAPPING':
            self.persistent_grid[:] = CELL_UNKNOWN
            self.temp_grid[:]      = CELL_UNKNOWN
            self.mode = 'MAPPING'
            self.get_logger().info('Switched to MAPPING mode — building map')
            self._publish_status()
        elif cmd == 'stop' and self.mode != 'LIVE':
            self.mode = 'LIVE'
            self.get_logger().info('Switched to LIVE mode — 2m radius')
            self._publish_status()

    def _on_scan(self, msg: LaserScan):
        self._scan_count += 1
        ranges = np.array(msg.ranges, dtype=np.float32)
        angles = np.arange(len(ranges)) * msg.angle_increment + msg.angle_min

        valid = ~(np.isinf(ranges) | np.isnan(ranges))
        valid &= (ranges >= msg.range_min) & (ranges <= MAX_RANGE)
        if not np.any(valid):
            return

        abs_angles  = angles[valid] + self.odom_theta
        valid_ranges = ranges[valid]
        n = len(valid_ranges)

        step     = RESOLUTION * 0.5
        max_steps = int(MAX_RANGE / step) + 1
        dists     = np.arange(max_steps, dtype=np.float32) * step

        xs = self.odom_x + np.outer(np.cos(abs_angles), dists).astype(np.float32)
        ys = self.odom_y + np.sin(np.tile(abs_angles, (max_steps, 1)).T * np.ones((n, max_steps)), dists).T.astype(np.float32)

        gxs = ((xs - ORIGIN) / RESOLUTION).astype(np.int32)
        gys = ((ys - ORIGIN) / RESOLUTION).astype(np.int32)

        in_bounds = (gxs >= 0) & (gxs < GRID_SIZE) & (gys >= 0) & (gys < GRID_SIZE)

        hit_steps = np.clip(
            np.searchsorted(dists, valid_ranges, side='right'),
            0, max_steps - 1)

        if self.mode == 'MAPPING':
            self._build_mapping(valid_ranges, abs_angles, gxs, gys, in_bounds, hit_steps, max_steps, n)
        else:
            self._build_live(msg, abs_angles, gxs, gys, in_bounds, hit_steps, max_steps, n)

    def _build_mapping(self, valid_ranges, abs_angles, gxs, gys, in_bounds, hit_steps, max_steps, n):
        dx = self.odom_x - self.last_odom_x
        dy = self.odom_y - self.last_odom_y
        moved = math.sqrt(dx * dx + dy * dy) > TRAVEL_THRESHOLD

        if not moved:
            return

        self.last_odom_x = self.odom_x
        self.last_odom_y = self.odom_y

        grid = self.persistent_grid
        for i in range(n):
            ht = hit_steps[i]
            gx_i = gxs[i]
            gy_i = gys[i]
            ib_i = in_bounds[i]
            for s in range(ht):
                if ib_i[s]:
                    j = gy_i[s] * GRID_SIZE + gx_i[s]
                    if grid[j] == CELL_UNKNOWN:
                        grid[j] = CELL_FREE
            gi = gy_i[ht] * GRID_SIZE + gx_i[ht]
            if 0 <= gi < len(grid):
                grid[gi] = CELL_OCCUPIED

    def _build_live(self, msg, abs_angles, gxs, gys, in_bounds, hit_steps, max_steps, n):
        rx = self.odom_x
        ry = self.odom_y
        grid = self.temp_grid
        grid[:] = CELL_UNKNOWN

        # Robot position in grid
        r_gx = int((rx - ORIGIN) / RESOLUTION)
        r_gy = int((ry - ORIGIN) / RESOLUTION)
        r_radius = int(TEMP_RADIUS / RESOLUTION)

        for i in range(n):
            ht = hit_steps[i]
            gx_i = gxs[i]
            gy_i = gys[i]
            ib_i = in_bounds[i]
            for s in range(ht):
                if ib_i[s]:
                    j = gy_i[s] * GRID_SIZE + gx_i[s]
                    if grid[j] == CELL_UNKNOWN:
                        grid[j] = CELL_FREE
            gi = gy_i[ht] * GRID_SIZE + gx_i[ht]
            if 0 <= gi < len(grid):
                grid[gi] = CELL_OCCUPIED

        # Mask: keep only 2m radius around robot
        for gy in range(max(0, r_gy - r_radius), min(GRID_SIZE, r_gy + r_radius)):
            for gx in range(max(0, r_gx - r_radius), min(GRID_SIZE, r_gx + r_radius)):
                wx = gx * RESOLUTION + ORIGIN
                wy = gy * RESOLUTION + ORIGIN
                if (wx - rx) ** 2 + (wy - ry) ** 2 > TEMP_RADIUS ** 2:
                    grid[gy * GRID_SIZE + gx] = CELL_UNKNOWN

    # -------------------------------------------------------------------------
    # Publishing
    # -------------------------------------------------------------------------
    def _publish(self):
        msg = OccupancyGrid()
        msg.header.stamp = self.get_clock().now().to_msg()
        msg.header.frame_id = 'map'
        msg.info.width      = GRID_SIZE
        msg.info.height     = GRID_SIZE
        msg.info.resolution = RESOLUTION
        msg.info.origin.position.x = ORIGIN
        msg.info.origin.position.y = ORIGIN
        msg.info.origin.orientation.w = 1.0

        if self.mode == 'LIVE':
            msg.data = self.temp_grid.tolist()
        else:
            msg.data = self.persistent_grid.tolist()

        self.map_pub.publish(msg)

    def _publish_status(self):
        data = f'MAPPING: scanning...' if self.mode == 'MAPPING' else f'LIVE: localizing'
        self.status_pub.publish(String(data=data))

    @staticmethod
    def _yaw(x, y, z, w):
        return math.atan2(2 * (w * y + z * x), 1 - 2 * (x * x + y * y))


def main():
    rclpy.init()
    node = MapManager()
    try:
        rclpy.spin(node)
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
