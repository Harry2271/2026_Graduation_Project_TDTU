#!/usr/bin/env python3
"""
map_manager_node.py
Custom two-map occupancy grid builder for robot-controller.

Two independent maps:
  persistent_grid  — grows as the robot explores. Saved to disk on mode switch.
  temporary_grid   — 2m radius around robot. Clears objects that disappear.

Modes:
  MAPPING  — only persistent_grid grows, triggered when robot moves > 0.15m
  LIVE     — temporary_grid rebuilt every scan, overlaid on saved persistent_grid
  IDLE     — no processing, waiting for /mapping/control command

Auto-stop: switches MAPPING -> LIVE when robot hasn't expanded the persistent
grid's bounding box for 10 seconds (room fully scanned).
"""

import math
import os
import threading
import time

import rclpy
from rclpy.node import Node
from rclpy.duration import Duration
from geometry_msgs.msg import TransformStamped
from nav_msgs.msg import OccupancyGrid
from sensor_msgs.msg import LaserScan
from std_msgs.msg import String
from tf2_ros import TransformListener, Buffer

# Map parameters
GRID_RESOLUTION = 0.05       # meters per cell
GRID_SIZE_METERS = 40.0     # total grid size (800 x 800 cells)
GRID_CELLS = int(GRID_SIZE_METERS / GRID_RESOLUTION)  # 800
GRID_ORIGIN = -GRID_SIZE_METERS / 2.0  # -20.0 (grid centered at world origin)

MAX_LASER_RANGE = 8.0       # meters — skip readings beyond this
TRAVEL_THRESHOLD = 0.15     # meters — minimum movement to update persistent map
TEMP_RADIUS = 2.0           # meters — temporary map radius
TEMP_CLEAR_SCANS = 5        # scans without detection to clear a temp cell
COVERAGE_STABLE_TIME = 10.0  # seconds of no expansion -> auto-switch to LIVE

# Cell values
CELL_UNKNOWN = -1
CELL_FREE = 0
CELL_OCCUPIED = 100

SAVE_PATH = '/app/saved_map.json'


