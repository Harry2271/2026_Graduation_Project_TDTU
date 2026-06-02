#!/usr/bin/env python3
"""
map_manager_node — Map relay + obstacle awareness layer.

After refactoring to slam_toolbox, this node no longer builds its own map.
Instead it:

  1. Subscribes to slam_toolbox's /map topic and relays it on /map_combined.
  2. Builds a live 2m obstacle awareness zone around the robot in LIVE mode.
  3. Merges the live zone on top of the slam map for dynamic obstacle tracking.
  4. Manages the state machine (IDLE, MAPPING_IDLE, MAPPING_ACTIVE,
     SCAN_OBSTACLE, LIVE) for frontend control.

State Machine:
  IDLE            — waiting for 'start' command
  MAPPING_IDLE    — 'start' received, slam_toolbox building map, waiting for movement
  MAPPING_ACTIVE  — robot moved, slam_toolbox recording, relaying map
  SCAN_OBSTACLE   — 'stop' received, accumulating 360° scan for awareness zone
  LIVE            — showing slam map + 2m dynamic obstacle overlay

Commands via /mapping/control:
  "start"  → MAPPING_IDLE (activates slam_toolbox mapping)
  "stop"   → SCAN_OBSTACLE → LIVE
  "idle"   → IDLE
  "reset"  → clear obstacle layer, reset slam_toolbox, go IDLE

No occupancy grid building — slam_toolbox handles that.
No odom subscription — pose comes from TF (map→base_footprint).
"""
from __future__ import annotations

import math
import numpy as np
from typing import Optional, Tuple

import rclpy
from rclpy.node import Node
from rclpy.time import Time
from sensor_msgs.msg import LaserScan
from nav_msgs.msg import OccupancyGrid
from std_msgs.msg import String
from std_srvs.srv import Empty
from tf2_ros import Buffer, TransformListener

# ── Grid parameters ────────────────────────────────────────────────────────────
RESOLUTION    = 0.05          # m per cell
GRID_SIZE     = 800           # 40 m × 40 m world
ORIGIN        = -GRID_SIZE * RESOLUTION / 2.0   # -20.0 m
MAX_RANGE     = 8.0           # m — lidar max range for live grid
VOXEL_SIZE    = 0.05          # m — voxel grid bin size

# ── State machine ──────────────────────────────────────────────────────────────
STATE_IDLE           = 'IDLE'
STATE_MAPPING_IDLE   = 'MAPPING_IDLE'
STATE_MAPPING_ACTIVE = 'MAPPING_ACTIVE'
STATE_SCAN_OBSTACLE  = 'SCAN_OBSTACLE'
STATE_LIVE           = 'LIVE'

# ── Cell values ────────────────────────────────────────────────────────────────
CELL_UNKNOWN  = -1
CELL_FREE     = 0
CELL_OCCUPIED = 100

# ── Thresholds ─────────────────────────────────────────────────────���───────────
OBSTACLE_RADIUS   = 2.0        # m — post-mapping awareness zone radius
WEB_THROTTLE_HZ   = 5          # max Hz for map publication

# ── Topics ────────────────────────────────────────────────────────────────────
TOPIC_SLAM_MAP       = '/map'
TOPIC_MAP_COMBINED   = '/map_combined'
TOPIC_OBSTACLE_LAYER = '/obstacle_layer'
TOPIC_MAPPING_STATUS = '/mapping_status'
TOPIC_MAPPING_CTRL   = '/mapping/control'


def _yaw_from_quat(x: float, y: float, z: float, w: float) -> float:
    """Extract yaw from quaternion."""
    return math.atan2(2.0 * (w * z + x * x), 1.0 - 2.0 * (y * y + z * z))


