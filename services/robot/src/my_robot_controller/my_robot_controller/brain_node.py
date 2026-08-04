"""Brain controller — high-level state machine for the warehouse robot.

Phase 6: Drives the real ESP32 via RealEsp32Bridge (serial → motors) and
Nav2 for global path planning. Jobs come from the API via Socket.io.
"""
from __future__ import annotations

import asyncio
import math
import os
import time
from enum import Enum

import json
import time

import rclpy
from geometry_msgs.msg import PoseStamped
from nav2_simple_commander.robot_navigator import BasicNavigator
from rclpy.node import Node
from rclpy.time import Time
from sensor_msgs.msg import LaserScan
from std_msgs.msg import String
from tf2_ros import Buffer, TransformListener

from my_robot_controller.api_client import BrainApiClient
from my_robot_controller.esp32_bridge import (
    Esp32Bridge, FakeEsp32Bridge, open_esp32_bridge,
)


class BrainState(str, Enum):
    BOOT = 'BOOT'
    EXPLORE = 'EXPLORE'
    MAPPING_DONE = 'MAPPING_DONE'
    IDLE = 'IDLE'
    JOB_NAV_TO_PICKUP = 'JOB_NAV_TO_PICKUP'
    JOB_WAIT_FOR_CLEAR = 'JOB_WAIT_FOR_CLEAR'
    JOB_NAV_TO_DROPOFF = 'JOB_NAV_TO_DROPOFF'
    JOB_DOCK_UNLOAD = 'JOB_DOCK_UNLOAD'
    JOB_PLACE = 'JOB_PLACE'
    JOB_RETURN_HOME = 'JOB_RETURN_HOME'
    E_STOP = 'E_STOP'
    ERROR = 'ERROR'


# Firmware unload state values (AutoRoam::UnloadState in firmware).
# Mirrors type-140 telemetry payload `state` field.
UNLOAD_STATE_IDLE       = 0
UNLOAD_STATE_ADJUSTING  = 1
UNLOAD_STATE_EXTENDING  = 2
UNLOAD_STATE_HOLDING    = 3
UNLOAD_STATE_RETRACTING = 4
UNLOAD_STATE_DONE       = 5
UNLOAD_STATE_LEAVE      = 6
UNLOAD_STATE_COMPLETE   = 7


# Cap on the full dock+unload sequence (heading hold, VL53L0X align,
# cylinder extend/hold/retract, leave dock).  Worst case ~15s cylinder
# timeouts + 8s leave-dock + ~20s IMU settling ≈ 60s.
DOCK_SEQUENCE_TIMEOUT_S = 90.0


# Whether to instantiate the real hardware bridge or the fake test double.
# Set USE_REAL_BRIDGE=0 in the PM2 environment to force the fake for tests.
USE_REAL_BRIDGE = os.environ.get('USE_REAL_BRIDGE', '1') not in ('0', 'false', 'False')