class MapManager(Node):
    def __init__(self):
        super().__init__('map_manager')

        # --- Grids (flat list[row*width + col]) ---
        self.persistent_grid = [CELL_UNKNOWN] * (GRID_CELLS * GRID_CELLS)
        self.temporary_grid = [CELL_UNKNOWN] * (GRID_CELLS * GRID_CELLS)
        self.temp_hit_count = [0] * (GRID_CELLS * GRID_CELLS)

        # --- Persistent grid bounding box of occupied cells (world coords) ---
        self.bbox_min_x = float('inf')
        self.bbox_max_x = float('-inf')
        self.bbox_min_y = float('inf')
        self.bbox_max_y = float('-inf')
        self.last_bbox_change_time = 0.0

        # --- Robot pose from TF ---
        self.tf_buffer = Buffer()
        self.tf_listener = TransformListener(self.tf_buffer, self)
        self.last_pose_x = 0.0
        self.last_pose_y = 0.0
        self.last_pose_theta = 0.0
        self.last_update_pose_x = 0.0
        self.last_update_pose_y = 0.0

        # --- Mode state ---
        self.mode = 'IDLE'  # IDLE | MAPPING | LIVE
        self.mapping_start_time = 0.0

        # --- Publishers ---
        self.map_combined_pub = self.create_publisher(OccupancyGrid, '/map_combined', 1)
        self.temporary_map_pub = self.create_publisher(OccupancyGrid, '/temporary_map', 1)
        self.status_pub = self.create_publisher(String, '/mapping_status', 1)

        # --- Subscriptions ---
        self.scan_sub = self.create_subscription(LaserScan, '/scan', self._on_scan, 10)
        self.control_sub = self.create_subscription(String, '/mapping/control', self._on_control, 10)

        # --- Timers ---
        self.create_timer(0.1, self._poll_pose_and_publish)

        self.get_logger().info(
            f'MapManager started — grid: {GRID_CELLS}x{GRID_CELLS} '
            f'({GRID_SIZE_METERS}m x {GRID_SIZE_METERS}m, {GRID_RESOLUTION}m/cell)'
        )

    # -------------------------------------------------------------------------
    # Grid helpers
    # -------------------------------------------------------------------------
    def _world_to_grid(self, wx: float, wy: float) -> tuple[int, int]:
        gx = int((wx - GRID_ORIGIN) / GRID_RESOLUTION)
        gy = int((wy - GRID_ORIGIN) / GRID_RESOLUTION)
        return gx, gy

    def _grid_to_idx(self, gx: int, gy: int) -> int:
        return gy * GRID_CELLS + gx

    def _in_bounds(self, gx: int, gy: int) -> bool:
        return 0 <= gx < GRID_CELLS and 0 <= gy < GRID_CELLS

    def _set_persistent(self, gx: int, gy: int, value: int):
        if self._in_bounds(gx, gy):
            self.persistent_grid[self._grid_to_idx(gx, gy)] = value

    def _set_temporary(self, gx: int, gy: int, value: int):
        if self._in_bounds(gx, gy):
            self.temporary_grid[self._grid_to_idx(gx, gy)] = value

    # -------------------------------------------------------------------------
    # Raycasting — Bresenham-style along lidar beam
    # -------------------------------------------------------------------------
    def _cast_ray(self, rx: float, ry: float, angle: float,
                  max_range: float, layer: str):
        """Mark cells along a lidar beam as FREE, final cell as OCCUPIED."""
        cos_a = math.cos(angle)
        sin_a = math.sin(angle)
        step = GRID_RESOLUTION * 0.5  # step smaller than cell for accuracy

        x = rx
        y = ry
        dist = 0.0

        while dist < max_range:
            dist += step
            x = rx + cos_a * dist
            y = ry + sin_a * dist
            gx, gy = self._world_to_grid(x, y)
            if not self._in_bounds(gx, gy):
                break

            # Check if we've reached the obstacle
            if dist >= max_range - step:
                if layer == 'persistent':
                    self._set_persistent(gx, gy, CELL_OCCUPIED)
                else:
                    self._set_temporary(gx, gy, CELL_OCCUPIED)
                # Update bounding box for persistent layer
                if layer == 'persistent':
                    self._update_bbox(x, y)
                break
            else:
                # Mark as FREE (don't overwrite OCCUPIED)
                if layer == 'persistent':
                    idx = self._grid_to_idx(gx, gy)
                    if self.persistent_grid[idx] == CELL_UNKNOWN:
                        self.persistent_grid[idx] = CELL_FREE
                else:
                    idx = self._grid_to_idx(gx, gy)
                    if self.temporary_grid[idx] == CELL_UNKNOWN:
                        self.temporary_grid[idx] = CELL_FREE

    def _update_bbox(self, wx: float, wy: float):
        changed = False
        if wx < self.bbox_min_x: self.bbox_min_x = wx; changed = True
        if wx > self.bbox_max_x: self.bbox_max_x = wx; changed = True
        if wy < self.bbox_min_y: self.bbox_min_y = wy; changed = True
        if wy > self.bbox_max_y: self.bbox_max_y = wy; changed = True
        if changed:
            self.last_bbox_change_time = time.time()

    def _has_moved(self, x: float, y: float) -> bool:
        dx = x - self.last_update_pose_x
        dy = y - self.last_update_pose_y
        return math.sqrt(dx * dx + dy * dy) > TRAVEL_THRESHOLD

    # -------------------------------------------------------------------------
    # Scan callback
    # -------------------------------------------------------------------------
    def _on_scan(self, msg: LaserScan):
        if self.mode == 'IDLE':
            return

        # Get robot pose from TF
        try:
            t: TransformStamped = self.tf_buffer.lookup_transform(
                'map', 'base_footprint', rclpy.time.Time(),
                timeout=Duration(seconds=0.05))
            rx = t.transform.translation.x
            ry = t.transform.translation.y
            q = t.transform.rotation
            theta = self._yaw_from_quat(q.x, q.y, q.z, q.w)
        except Exception:
            return

        if self.mode == 'MAPPING':
            self._process_mapping_scan(msg, rx, ry, theta)
        elif self.mode == 'LIVE':
            self._process_live_scan(msg, rx, ry, theta)

    def _process_mapping_scan(self, msg: LaserScan, rx: float, ry: float, theta: float):
        if not self._has_moved(rx, ry):
            return  # No movement — skip

        self.last_update_pose_x = rx
        self.last_update_pose_y = ry

        # Raycast each lidar beam into persistent grid
        angle = msg.angle_min
        for r in msg.ranges:
            if not (math.isinf(r) or math.isnan(r)) and msg.range_min <= r <= MAX_LASER_RANGE:
                self._cast_ray(rx, ry, angle + theta, r, 'persistent')
            angle += msg.angle_increment

        # Check if room is fully scanned (bounding box stable)
        if time.time() - self.last_bbox_change_time > COVERAGE_STABLE_TIME:
            self.get_logger().info(
                f'Mapping complete! Bounding box: '
                f'[{self.bbox_min_x:.1f}, {self.bbox_max_x:.1f}] x '
                f'[{self.bbox_min_y:.1f}, {self.bbox_max_y:.1f}]'
            )
            self._save_persistent_map()
            self._switch_mode('LIVE')

    def _process_live_scan(self, msg: LaserScan, rx: float, ry: float, theta: float):
        # Reset temporary grid to UNKNOWN
        self.temporary_grid = [CELL_UNKNOWN] * (GRID_CELLS * GRID_CELLS)

        # Raycast into temporary grid, limited to TEMP_RADIUS
        angle = msg.angle_min
        for r in msg.ranges:
            if not (math.isinf(r) or math.isnan(r)) and msg.range_min <= r <= min(MAX_LASER_RANGE, TEMP_RADIUS):
                self._cast_ray(rx, ry, angle + theta, r, 'temporary')
            angle += msg.angle_increment

        # --- Track hit counts for clearing ---
        for i, v in enumerate(self.temporary_grid):
            if v == CELL_OCCUPIED:
                self.temp_hit_count[i] += 1
            elif v == CELL_FREE:
                self.temp_hit_count[i] = 0  # reset on FREE reading

        # --- Decay: cells that haven't been hit in TEMP_CLEAR_SCANS -> FREE ---
        for i in range(len(self.temporary_grid)):
            if self.temp_hit_count[i] >= TEMP_CLEAR_SCANS:
                self.temporary_grid[i] = CELL_FREE
                self.temp_hit_count[i] = 0

    # -------------------------------------------------------------------------
    # Control
    # -------------------------------------------------------------------------
    def _on_control(self, msg: String):
        cmd = msg.data.strip().lower()
        if cmd == 'start':
            if self.mode == 'LIVE':
                self.get_logger().warn('Already in LIVE mode — reset first')
                return
            self.get_logger().info('Starting MAPPING mode')
            self._reset_grids()
            self.mode = 'MAPPING'
            self.mapping_start_time = time.time()
        elif cmd == 'stop':
            self.get_logger().info('Stopping MAPPING mode, switching to LIVE')
            self._save_persistent_map()
            self._switch_mode('LIVE')
        elif cmd == 'reset':
            self.get_logger().info('Resetting — clearing all maps')
            self._reset_grids()
            self._load_persistent_map()
            self.mode = 'LIVE'

    def _reset_grids(self):
        self.persistent_grid = [CELL_UNKNOWN] * (GRID_CELLS * GRID_CELLS)
        self.temporary_grid = [CELL_UNKNOWN] * (GRID_CELLS * GRID_CELLS)
        self.temp_hit_count = [0] * (GRID_CELLS * GRID_CELLS)
        self.bbox_min_x = float('inf')
        self.bbox_max_x = float('-inf')
        self.bbox_min_y = float('inf')
        self.bbox_max_y = float('-inf')
        self.last_bbox_change_time = 0.0
        self.last_update_pose_x = 0.0
        self.last_update_pose_y = 0.0

    def _switch_mode(self, new_mode: str):
        self.mode = new_mode
        status_msg = String()
        if new_mode == 'LIVE':
            status_msg.data = 'LIVE: localizing'
        elif new_mode == 'MAPPING':
            status_msg.data = 'MAPPING: scanning...'
        else:
            status_msg.data = 'IDLE'
        self.status_pub.publish(status_msg)

    # -------------------------------------------------------------------------
    # Map publishing
    # -------------------------------------------------------------------------
    def _poll_pose_and_publish(self):
        try:
            t: TransformStamped = self.tf_buffer.lookup_transform(
                'map', 'base_footprint', rclpy.time.Time(),
                timeout=Duration(seconds=0.05))
            self.last_pose_x = t.transform.translation.x
            self.last_pose_y = t.transform.translation.y
            q = t.transform.rotation
            self.last_pose_theta = self._yaw_from_quat(q.x, q.y, q.z, q.w)
        except Exception:
            pass

        if self.mode != 'IDLE':
            self._publish_combined_map()
            if self.mode == 'LIVE':
                self._publish_temporary_map()

    def _build_grid_msg(self, data: list[int], frame_id: str) -> OccupancyGrid:
        msg = OccupancyGrid()
        msg.header.stamp = self.get_clock().now().to_msg()
        msg.header.frame_id = frame_id
        msg.info.width = GRID_CELLS
        msg.info.height = GRID_CELLS
        msg.info.resolution = GRID_RESOLUTION
        msg.info.origin.position.x = GRID_ORIGIN
        msg.info.origin.position.y = GRID_ORIGIN
        msg.info.origin.position.z = 0.0
        msg.info.origin.orientation.w = 1.0
        msg.data = data
        return msg

    def _publish_combined_map(self):
        # Overlay: persistent + temporary
        # Temporary OCCUPIED (100) overrides persistent
        # Temporary FREE (-1) clears persistent OCCUPIED
        combined = []
        for i in range(len(self.persistent_grid)):
            if self.temporary_grid[i] == CELL_OCCUPIED:
                combined.append(CELL_OCCUPIED)
            elif self.temporary_grid[i] == CELL_FREE and self.persistent_grid[i] == CELL_OCCUPIED:
                combined.append(CELL_FREE)
            else:
                combined.append(self.persistent_grid[i])

        msg = self._build_grid_msg(combined, 'map')
        self.map_combined_pub.publish(msg)

    def _publish_temporary_map(self):
        msg = self._build_grid_msg(self.temporary_grid, 'map')
        self.temporary_map_pub.publish(msg)

    # -------------------------------------------------------------------------
    # Save / Load
    # -------------------------------------------------------------------------
    def _save_persistent_map(self):
        try:
            import json
            data = {
                'grid': self.persistent_grid,
                'bbox': {
                    'min_x': self.bbox_min_x,
                    'max_x': self.bbox_max_x,
                    'min_y': self.bbox_min_y,
                    'max_y': self.bbox_max_y,
                },
                'saved_at': time.strftime('%Y-%m-%d %H:%M:%S'),
            }
            with open(SAVE_PATH, 'w') as f:
                json.dump(data, f)
            self.get_logger().info(f'Persistent map saved to {SAVE_PATH}')
        except Exception as e:
            self.get_logger().error(f'Failed to save map: {e}')

    def _load_persistent_map(self):
        try:
            import json
            if not os.path.exists(SAVE_PATH):
                self.get_logger().warn(f'No saved map found at {SAVE_PATH}')
                return
            with open(SAVE_PATH, 'r') as f:
                data = json.load(f)
            self.persistent_grid = data['grid']
            bbox = data.get('bbox', {})
            self.bbox_min_x = bbox.get('min_x', float('inf'))
            self.bbox_max_x = bbox.get('max_x', float('-inf'))
            self.bbox_min_y = bbox.get('min_y', float('inf'))
            self.bbox_max_y = bbox.get('max_y', float('-inf'))
            self.get_logger().info(
                f'Loaded saved map from {SAVE_PATH} '
                f'({len(self.persistent_grid)} cells, '
                f'bbox: {self.bbox_min_x:.1f}-{self.bbox_max_x:.1f} x '
                f'{self.bbox_min_y:.1f}-{self.bbox_max_y:.1f})'
            )
        except Exception as e:
            self.get_logger().error(f'Failed to load map: {e}')

    # -------------------------------------------------------------------------
    # Utils
    # -------------------------------------------------------------------------
    @staticmethod
    def _yaw_from_quat(x, y, z, w) -> float:
        siny_cosp = 2.0 * (w * y + z * x)
        cosy_cosp = 1.0 - 2.0 * (x * x + y * y)
        return math.atan2(siny_cosp, cosy_cosp)


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