def voxel_downsample(xs: np.ndarray, ys: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    """Downsample point cloud using 5cm voxel grid (nearest-point rule)."""
    if xs.size == 0:
        return np.array([], dtype=np.float32), np.array([], dtype=np.float32)
    gx = np.round(xs / VOXEL_SIZE).astype(np.int32)
    gy = np.round(ys / VOXEL_SIZE).astype(np.int32)
    stride = max(1, gx.max() - gx.min() + 1)
    keys = (gx - gx.min()) + (gy - gy.min()) * stride
    order = np.lexsort((ys, xs))
    keys_s = keys[order]
    xs_s = xs[order]
    ys_s = ys[order]
    _, first_idx = np.unique(keys_s, return_index=True)
    return xs_s[first_idx].astype(np.float32), ys_s[first_idx].astype(np.float32)


class MapManager(Node):
    """
    Map relay + obstacle awareness layer for slam_toolbox.

    Subscribes to slam_toolbox's /map and relays it to the web bridge
    on /map_combined.  In LIVE mode, overlays a 2m dynamic obstacle zone
    built from current lidar scans.
    """

    def __init__(self) -> None:
        super().__init__('map_manager')

        # ── State machine ────────────────────────────────────────────────
        self.state: str = STATE_IDLE

        # ── TF2 for pose extraction (replaces /odom subscription) ───────
        self.tf_buffer = Buffer()
        self.tf_listener = TransformListener(self.tf_buffer, self)

        # ── Slam map cache ──────────────────────────────────────────────
        self.slam_map_cache: Optional[OccupancyGrid] = None

        # ── Live obstacle grid (2m radius, rebuilt per scan) ────────────
        self.temp_grid: np.ndarray = np.full(
            GRID_SIZE * GRID_SIZE, CELL_UNKNOWN, dtype=np.int8)

        # ── Obstacle scan accumulator (for SCAN_OBSTACLE state) ─────────
        self._obstacle_scan_buf: list = []

        # ── Throttling ──────────────────────────────────────────────────
        self._last_publish_time: float = 0.0

        # ── Subscriptions ───────────────────────────────────────────────
        self.slam_map_sub = self.create_subscription(
            OccupancyGrid, TOPIC_SLAM_MAP, self._on_slam_map, 10)
        self.scan_sub = self.create_subscription(
            LaserScan, '/scan', self._on_scan, 10)
        self.ctrl_sub = self.create_subscription(
            String, TOPIC_MAPPING_CTRL, self._on_control, 10)

        # ── Publishers ──────────────────────────────────────────────────
        self.map_pub = self.create_publisher(
            OccupancyGrid, TOPIC_MAP_COMBINED, 1)
        self.obstacle_pub = self.create_publisher(
            OccupancyGrid, TOPIC_OBSTACLE_LAYER, 1)
        self.status_pub = self.create_publisher(
            String, TOPIC_MAPPING_STATUS, 1)

        # ── Slam toolbox reset service client ───────────────────────────
        self.slam_reset_client = self.create_client(Empty, '/slam_toolbox/reset')

        # ── Timers ──────────────────────────────────────────────────────
        self.create_timer(1.0 / WEB_THROTTLE_HZ, self._throttled_publish)

        self._publish_status()
        self.get_logger().info('MapManager started (slam_toolbox relay mode)')

    # ── Subscriptions ──────────────────────────────────────────────────────────

    def _on_slam_map(self, msg: OccupancyGrid) -> None:
        """Cache the latest map from slam_toolbox."""
        self.slam_map_cache = msg

    def _on_control(self, msg: String) -> None:
        cmd = msg.data.strip().lower()
        self.get_logger().info(f'Control command: {cmd!r} (current state: {self.state})')

        if cmd == 'start':
            if self.state not in (STATE_MAPPING_IDLE, STATE_MAPPING_ACTIVE):
                self.get_logger().info(f'Start: transitioning {self.state} → MAPPING_IDLE')
                self._enter_mapping_idle()
            else:
                self.get_logger().warn(f'Start: ignored (already in {self.state})')
        elif cmd == 'stop':
            if self.state in (STATE_MAPPING_IDLE, STATE_MAPPING_ACTIVE):
                self.get_logger().info(f'Stop: transitioning {self.state} → SCAN_OBSTACLE')
                self._enter_scan_obstacle()
            else:
                self.get_logger().warn(f'Stop: ignored (not in mapping state, current={self.state})')
        elif cmd == 'idle':
            self.get_logger().info(f'Idle: transitioning {self.state} → IDLE')
            self._enter_idle()
        elif cmd == 'reset':
            self.get_logger().info(f'Reset: clearing obstacles and resetting slam_toolbox')
            self._reset_slam_and_obstacles()
        else:
            self.get_logger().warn(f'Unknown command: {cmd!r}')

    def _on_scan(self, msg: LaserScan) -> None:
        """Route scan to the appropriate handler based on state."""
        if self.state == STATE_SCAN_OBSTACLE:
            self._handle_obstacle_scan(msg)
        elif self.state == STATE_LIVE:
            self._handle_live_scan(msg)
        # MAPPING states: slam_toolbox handles scan processing directly.

    # ── State transitions ──────────────────────────────────────────────────────

    def _enter_idle(self) -> None:
        self.state = STATE_IDLE
        self.get_logger().info('Entered IDLE')
        self._publish_status()

    def _enter_mapping_idle(self) -> None:
        self.state = STATE_MAPPING_IDLE
        self.get_logger().info('Entered MAPPING_IDLE — slam_toolbox building map')
        self._publish_status()

    def _enter_scan_obstacle(self) -> None:
        self.state = STATE_SCAN_OBSTACLE
        self._obstacle_scan_buf = []
        self.get_logger().info('Entered SCAN_OBSTACLE — accumulating 360° scan')
        self._publish_status()

    def _enter_live(self) -> None:
        self.state = STATE_LIVE
        self.temp_grid[:] = CELL_UNKNOWN
        self.get_logger().info('Entered LIVE — slam map + 2m awareness zone')
        self._publish_status()

    def _reset_slam_and_obstacles(self) -> None:
        """Clear obstacle layers and reset slam_toolbox."""
        self.temp_grid[:] = CELL_UNKNOWN
        self._obstacle_scan_buf = []

        # Call slam_toolbox reset service (non-blocking)
        if self.slam_reset_client.service_is_ready():
            self.slam_reset_client.call_async(Empty.Request())
            self.get_logger().info('Sent reset to slam_toolbox')
        else:
            self.get_logger().error('slam_toolbox reset service not available')

        self._enter_idle()

    # ── Pose extraction via TF ─────────────────────────────────────────────────

    def _get_robot_pose(self) -> Tuple[float, float, float]:
        """Look up map→base_footprint transform from slam_toolbox's TF tree."""
        try:
            tf = self.tf_buffer.lookup_transform(
                'map', 'base_footprint', Time())
            x = tf.transform.translation.x
            y = tf.transform.translation.y
            q = tf.transform.rotation
            theta = _yaw_from_quat(q.x, q.y, q.z, q.w)
            return (x, y, theta)
        except Exception:
            return (0.0, 0.0, 0.0)

    # ── Scan handlers ───────────────────────────────────────────────────────────

    def _handle_obstacle_scan(self, msg: LaserScan) -> None:
        """Accumulate clean scan points within 2m during SCAN_OBSTACLE."""
        ranges = np.array(msg.ranges, dtype=np.float32)
        angles = np.arange(len(ranges)) * msg.angle_increment + msg.angle_min

        valid = ~(np.isinf(ranges) | np.isnan(ranges))
        valid &= (ranges >= msg.range_min) & (ranges <= MAX_RANGE)
        if not np.any(valid):
            return

        rx, ry, _ = self._get_robot_pose()

        abs_angles = angles[valid] + math.atan2(0, 1)  # orientation handled by TF
        valid_ranges = ranges[valid]

        # World coordinates: use TF pose for robot position, lidar angles for direction
        _, _, theta = self._get_robot_pose()
        abs_angles = angles[valid] + theta
        wxs = rx + valid_ranges * np.cos(abs_angles)
        wys = ry + valid_ranges * np.sin(abs_angles)

        # Filter to 2m radius
        dists_sq = (wxs - rx) ** 2 + (wys - ry) ** 2
        mask = dists_sq <= OBSTACLE_RADIUS ** 2

        # Voxel downsample
        dx, dy = voxel_downsample(wxs[mask], wys[mask])
        self._obstacle_scan_buf.append((dx, dy))

        # After full 360° accumulation (80% coverage heuristic)
        total_points = sum(p[0].size for p in self._obstacle_scan_buf)
        expected_full = int((2 * math.pi / msg.angle_increment) * 0.8)
        if total_points >= expected_full and len(self._obstacle_scan_buf) >= 3:
            self._finalize_obstacle_scan()

    def _handle_live_scan(self, msg: LaserScan) -> None:
        """Build the live 2m-radius grid around the robot."""
        self._build_live_grid(msg)

    # ── Obstacle scan finalisation ─────────────────────────────────────────────

    def _finalize_obstacle_scan(self) -> None:
        """Merge accumulated scans into obstacle_grid and switch to LIVE."""
        all_x = np.concatenate([p[0] for p in self._obstacle_scan_buf])
        all_y = np.concatenate([p[1] for p in self._obstacle_scan_buf])
        self._obstacle_scan_buf = []

        # Voxel downsample
        vx, vy = voxel_downsample(all_x, all_y)
        if vx.size == 0:
            self._enter_live()
            return

        # Convert to grid cells
        gx = np.round((vx - ORIGIN) / RESOLUTION).astype(np.int32)
        gy = np.round((vy - ORIGIN) / RESOLUTION).astype(np.int32)
        mask = (gx >= 0) & (gx < GRID_SIZE) & (gy >= 0) & (gy < GRID_SIZE)

        # Build obstacle grid for publishing
        obs_grid = np.full(GRID_SIZE * GRID_SIZE, CELL_UNKNOWN, dtype=np.int8)
        for ix, iy in zip(gx[mask], gy[mask]):
            obs_grid[iy * GRID_SIZE + ix] = CELL_OCCUPIED

        self.get_logger().info(
            f'Obstacle scan finalised — {vx.size} points within {OBSTACLE_RADIUS}m')

        # Publish obstacle layer once
        self._publish_obstacle_layer_from(obs_grid)

        self._enter_live()

    # ── Live grid (2m awareness zone) ──────────────────────────────────────────

    def _build_live_grid(self, msg: LaserScan) -> None:
        """Rebuild temp_grid from current scan — vectorized ray-march."""
        ranges = np.array(msg.ranges, dtype=np.float32)
        angles = np.arange(len(ranges)) * msg.angle_increment + msg.angle_min

        valid = ~(np.isinf(ranges) | np.isnan(ranges))
        valid &= (ranges >= msg.range_min) & (ranges <= MAX_RANGE)
        if not np.any(valid):
            return

        rx, ry, theta = self._get_robot_pose()
        abs_angles = angles[valid] + theta
        valid_ranges = ranges[valid]

        step = RESOLUTION * 0.5
        max_steps = int(MAX_RANGE / step) + 1
        dists = np.arange(max_steps, dtype=np.float32) * step

        xs = rx + np.outer(np.cos(abs_angles), dists).astype(np.float32)
        ys = ry + np.outer(np.sin(abs_angles), dists).astype(np.float32)

        gxs = ((xs - ORIGIN) / RESOLUTION).astype(np.int32)
        gys = ((ys - ORIGIN) / RESOLUTION).astype(np.int32)

        in_bounds = (gxs >= 0) & (gxs < GRID_SIZE) & (gys >= 0) & (gys < GRID_SIZE)

        hit_steps = np.clip(
            np.searchsorted(dists, valid_ranges, side='right'),
            0, max_steps - 1)

        grid = self.temp_grid
        grid[:] = CELL_UNKNOWN

        # Vectorized ray-march + occupancy
        n_rays = len(valid_ranges)
        ray_idx = np.repeat(np.arange(n_rays, dtype=np.int32), max_steps)
        step_idx = np.tile(np.arange(max_steps, dtype=np.int32), n_rays)
        flat = gys.ravel() * GRID_SIZE + gxs.ravel()
        ok = (step_idx < hit_steps.ravel()[ray_idx]) & in_bounds.ravel()
        free_cells = flat[ok]
        if free_cells.size > 0:
            unknown_mask = grid[free_cells] == CELL_UNKNOWN
            grid[free_cells[unknown_mask]] = CELL_FREE

        ht_indices = np.clip(hit_steps, 0, max_steps - 1)
        hit_flat = (
            gys[np.arange(n_rays), ht_indices] * GRID_SIZE +
            gxs[np.arange(n_rays), ht_indices])
        hit_valid = (hit_flat >= 0) & (hit_flat < GRID_SIZE * GRID_SIZE)
        grid[hit_flat[hit_valid]] = CELL_OCCUPIED

        # Mask: keep only 2m radius around robot
        r_gx = int((rx - ORIGIN) / RESOLUTION)
        r_gy = int((ry - ORIGIN) / RESOLUTION)
        r_radius = int(OBSTACLE_RADIUS / RESOLUTION)
        y_lo, y_hi = max(0, r_gy - r_radius), min(GRID_SIZE, r_gy + r_radius)
        x_lo, x_hi = max(0, r_gx - r_radius), min(GRID_SIZE, r_gx + r_radius)
        if y_hi > y_lo and x_hi > x_lo:
            gy_range = np.arange(y_lo, y_hi, dtype=np.int32)
            gx_range = np.arange(x_lo, x_hi, dtype=np.int32)
            yy, xx = np.meshgrid(gy_range, gx_range, indexing='ij')
            wx = xx * RESOLUTION + ORIGIN
            wy = yy * RESOLUTION + ORIGIN
            dist_sq = (wx - rx) ** 2 + (wy - ry) ** 2
            outside = dist_sq > OBSTACLE_RADIUS ** 2
            flat_idx = yy.ravel() * GRID_SIZE + xx.ravel()
            grid[flat_idx[outside.ravel()]] = CELL_UNKNOWN

    # ── Publishers ─────────────────────────────────────────────────────────────

    def _throttled_publish(self) -> None:
        """Rate-limited publish — enforced WEB_THROTTLE_HZ ceiling."""
        now = self.get_clock().now().nanoseconds * 1e-9
        period = 1.0 / WEB_THROTTLE_HZ
        if now - self._last_publish_time < period * 0.99:
            return
        self._last_publish_time = now

        if self.state in (STATE_MAPPING_IDLE, STATE_MAPPING_ACTIVE, STATE_LIVE,
                          STATE_SCAN_OBSTACLE):
            self._publish_map_layer()

    def _publish_map_layer(self) -> None:
        """Publish the map — either raw slam map or merged with live overlay."""
        if self.slam_map_cache is None:
            return

        if self.state == STATE_LIVE:
            # Merge: slam map + live 2m obstacle overlay
            slam_data = np.array(self.slam_map_cache.data, dtype=np.int8)
            combined = slam_data.copy()
            live_mask = self.temp_grid != CELL_UNKNOWN
            combined[live_mask] = self.temp_grid[live_mask]

            msg = OccupancyGrid()
            msg.header.stamp = self.get_clock().now().to_msg()
            msg.header.frame_id = 'map'
            msg.info = self.slam_map_cache.info
            msg.data = combined.tolist()
            self.map_pub.publish(msg)
        else:
            # Forward slam_toolbox's map directly
            self.map_pub.publish(self.slam_map_cache)

    def _publish_obstacle_layer_from(self, grid: np.ndarray) -> None:
        """Publish the obstacle awareness zone as a separate layer."""
        msg = OccupancyGrid()
        msg.header.stamp = self.get_clock().now().to_msg()
        msg.header.frame_id = 'map'
        msg.info.width = GRID_SIZE
        msg.info.height = GRID_SIZE
        msg.info.resolution = RESOLUTION
        msg.info.origin.position.x = ORIGIN
        msg.info.origin.position.y = ORIGIN
        msg.info.origin.orientation.w = 1.0
        msg.data = grid.tolist()
        self.obstacle_pub.publish(msg)

    def _publish_status(self) -> None:
        labels = {
            STATE_IDLE:           'IDLE: waiting',
            STATE_MAPPING_IDLE:   'MAPPING: waiting for movement...',
            STATE_MAPPING_ACTIVE: 'MAPPING: recording...',
            STATE_SCAN_OBSTACLE:  'MAPPING: scanning obstacles...',
            STATE_LIVE:           'LIVE: localizing',
        }
        self.status_pub.publish(String(data=labels.get(self.state, 'IDLE: unknown')))


def main() -> None:
    rclpy.init()
    node = MapManager()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        try:
            rclpy.shutdown()
        except Exception:
            pass


if __name__ == '__main__':
    main()