class BrainNode(Node):
    def __init__(self) -> None:
        super().__init__('brain')
        self._state: BrainState = BrainState.BOOT
        self._bridge: Esp32Bridge = FakeEsp32Bridge()
        self._bridge_connected: bool = False
        self._api_client = BrainApiClient()
        self._api_client.on_job_dispatch(self._handle_job_dispatch)

        # AprilTag detection subscriber — latest detection stored for job execution
        self._latest_tag: Optional[dict] = None
        self._tag_sub = self.create_subscription(
            String, '/detected_tags', self._on_tag_detected, 10)

        # ── Obstacle avoidance: LiDAR + ESP32 local sensors ──────────────
        #   LiDAR: /scan (LaserScan ~10 Hz) — global view
        #   ESP32 telemetry: type-131 contains "ir":[4 bools], "sharp":cm, "obs":bool
        #
        #   Fusion strategy:
        #     1. IR triggers immediate stop (binary, <100ms latency)
        #     2. Sharp triggers slow-down or hard-stop (analog, distance-based)
        #     3. LiDAR triggers replanning / zone detection (global, 2m range)
        #
        self._lidar_min_front = float('inf')  # min distance in forward cone (m)
        self._lidar_min_left = float('inf')
        self._lidar_min_right = float('inf')
        self._lidar_min_rear = float('inf')
        self._lidar_last_update = 0.0
        self._obstacle_detected = False
        self._obstacle_direction = 'none'  # front/left/right/rear/none

        self._scan_sub = self.create_subscription(
            LaserScan, '/scan', self._on_scan, 10)

        # ESP32 telemetry — IR + Sharp status
        self._esp32_status: dict = {}
        self._esp32_sub = self.create_subscription(
            String, '/esp32/status', self._on_esp32_status, 10)

        # TF for home pose capture + navigation goal poses
        self._tf_buffer = Buffer()
        self._tf_listener = TransformListener(self._tf_buffer, self)

        # Home pose: captured once from TF at boot (map→base_footprint).
        # _return_home() uses this to send the robot back to its origin
        # after completing a job.
        self._home_pose: tuple[float, float, float] | None = None
        self._home_pose_timer = self.create_timer(1.0, self._try_capture_home_pose)
        self._home_pose_captured = False

        self.get_logger().info(f'brain_node started in state {self._state}')

    def transition_to(self, new_state: BrainState, reason: str = '') -> None:
        old = self._state
        self._state = new_state
        self.get_logger().info(f'state: {old} -> {new_state} ({reason})')

    @property
    def state(self) -> BrainState:
        return self._state

    async def connect_bridge(self) -> None:
        """Open the real ESP32 serial bridge. Safe to call repeatedly."""
        if self._bridge_connected:
            return
        if not USE_REAL_BRIDGE:
            self.get_logger().info('USE_REAL_BRIDGE=0 — keeping FakeEsp32Bridge')
            self._bridge_connected = True
            return

        port = os.environ.get('ESP32_PORT', '/dev/robot-esp32')
        self.get_logger().info(f'Connecting to ESP32 on {port}...')
        try:
            self._bridge = await open_esp32_bridge(port=port, baudrate=115200)
            await self._bridge.connect()
            self._bridge_connected = True
            self.get_logger().info(f'ESP32 bridge connected on {port}')
        except Exception as e:
            self.get_logger().error(f'ESP32 bridge connect failed: {e}')
            self.get_logger().warn('Falling back to FakeEsp32Bridge')
            self._bridge = FakeEsp32Bridge()
            self._bridge_connected = True

    def _try_capture_home_pose(self) -> None:
        """Poll TF until AMCL converges, then save home pose (once)."""
        if self._home_pose_captured:
            return
        try:
            tf = self._tf_buffer.lookup_transform('map', 'base_footprint', Time())
            x = tf.transform.translation.x
            y = tf.transform.translation.y
            q = tf.transform.rotation
            yaw = math.atan2(2.0 * (q.w * q.z + q.x * q.y),
                              1.0 - 2.0 * (q.y ** 2 + q.z ** 2))
            self._home_pose = (x, y, yaw)
            self._home_pose_captured = True
            self.get_logger().info(
                f'Home pose captured: ({x:.2f}, {y:.2f}, {math.degrees(yaw):.1f}°)')
        except Exception:
            pass  # TF not ready yet — timer retries in 1s

    async def disconnect_bridge(self) -> None:
        if not self._bridge_connected:
            return
        try:
            await self._bridge.disconnect()
        except Exception as e:
            self.get_logger().warn(f'ESP32 bridge disconnect error: {e}')
        self._bridge_connected = False

    def navigate_to(self, x: float, y: float, theta: float) -> bool:
        """Send a navigation goal to Nav2. Blocks until done.

        Args:
            x: X coordinate in the map frame (meters).
            y: Y coordinate in the map frame (meters).
            theta: Yaw angle (radians).

        Returns:
            True if the goal was reached, False on failure or cancellation.
        """
        navigator: BasicNavigator | None = None
        try:
            navigator = BasicNavigator()
            navigator.waitUntilNav2Active()

            goal_pose = PoseStamped()
            goal_pose.header.frame_id = 'map'
            goal_pose.header.stamp = navigator.get_clock().now().to_msg()
            goal_pose.pose.position.x = x
            goal_pose.pose.position.y = y
            goal_pose.pose.orientation.z = math.sin(theta / 2.0)
            goal_pose.pose.orientation.w = math.cos(theta / 2.0)

            navigator.goToPose(goal_pose)
            while not navigator.isGoalReached():
                time.sleep(0.1)

            return navigator.isGoalReached()
        except Exception as e:
            self.get_logger().error(f'navigate_to failed: {e}')
            return False
        finally:
            if navigator is not None:
                navigator.lifecycleShutdown()

    async def _drive(self, vx: float, vy: float, omega: float) -> None:
        """Send a velocity command to the ESP32 and let it persist.

        The ESP32 has its own 50 Hz PID control loop — we just send the
        desired (vx, vy, omega) and it keeps the motors running until the
        next command or e-stop.
        """
        await self._bridge.move(vx, vy, omega)

    async def _stop(self) -> None:
        """Hard stop: zero velocity + brake. Used at end of every job."""
        try:
            await self._bridge.stop()
        except Exception as e:
            self.get_logger().warn(f'bridge.stop failed: {e}')

    async def _dock_align(self, tag_id: int, target_mm: int,
                          timeout_s: float = 15.0) -> bool:
        """Camera-based AprilTag alignment using VL53L0X distance.

        Proportional control:
          - Tag visible: steer toward tag_x → omega = Kp * tag_x
          - Tag_x centered: drive forward/backward toward target_mm
          - Within ±15 mm of target: stop, return True
          - Timeout: return False
        """
        loop = asyncio.get_event_loop()
        t0 = loop.time()
        self.get_logger().info(f'Dock align: tag={tag_id} target={target_mm}mm')

        while (loop.time() - t0) < timeout_s:
            await asyncio.sleep(0.1)

            tag = self._get_tag(tag_id)
            if tag is None:
                # Tag not visible — slowly nudge forward to find it
                await self._drive(20.0, 0.0, 0.0)
                continue

            tag_z_m = tag['z']          # distance camera→tag (metres)
            tag_z_mm = tag_z_m * 1000.0
            tag_x = tag['x']           # horizontal offset in camera frame

            self.get_logger().debug(
                f'Dock: tag_z={tag_z_mm:.0f}mm offset_x={tag_x:.3f}m')

            # Horizontal alignment — rotate to center the tag
            omega = 0.0
            if abs(tag_x) > 0.05:   # >5 cm off-centre in camera frame
                omega = 0.5 * tag_x  # proportional
                omega = max(-0.3, min(0.3, omega))
                await self._drive(0.0, 0.0, omega)
                continue

            # Distance check — within tolerance
            if abs(tag_z_mm - target_mm) < 15:  # ±15 mm
                self.get_logger().info('Dock: at target distance — done')
                await self._stop()
                return True

            # Drive forward/backward proportionally
            error_mm = target_mm - tag_z_mm
            vx = max(-40.0, min(40.0, error_mm * 0.5))
            await self._drive(vx, 0.0, 0.0)

        self.get_logger().warn('Dock align: timed out')
        await self._stop()
        return False

    async def _cylinder_extend(self, timeout_s: float = 8.0) -> None:
        """Send cylinder extend and wait until type 139 reports extended."""
        loop = asyncio.get_event_loop()
        t0 = loop.time()
        try:
            await self._bridge.cylinder_extend()
        except Exception as e:
            self.get_logger().warn(f'cylinder_extend failed: {e}')
            return
        while (loop.time() - t0) < timeout_s:
            await asyncio.sleep(0.3)

    async def _cylinder_retract(self) -> None:
        """Send cylinder retract command to ESP32."""
        try:
            await self._bridge.cylinder_retract()
        except Exception as e:
            self.get_logger().warn(f'cylinder_retract failed: {e}')

    async def _poll_unload_state(self, timeout_s: float = DOCK_SEQUENCE_TIMEOUT_S) -> bool:
        """Poll ESP32 type-140 unload state until UNLOAD_STATE_COMPLETE.

        Firmware sequence: IDLE → ADJUSTING → EXTENDING → HOLDING →
        RETRACTING → DONE → LEAVE → COMPLETE.

        Returns True when COMPLETE is reached; False on timeout.
        """
        loop = asyncio.get_event_loop()
        t0 = loop.time()
        last_state = -1

        # Wait for sequence to start (state changes away from IDLE)
        while (loop.time() - t0) < timeout_s:
            state = await self._bridge.get_unload_state()
            current = state.get('state', 0)
            if current != UNLOAD_STATE_IDLE:
                self.get_logger().info(f'Unload started: state={current}')
                last_state = current
                break
            if (loop.time() - t0) > 5.0:
                self.get_logger().warn('Waiting for unload to start...')
            await asyncio.sleep(0.2)

        # Poll until COMPLETE (7) or timeout
        while (loop.time() - t0) < timeout_s:
            state = await self._bridge.get_unload_state()
            current = state.get('state', 0)

            if current != last_state:
                names = {0:'IDLE', 1:'ADJUST', 2:'EXTEND', 3:'HOLD',
                         4:'RETRACT', 5:'DONE', 6:'LEAVE', 7:'COMPLETE'}
                self.get_logger().info(
                    f'Unload: {names.get(last_state, last_state)} '
                    f'-> {names.get(current, current)}')
                last_state = current

            if current == UNLOAD_STATE_COMPLETE:
                self.get_logger().info('Unload COMPLETE')
                return True

            await asyncio.sleep(0.3)

        self.get_logger().warn('Unload timed out — cancelling')
        await self._bridge.cancel_dock()
        return False

    async def _return_home(self) -> bool:
        """Navigate back to home pose via Nav2 after unload.

        home_pose is captured once at boot from TF (map→base_footprint).
        """
        if self._home_pose is None:
            self.get_logger().warn('No home_pose captured — skipping return')
            return True
        self.get_logger().info(
            f'Returning home: ({self._home_pose[0]:.2f}, '
            f'{self._home_pose[1]:.2f}, {self._home_pose[2]:.3f})')
        return await self._nav_to_pose(*self._home_pose)

    def _on_tag_detected(self, msg: String) -> None:
        """Keep a timestamped cache of the latest tag detection."""
        try:
            self._latest_tag = json.loads(msg.data)
            self._latest_tag['_age'] = time.time()
        except Exception:
            pass

    def _get_tag(self, tag_id: int, max_age_s: float = 2.0) -> Optional[dict]:
        """Return the latest detection for a specific tag if fresh enough."""
        if self._latest_tag is None:
            return None
        if self._latest_tag.get('tag_id') != tag_id:
            return None
        if (time.time() - self._latest_tag.get('_age', 0)) > max_age_s:
            return None
        return self._latest_tag

    def _clear_tag(self) -> None:
        """Invalidate cached tag so a fresh scan is needed for the next dock."""
        self._latest_tag = None

    # ─────────────────────────────────────────────────────────────────
    #  Obstacle avoidance: LiDAR + IR + Sharp fusion
    # ─────────────────────────────────────────────────────────────────

    def _on_scan(self, msg: LaserScan) -> None:
        """Process a LiDAR LaserScan and update zone distances.

        The RPLIDAR A1M8 returns angles in the robot frame:
          - 0 rad   = forward (front)
          - π/2     = left
          - π or -π = rear
          - -π/2    = right
        """
        # Snapshot input + config in locals for speed
        ranges = msg.ranges
        angle_min = msg.angle_min
        angle_step = msg.angle_increment
        n = len(ranges)
        if n == 0 or angle_step <= 0.0:
            return

        def _min_in_sector(lo: float, hi: float) -> float:
            """Return min range (m) within [lo, hi] radians. ±inf if none."""
            best = float('inf')
            # Convert radians to index range
            i_lo = max(0, int((lo - angle_min) / angle_step))
            i_hi = min(n - 1, int((hi - angle_min) / angle_step))
            for i in range(i_lo, i_hi + 1):
                r = ranges[i]
                if msg.range_min <= r <= msg.range_max:
                    if r < best:
                        best = r
            return best

        # Sector bounds (radians, robot frame)
        # 4 zones ±90° from forward, with a 5° gap on the seam to avoid wrap
        # Front  [-π/4, +π/4]
        # Left   [+π/4, +3π/4]
        # Rear   [+3π/4, -3π/4]  (wraps through ±π)
        # Right  [-3π/4, -π/4]
        import math as _m
        q = _m.pi / 4.0
        f = _min_in_sector(-q, +q)
        l = _min_in_sector(+q, 3 * q)
        r = _min_in_sector(-3 * q, -q)
        # Rear zone wraps: handle by reading both halves
        rear_a = _min_in_sector(3 * q, 0)
        # Note: angle_max - angle_min < 2π so rear can also include end of scan
        # if it doesn't fully wrap.  Combine: take min of two sectors.
        rear_b = _min_in_sector(-_m.pi, -3 * q)
        rear = min(rear_a, rear_b)

        self._lidar_min_front = f
        self._lidar_min_left = l
        self._lidar_min_right = r
        self._lidar_min_rear = rear
        self._lidar_last_update = time.time()

    def _on_esp32_status(self, msg: String) -> None:
        """Cache ESP32 type-131 status for IR + Sharp.

        ESP32 firmware publishes type-131 frames with structure:
          {"st": {"ir":[rl,rr,l,r], "sharp":cm, "obs":bool}, ...}
        """
        try:
            self._esp32_status = json.loads(msg.data)
        except Exception:
            pass

    def _esp32_obstacle_blocking(self) -> bool:
        """Return True if ESP32's local sensors (IR / Sharp) report an
        immediate obstacle.  Used as a fast e-stop layer before LiDAR.
        """
        if not self._esp32_status:
            return False
        st = self._esp32_status.get('st', {})
        # Sharp < 15cm = hard stop
        sharp = st.get('sharp', 999)
        if isinstance(sharp, (int, float)) and 0 < sharp < 15:
            return True
        # Any IR sensor detects obstacle
        ir = st.get('ir', [False, False, False, False])
        if isinstance(ir, list) and any(ir):
            return True
        # ESP32 already raised the obs flag
        if st.get('obs', False):
            return True
        return False

    def _lidar_obstacle_blocking(self) -> tuple[bool, str]:
        """Return (blocked, direction) from LiDAR zone distances.

        blocked = True if any zone has an obstacle within threshold.
        direction = which zone is closest.
        """
        # Obstacle distance thresholds (meters)
        # LiDAR can see up to 12m; trigger avoidance at 1.5m for safety margin
        # (ESP32's local sensors take over below 80cm for emergency stop)
        threshold = 1.5
        zones = {
            'front': self._lidar_min_front,
            'left':  self._lidar_min_left,
            'right': self._lidar_min_right,
            'rear':  self._lidar_min_rear,
        }
        blocked_zone = None
        for name, d in zones.items():
            if d < threshold:
                if blocked_zone is None or d < zones[blocked_zone]:
                    blocked_zone = name

        # Stale LiDAR data (>500ms) = don't trust it
        if (time.time() - self._lidar_last_update) > 0.5:
            return False, 'none'

        return blocked_zone is not None, (blocked_zone or 'none')

    def _obstacle_blocking(self) -> bool:
        """Combined obstacle check: LiDAR + ESP32 local sensors.

        Return True if any sensor reports an immediate obstacle.
        Used to stop the robot before sending a move command.
        """
        esp32_blocked = self._esp32_obstacle_blocking()
        if esp32_blocked:
            return True
        lidar_blocked, _ = self._lidar_obstacle_blocking()
        return lidar_blocked

    def _safe_drive(self, vx: float, vy: float, omega: float) -> bool:
        """Send a drive command only if path is clear.  Returns False
        if obstacle detected (caller should stop or replan).
        """
        if self._obstacle_blocking():
            self.get_logger().warn(
                f'obstacle blocking — refusing drive vx={vx} vy={vy} omega={omega}')
            return False
        # Caller is responsible for actually sending the move
        return True

    async def _handle_job_dispatch(self, payload: dict) -> None:
        """Called when a job:dispatch event is received from the API."""
        job_id = payload.get('_id', 'unknown')
        self.get_logger().info(f'Received job dispatch: {job_id}')
        asyncio.create_task(self._execute_job(payload))

    async def _execute_job(self, job: dict) -> None:
        """Walk the state machine with real ESP32 + Nav2 movement.

        Job payload may include:
          pickup:  {x, y, theta} — map-frame pose to navigate to
          dropoff: {x, y, theta, tag_id} — tag_id triggers Apriltag docking
          dock_distance_mm: target distance for VL53L0X alignment (default 40)
        """
        job_id = job.get('_id', 'unknown')
        self.get_logger().info(f'Starting job {job_id}')

        # Lazy-connect the bridge at the first job so initial boot is fast
        # and the brain can still come up cleanly without a wired ESP32.
        await self.connect_bridge()

        try:
            # ── Phase 1: Navigate to pickup ─────────────────────────────
            self.transition_to(BrainState.JOB_NAV_TO_PICKUP, f'job {job_id}')
            await self._api_client.emit_job_status(job_id, 'IN_PROGRESS')

            pickup = job.get('pickup', {})
            if pickup:
                reached = await self._nav_to_pose(
                    pickup.get('x', 0.0),
                    pickup.get('y', 0.0),
                    pickup.get('theta', 0.0))
                if not reached:
                    self.transition_to(BrainState.ERROR, 'nav to pickup failed')
                    await self._api_client.emit_job_status(job_id, 'FAILED')
                    return
            else:
                self.get_logger().warn(
                    'job has no pickup coords — sitting in NAV state for 5s')
                await asyncio.sleep(5)

            # ── Phase 2: Navigate to dropoff ─────────────────────────────
            self.transition_to(BrainState.JOB_NAV_TO_DROPOFF, f'job {job_id}')
            dropoff = job.get('dropoff', {})
            tag_id = dropoff.get('tag_id')  # None if no Apriltag dock needed
            target_mm = job.get('dock_distance_mm', 40)

            if dropoff:
                reached = await self._nav_to_pose(
                    dropoff.get('x', 0.0),
                    dropoff.get('y', 0.0),
                    dropoff.get('theta', 0.0))
                if not reached:
                    self.transition_to(BrainState.ERROR, 'nav to dropoff failed')
                    await self._api_client.emit_job_status(job_id, 'FAILED')
                    return
            else:
                await asyncio.sleep(5)

            # ── Phase 3: Dock + firmware unload sequence ────────────────
            # 3a: Camera-based AprilTag alignment (brings robot close enough
            #     for the ESP32's VL53L0X + IMU to take over).
            if tag_id is not None:
                self.transition_to(BrainState.JOB_DOCK_UNLOAD, f'job {job_id}')
                dock_ok = await self._dock_align(tag_id, target_mm)
                if not dock_ok:
                    self.transition_to(BrainState.ERROR, 'dock align failed')
                    await self._api_client.emit_job_status(job_id, 'FAILED')
                    return

            # 3b: Hand off to ESP32 firmware: heading hold → VL53L0X adjust
            #     → cylinder extend (L298N) → hold → retract → leave dock.
            #     Brain polls type-140 telemetry until UNLOAD_STATE_COMPLETE.
            self.get_logger().info('Sending begin_dock to firmware...')
            await self._bridge.begin_dock(tag_id or 0, target_mm)
            unload_ok = await self._poll_unload_state()
            if not unload_ok:
                self.transition_to(BrainState.ERROR, f'job {job_id} unload timeout')
                await self._api_client.emit_job_status(job_id, 'FAILED')
                return

            # ── Phase 4: Return home ────────────────────────────────────
            self.transition_to(BrainState.JOB_RETURN_HOME, f'job {job_id}')
            await self._return_home()

            # ── Phase 5: Idle — job done ────────────────────────────────
            self.transition_to(BrainState.IDLE, f'job {job_id} completed')
            await self._stop()
            self._clear_tag()
            await self._api_client.emit_job_status(job_id, 'COMPLETED')
            self.get_logger().info(f'Job {job_id} completed successfully')

        except Exception as e:
            self.get_logger().error(f'Job {job_id} failed: {e}')
            await self._api_client.emit_job_status(job_id, 'FAILED')
            await self._stop()
            self.transition_to(BrainState.ERROR, f'job {job_id} failed')

    async def _nav_to_pose(self, x: float, y: float, theta: float) -> bool:
        """Drive to a map-frame pose via Nav2.

        Nav2's SimpleFollowPath does local obstacle avoidance using the
        costmap.  The global path replans automatically when LiDAR detects
        new obstacles.  This is our primary obstacle-avoidance path.
        """
        loop = asyncio.get_event_loop()
        try:
            ok = await loop.run_in_executor(None, self.navigate_to, x, y, theta)
        except Exception as e:
            self.get_logger().error(f'Nav2 navigate_to exception: {e}')
            ok = False
        if not ok:
            self.get_logger().warn(f'Nav2 failed to reach ({x:.2f}, {y:.2f})')
            await self._stop()
        return ok


