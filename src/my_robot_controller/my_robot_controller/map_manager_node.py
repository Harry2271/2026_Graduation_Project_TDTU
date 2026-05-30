#!/usr/bin/env python3
"""
map_manager_node — Lidar occupancy grid builder with manual mapping control.

States:
  IDLE            — no mapping in progress
  MAPPING_IDLE   — 'start' received, waiting for robot to move
  MAPPING_ACTIVE — robot moved > threshold, recording map with settling-time logic
  SCAN_OBSTACLE  — 'stop' received, performing final 360° obstacle scan
  LIVE           — showing 2m radius around robot (dynamic obstacles)

Commands via /mapping/control:
  "start" → MAPPING_IDLE
  "stop"  → SCAN_OBSTACLE → LIVE

Smart Movement Trigger:
  Map update only when robot has moved > 15cm linear OR rotated > 15° from last
  recorded pose. After trigger, robot waits 0.5–1.0 s (settling time) before
  taking the clean snapshot.

Voxel Grid Filtering:
  Point cloud is downsampled to 5cm bins before grid update. CPU savings are
  significant at full 360° / 12 Hz lidar rates.

Post-Mapping Obstacle Scan:
  After 'stop', robot performs one clean 360° scan. All points within 2 m of the
  robot are published on /obstacle_layer as a separate OccupancyGrid so the
  frontend can render the awareness zone as a distinct overlay.
"""
import math
import numpy as np
import rclpy
from rclpy.node import Node
from sensor_msgs.msg import LaserScan
from nav_msgs.msg import Odometry, OccupancyGrid
from std_msgs.msg import String

# ── Grid parameters ────────────────────────────────────────────────────────────
RESOLUTION   = 0.05          # m per cell
GRID_SIZE    = 800           # 40 m × 40 m world
ORIGIN       = -GRID_SIZE * RESOLUTION / 2.0   # -20.0 m
MAX_RANGE    = 8.0           # m — lidar maximum range
VOXEL_SIZE   = 0.05          # m — voxel grid bin size (same as RESOLUTION)

# ── State machine ──────────────────────────────────────────────────────────────
STATE_IDLE           = 'IDLE'
STATE_MAPPING_IDLE   = 'MAPPING_IDLE'
STATE_MAPPING_ACTIVE = 'MAPPING_ACTIVE'
STATE_SCAN_OBSTACLE  = 'SCAN_OBSTACLE'
STATE_LIVE           = 'LIVE'

# ── Cell values ────────────────────────────────────────────────────────────────
CELL_UNKNOWN   = -1
CELL_FREE      = 0
CELL_OCCUPIED  = 100

# ── Thresholds ─────────────────────────────────────────────────────────────────
DIST_THRESHOLD   = 0.05       # m — minimum linear movement to trigger map update
ANGLE_THRESHOLD  = math.radians(5)  # rad — minimum angular movement
SETTLING_TIME_MIN = 0.2       # s
SETTLING_TIME_MAX = 0.4       # s
OBSTACLE_RADIUS  = 2.0        # m — post-mapping awareness zone radius
WEB_THROTTLE_HZ  = 5          # max Hz for layer publication

# ── Topics ────────────────────────────────────────────────────────────────────
TOPIC_OBSTACLE_LAYER = '/obstacle_layer'   # separate awareness-zone grid


def _yaw(x, y, z, w):
    return math.atan2(2 * (w * y + z * x), 1 - 2 * (x * x + y * y))


def voxel_downsample(xs: np.ndarray, ys: np.ndarray) -> tuple:
    """
    Downsample (x, y) point cloud using a simple voxel grid (nearest-point rule).

    All points that fall in the same VOXEL_SIZE × VOXEL_SIZE bin are reduced
    to a single representative point: the one closest to the bin centre.
    Returns (filtered_x, filtered_y) as numpy arrays of equal length.
    """
    if xs.size == 0:
        return np.array([], dtype=np.float32), np.array([], dtype=np.float32)

    # Snap each point to its voxel cell centre
    gx = np.round(xs / VOXEL_SIZE).astype(np.int32)
    gy = np.round(ys / VOXEL_SIZE).astype(np.int32)

    # Linearise cell key for deduplication
    stride = max(1, gx.max() - gx.min() + 1)
    keys = (gx - gx.min()) + (gy - gy.min()) * stride

    # For each unique cell, keep the point with smallest distance to cell centre
    order = np.lexsort((ys, xs))          # sort by x then y
    keys = keys[order]
    xs_s = xs[order]
    ys_s = ys[order]

    unique_keys, first_idx = np.unique(keys, return_index=True)
    result_x = xs_s[first_idx]
    result_y = ys_s[first_idx]
    return result_x.astype(np.float32), result_y.astype(np.float32)


