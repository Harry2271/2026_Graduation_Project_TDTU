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
import time
import json

import numpy as np
import rclpy
from rclpy.node import Node
from rclpy.duration import Duration
from geometry_msgs.msg import TransformStamped
from nav_msgs.msg import OccupancyGrid
from sensor_msgs.msg import LaserScan
from std_msgs.msg import String
from tf2_ros import TransformListener, Buffer

# Map parameters
GRID_RESOLUTION = 0.05       # meters per cell (5cm — matches frontend API, same as ROS SLAM)
GRID_SIZE_METERS = 40.0     # total grid size (40m x 40m)
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
        self._scan_count = 0
        self._scan_skipped_tf = 0
        self._last_skipped_log = 0.0
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
        self.range_min = 0.15  # A1M8 minimum range (meters)
        self.tf_buffer = Buffer()
        self.tf_listener = TransformListener(self.tf_buffer, self)
        self.last_pose_x = 0.0
        self.last_pose_y = 0.0
        self.last_pose_theta = 0.0
        self.last_update_pose_x = 0.0
        self.last_update_pose_y = 0.0

        # --- Mode state ---
        # Read initial mode from MAPPING_MODE env (set by docker-compose)
        env_mode = os.environ.get('MAPPING_MODE', '').strip().lower()
        if env_mode == 'mapping':
            self.mode = 'MAPPING'
        elif env_mode == 'live':
            self.mode = 'LIVE'
            self._load_persistent_map()
        else:
            self.mode = 'IDLE'
        self.mapping_start_time = 0.0

        # --- Publishers ---
        self.map_combined_pub = self.create_publisher(OccupancyGrid, '/map_combined', 1)
        self.temporary_map_pub = self.create_publisher(OccupancyGrid, '/temporary_map', 1)
        self.status_pub = self.create_publisher(String, '/mapping_status', 1)

        # --- Subscriptions ---
        self.scan_sub = self.create_subscription(LaserScan, '/scan', self._on_scan, 10)
        self.control_sub = self.create_subscription(String, '/mapping/control', self._on_control, 10)

        # --- Timers ---
        # Pose tracking: 10 Hz (fast for real-time tracking)
        self.create_timer(0.1, self._poll_pose)
        # Map publishing: 1 Hz (every 1s) — reduced from 2Hz to save bandwidth on 800x800 grid
        self.create_timer(1.0, self._publish_maps)

        # Debug: log TF skip stats every 10s
        self.create_timer(10.0, self._log_tf_stats)

        self.get_logger().info(
            f'MapManager started — grid: {GRID_CELLS}x{GRID_CELLS} '
            f'({GRID_SIZE_METERS}m x {GRID_SIZE_METERS}m, {GRID_RESOLUTION}m/cell)'
        )
        # Publish initial mode so subscribers (web_bridge) immediately see the state
        self._switch_mode(self.mode)

        # Publish initial map immediately so the frontend gets coordinate system info
        # before the robot has moved. This is a gray/unknown grid that establishes the
        # 800x800 cell space centered at world origin.
        if self.mode != 'IDLE':
            self._publish_combined_map()

    # -------------------------------------------------------------------------
    # Raycasting — numpy-vectorized (processes all beams simultaneously)
    # -------------------------------------------------------------------------
    def _cast_rays_vectorized(self, rx: float, ry: float, theta: float,
                              angles: np.ndarray, ranges: np.ndarray,
                              layer: str, max_range: float = MAX_LASER_RANGE):
        """Mark cells along ALL lidar beams as FREE, final cells as OCCUPIED."""
        n = len(angles)
        if n == 0:
            return

        # Filter valid readings
        valid = ~(np.isinf(ranges) | np.isnan(ranges))
        valid &= (ranges >= self.range_min) & (ranges <= max_range)
        if not np.any(valid):
            return

        abs_angles = angles[valid] + theta
        valid_ranges = ranges[valid]
        n_beams = len(valid_ranges)

        if n_beams == 0:
            return

        # Step along each beam in increments of half-cell
        step = GRID_RESOLUTION * 0.5
        max_steps = int(max_range / step) + 1

        # (n_beams, n_steps) — all world positions along all beams
        dists = np.arange(max_steps, dtype=np.float32) * step
        xs = rx + np.outer(np.cos(abs_angles), dists).astype(np.float32)
        ys = ry + np.outer(np.sin(abs_angles), dists).astype(np.float32)

        # Grid coords: (n_beams, n_steps)
        gxs = ((xs - GRID_ORIGIN) / GRID_RESOLUTION).astype(np.int32)
        gys = ((ys - GRID_ORIGIN) / GRID_RESOLUTION).astype(np.int32)

        # Mask: cells inside the grid
        in_bounds = (gxs >= 0) & (gxs < GRID_CELLS) & (gys >= 0) & (gys < GRID_CELLS)

        # Per-beam: find the hit step (last step before obstacle)
        hit_steps = np.searchsorted(dists, valid_ranges, side='right')
        hit_steps = np.clip(hit_steps, 0, max_steps - 1)

        if layer == 'persistent':
            grid = self.persistent_grid
        else:
            grid = self.temporary_grid

        free_count = 0
        occ_count = 0
        occ_wx = []
        occ_wy = []

        for i in range(n_beams):
            hit_step = hit_steps[i]
            for s in range(hit_step):
                if in_bounds[i, s]:
                    gx, gy = gxs[i, s], gys[i, s]
                    j = gy * GRID_CELLS + gx
                    if s < hit_step - 1:
                        # FREE cell
                        if grid[j] == CELL_UNKNOWN:
                            grid[j] = CELL_FREE
                            free_count += 1
                    else:
                        # OCCUPIED cell (hit)
                        grid[j] = CELL_OCCUPIED
                        occ_count += 1
                        if layer == 'persistent':
                            occ_wx.append(xs[i, s])
                            occ_wy.append(ys[i, s])

        # Update bounding box
        if layer == 'persistent' and occ_count > 0:
            min_wx, max_wx = min(occ_wx), max(occ_wx)
            min_wy, max_wy = min(occ_wy), max(occ_wy)
            changed = (min_wx < self.bbox_min_x or max_wx > self.bbox_max_x or
                       min_wy < self.bbox_min_y or max_wy > self.bbox_max_y)
            if changed:
                self.bbox_min_x = min(self.bbox_min_x, min_wx)
                self.bbox_max_x = max(self.bbox_max_x, max_wx)
                self.bbox_min_y = min(self.bbox_min_y, min_wy)
                self.bbox_max_y = max(self.bbox_max_y, max_wy)
                self.last_bbox_change_time = time.time()

    def _log_tf_stats(self):
        if self._scan_count > 0:
            skip_pct = self._scan_skipped_tf / self._scan_count * 100
            self.get_logger().info(
                f'Scan stats: {self._scan_count} total, '
                f'{self._scan_skipped_tf} skipped due to TF ({skip_pct:.0f}%)'
            )

    def _has_moved(self, x: float, y: float) -> bool:
        dx = x - self.last_update_pose_x
        dy = y - self.last_update_pose_y
        dist = math.sqrt(dx * dx + dy * dy)
        if dist > TRAVEL_THRESHOLD:
            return True
        # Always process the first valid scan to initialize the grid
        if self.last_update_pose_x == 0.0 and self.last_update_pose_y == 0.0 and dist > 0:
            return True
        return False

    # -------------------------------------------------------------------------
    # Scan callback
    # -------------------------------------------------------------------------
    def _on_scan(self, msg: LaserScan):
        if self.mode == 'IDLE':
            return

        self._scan_count += 1

        # Get robot pose from TF
        try:
            t: TransformStamped = self.tf_buffer.lookup_transform(
                'map', 'base_footprint', rclpy.time.Time(),
                timeout=Duration(seconds=0.05))
            rx = t.transform.translation.x
            ry = t.transform.translation.y
            q = t.transform.rotation
            theta = self._yaw_from_quat(q.x, q.y, q.z, q.w)
        except Exception as e:
            self._scan_skipped_tf += 1
            if self._scan_skipped_tf == 1 or time.time() - self._last_skipped_log > 10:
                self.get_logger().warn(
                    f'TF lookup failed (skipping scan): {e} — '
                    f'{self._scan_skipped_tf}/{self._scan_count} scans skipped. '
                    'Is SLAM running and has the robot moved enough for localization?'
                )
                self._last_skipped_log = time.time()
            # Still publish the current combined map so the frontend sees live updates
            # even if pose is temporarily unavailable (e.g. during initialization).
            self._publish_combined_map()
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

        # Numpy vectorized raycasting
        angles = np.arange(len(msg.ranges)) * msg.angle_increment + msg.angle_min
        ranges = np.array(msg.ranges, dtype=np.float32)
        self.range_min = msg.range_min
        self._cast_rays_vectorized(rx, ry, theta, angles, ranges, 'persistent')

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

        # Numpy vectorized raycasting within TEMP_RADIUS
        angles = np.arange(len(msg.ranges)) * msg.angle_increment + msg.angle_min
        ranges = np.array(msg.ranges, dtype=np.float32)
        self.range_min = msg.range_min
        self._cast_rays_vectorized(rx, ry, theta, angles, ranges, 'temporary',
                                    max_range=TEMP_RADIUS)

        # --- Track hit counts for clearing ---
        for i, v in enumerate(self.temporary_grid):
            if v == CELL_OCCUPIED:
                self.temp_hit_count[i] += 1
            elif v == CELL_FREE:
                self.temp_hit_count[i] = 0

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
                self.get_logger().info('Switching LIVE -> MAPPING')
                self._reset_grids()
                self.mode = 'MAPPING'
                self.mapping_start_time = time.time()
            elif self.mode == 'IDLE':
                self.get_logger().info('Starting MAPPING mode')
                self._reset_grids()
                self.mode = 'MAPPING'
                self.mapping_start_time = time.time()
        elif cmd == 'stop':
            self.get_logger().info('Stopping MAPPING mode, switching to LIVE')
            self._save_persistent_map()
            self._switch_mode('LIVE')
        elif cmd == 'reset':
            if self.mode == 'LIVE':
                # Only clear temporary obstacles, keep the saved map
                self.get_logger().info('Resetting temporary obstacles')
                self.temporary_grid = [CELL_UNKNOWN] * (GRID_CELLS * GRID_CELLS)
                self.temp_hit_count = [0] * (GRID_CELLS * GRID_CELLS)
            else:
                # MAPPING/IDLE: clear everything and start fresh
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
    # Pose tracking
    # -------------------------------------------------------------------------
    def _poll_pose(self):
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

    # -------------------------------------------------------------------------
    # Map publishing
    # -------------------------------------------------------------------------
    def _publish_maps(self):
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