_RECONNECT_INTERVAL = 30.0  # seconds between background reconnection attempts


async def _run_async(node: BrainNode) -> None:
    """Async ROS spin loop that keeps the Socket.io client alive.

    The API connection is non-fatal — if the backend is unreachable the brain
    keeps spinning ROS and periodically retries the connection.  This prevents
    PM2 crash-looping 1500+ times when the backend is temporarily down.
    """
    node.get_logger().info('Attempting initial API connection...')
    await node._api_client.connect()

    last_reconnect = asyncio.get_event_loop().time()

    while rclpy.ok():
        rclpy.spin_once(node, timeout_sec=0.1)

        # If disconnected, try to reconnect periodically
        if not node._api_client.connected:
            now = asyncio.get_event_loop().time()
            if now - last_reconnect >= _RECONNECT_INTERVAL:
                node.get_logger().info('Attempting to reconnect to API...')
                last_reconnect = now
                await node._api_client.connect()

        await asyncio.sleep(0.1)

    await node._api_client.disconnect()
    await node.disconnect_bridge()


def main() -> None:
    rclpy.init()
    node = BrainNode()
    try:
        asyncio.run(_run_async(node))
    except KeyboardInterrupt:
        pass
    finally:
        rclpy.shutdown()


if __name__ == '__main__':
    main()
