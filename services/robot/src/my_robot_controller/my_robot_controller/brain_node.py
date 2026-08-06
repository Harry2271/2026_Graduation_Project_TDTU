"""Brain controller — high-level state machine for the warehouse robot.

Phase 6: Drives the real ESP32 via RealEsp32Bridge (serial → motors) and
Nav2 for global path planning. Jobs come from the API via Socket.io.
"""
from __future__ import annotations

import asyncio
import json
import math
import os
import time
from datetime import datetime, timezone
from enum import Enum
from typing import Optional

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

# Serialized job execution: only 1 job runs at a time; retries on failure.
_JOB_MAX_ATTEMPTS = 3      # 1 original + 2 retries
_JOB_RETRY_BACKOFF_S = 3.0 # seconds between retries


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

        # Exactly one worker consumes jobs. Socket.io events are queued so a
        # second dispatch can never start a parallel motor sequence.
        self._job_queue: asyncio.Queue[dict] = asyncio.Queue()
        self._job_worker_task: asyncio.Task[None] | None = None
        self._health_task: asyncio.Task[None] | None = None

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

    async def _health_heartbeat_loop(self) -> None:
        """Periodically emit robot:health to the API so it can track brain liveness."""
        try:
            while True:
                await asyncio.sleep(10.0)
                await self._api_client.emit_robot_health()
        except asyncio.CancelledError:
            return

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
        """Called when a job:dispatch event is received from the API.

        Enqueue (do NOT spawn a parallel task). A single worker task pops
        jobs from the queue and runs them serially — guarantees one motor
        sequence at a time and that the API's queue ordering survives a
        brief Socket.io reconnect storm.
        """
        job_id = payload.get('_id', 'unknown')
        op_id = payload.get('operationId')
        self.get_logger().info(f'Enqueue job {job_id} (op={op_id})')
        await self._job_queue.put(payload)

    async def _job_worker_loop(self) -> None:
        """Single-consumer job execution loop.

        Pops jobs off `_job_queue` and runs them through `_execute_job`.
        Wraps each execution in a retry-with-backoff to survive transient
        Nav2 / dock failures (1 original + 2 retries = 3 attempts max).
        """
        self.get_logger().info('Job worker started')
        while rclpy.ok():
            payload = await self._job_queue.get()
            job_id = payload.get('_id', 'unknown')
            try:
                last_error: str | None = None
                for attempt in range(1, _JOB_MAX_ATTEMPTS + 1):
                    try:
                        await self._api_client.emit_job_phase(
                            job_id, f'ATTEMPT_{attempt}' if attempt > 1 else 'STARTED')
                        await self._execute_job(payload, attempt=attempt)
                        last_error = None
                        break
                    except Exception as e:
                        last_error = repr(e)
                        self.get_logger().warn(
                            f'Job {job_id} attempt {attempt}/{_JOB_MAX_ATTEMPTS} '
                            f'failed: {e}')
                        if attempt < _JOB_MAX_ATTEMPTS:
                            # Brief backoff; stay below watchdog timeout.
                            await asyncio.sleep(_JOB_RETRY_BACKOFF_S)
                        else:
                            raise
                if last_error is not None:
                    self.get_logger().error(
                        f'Job {job_id} exhausted {_JOB_MAX_ATTEMPTS} attempts: {last_error}')
                    await self._api_client.emit_job_status(job_id, 'FAILED')
                    self.transition_to(BrainState.ERROR, f'job {job_id} retries exhausted')
            finally:
                self._job_queue.task_done()
        self.get_logger().info('Job worker stopped')

    async def _execute_job(self, job: dict, *, attempt: int = 1) -> None:
        """Walk the state machine with real ESP32 + Nav2 movement.

        Job payload may include:
          pickup:  {x, y, theta} — map-frame pose to navigate to
          dropoff: {x, y, theta, tag_id} — tag_id triggers Apriltag docking
          dock_distance_mm: target distance for VL53L0X alignment (default 40)
          operationId: idempotency key for firmware dock sequence

        **Exceptions propagate to the caller** — the worker loop decides
        whether to retry or emit FAILED.
        """
        job_id = job.get('_id', 'unknown')
        op_id = job.get('operationId')
        self.get_logger().info(f'Starting job {job_id} (attempt {attempt})')

        # ── Timing: start clock ──────────────────────────────────────────
        t_start = time.time()
        t_started = datetime.now(timezone.utc).isoformat()
        t_pickup_at: str | None = None
        t_dropoff_at: str | None = None
        t_unload_at: str | None = None
        travel_to_pickup_ms: int = 0
        travel_to_dropoff_ms: int = 0
        unload_duration_ms: int = 0

        # Lazy-connect the bridge at the first job so initial boot is fast
        # and the brain can still come up cleanly without a wired ESP32.
        await self.connect_bridge()

        # ── Phase 1: Navigate to pickup ──────────────────────────────────
        self.transition_to(BrainState.JOB_NAV_TO_PICKUP, f'job {job_id}')
        await self._api_client.emit_job_status(job_id, 'IN_PROGRESS')
        await self._api_client.emit_job_phase(job_id, 'NAVIGATE_PICKUP')

        pickup = job.get('pickup', {})
        if pickup:
            reached = await self._nav_to_pose(
                pickup.get('x', 0.0),
                pickup.get('y', 0.0),
                pickup.get('theta', 0.0))
            if not reached:
                raise RuntimeError(f'Nav2 failed to reach pickup ({pickup.get("x", 0)}, {pickup.get("y", 0)})')
        else:
            self.get_logger().warn('job has no pickup coords — pausing 5s')
            await asyncio.sleep(5)

        # ── Timing: arrived at pickup ────────────────────────────────────
        t_pickup_at = datetime.now(timezone.utc).isoformat()
        travel_to_pickup_ms = int((time.time() - t_start) * 1000)
        self.get_logger().info(f'Timing: arrived at pickup after {travel_to_pickup_ms}ms')

        # ── Phase 2: Navigate to dropoff ─────────────────────────────────
        self.transition_to(BrainState.JOB_NAV_TO_DROPOFF, f'job {job_id}')
        await self._api_client.emit_job_phase(job_id, 'NAVIGATE_DROPOFF')
        t_dropoff_start = time.time()
        dropoff = job.get('dropoff', {})
        tag_id = dropoff.get('tag_id')  # None if no Apriltag dock needed
        target_mm = job.get('dock_distance_mm', 40)

        if dropoff:
            reached = await self._nav_to_pose(
                dropoff.get('x', 0.0),
                dropoff.get('y', 0.0),
                dropoff.get('theta', 0.0))
            if not reached:
                raise RuntimeError(f'Nav2 failed to reach dropoff ({dropoff.get("x", 0)}, {dropoff.get("y", 0)})')
        else:
            await asyncio.sleep(5)

        # ── Timing: arrived at dropoff ───────────────────────────────────
        t_dropoff_at = datetime.now(timezone.utc).isoformat()
        travel_to_dropoff_ms = int((time.time() - t_dropoff_start) * 1000)
        self.get_logger().info(f'Timing: arrived at dropoff after {travel_to_dropoff_ms}ms')

        # ── Phase 3: Dock + firmware unload sequence ────────────────────
        t_unload_start = time.time()

        # 3a: Camera-based AprilTag alignment
        if tag_id is not None:
            self.transition_to(BrainState.JOB_DOCK_UNLOAD, f'job {job_id}')
            await self._api_client.emit_job_phase(job_id, 'AT_PICKUP')
            dock_ok = await self._dock_align(tag_id, target_mm)
            if not dock_ok:
                raise RuntimeError('Dock align failed')

        # 3b: Hand off to ESP32 firmware for autonomous unload
        self.get_logger().info(f'Sending begin_dock to firmware (op={op_id})...')
        await self._api_client.emit_job_phase(job_id, 'UNLOADING')
        await self._bridge.begin_dock(tag_id or 0, target_mm, operation_id=op_id)
        unload_ok = await self._poll_unload_state()
        if not unload_ok:
            raise RuntimeError(f'Job {job_id} unload timed out')

        # ── Timing: unload complete ──────────────────────────────────────
        t_unload_at = datetime.now(timezone.utc).isoformat()
        unload_duration_ms = int((time.time() - t_unload_start) * 1000)
        delivery_duration_ms = int((time.time() - t_start) * 1000)
        self.get_logger().info(
            f'Timing: unload completed in {unload_duration_ms}ms; '
            f'delivery total={delivery_duration_ms}ms')

        # ── Phase 4: Return home ────────────────────────────────────────
        self.transition_to(BrainState.JOB_RETURN_HOME, f'job {job_id}')
        await self._api_client.emit_job_phase(job_id, 'RETURNING')
        await self._return_home()
        full_cycle_duration_ms = int((time.time() - t_start) * 1000)

        # ── Phase 5: Idle — job done ────────────────────────────────────
        self.transition_to(BrainState.IDLE, f'job {job_id} completed')
        await self._stop()
        self._clear_tag()

        # ── Timing: compute totals + send to API ────────────────────────
        timing = {
            'startedAt': t_started,
            'pickupAt': t_pickup_at,
            'dropoffAt': t_dropoff_at,
            'unloadAt': t_unload_at,
            'totalDurationMs': delivery_duration_ms,
            'fullCycleDurationMs': full_cycle_duration_ms,
            'travelToPickupMs': travel_to_pickup_ms,
            'travelToDropoffMs': travel_to_dropoff_ms,
            'unloadDurationMs': unload_duration_ms,
        }
        await self._api_client.emit_job_timing(job_id, timing)
        await self._api_client.emit_job_status(job_id, 'COMPLETED')
        self.get_logger().info(f'Job {job_id} completed successfully')

    # ─────────────────────────────────────────────────────────────────
    #  LiDAR Direction Scoring (Layer 2 global path planning)
    # ─────────────────────────────────────────────────────────────────

    def _score_escape_directions(self) -> tuple[str, float]:
        """Evaluate all 4 LiDAR zones + 4 mecanum directions, return (best_dir, score).

        Direction names → ESP32 velocity (vx, vy, omega):
          'forward':   (100, 0, 0)   — advance ahead
          'backward':  (-100, 0, 0)  — reverse away
          'strafe_left': (0, -100, 0) — dodge left
          'strafe_right':(0, +100, 0) — dodge right
          'rotate_ccw': (0, 0, -100) — rotate counter-clockwise
          'rotate_cw':  (0, 0, +100) — rotate clockwise
        """
        # Zone clearance scores (meters)
        zones = {
            'front': max(self._lidar_min_front, 0.0),
            'left':  max(self._lidar_min_left, 0.0),
            'right': max(self._lidar_min_right, 0.0),
            'rear':  max(self._lidar_min_rear, 0.0),
        }

        # Check stale data (>500ms) → don't trust zones
        if (time.time() - self._lidar_last_update) > 0.5:
            return 'forward', 0.0

        # Score each direction by: min_dist + bonus for free zones
        THRESHOLD = 1.5  # meters — trigger avoidance distance

        def blocked(z): return z < THRESHOLD
        def free(z):    return z >= THRESHOLD

        directions = {
            'forward':    zones['front'],
            'left':       zones['left'],
            'right':      zones['right'],
            'backward':   zones['rear'],
            'rotate_cw':  min(zones['right'], zones['rear']) * 0.7,   # rotate CW → go right+rear
            'rotate_ccw': min(zones['left'], zones['rear']) * 0.7,   # rotate CCW → go left+rear
        }

        # Score each direction
        scores = {}
        for name, clearance in directions.items():
            if clearance >= THRESHOLD:
                # Free direction — bonus for clearance
                scores[name] = clearance + 1.0
            else:
                # Blocked direction — negative score
                scores[name] = -1.0

        # Pick best
        best_dir = max(scores, key=scores.get)
        best_score = scores[best_dir]

        # If all blocked → return 'e_stop'
        if all(s < 0 for s in scores.values()):
            return 'e_stop', 0.0

        return best_dir, best_score

    def _velocity_for_direction(self, direction: str) -> tuple[float, float, float]:
        """Convert direction name to (vx, vy, omega)."""
        VELOCITY_MAP = {
            'forward':      (100, 0, 0),
            'backward':     (-100, 0, 0),
            'strafe_left':  (0, -100, 0),
            'strafe_right': (0, 100, 0),
            'rotate_ccw':   (0, 0, -100),
            'rotate_cw':    (0, 0, 100),
        }
        return VELOCITY_MAP.get(direction, (0, 0, 0))

    # ─────────────────────────────────────────────────────────────────
    #  Navigation with LiDAR obstacle avoidance (Layer 2)
    # ─────────────────────────────────────────────────────────────────

    async def _replan_escape_if_blocked(self) -> bool:
        """If a zone is blocked, send a velocity override to ESP32 to escape.

        Returns True if sent an escape velocity, False if path is clear.
        On "e_stop" all zones blocked → sends hard stop.
        """
        # Refresh sensors first
        esp32_blocked = self._esp32_obstacle_blocking()
        if esp32_blocked:
            # ESP32 layer 1 already handles this — just send stop
            self.get_logger().warn('ESP32 sensors blocked → stop')
            await self._bridge.stop()
            return True

        direction, score = self._score_escape_directions()
        if direction == 'e_stop':
            self.get_logger().error('ALL zones blocked → E-STOP')
            await self._bridge.stop()
            return True

        # Only override if LiDAR sees something close
        THRESHOLD = 1.5
        min_clear = min(self._lidar_min_front, self._lidar_min_left,
                         self._lidar_min_right, self._lidar_min_rear)
        if min_clear >= THRESHOLD:
            # Path clear → no override needed
            return False

        vx, vy, omega = self._velocity_for_direction(direction)
        self.get_logger().info(
            f'LiDAR replan: dir={direction} score={score:.2f} → '
            f'vx={vx:.0f} vy={vy:.0f} omega={omega:.0f}')
        await self._bridge.move(vx, vy, omega)
        return True

    async def _nav_to_pose(self, x: float, y: float, theta: float) -> bool:
        """Drive to a map-frame pose via Nav2.

        Nav2's SimpleFollowPath does local obstacle avoidance using the
        costmap.  The global path replans automatically when LiDAR detects
        new obstacles.  This is our primary obstacle-avoidance path.

        Before Nav2 starts, run one LiDAR replanning pass to:
          - Check 4 zones for obstacles
          - If blocked, send a short escape maneuver (~500ms)
          - Then let Nav2 take over
        """
        # Pre-flight: check LiDAR + ESP32 sensors before Nav2
        if await self._replan_escape_if_blocked():
            await asyncio.sleep(0.5)  # brief escape duration

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

    Also starts the single ``_job_worker_loop`` task that consumes jobs off
    the asyncio queue — exactly one motor sequence at a time.
    """
    node.get_logger().info('Attempting initial API connection...')
    await node._api_client.connect()

    # Start the serialized job worker (one queue, one consumer).
    node._job_worker_task = asyncio.create_task(node._job_worker_loop())

    # Periodic health heartbeat to the API so the UI can show "brain alive".
    node._health_task = asyncio.create_task(node._health_heartbeat_loop())

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

    # Shutdown — cancel worker + health heartbeat before tearing down.
    for task in (node._job_worker_task, node._health_task):
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
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
