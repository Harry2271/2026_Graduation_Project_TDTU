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

# ── Scan parameters ────────────────────────────────────────────────────────────
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
    # Correct formula: siny_cosp = 2*(qw*qz + qx*qy)
    siny_cosp = 2.0 * (w * z + x * y)
    cosy_cosp = 1.0 - 2.0 * (y * y + z * z)
    return math.atan2(siny_cosp, cosy_cosp)


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
        self._mapping_start_pose: Optional[Tuple[float, float]] = None

        # ── TF2 for pose extraction (replaces /odom subscription) ───────
        self.tf_buffer = Buffer()
        self.tf_listener = TransformListener(self.tf_buffer, self)

        # ── Slam map cache ──────────────────────────────────────────────
        self.slam_map_cache: Optional[OccupancyGrid] = None

        # ── Live obstacle grid (matches the current slam map geometry) ──
        self.temp_grid: Optional[np.ndarray] = None
        self._temp_grid_geometry: Optional[Tuple[int, int, float, float, float]] = None

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
        """Cache only well-formed maps and resize the live overlay as needed."""
        geometry = self._grid_geometry(msg)
        if geometry is None:
            self.get_logger().warn(
                'Ignoring malformed slam map: data length does not match geometry')
            return
        self.slam_map_cache = msg
        self._prepare_live_grid(geometry)

    @staticmethod
    def _grid_geometry(msg: OccupancyGrid) -> Optional[Tuple[int, int, float, float, float]]:
        """Return width, height, resolution and origin for a valid occupancy grid."""
        width = int(msg.info.width)
        height = int(msg.info.height)
        resolution = float(msg.info.resolution)
        if width <= 0 or height <= 0 or resolution <= 0.0:
            return None
        if len(msg.data) != width * height:
            return None
        return (
            width,
            height,
            resolution,
            float(msg.info.origin.position.x),
            float(msg.info.origin.position.y),
        )

    def _clear_live_grid(self) -> None:
        self.temp_grid = None
        self._temp_grid_geometry = None

    def _prepare_live_grid(
        self, geometry: Tuple[int, int, float, float, float]
    ) -> None:
        """Allocate the overlay using the current SLAM map geometry."""
        if self._temp_grid_geometry == geometry and self.temp_grid is not None:
            return
        width, height, _resolution, _origin_x, _origin_y = geometry
        self.temp_grid = np.full(width * height, CELL_UNKNOWN, dtype=np.int8)
        self._temp_grid_geometry = geometry

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
        if self.state == STATE_MAPPING_IDLE:
            self._activate_mapping_if_moved()
        elif self.state == STATE_SCAN_OBSTACLE:
            self._handle_obstacle_scan(msg)
        elif self.state == STATE_LIVE:
            self._handle_live_scan(msg)
        # MAPPING_ACTIVE is handled by slam_toolbox directly.

    # ── State transitions ──────────────────────────────────────────────────────

    def _enter_idle(self) -> None:
        self.state = STATE_IDLE
        self.get_logger().info('Entered IDLE')
        self._publish_status()

    def _enter_mapping_idle(self) -> None:
        self.state = STATE_MAPPING_IDLE
        x, y, _ = self._get_robot_pose()
        self._mapping_start_pose = (x, y)
        self.get_logger().info('Entered MAPPING_IDLE — waiting for robot movement')
        self._publish_status()

    def _activate_mapping_if_moved(self) -> None:
        if self._mapping_start_pose is None:
            return
        x, y, _ = self._get_robot_pose()
        start_x, start_y = self._mapping_start_pose
        if math.hypot(x - start_x, y - start_y) < 0.05:
            return
        self.state = STATE_MAPPING_ACTIVE
        self.get_logger().info('Entered MAPPING_ACTIVE — robot movement detected')
        self._publish_status()

    def _enter_scan_obstacle(self) -> None:
        self.state = STATE_SCAN_OBSTACLE
        self._obstacle_scan_buf = []
        self.get_logger().info('Entered SCAN_OBSTACLE — accumulating 360° scan')
        self._publish_status()

    def _enter_live(self) -> None:
        self.state = STATE_LIVE
        if self.temp_grid is not None:
            self.temp_grid[:] = CELL_UNKNOWN
        self.get_logger().info('Entered LIVE — slam map + 2m awareness zone')
        self._publish_status()

    def _reset_slam_and_obstacles(self) -> None:
        """Clear obstacle layers and reset slam_toolbox."""
        self._clear_live_grid()
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

        rx, ry, theta = self._get_robot_pose()
        valid_ranges = ranges[valid]

        # World coordinates: use one TF pose snapshot for position and heading.
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

        if self.slam_map_cache is None:
            self.get_logger().warn('Cannot publish obstacle layer before receiving a slam map')
            self._enter_live()
            return
        geometry = self._grid_geometry(self.slam_map_cache)
        if geometry is None:
            self.get_logger().warn('Cannot publish obstacle layer from malformed slam map')
            self._enter_live()
            return
        self._prepare_live_grid(geometry)
        width, height, resolution, origin_x, origin_y = geometry

        # Convert world points to cells using the current SLAM map geometry.
        gx = np.floor((vx - origin_x) / resolution).astype(np.int32)
        gy = np.floor((vy - origin_y) / resolution).astype(np.int32)
        mask = (gx >= 0) & (gx < width) & (gy >= 0) & (gy < height)

        obs_grid = np.full(width * height, CELL_UNKNOWN, dtype=np.int8)
        obs_grid[gy[mask] * width + gx[mask]] = CELL_OCCUPIED

        self.get_logger().info(
            f'Obstacle scan finalised — {vx.size} points within {OBSTACLE_RADIUS}m')

        # Publish obstacle layer once using exactly the SLAM map geometry.
        self._publish_obstacle_layer_from(obs_grid, geometry)

        self._enter_live()

    # ── Live grid (2m awareness zone) ──────────────────────────────────────────

    def _build_live_grid(self, msg: LaserScan) -> None:
        """Rebuild the dynamic overlay using the current SLAM map geometry."""
        if self.slam_map_cache is None:
            return
        geometry = self._grid_geometry(self.slam_map_cache)
        if geometry is None:
            self._clear_live_grid()
            return
        self._prepare_live_grid(geometry)
        width, height, resolution, origin_x, origin_y = geometry

        ranges = np.array(msg.ranges, dtype=np.float32)
        angles = np.arange(len(ranges)) * msg.angle_increment + msg.angle_min

        valid = ~(np.isinf(ranges) | np.isnan(ranges))
        valid &= (ranges >= msg.range_min) & (ranges <= MAX_RANGE)
        if not np.any(valid):
            return

        rx, ry, theta = self._get_robot_pose()
        abs_angles = angles[valid] + theta
        valid_ranges = ranges[valid]

        step = resolution * 0.5
        max_steps = int(MAX_RANGE / step) + 1
        dists = np.arange(max_steps, dtype=np.float32) * step

        xs = rx + np.outer(np.cos(abs_angles), dists).astype(np.float32)
        ys = ry + np.outer(np.sin(abs_angles), dists).astype(np.float32)

        gxs = np.floor((xs - origin_x) / resolution).astype(np.int32)
        gys = np.floor((ys - origin_y) / resolution).astype(np.int32)

        in_bounds = (gxs >= 0) & (gxs < width) & (gys >= 0) & (gys < height)

        hit_steps = np.clip(
            np.searchsorted(dists, valid_ranges, side='right'),
            0, max_steps - 1)

        grid = self.temp_grid
        if grid is None:
            return
        grid[:] = CELL_UNKNOWN

        # Vectorized ray-march + occupancy
        n_rays = len(valid_ranges)
        ray_idx = np.repeat(np.arange(n_rays, dtype=np.int32), max_steps)
        step_idx = np.tile(np.arange(max_steps, dtype=np.int32), n_rays)
        flat = gys.ravel() * width + gxs.ravel()
        ok = (step_idx < hit_steps.ravel()[ray_idx]) & in_bounds.ravel()
        free_cells = flat[ok]
        if free_cells.size > 0:
            unknown_mask = grid[free_cells] == CELL_UNKNOWN
            grid[free_cells[unknown_mask]] = CELL_FREE

        ht_indices = np.clip(hit_steps, 0, max_steps - 1)
        hit_flat = (
            gys[np.arange(n_rays), ht_indices] * width +
            gxs[np.arange(n_rays), ht_indices])
        hit_valid = (hit_flat >= 0) & (hit_flat < width * height)
        grid[hit_flat[hit_valid]] = CELL_OCCUPIED

        # Mask: keep only 2m radius around robot
        r_gx = int(math.floor((rx - origin_x) / resolution))
        r_gy = int(math.floor((ry - origin_y) / resolution))
        r_radius = int(OBSTACLE_RADIUS / resolution)
        y_lo, y_hi = max(0, r_gy - r_radius), min(height, r_gy + r_radius)
        x_lo, x_hi = max(0, r_gx - r_radius), min(width, r_gx + r_radius)
        if y_hi > y_lo and x_hi > x_lo:
            gy_range = np.arange(y_lo, y_hi, dtype=np.int32)
            gx_range = np.arange(x_lo, x_hi, dtype=np.int32)
            yy, xx = np.meshgrid(gy_range, gx_range, indexing='ij')
            wx = (xx + 0.5) * resolution + origin_x
            wy = (yy + 0.5) * resolution + origin_y
            dist_sq = (wx - rx) ** 2 + (wy - ry) ** 2
            outside = dist_sq > OBSTACLE_RADIUS ** 2
            flat_idx = yy.ravel() * width + xx.ravel()
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
            geometry = self._grid_geometry(self.slam_map_cache)
            if geometry is None:
                return
            self._prepare_live_grid(geometry)
            if self.temp_grid is None:
                return

            # Merge: slam map + live 2m obstacle overlay with matching geometry.
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

    def _publish_obstacle_layer_from(
        self, grid: np.ndarray, geometry: Tuple[int, int, float, float, float]
    ) -> None:
        """Publish the obstacle awareness zone with the current SLAM geometry."""
        width, height, resolution, origin_x, origin_y = geometry
        msg = OccupancyGrid()
        msg.header.stamp = self.get_clock().now().to_msg()
        msg.header.frame_id = 'map'
        msg.info.width = width
        msg.info.height = height
        msg.info.resolution = resolution
        msg.info.origin.position.x = origin_x
        msg.info.origin.position.y = origin_y
        msg.info.origin.orientation.w = 1.0
        msg.data = grid.tolist()
        self.obstacle_pub.publish(msg)

    def _publish_status(self) -> None:
        # Status strings are formatted as "STATE_NAME: <description>" so
        # web_bridge.py can parse the state from the prefix (the underscored
        # form is unambiguous, the bare "MAPPING" was ambiguous between
        # MAPPING_IDLE / MAPPING_ACTIVE / SCAN_OBSTACLE).
        labels = {
            STATE_IDLE:           'IDLE: waiting',
            STATE_MAPPING_IDLE:   'MAPPING_IDLE: waiting for movement...',
            STATE_MAPPING_ACTIVE: 'MAPPING_ACTIVE: recording...',
            STATE_SCAN_OBSTACLE:  'SCAN_OBSTACLE: scanning obstacles...',
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