class MapManager(Node):
    def __init__(self):
        super().__init__('map_manager')

        # ── State ─────────────────────────────────────────────────────────────
        self.state = STATE_IDLE

        # ── Grids ─────────────────────────────────────────────────────────────
        self.persistent_grid = np.full(GRID_SIZE * GRID_SIZE, CELL_UNKNOWN, dtype=np.int8)
        self.temp_grid       = np.full(GRID_SIZE * GRID_SIZE, CELL_UNKNOWN, dtype=np.int8)
        self.obstacle_grid   = np.full(GRID_SIZE * GRID_SIZE, CELL_UNKNOWN, dtype=np.int8)

        # ── Odometry ─────────────────────────────────────────────────────────
        self.odom_x     = 0.0
        self.odom_y     = 0.0
        self.odom_theta = 0.0

        # ── Movement tracking (for smart trigger) ──────────────────────────────
        self.last_recorded_x     = 0.0
        self.last_recorded_y     = 0.0
        self.last_recorded_theta = 0.0

        # ── Settling-time state ───────────────────────────────────────────────
        self._settling_pending  = False
        self._settle_deadline  = 0.0          # wall-clock time (s)
        self._pending_scan_buf = None          # LaserScan held during settle

        # ── Obstacle scan state ────────────────────────────────────────────────
        self._obstacle_scan_buf = []           # accumulated scan points for SCAN_OBSTACLE

        # ── Throttling ────────────────────────────────────────────────────────
        self._last_publish_time = 0.0

        # ── Subscriptions ─────────────────────────────────────────────────────
        self.scan_sub = self.create_subscription(LaserScan, '/scan',     self._on_scan,     10)
        self.odom_sub = self.create_subscription(Odometry,  '/odom',     self._on_odom,    10)
        self.ctrl_sub = self.create_subscription(String,    '/mapping/control', self._on_control, 10)

        # ── Publishers ────────────────────────────────────────────────────────
        self.map_pub       = self.create_publisher(OccupancyGrid, '/map_combined',      1)
        self.obstacle_pub  = self.create_publisher(OccupancyGrid, TOPIC_OBSTACLE_LAYER, 1)
        self.status_pub    = self.create_publisher(String, '/mapping_status', 1)

        # ── Timers ────────────────────────────────────────────────────────────
        # Settling timer fires at SETTLING_TIME_MIN to begin settle countdown.
        # Actual snapshot is taken at _settle_deadline (randomised up to SETTLING_TIME_MAX).
        self.create_timer(0.05, self._settling_tick)
        self.create_timer(1.0 / WEB_THROTTLE_HZ, self._throttled_publish)

        self._publish_status()
        self.get_logger().info(f'MapManager started in {self.state} state')

    # ── Subscriptions ──────────────────────────────────────────────────────────

    def _on_odom(self, msg: Odometry):
        self.odom_x     = msg.pose.pose.position.x
        self.odom_y     = msg.pose.pose.position.y
        q = msg.pose.pose.orientation
        self.odom_theta = _yaw(q.x, q.y, q.z, q.w)

    def _on_control(self, msg: String):
        cmd = msg.data.strip().lower()
        self.get_logger().info(f'Control command: {cmd}')

        if cmd == 'start':
            if self.state not in (STATE_MAPPING_IDLE, STATE_MAPPING_ACTIVE):
                self._enter_mapping_idle()
        elif cmd == 'stop':
            if self.state in (STATE_MAPPING_IDLE, STATE_MAPPING_ACTIVE):
                self._enter_scan_obstacle()
        elif cmd == 'idle':
            self._enter_idle()
        elif cmd == 'reset':
            self.persistent_grid[:] = CELL_UNKNOWN
            self.temp_grid[:]       = CELL_UNKNOWN
            self.obstacle_grid[:]   = CELL_UNKNOWN
            self._enter_idle()
            self._publish_map_layer()
            self._publish_obstacle_layer()

    def _on_scan(self, msg: LaserScan):
        """Route scan to the appropriate handler based on current state."""
        if self.state == STATE_SCAN_OBSTACLE:
            self._handle_obstacle_scan(msg)
        elif self.state in (STATE_MAPPING_IDLE, STATE_MAPPING_ACTIVE):
            self._handle_mapping_scan(msg)
        elif self.state == STATE_LIVE:
            self._handle_live_scan(msg)

    # ── State transitions ──────────────────────────────────────────────────────

    def _enter_idle(self):
        self.state = STATE_IDLE
        self._settling_pending = False
        self._pending_scan_buf = None
        self._publish_status()

    def _enter_mapping_idle(self):
        self.persistent_grid[:] = CELL_UNKNOWN
        self.temp_grid[:]       = CELL_UNKNOWN
        self.obstacle_grid[:]   = CELL_UNKNOWN
        self.state = STATE_MAPPING_IDLE
        self._settling_pending = False
        self._pending_scan_buf = None
        # Reset last recorded pose so first movement always triggers
        self.last_recorded_x     = self.odom_x
        self.last_recorded_y     = self.odom_y
        self.last_recorded_theta = self.odom_theta
        self._publish_status()
        self.get_logger().info('Entered MAPPING_IDLE — move the robot to begin recording')

    def _enter_mapping_active(self, scan_msg: LaserScan):
        self.state = STATE_MAPPING_ACTIVE
        self._settling_pending = True
        # Random settling delay between SETTLING_TIME_MIN and SETTLING_TIME_MAX
        settle_dur = SETTLING_TIME_MIN + (hash(scan_msg.header.stamp.sec) % 100) / 100.0 * (
            SETTLING_TIME_MAX - SETTLING_TIME_MIN)
        self._settle_deadline = self.get_clock().now().nanoseconds * 1e-9 + settle_dur
        self._pending_scan_buf = scan_msg
        self.get_logger().info(
            f'Entered MAPPING_ACTIVE — settling for {settle_dur:.2f}s before recording')
        self._publish_status()

    def _enter_scan_obstacle(self):
        self.state = STATE_SCAN_OBSTACLE
        self._settling_pending = False
        self._pending_scan_buf = None
        self._obstacle_scan_buf = []
        self.get_logger().info('Entered SCAN_OBSTACLE — performing final 360° scan')
        self._publish_status()

    def _enter_live(self):
        self.state = STATE_LIVE
        self.temp_grid[:] = CELL_UNKNOWN
        self.get_logger().info('Entered LIVE — showing 2m awareness zone')
        self._publish_status()

    # ── Scan handlers ───────────────────────────────────────────────────────────

    def _handle_mapping_scan(self, msg: LaserScan):
        # During settling: hold the first scan that triggered active state,
        # discard subsequent scans until deadline.
        if self._settling_pending:
            if self.get_clock().now().nanoseconds * 1e-9 < self._settle_deadline:
                return   # still settling — discard scan
            # Settling complete: record map with the held scan, clear pending
            self._settling_pending = False
            scan = self._pending_scan_buf
            self._pending_scan_buf = None
            self._record_map_snapshot(scan)
            return

        # Normal path: check movement threshold
        dx = self.odom_x - self.last_recorded_x
        dy = self.odom_y - self.last_recorded_y
        d_lin = math.sqrt(dx * dx + dy * dy)
        d_ang = abs(self._angle_diff(self.odom_theta, self.last_recorded_theta))

        if d_lin < DIST_THRESHOLD and d_ang < ANGLE_THRESHOLD:
            return   # below threshold — no update needed

        if self.state == STATE_MAPPING_IDLE:
            self._enter_mapping_active(msg)
        else:
            self._settling_pending = True
            settle_dur = SETTLING_TIME_MIN + (hash(msg.header.stamp.sec + msg.header.stamp.nanosec) % 100) / 100.0 * (
                SETTLING_TIME_MAX - SETTLING_TIME_MIN)
            self._settle_deadline = self.get_clock().now().nanoseconds * 1e-9 + settle_dur
            self._pending_scan_buf = msg
            self.get_logger().debug(f'Movement detected — settling for {settle_dur:.2f}s')

    def _handle_obstacle_scan(self, msg: LaserScan):
        """Accumulate clean scan points during SCAN_OBSTACLE."""
        ranges = np.array(msg.ranges, dtype=np.float32)
        angles = np.arange(len(ranges)) * msg.angle_increment + msg.angle_min

        valid = ~(np.isinf(ranges) | np.isnan(ranges))
        valid &= (ranges >= msg.range_min) & (ranges <= MAX_RANGE)
        if not np.any(valid):
            return

        abs_angles   = angles[valid] + self.odom_theta
        valid_ranges = ranges[valid]

        xs = self.odom_x + valid_ranges * np.cos(abs_angles)
        ys = self.odom_y + valid_ranges * np.sin(abs_angles)

        # Filter to 2 m radius
        dists_sq = (xs - self.odom_x) ** 2 + (ys - self.odom_y) ** 2
        mask     = dists_sq <= OBSTACLE_RADIUS ** 2

        # Voxel downsample the filtered points
        dx, dy = voxel_downsample(xs[mask], ys[mask])

        self._obstacle_scan_buf.append((dx, dy))

        # After a full 360° accumulation (rough heuristic: 360 / angle_increment scans)
        total_points = sum(p[0].size for p in self._obstacle_scan_buf)
        expected_full = int((2 * math.pi / msg.angle_increment) * 0.8)  # 80% coverage = done
        if total_points >= expected_full and len(self._obstacle_scan_buf) >= 3:
            self._finalize_obstacle_scan()

    def _handle_live_scan(self, msg: LaserScan):
        """Build the live 2m-radius grid around the robot."""
        self._build_live_grid(msg)

    # ── Map recording ───────────────────────────────────────────────────────────

    def _record_map_snapshot(self, msg: LaserScan):
        """Apply one clean scan to the persistent occupancy grid after settling.

        Point cloud is voxel-downsampled first, then ray-marched cell-by-cell
        using the same approach as _build_mapping.
        """
        ranges = np.array(msg.ranges, dtype=np.float32)
        angles = np.arange(len(ranges)) * msg.angle_increment + msg.angle_min

        valid = ~(np.isinf(ranges) | np.isnan(ranges))
        valid &= (ranges >= msg.range_min) & (ranges <= MAX_RANGE)
        if not np.any(valid):
            return

        abs_angles   = angles[valid] + self.odom_theta
        valid_ranges = ranges[valid]

        # World coordinates of all valid hit points
        wxs = self.odom_x + valid_ranges * np.cos(abs_angles)
        wys = self.odom_y + valid_ranges * np.sin(abs_angles)

        # Voxel downsample to reduce point count before grid update
        vx, vy = voxel_downsample(wxs, wys)
        if vx.size == 0:
            return

        # Compute bearing of each downsampled point relative to robot
        bearings = np.arctan2(vy - self.odom_y, vx - self.odom_x)
        hit_dists = np.sqrt((vx - self.odom_x) ** 2 + (vy - self.odom_y) ** 2)

        # Ray march — fully vectorized (no Python loops)
        step      = RESOLUTION * 0.5
        max_steps = int(MAX_RANGE / step) + 1
        dists     = np.arange(max_steps, dtype=np.float32) * step

        xs = self.odom_x + np.outer(np.cos(bearings), dists).astype(np.float32)
        ys = self.odom_y + np.outer(np.sin(bearings), dists).astype(np.float32)

        gxs = ((xs - ORIGIN) / RESOLUTION).astype(np.int32)
        gys = ((ys - ORIGIN) / RESOLUTION).astype(np.int32)

        in_bounds = (gxs >= 0) & (gxs < GRID_SIZE) & (gys >= 0) & (gys < GRID_SIZE)

        hit_steps = np.clip(
            np.searchsorted(dists, hit_dists, side='right'),
            0, max_steps - 1)

        grid = self.persistent_grid

        # Mark all free cells along each ray in bulk.
        # Build a flat index array for every cell in the ray-march volume,
        # then mask to only cells that are (a) before the hit and (b) in bounds.
        n_rays = vx.size
        ray_idx  = np.repeat(np.arange(n_rays, dtype=np.int32), max_steps)
        step_idx = np.tile(np.arange(max_steps, dtype=np.int32), n_rays)
        flat     = gys.ravel()[:, None] * GRID_SIZE + gxs.ravel()
        flat     = flat.ravel()
        ok       = (step_idx < hit_steps.ravel()[ray_idx]) & in_bounds.ravel()
        free_cells = flat[ok]
        if free_cells.size > 0:
            unknown_mask = grid[free_cells] == CELL_UNKNOWN
            grid[free_cells[unknown_mask]] = CELL_FREE

        # Mark hit cells as occupied
        ht_indices = np.clip(hit_steps, 0, max_steps - 1)
        hit_flat = (
            gys[np.arange(n_rays), ht_indices] * GRID_SIZE +
            gxs[np.arange(n_rays), ht_indices]
        )
        hit_valid = (hit_flat >= 0) & (hit_flat < GRID_SIZE * GRID_SIZE)
        grid[hit_flat[hit_valid]] = CELL_OCCUPIED

        # Update last recorded pose
        self.last_recorded_x      = self.odom_x
        self.last_recorded_y      = self.odom_y
        self.last_recorded_theta  = self.odom_theta

        self.get_logger().debug(
            f'Map snapshot recorded at ({self.odom_x:.2f}, {self.odom_y:.2f}, '
            f'{math.degrees(self.odom_theta):.1f}°)')

    # ── Live grid ──────────────────────────────────────────────────────────────

    def _build_live_grid(self, msg: LaserScan):
        ranges = np.array(msg.ranges, dtype=np.float32)
        angles = np.arange(len(ranges)) * msg.angle_increment + msg.angle_min

        valid = ~(np.isinf(ranges) | np.isnan(ranges))
        valid &= (ranges >= msg.range_min) & (ranges <= MAX_RANGE)
        if not np.any(valid):
            return

        abs_angles   = angles[valid] + self.odom_theta
        valid_ranges = ranges[valid]

        step      = RESOLUTION * 0.5
        max_steps = int(MAX_RANGE / step) + 1
        dists     = np.arange(max_steps, dtype=np.float32) * step

        xs = self.odom_x + np.outer(np.cos(abs_angles), dists).astype(np.float32)
        ys = self.odom_y + np.outer(np.sin(abs_angles), dists).astype(np.float32)

        gxs = ((xs - ORIGIN) / RESOLUTION).astype(np.int32)
        gys = ((ys - ORIGIN) / RESOLUTION).astype(np.int32)

        in_bounds = (gxs >= 0) & (gxs < GRID_SIZE) & (gys >= 0) & (gys < GRID_SIZE)

        hit_steps = np.clip(
            np.searchsorted(dists, valid_ranges, side='right'),
            0, max_steps - 1)

        grid = self.temp_grid
        grid[:] = CELL_UNKNOWN

        # ── Vectorized ray-march + occupancy (no Python loops) ─────────────
        n_rays = len(valid_ranges)
        ray_idx  = np.repeat(np.arange(n_rays, dtype=np.int32), max_steps)
        step_idx = np.tile(np.arange(max_steps, dtype=np.int32), n_rays)
        flat     = gys.ravel()[:, None] * GRID_SIZE + gxs.ravel()
        flat     = flat.ravel()
        ok       = (step_idx < hit_steps.ravel()[ray_idx]) & in_bounds.ravel()
        free_cells = flat[ok]
        if free_cells.size > 0:
            unknown_mask = grid[free_cells] == CELL_UNKNOWN
            grid[free_cells[unknown_mask]] = CELL_FREE

        ht_indices = np.clip(hit_steps, 0, max_steps - 1)
        hit_flat = (
            gys[np.arange(n_rays), ht_indices] * GRID_SIZE +
            gxs[np.arange(n_rays), ht_indices]
        )
        hit_valid = (hit_flat >= 0) & (hit_flat < GRID_SIZE * GRID_SIZE)
        grid[hit_flat[hit_valid]] = CELL_OCCUPIED

        # ── Vectorized 2m radius mask ──────────────────────────────────────
        r_gx = int((self.odom_x - ORIGIN) / RESOLUTION)
        r_gy = int((self.odom_y - ORIGIN) / RESOLUTION)
        r_radius = int(OBSTACLE_RADIUS / RESOLUTION)
        y_lo, y_hi = max(0, r_gy - r_radius), min(GRID_SIZE, r_gy + r_radius)
        x_lo, x_hi = max(0, r_gx - r_radius), min(GRID_SIZE, r_gx + r_radius)
        if y_hi > y_lo and x_hi > x_lo:
            gy_range = np.arange(y_lo, y_hi, dtype=np.int32)
            gx_range = np.arange(x_lo, x_hi, dtype=np.int32)
            yy, xx = np.meshgrid(gy_range, gx_range, indexing='ij')
            wx = xx * RESOLUTION + ORIGIN
            wy = yy * RESOLUTION + ORIGIN
            dist_sq = (wx - self.odom_x) ** 2 + (wy - self.odom_y) ** 2
            outside = dist_sq > OBSTACLE_RADIUS ** 2
            flat_idx = yy.ravel() * GRID_SIZE + xx.ravel()
            grid[flat_idx[outside.ravel()]] = CELL_UNKNOWN

    # ── Obstacle scan finalisation ─────────────────────────────────────────────

    def _finalize_obstacle_scan(self):
        """Merge accumulated scans into the obstacle_grid and switch to LIVE."""
        all_x = np.concatenate([p[0] for p in self._obstacle_scan_buf])
        all_y = np.concatenate([p[1] for p in self._obstacle_scan_buf])
        self._obstacle_scan_buf = []

        grid = self.obstacle_grid
        grid[:] = CELL_UNKNOWN

        # Voxel downsample the accumulated points
        vx, vy = voxel_downsample(all_x, all_y)

        # Convert to grid cells around the robot's final pose
        gx = np.round((vx - ORIGIN) / RESOLUTION).astype(np.int32)
        gy = np.round((vy - ORIGIN) / RESOLUTION).astype(np.int32)

        mask = (gx >= 0) & (gx < GRID_SIZE) & (gy >= 0) & (gy < GRID_SIZE)
        for ix, iy in zip(gx[mask], gy[mask]):
            grid[iy * GRID_SIZE + ix] = CELL_OCCUPIED

        self.get_logger().info(
            f'Obstacle scan finalised — {vx.size} obstacle cells within {OBSTACLE_RADIUS}m')

        # Immediately publish the obstacle layer once
        self._publish_obstacle_layer()

        self._enter_live()

    # ── Publishers ─────────────────────────────────────────────────────────────

    def _throttled_publish(self):
        """Rate-limited publish — enforced WEB_THROTTLE_HZ ceiling."""
        now = self.get_clock().now().nanoseconds * 1e-9
        period = 1.0 / WEB_THROTTLE_HZ
        if now - self._last_publish_time < period * 0.99:   # 1 % headroom
            return
        self._last_publish_time = now

        if self.state in (STATE_MAPPING_IDLE, STATE_MAPPING_ACTIVE, STATE_LIVE):
            self._publish_map_layer()
        elif self.state == STATE_SCAN_OBSTACLE:
            # Still publish map during obstacle scan so frontend stays responsive
            self._publish_map_layer()

    def _publish_map_layer(self):
        msg = OccupancyGrid()
        msg.header.stamp = self.get_clock().now().to_msg()
        msg.header.frame_id = 'map'
        msg.info.width      = GRID_SIZE
        msg.info.height     = GRID_SIZE
        msg.info.resolution = RESOLUTION
        msg.info.origin.position.x = ORIGIN
        msg.info.origin.position.y = ORIGIN
        msg.info.origin.orientation.w = 1.0

        if self.state == STATE_LIVE:
            msg.data = self.temp_grid.tolist()
        else:
            msg.data = self.persistent_grid.tolist()

        self.map_pub.publish(msg)

    def _publish_obstacle_layer(self):
        """Publish the 2m awareness-zone grid as a separate layer."""
        msg = OccupancyGrid()
        msg.header.stamp = self.get_clock().now().to_msg()
        msg.header.frame_id = 'map'
        msg.info.width      = GRID_SIZE
        msg.info.height     = GRID_SIZE
        msg.info.resolution = RESOLUTION
        msg.info.origin.position.x = ORIGIN
        msg.info.origin.position.y = ORIGIN
        msg.info.origin.orientation.w = 1.0
        msg.data = self.obstacle_grid.tolist()

        self.obstacle_pub.publish(msg)

    def _publish_status(self):
        labels = {
            STATE_IDLE:           'IDLE: waiting',
            STATE_MAPPING_IDLE:   'MAPPING: waiting for movement...',
            STATE_MAPPING_ACTIVE: 'MAPPING: recording...',
            STATE_SCAN_OBSTACLE:  'MAPPING: scanning obstacles...',
            STATE_LIVE:           'LIVE: localizing',
        }
        self.status_pub.publish(String(data=labels.get(self.state, 'IDLE: unknown')))

    # ── Settling timer ─────────────────────────────────────────────────────────

    def _settling_tick(self):
        """Fired every 50 ms. Processes pending settling scans that have matured."""
        if not self._settling_pending or self._pending_scan_buf is None:
            return
        now = self.get_clock().now().nanoseconds * 1e-9
        if now >= self._settle_deadline:
            scan = self._pending_scan_buf
            self._pending_scan_buf = None
            self._settling_pending = False
            self._record_map_snapshot(scan)

    # ── Utilities ──────────────────────────────────────────────────────────────

    @staticmethod
    def _angle_diff(a, b):
        diff = a - b
        while diff > math.pi:
            diff -= 2 * math.pi
        while diff < -math.pi:
            diff += 2 * math.pi
        return abs(diff)


def main():
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
