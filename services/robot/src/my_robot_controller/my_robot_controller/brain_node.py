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
    Esp32Bridge, FakeEsp32Bridge, MirrorBridge,
)


class BrainState(str, Enum):
    BOOT = 'BOOT'
    EXPLORE = 'EXPLORE'
    EXPLORE_SEARCH_TAG = 'EXPLORE_SEARCH_TAG'
    EXPLORE_REVERSE = 'EXPLORE_REVERSE'
    MAPPING_DONE = 'MAPPING_DONE'
    IDLE = 'IDLE'
    JOB_NAV_TO_DROPOFF = 'JOB_NAV_TO_DROPOFF'
    JOB_DOCK_UNLOAD = 'JOB_DOCK_UNLOAD'
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

# Direction-A mirror mode: brain uses ROS /esp32/cmd topic to send commands,
# telemetry_node owns serial and mirrors telemetry back.
# Set USE_MIRROR_BRIDGE=1 in PM2 env for production (Pi 5).
USE_MIRROR_BRIDGE = os.environ.get('USE_MIRROR_BRIDGE', '1') not in ('0', 'false', 'False')

# Explorer parameters (Tag search phase)
EXPLORE_FWD_SPEED     = 60     # PWM forward speed during tag search
EXPLORE_FWD_TIMEOUT_S = 30.0   # Max time searching forward before giving up
EXPLORE_REVERSE_SPEED = -60    # PWM reverse speed
EXPLORE_REVERSE_DIST_M = 1.0   # Reverse distance (m) after detecting AprilTag

# Cargo sensor polling interval (seconds) — IDLE checks this often
CARGO_POLL_INTERVAL_S = 2.0
# After cargo is detected on the bed, wait this long before driving off.
# Gives the operator time to step away / confirm placement.
CARGO_STARTUP_DELAY_S = 20.0
# After the ben is lowered and the package falls out, the cargo limit switch
# must read LOW (empty) for this many seconds before we consider it dropped.
CARGO_RELEASE_TIMEOUT_S = 15.0
CARGO_RELEASE_STABLE_S = 0.8

# ── Demo delivery zones (4 zones A/B/C/D for capstone demo) ─────────────────
# Hard-coded coordinates suitable for the demo mat.  Each zone is 0.9×1.1 m
# with a 15×15 cm AprilTag at the centre of its approach face.  The robot
# navigates to the centroid, then uses AprilTag + VL53L0X to dock to the
# precise ±3 cm unload position.
#
# Coordinates are in the map frame — they become valid once SLAM has built
# a map in MAPPING mode and lifecycle has shifted to LIVE (AMCL).
DEMO_ZONES: dict[str, dict] = {
    'A': {'x': 1.00, 'y': 0.90, 'theta': 0.0, 'tag_id': 0, 'label': 'Khu A'},
    'B': {'x': 2.40, 'y': 0.90, 'theta': 0.0, 'tag_id': 1, 'label': 'Khu B'},
    'C': {'x': 1.00, 'y': 2.20, 'theta': 0.0, 'tag_id': 2, 'label': 'Khu C'},
    'D': {'x': 2.40, 'y': 2.20, 'theta': 0.0, 'tag_id': 3, 'label': 'Khu D'},
}
DEMO_DOCK_DISTANCE_MM = 300   # VL53L0X target distance to dock body
DEMO_DEMO_SEQUENCE = ['A', 'B', 'D', 'C']  # route that minimises total travel


class BrainNode(Node):
    def __init__(self) -> None:
        super().__init__('brain')
        self._state: BrainState = BrainState.BOOT
        # Direction-A production path: MirrorBridge publishes ROS commands;
        # esp32_telemetry_node is the sole serial owner.
        self._bridge: Esp32Bridge = (
            MirrorBridge(self) if USE_MIRROR_BRIDGE else FakeEsp32Bridge())
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

        # ── Demo control: web_bridge → /demo/cmd (trigger zone or full run) ──
        # Payload: 'A'|'B'|'C'|'D' → run deliver_to_zone once
        # Payload: 'full'           → run_demo (S→A→B→D→C→S)
        # Payload: 'stop'           → request cancel of current demo step
        self._demo_pub = self.create_publisher(String, '/demo/status', 10)
        self._demo_cmd_sub = self.create_subscription(
            String, '/demo/cmd', self._on_demo_cmd, 10)
        self._demo_task: asyncio.Task[None] | None = None
        self._demo_cancel = False

        # ── Operator navigation: web_bridge → /brain/navigate_cmd ──────────
        # Payload JSON: {"action":"navigate","x":1.5,"y":2.0,"theta":0.0}
        #         or : {"action":"navigate_home"}
        # brain_node dispatches the goal to Nav2, publishes progress to
        # /brain/navigate_status, and emits a terminal result on
        # /brain/navigate_result.
        self._navigate_status_pub = self.create_publisher(
            String, '/brain/navigate_status', 10)
        self._navigate_result_pub = self.create_publisher(
            String, '/brain/navigate_result', 10)
        self._navigate_cmd_sub = self.create_subscription(
            String, '/brain/navigate_cmd', self._on_navigate_cmd, 10)
        self._navigate_task: asyncio.Task[None] | None = None
        self._navigate_cancel = False

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
        self._lidar_min_front_left = float('inf')   # [-45°, -15°]
        self._lidar_min_front_center = float('inf')  # [-15°, +15°]
        self._lidar_min_front_right = float('inf')  # [+15°, +45°]
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

        # Autonomous cargo workflow state.  The robot stays at home until
        # the microswitch reports a package, then drives forward looking for
        # any fresh AprilTag, reverses, unloads, and returns home.
        self._autonomous_task: asyncio.Task[None] | None = None
        self._cargo_poll_task: asyncio.Task[None] | None = None
        self._cargo_present = False
        self._last_cargo_poll = 0.0
        self._autonomous_cycle_count = 0

        self.get_logger().info(f'brain_node started in state {self._state}')

    def transition_to(self, new_state: BrainState, reason: str = '') -> None:
        old = self._state
        self._state = new_state
        self.get_logger().info(f'state: {old} -> {new_state} ({reason})')

    @property
    def state(self) -> BrainState:
        return self._state

    async def connect_bridge(self) -> None:
        """Open the real ESP32 serial bridge. Safe to call repeatedly.

        Direction-A architecture: when USE_MIRROR_BRIDGE=1 (production),
        brain_node does NOT open the serial device directly — it relies on
        esp32_telemetry_node (started via PM2) being the sole serial owner
        and forwarding commands via /esp32/cmd, returning telemetry via
        /esp32/status and friends.  This call only marks the bridge ready.
        """
        if self._bridge_connected:
            return

        if USE_MIRROR_BRIDGE:
            await self._bridge.connect()
            self._bridge_connected = True
            self.get_logger().info(
                'Mirror bridge ready — using /esp32/cmd + /esp32/status topics '
                '(serial owned by esp32_telemetry_node)')
            return

        if not USE_REAL_BRIDGE:
            self.get_logger().info('USE_REAL_BRIDGE=0 — keeping FakeEsp32Bridge')
            self._bridge_connected = True
            return

        # Legacy direct-serial path — kept only for dev/test
        from my_robot_controller.esp32_bridge import open_esp32_bridge
        port = os.environ.get('ESP32_PORT', '/dev/robot-esp32')
        self.get_logger().info(f'Connecting to ESP32 directly on {port}...')
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
    #  Four-zone delivery demo
    # ─────────────────────────────────────────────────────────────────

    def _publish_demo_status(self, state: str, zone: str = '',
                             message: str = '') -> None:
        """Publish a small JSON status frame for the map-page demo panel."""
        payload = json.dumps({
            'state': state,
            'zone': zone,
            'message': message,
            'ts': time.time(),
        })
        self._demo_pub.publish(String(data=payload))

    def _on_demo_cmd(self, msg: String) -> None:
        """Start/cancel demo tasks from a ROS String command."""
        command = msg.data.strip().upper()
        if command == 'STOP':
            self._demo_cancel = True
            if self._demo_task is not None and not self._demo_task.done():
                self._demo_task.cancel()
            self.get_logger().warn('Demo stop requested')
            self._publish_demo_status('STOPPED', message='Demo đã dừng')
            return
        if command == 'FULL':
            if self._demo_task is not None and not self._demo_task.done():
                self.get_logger().warn('Demo already running — ignoring FULL')
                return
            self._demo_cancel = False
            self._demo_task = asyncio.create_task(self.run_demo())
            return
        if command in DEMO_ZONES:
            if self._demo_task is not None and not self._demo_task.done():
                self.get_logger().warn('Demo already running — ignoring zone command')
                return
            self._demo_cancel = False
            self._demo_task = asyncio.create_task(self.deliver_to_zone(command))
            return
        self.get_logger().warn(f'Unknown demo command: {msg.data!r}')

    # ─────────────────────────────────────────────────────────────────
    #  Operator navigation (WebSocket → Nav2)
    # ─────────────────────────────────────────────────────────────────

    def _on_navigate_cmd(self, msg: String) -> None:
        """Accept operator navigation commands via ROS from web_bridge.

        Two accepted payloads:
          {"action":"navigate", "x":float, "y":float, "theta":float}
          {"action":"navigate_home"}
        """
        try:
            payload = json.loads(msg.data)
        except json.JSONDecodeError:
            self.get_logger().warn(f'navigate_cmd: bad JSON: {msg.data!r}')
            return

        action = payload.get('action', '')

        if self._navigate_task is not None and not self._navigate_task.done():
            self._navigate_cancel = True
            self._navigate_task.cancel()
            self.get_logger().warn('Previous operator navigation cancelled')

        if action == 'navigate':
            x = float(payload.get('x', 0.0))
            y = float(payload.get('y', 0.0))
            theta = float(payload.get('theta', 0.0))
            self._navigate_cancel = False
            self._navigate_task = asyncio.create_task(
                self._operator_navigate(x, y, theta))
        elif action == 'navigate_home':
            self._navigate_cancel = False
            self._navigate_task = asyncio.create_task(
                self._operator_navigate_home())
        else:
            self.get_logger().warn(f'navigate_cmd: unknown action {action!r}')

    def _publish_navigate_status(self, state: str, goal: dict | None = None) -> None:
        payload = json.dumps({
            'state': state,
            'goal': goal,
            'ts': time.time(),
        })
        self._navigate_status_pub.publish(String(data=payload))

    def _publish_navigate_result(self, success: bool, duration_s: float = 0.0,
                                 error: str = '') -> None:
        payload = json.dumps({
            'success': success,
            'duration_s': round(duration_s, 2),
            'error': error,
            'ts': time.time(),
        })
        self._navigate_result_pub.publish(String(data=payload))

    async def _operator_navigate(self, x: float, y: float, theta: float) -> None:
        goal = {'x': round(x, 4), 'y': round(y, 4), 'theta': round(theta, 4)}
        self.get_logger().info(f'Operator navigate → ({x:.2f}, {y:.2f}, θ={math.degrees(theta):.1f}°)')
        self._publish_navigate_status('navigating', goal=goal)
        t0 = time.time()

        try:
            self.transition_to(BrainState.JOB_NAV_TO_DROPOFF, 'operator nav')
            ok = await self._nav_to_pose(x, y, theta)
            if self._navigate_cancel:
                self.get_logger().info('Operator navigation was cancelled')
                return
            elapsed = time.time() - t0
            if ok:
                self.transition_to(BrainState.IDLE, 'operator nav complete')
                self._publish_navigate_result(True, duration_s=elapsed)
            else:
                self.transition_to(BrainState.IDLE, 'operator nav failed')
                self._publish_navigate_result(False, duration_s=elapsed,
                                               error='nav failed or aborted')
        except asyncio.CancelledError:
            self.get_logger().info('Operator navigate task cancelled')
            return
        except Exception as exc:
            elapsed = time.time() - t0
            self.transition_to(BrainState.ERROR, 'operator nav exception')
            self._publish_navigate_result(False, duration_s=elapsed, error=str(exc))
            self.get_logger().error(f'Operator navigate failed: {exc}')

    async def _operator_navigate_home(self) -> None:
        self.get_logger().info('Operator navigate_home')
        if self._home_pose is None:
            self._publish_navigate_result(False, error='home pose not captured')
            self.get_logger().warn('navigate_home: home pose not yet available')
            return
        hx, hy, ht = self._home_pose
        await self._operator_navigate(hx, hy, ht)

    async def deliver_to_zone(self, zone_id: str,
                              return_home: bool = True) -> bool:
        """Navigate to one configured zone, dock with its tag, and unload.

        Nav2 handles the coarse map-frame trip.  AprilTag + VL53L0X provide
        the final alignment, then the ESP32 firmware executes the guarded
        cylinder unload sequence.  All failures stop the robot and are
        reported on /demo/status; no stale Nav2 goal is allowed to continue.
        """
        zone_id = zone_id.upper()
        zone = DEMO_ZONES.get(zone_id)
        if zone is None:
            self.get_logger().error(f'Unknown delivery zone {zone_id!r}')
            return False

        self.transition_to(BrainState.JOB_NAV_TO_DROPOFF, f'demo zone {zone_id}')
        self._publish_demo_status('NAVIGATING', zone_id,
                                  f'Đang đi đến {zone["label"]}')
        try:
            await self.connect_bridge()
            if self._demo_cancel:
                return False

            reached = await self._nav_to_pose(
                zone['x'], zone['y'], zone['theta'])
            if not reached:
                raise RuntimeError('Nav2 không đến được tọa độ khu đổ hàng')

            self._publish_demo_status('SEARCHING_TAG', zone_id,
                                      f'Tìm AprilTag ID {zone["tag_id"]}')
            self.transition_to(BrainState.JOB_DOCK_UNLOAD,
                               f'demo zone {zone_id} tag')
            self._clear_tag()
            dock_ok = await self._dock_align(
                zone['tag_id'], DEMO_DOCK_DISTANCE_MM, timeout_s=20.0)
            if not dock_ok:
                raise RuntimeError(f'Không căn được AprilTag ID {zone["tag_id"]}')

            if self._demo_cancel:
                return False
            self._publish_demo_status('UNLOADING', zone_id,
                                      'Đang đổ hàng bằng xy lanh')
            await self._bridge.begin_dock(
                zone['tag_id'], DEMO_DOCK_DISTANCE_MM,
                facing_theta_deg=math.degrees(zone['theta']),
                operation_id=f'demo-{zone_id}-{int(time.time())}')
            if not await self._poll_unload_state():
                raise RuntimeError('Firmware unload timeout')

            self._clear_tag()
            self.transition_to(BrainState.IDLE, f'demo zone {zone_id} complete')
            self._publish_demo_status('COMPLETED', zone_id,
                                      f'Đã đổ hàng tại {zone["label"]}')
            if return_home:
                self._publish_demo_status('RETURNING', zone_id, 'Đang về điểm S')
                if not await self._return_home():
                    raise RuntimeError('Không thể quay về điểm xuất phát')
            await self._stop()
            return True
        except asyncio.CancelledError:
            await self._stop()
            self.transition_to(BrainState.IDLE, 'demo cancelled')
            raise
        except Exception as exc:
            self.get_logger().error(f'Demo zone {zone_id} failed: {exc}')
            await self._stop()
            self.transition_to(BrainState.ERROR, f'demo zone {zone_id} failed')
            self._publish_demo_status('FAILED', zone_id, str(exc))
            return False

    async def run_demo(self) -> bool:
        """Run the short capstone route S→A→B→D→C→S."""
        self._publish_demo_status('RUNNING', message='Bắt đầu demo A→B→D→C')
        try:
            for zone_id in DEMO_DEMO_SEQUENCE:
                if self._demo_cancel:
                    return False
                if not await self.deliver_to_zone(zone_id, return_home=False):
                    return False
                await asyncio.sleep(1.0)
            self._publish_demo_status('RETURNING', message='Đang về điểm xuất phát S')
            returned = await self._return_home()
            await self._stop()
            if returned:
                self.transition_to(BrainState.IDLE, 'full demo complete')
                self._publish_demo_status('COMPLETED', message='Hoàn tất demo A→B→D→C')
            return returned
        except asyncio.CancelledError:
            await self._stop()
            self.transition_to(BrainState.IDLE, 'full demo cancelled')
            raise
        except Exception as exc:
            self.get_logger().error(f'Full demo failed: {exc}')
            await self._stop()
            self.transition_to(BrainState.ERROR, 'full demo failed')
            self._publish_demo_status('FAILED', message=str(exc))
            return False

    # ─────────────────────────────────────────────────────────────────
    #  Cargo sensor: detect new cargo and emit cargo_ready event
    # ─────────────────────────────────────────────────────────────────

    async def _poll_cargo_sensor(self) -> None:
        """Periodically poll ESP32 cargo limit switch.  The switch wiring is:
          - NO (normally open) between GPIO36 and GND
          - INPUT_PULLUP, so HIGH = cargo on bed, LOW = empty
        When cargo is first detected after being absent, emit
        'robot:cargo_ready' to the API and start the autonomous cycle
        (which includes a 20 s safety delay before driving off).

        Called from `_cargo_poll_loop` while state is IDLE.
        """
        now = time.time()
        if (now - self._last_cargo_poll) < CARGO_POLL_INTERVAL_S:
            return
        self._last_cargo_poll = now

        try:
            cargo = await self._bridge.get_cargo()
        except Exception:
            cargo = {}

        present = bool(cargo.get('present', False))
        if present and not self._cargo_present:
            # Rising edge: cargo just arrived
            self.get_logger().info('Cargo detected — emitting cargo_ready')
            await self._api_client.emit_cargo_ready()
            # Auto-start the autonomous explore cycle
            if self._state == BrainState.IDLE and self._autonomous_task is None:
                self._autonomous_task = asyncio.create_task(self._autonomous_cycle())

        elif not present and self._cargo_present:
            self.get_logger().info('Cargo removed — returning to idle')

        self._cargo_present = present

    # ─────────────────────────────────────────────────────────────────
    #  Autonomous explore: drive forward → find any AprilTag → reverse
    # ─────────────────────────────────────────────────────────────────

    async def _autonomous_cycle(self) -> None:
        """Full autonomous delivery cycle triggered by cargo sensor.

        Flow:
          0. Wait 20 s after cargo is placed (safety delay)
          1. Drive forward from home (EXPLORE_SEARCH_TAG) scanning camera
          2. Detect any AprilTag → stop
          3. Cylinder extend (lower ben) → wait for limit switch LOW (cargo gone)
          4. Cylinder retract (raise ben) → reverse away
          5. Return home (JOB_RETURN_HOME), wait for next cargo (IDLE)
        """
        cycle = self._autonomous_cycle_count
        self._autonomous_cycle_count += 1
        self.get_logger().info(f'Autonomous cycle #{self._autonomous_cycle_count} started')

        try:
            # Phase 0: startup delay — give operator time to step away
            self.get_logger().info(
                f'Waiting {CARGO_STARTUP_DELAY_S}s before driving...')
            await asyncio.sleep(CARGO_STARTUP_DELAY_S)

            # Phase 1: drive forward to search for any AprilTag
            self.transition_to(BrainState.EXPLORE_SEARCH_TAG, f'cycle {self._autonomous_cycle_count}')
            tag = await self._drive_and_search_tag()

            if tag is None:
                self.get_logger().warn('No AprilTag found — returning home')
                await self._stop()
                await self._return_home()
                self.transition_to(BrainState.IDLE, 'explore failed, no tag')
                self._clear_tag()
                return

            tag_id = tag.get('tag_id', 0)
            self.get_logger().info(f'Tag {tag_id} detected — reversing before return')

            # Phase 2: reverse away from the shelf/dropoff point
            self.transition_to(BrainState.EXPLORE_REVERSE, f'tag {tag_id}')
            await self._drive_reverse_distance(EXPLORE_REVERSE_DIST_M, EXPLORE_REVERSE_SPEED)

            # Phase 3: unload — brain-controlled sequence so we can verify cargo
            # release via the microswitch before retracting the ben.
            #
            # The firmware begin_dock() runs its own extend→hold→retract→leave
            # state machine.  We do NOT use it here because it doesn't know
            # about the cargo sensor.  Instead we drive the cylinder directly:
            #   1. Extend the ben (cylinder_extend)
            #   2. Wait for the cargo microswitch to release (cargo dropped)
            #   3. Retract the ben (cylinder_retract)
            #   4. Reverse away from the dock area
            self.transition_to(BrainState.JOB_DOCK_UNLOAD, f'tag {tag_id}')

            self.get_logger().info('Lowering ben to dump cargo...')
            await self._bridge.cylinder_extend()

            # Wait for cargo to actually fall off the bed (switch releases)
            cargo_released = await self._wait_cargo_released()
            if not cargo_released:
                self.get_logger().warn('Cargo may still be on bed — retracting anyway')

            # Retract the ben back to stowed position
            self.get_logger().info('Retracting ben...')
            await self._bridge.cylinder_retract()
            await asyncio.sleep(4.0)  # wait for cylinder to fully retract

            # Reverse away from the dock point
            self.transition_to(BrainState.EXPLORE_REVERSE, f'after unload tag {tag_id}')
            await self._drive_reverse_distance(EXPLORE_REVERSE_DIST_M, EXPLORE_REVERSE_SPEED)

            # Phase 4: return home to wait for the next cargo
            self.transition_to(BrainState.JOB_RETURN_HOME, 'after unload')
            await self._return_home()
            self.transition_to(BrainState.IDLE, f'cycle {self._autonomous_cycle_count} complete')

        except Exception as e:
            self.get_logger().error(f'Autonomous cycle failed: {e}')
            await self._stop()
            await self._return_home()
            self.transition_to(BrainState.ERROR, 'autonomous cycle exception')
        finally:
            self._clear_tag()
            self._autonomous_task = None

    # Max seconds the active-dodge loop may spend on a single obstacle
    # before giving up and reversing as a fallback.
    _DODGE_TIMEOUT_S = 5.0
    # How many obstacle-escape attempts before E-STOP.  Reduced from 6 to 3
    # so the robot cannot loop forward-dodge-reverse-fallback forever when
    # surrounded.  Counter is NOT reset on reverse fallback; it persists
    # until the path is genuinely clear (no blocking sensors).
    _DODGE_MAX_ATTEMPTS = 3

    async def _drive_and_search_tag(self) -> Optional[dict]:
        """Drive forward at EXPLORE_FWD_SPEED until ANY AprilTag is detected
        or timeout is reached.

        When an obstacle is detected, uses active mecanum dodge:
          Case 1 (single side blocked): strafe to other side + slow forward
          Case 2 (front + 1 side):      reverse + strafe to open side
          Case 3 (front + 2 sides):     reverse + strafe (prefer right first)
          Case 4 (fully surrounded):    reverse hard, rotate, retry

        The robot always tries the shortest clearance path back to the
        forward line of travel, then resumes scanning for the tag.
        Returns the first fresh tag dict, or None on timeout.
        """
        self.get_logger().info('Driving forward to search for AprilTag...')
        loop = asyncio.get_event_loop()
        t0 = loop.time()
        dodge_attempts = 0

        while (loop.time() - t0) < EXPLORE_FWD_TIMEOUT_S:
            tag = self._get_any_tag()
            if tag is not None:
                await self._stop()
                self.get_logger().info(
                    f'Tag found during explore: id={tag.get("tag_id")} '
                    f'dist={tag.get("z", 0):.2f}m')
                return tag

            # No obstacle → drive forward
            if not self._obstacle_blocking():
                await self._drive(EXPLORE_FWD_SPEED, 0.0, 0.0)
                await asyncio.sleep(0.1)
                dodge_attempts = 0  # reset on clear driving
                continue

            # ── Obstacle detected: active dodge ──
            dodge_attempts += 1
            if dodge_attempts > self._DODGE_MAX_ATTEMPTS:
                # Hard cap on retries.  Reverse fallback counts as one attempt,
                # so do not reset the counter.  E-stop and abort exploration.
                self.get_logger().error(
                    f'Exploration stuck after {dodge_attempts} dodge attempts '
                    f'(>{self._DODGE_MAX_ATTEMPTS}) → E-STOP, abort exploration')
                await self._bridge.stop()
                return None

            escaped = await self._active_dodge()
            if escaped:
                self.get_logger().info('Dodge succeeded — resuming forward')
                dodge_attempts = 0
            else:
                self.get_logger().warn('Dodge did not clear path — retrying')

        await self._stop()
        self.get_logger().warn(f'No AprilTag found after {EXPLORE_FWD_TIMEOUT_S}s')
        return None

    async def _active_dodge(self) -> bool:
        """Execute an obstacle escape maneuver based on current sensor data.

        Returns True if the path was cleared (caller can resume forward),
        False if blocked.
        """
        direction, score = self._score_escape_directions()

        if direction == 'e_stop':
            self.get_logger().error('All directions blocked — e_stop')
            await self._bridge.stop()
            return False

        vx, vy, omega = self._velocity_for_direction(direction)
        self.get_logger().info(
            f'Dodge: dir={direction} score={score:.2f} → '
            f'vx={vx:.0f} vy={vy:.0f} omega={omega:.0f}')

        # Apply the escape maneuver
        await self._drive(vx, vy, omega)
        await asyncio.sleep(0.5)

        # Re-evaluate: is the path actually clear now?
        cleared = not self._obstacle_blocking()
        if cleared:
            return True

        # Still blocked — rotate toward the freeest LiDAR zone
        _, post_score = self._score_escape_directions()
        if post_score > score:
            # Second iteration found a better path
            return True

        return False

    def _get_any_tag(self, max_age_s: float = 1.0) -> Optional[dict]:
        """Return latest tag detection for ANY tag_id (used during explore)."""
        if self._latest_tag is None:
            return None
        if (time.time() - self._latest_tag.get('_age', 0)) > max_age_s:
            return None
        return self._latest_tag

    async def _drive_reverse_distance(self, distance_m: float, speed: int,
                                      timeout_s: float = 10.0) -> None:
        """Drive backward for approximately distance_m, using encoder delta
        to measure how far we've traveled.

        If encoders are unavailable, use a simple timed drive at the given speed.
        The Pi sends the command; the ESP32 handles the PID loop.
        """
        # Simple timed approach: estimate time from speed and target distance
        # At PWM 60, approximate robot speed ≈ 0.15 m/s (calibrate on real robot)
        speed_factor = abs(speed) / 100.0
        approx_v_mps = 0.15 * speed_factor  # rough estimate
        if approx_v_mps < 0.02:
            approx_v_mps = 0.02
        drive_time_s = distance_m / approx_v_mps
        drive_time_s = min(drive_time_s, timeout_s)

        self.get_logger().info(
            f'Reversing {distance_m:.1f}m at speed={speed} (~{drive_time_s:.1f}s)')
        await self._drive(speed, 0.0, 0.0)
        await asyncio.sleep(drive_time_s)
        await self._stop()

    async def _wait_cargo_released(self, timeout_s: float = CARGO_RELEASE_TIMEOUT_S,
                                   stable_s: float = CARGO_RELEASE_STABLE_S) -> bool:
        """After the ben is lowered (cylinder extend), wait until the cargo
        microswitch shows the bed is empty (package has fallen out).

        The switch must read 'empty' for `stable_s` consecutive seconds to
        avoid false triggers from vibration during lowering.

        Returns True when confirmed empty, False on timeout.
        """
        self.get_logger().info('Waiting for cargo switch to release (package dropped)...')
        loop = asyncio.get_event_loop()
        t0 = loop.time()
        released_since: float | None = None

        while (loop.time() - t0) < timeout_s:
            try:
                cargo = await self._bridge.get_cargo()
            except Exception:
                await asyncio.sleep(0.3)
                continue

            present = bool(cargo.get('present', False))

            if not present:
                if released_since is None:
                    released_since = loop.time()
                    self.get_logger().info('Cargo switch released — waiting for stability...')
                elif (loop.time() - released_since) >= stable_s:
                    elapsed = loop.time() - t0
                    self.get_logger().info(
                        f'Cargo confirmed dropped ({elapsed:.1f}s after lower)')
                    return True
            else:
                # Switch still pressed — cargo still on bed
                if released_since is not None:
                    self.get_logger().info('Cargo switch re-pressed — restarting stability check')
                released_since = None

            await asyncio.sleep(0.2)

        self.get_logger().warn(f'Cargo release timed out after {timeout_s}s — assuming dropped')
        return False

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
        # Front is split into 3 sub-zones for directional awareness:
        #   front_left:   [-45°, -15°]  — detects obstacles at FL corner
        #   front_center: [-15°, +15°]  — detects obstacles directly ahead
        #   front_right:  [+15°, +45°]  — detects obstacles at FR corner
        # Left   [+45°, +135°]
        # Rear   [+135°, -135°]  (wraps through ±π)
        # Right  [-135°, -45°]
        import math as _m
        q = _m.pi / 4.0          # 45°
        q3 = q / 3.0             # 15°

        # Front sub-zones (non-overlapping, contiguous from -45° to +45°)
        fl  = _min_in_sector(-q,    -q3)    # front-left:  [-45°, -15°]
        fc  = _min_in_sector(-q3,   +q3)    # front-center: [-15°, +15°]
        fr  = _min_in_sector(+q3,   +q)     # front-right: [+15°, +45°]

        l = _min_in_sector(+q, 3 * q)       # left:  [+45°, +135°]
        r = _min_in_sector(-3 * q, -q)       # right: [-135°, -45°]
        # Rear zone wraps: handle by reading both halves
        rear_a = _min_in_sector(3 * q, 0)
        rear_b = _min_in_sector(-_m.pi, -3 * q)
        rear = min(rear_a, rear_b)

        self._lidar_min_front_left = fl
        self._lidar_min_front_center = fc
        self._lidar_min_front_right = fr
        self._lidar_min_front = min(fl, fc, fr)  # backward compat aggregate
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

        IR detection range: 15 cm (E18-D80NK potentiometer-adjusted).
        Sharp zones:
          < 15cm  → hard stop (front too close)
          < 60cm  → obstacle detected (slowing zone — must react)
        """
        if not self._esp32_status:
            return False
        st = self._esp32_status.get('st', {})
        # Sharp: trigger at BOTH hard-stop AND slow-down zones
        sharp = st.get('sharp', 999)
        if isinstance(sharp, (int, float)) and 0 < sharp < 60:
            return True
        # Any IR sensor detects obstacle (15 cm detection range)
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

    async def _cargo_poll_loop(self) -> None:
        """Poll cargo presence while idle and trigger autonomous delivery."""
        while rclpy.ok():
            try:
                if self._state == BrainState.IDLE and self._autonomous_task is None:
                    await self._poll_cargo_sensor()
                await asyncio.sleep(CARGO_POLL_INTERVAL_S)
            except asyncio.CancelledError:
                return
            except Exception as exc:
                self.get_logger().warning(f'cargo poll failed: {exc}')
                await asyncio.sleep(CARGO_POLL_INTERVAL_S)

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

        Job payload includes:
          dropoff: {x, y, theta, tag_id} — map-frame pose and Apriltag dock
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
        t_dropoff_at: str | None = None
        t_unload_at: str | None = None
        travel_to_dropoff_ms: int = 0
        unload_duration_ms: int = 0

        # Lazy-connect the bridge at the first job so initial boot is fast
        # and the brain can still come up cleanly without a wired ESP32.
        await self.connect_bridge()

        # ── Phase 1: Navigate directly from home to destination ──────────
        self.transition_to(BrainState.JOB_NAV_TO_DROPOFF, f'job {job_id}')
        await self._api_client.emit_job_status(job_id, 'IN_PROGRESS')
        await self._api_client.emit_job_phase(job_id, 'NAVIGATE_DROPOFF')
        t_dropoff_start = time.time()
        dropoff = job.get('dropoff') or {}
        tag_id = dropoff.get('tag_id')
        target_mm = job.get('dock_distance_mm', 40)

        if 'x' not in dropoff or 'y' not in dropoff:
            raise RuntimeError(f'Job {job_id} has no calibrated dropoff coordinates')
        reached = await self._nav_to_pose(
            dropoff.get('x', 0.0),
            dropoff.get('y', 0.0),
            dropoff.get('theta', 0.0))
        if not reached:
            raise RuntimeError(f'Nav2 failed to reach dropoff ({dropoff.get("x", 0)}, {dropoff.get("y", 0)})')

        # ── Timing: arrived at dropoff ───────────────────────────────────
        t_dropoff_at = datetime.now(timezone.utc).isoformat()
        travel_to_dropoff_ms = int((time.time() - t_dropoff_start) * 1000)
        self.get_logger().info(f'Timing: arrived at dropoff after {travel_to_dropoff_ms}ms')

        # ── Phase 3: Dock + firmware unload sequence ────────────────────
        t_unload_start = time.time()

        # 3a: Camera-based AprilTag alignment
        if tag_id is not None:
            self.transition_to(BrainState.JOB_DOCK_UNLOAD, f'job {job_id}')
            await self._api_client.emit_job_phase(job_id, 'AT_DOCK')
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
            'dropoffAt': t_dropoff_at,
            'unloadAt': t_unload_at,
            'totalDurationMs': delivery_duration_ms,
            'fullCycleDurationMs': full_cycle_duration_ms,
            'travelToDropoffMs': travel_to_dropoff_ms,
            'unloadDurationMs': unload_duration_ms,
        }
        await self._api_client.emit_job_timing(job_id, timing)
        await self._api_client.emit_job_status(job_id, 'COMPLETED')
        self.get_logger().info(f'Job {job_id} completed successfully')

    # ─────────────────────────────────────────────────────────────────
    #  LiDAR Direction Scoring (Layer 2 global path planning)
    # ─────────────────────────────────────────────────────────────────

    # ─────────────────────────────────────────────────────────────────
    #  Escape-direction scoring for layered mecanum avoidance
    # ─────────────────────────────────────────────────────────────────
    # Distance thresholds (meters).  Layered response:
    #   >= THRESHOLD_CLEAR  → free, roam
    #   >= THRESHOLD_SLOW   → slow + bias away
    #   <  THRESHOLD_SLOW   → forced escape — strafe/reverse/rotate
    _AVOID_THRESHOLD_CLEAR = 2.0   # free enough to keep heading
    _AVOID_THRESHOLD_SLOW  = 1.2   # creep / bias away
    _AVOID_THRESHOLD_HARD  = 0.6   # reverse + rotate
    _PREFER_RIGHT          = True  # user bias for tie-break

    @staticmethod
    def _score_zone(zone_min: float, threshold: float) -> float:
        """Linear scoring: 0.0 at 0m, 1.0 at `threshold`, 2.0 at 2*threshold.

        Negative for blocked zones (< threshold).
        """
        if zone_min is None:
            return 0.5  # unknown → mild positive (don't pick last)
        if zone_min < 0.0:
            return -1.0
        if zone_min >= 2 * threshold:
            return 2.0
        if zone_min >= threshold:
            return 1.0 + (zone_min - threshold) / threshold
        # Below threshold: linear penalty as we approach 0
        return zone_min / threshold - 1.0  # in [-1.0, 0.0)

    def _score_escape_directions(self) -> tuple[str, float]:
        """Evaluate LiDAR zones + IR-side hint, return (best_dir, score).

        Cases covered (matching user spec):
          Case 1 — Single side IR hit (forward drive): the OTHER side is
                    always preferred (per user). Rear sensors during
                    forward motion are ignored.
          Case 2 — ≥ 2 zones blocked: escape to the freer side and resume
                    forward in the cleared corridor.
          Case 3 — Front + sides all blocked: reverse + strafe (PREFER
                    RIGHT FIRST), then rotate to clear.
          Plus: large obstacles (LiDAR-detected) trigger avoidance from
                any of the 8 escape directions. We pick the one with
                the highest clearance.

        Returns ('e_stop', 0.0) only when ALL LiDAR zones AND IR sensors
        are blocked.
        """
        # Read IR mask from ESP32 status (cached by _on_esp32_status).
        ir_pressed: set[str] = set()
        ir_count = 0
        if self._esp32_status:
            st = self._esp32_status.get('st', {})
            ir = st.get('ir', [False, False, False, False])
            if isinstance(ir, list) and len(ir) >= 4:
                # ir layout (per ESP32 type-131): [rl, rr, l, r]
                ir_count = sum(1 for hit in ir[:4] if bool(hit))
                if ir[0]: ir_pressed.add('left')   # rear-left → "left" side
                if ir[1]: ir_pressed.add('right')
                if ir[2]: ir_pressed.add('left')
                if ir[3]: ir_pressed.add('right')
        # Sharp very close (<30cm) → treat as front-blocked
        sharp_close = False
        if self._esp32_status:
            sharp = self._esp32_status.get('st', {}).get('sharp', 999)
            if isinstance(sharp, (int, float)) and 0 < sharp < 30:
                sharp_close = True

        # Stale LiDAR → just trust IR
        li_stale = (time.time() - self._lidar_last_update) > 0.5

        # LiDAR zone scores — now using 3 front sub-zones + left/right/rear
        # During forward drive, rear is ignored (robot is moving away).
        _safe = 99.0 if li_stale else None  # sentinel for stale data

        # Per-zone minimum distances (3 directional front + left/right/rear)
        fl_dist = self._lidar_min_front_left if not li_stale else 99.0
        fc_dist = self._lidar_min_front_center if not li_stale else 99.0
        fr_dist = self._lidar_min_front_right if not li_stale else 99.0
        l_dist  = self._lidar_min_left  if not li_stale else 99.0
        r_dist  = self._lidar_min_right if not li_stale else 99.0
        rr_dist = self._lidar_min_rear  if not li_stale else 99.0

        th = self._AVOID_THRESHOLD_SLOW

        # ── Layered distance scoring ──
        score_z = {
            'front_left':   self._score_zone(fl_dist, th),
            'front_center': self._score_zone(fc_dist, th),
            'front_right':  self._score_zone(fr_dist, th),
            'left':         self._score_zone(l_dist, th),
            'right':        self._score_zone(r_dist, th),
            'rear':         self._score_zone(rr_dist, th),
        }

        # ── IR-driven override: IR forces the side to be hostile ──
        # E18-D80NK is adjusted to 15cm.  A triggered side is therefore
        # not merely a weak penalty: do not choose a path through it.
        for side in ('left', 'right'):
            if side in ir_pressed:
                score_z[side] = -1.0
        if sharp_close:
            score_z['front_center'] = -1.0

        # ── Build candidate escape directions (mechanum-friendly) ──
        # Each candidate: name → (vx, vy, omega) + a scoring function.
        # Score is derived from the zones the candidate will pass through.
        # Front-LEFT/RIGHT sub-zones replace the old monolithic 'front'.
        candidates = {
            # Straight options
            'forward':      (score_z['front_center'], (100,   0,  0)),
            'backward':     (score_z['rear'],  (-100,  0,  0)),
            # Pure strafe
            'strafe_left':  (score_z['left'],  (0,   -100, 0)),
            'strafe_right': (score_z['right'], (0,   +100, 0)),
            # Forward-diagonal strafe (mecanum narrow-space squeeze)
            'forward_left': (min(score_z['front_left'], score_z['left']),
                             (60,  -60, 0)),
            'forward_right':(min(score_z['front_right'], score_z['right']),
                             (60,  +60, 0)),
            # Reverse-diagonal (used when surrounded)
            'reverse_left': (min(score_z['rear'], score_z['left']),
                             (-60, -60, 0)),
            'reverse_right':(min(score_z['rear'], score_z['right']),
                             (-60, +60, 0)),
            # Rotate after escaping
            'rotate_ccw':   (min(score_z['left'], score_z['rear']) * 0.7,
                             (0,   0,   -60)),
            'rotate_cw':    (min(score_z['right'], score_z['rear']) * 0.7,
                             (0,   0,   +60)),
        }

        # ─────────────────────────────────────────────────────────────
        # Hard e-stop: ALL 4 IR sensors triggered simultaneously
        # (robot physically surrounded by IR-detectable obstacles).
        # This is a genuine safety stop — no maneuver is safe.
        # ─────────────────────────────────────────────────────────────
        all_ir_blocked = (len(ir_pressed) >= 2 and sharp_close)
        if all_ir_blocked:
            self.get_logger().warn(
                'E-STOP: all 4 IR + Sharp sensors triggered — '
                'robot surrounded, all motion halted')
            return 'e_stop', -2.0

        # ─────────────────────────────────────────────────────────────
        # Hard e-stop: ALL 4 LiDAR zones < 0.6m (no IR info, but
        # LiDAR confirms complete surround at very close range).
        # ─────────────────────────────────────────────────────────────
        if not li_stale and max(fl_dist, fc_dist, fr_dist, l_dist, r_dist, rr_dist) < 0.6:
            self.get_logger().warn(
                'E-STOP: all LiDAR zones < 0.6m — robot surrounded')
            return 'e_stop', -2.0

        # ─────────────────────────────────────────────────────────────
        # Per-direction tuning per the user's 3 cases:
        # ─────────────────────────────────────────────────────────────

        # Case 1 (single-side IR, forward drive): use strafe to other
        # side, RESUME FORWARD when corridor is clear.
        if (('left' in ir_pressed) ^ ('right' in ir_pressed)) and not sharp_close:
            # Only ONE side blocked by IR → strafe to the OTHER side
            if 'left' in ir_pressed:
                candidates['strafe_right'] = (1.5, (0, +100, 0))
            else:
                candidates['strafe_left']  = (1.5, (0, -100, 0))

        # Case 3 (front + sides all blocked by IR/LiDAR, robot surrounded
        # but NOT all-sensors-blocked — some side is technically free).
        # PREFER RIGHT FIRST per user — bump reverse_right above reverse_left.
        all_sides_blocked = (
            (score_z['front_center'] < 0) and
            (score_z['left'] < 0) and
            (score_z['right'] < 0)
        )
        if all_sides_blocked:
            if self._PREFER_RIGHT:
                candidates['reverse_right'] = (1.0, (-60, +60, 0))
                candidates['reverse_left']  = (0.8, (-60, -60, 0))
            else:
                candidates['reverse_left']  = (1.0, (-60, -60, 0))
                candidates['reverse_right'] = (0.8, (-60, +60, 0))

        # ── Pick the best ──
        best_name = max(candidates, key=lambda n: candidates[n][0])
        best_score = candidates[best_name][0]

        # Truly nothing reachable at all?
        if best_score < -0.5:
            return 'e_stop', -1.0

        return best_name, best_score

    def _velocity_for_direction(self, direction: str) -> tuple[float, float, float]:
        """Convert direction name to (vx, vy, omega) (PWM units)."""
        VELOCITY_MAP = {
            'forward':       (100,    0,    0),
            'backward':      (-100,   0,    0),
            'strafe_left':   (  0, -100,    0),
            'strafe_right':  (  0, +100,    0),
            'forward_left':  ( 60,  -60,    0),
            'forward_right': ( 60,  +60,    0),
            'reverse_left':  (-60,  -60,    0),
            'reverse_right': (-60,  +60,    0),
            'rotate_ccw':    (  0,    0,  -60),
            'rotate_cw':     (  0,    0,  +60),
        }
        return VELOCITY_MAP.get(direction, (0, 0, 0))

    # ─────────────────────────────────────────────────────────────────
    #  Navigation with LiDAR obstacle avoidance (Layer 2)
    # ─────────────────────────────────────────────────────────────────

    async def _replan_escape_if_blocked(self) -> bool:
        """If a zone is blocked, send a velocity override to ESP32 to escape.

        Returns True if sent an escape velocity, False if path is clear.
        On "e_stop" all zones blocked → sends hard stop.

        Uses the mecanum-aware scoring from `_score_escape_directions`
        and tries up to 3 escape iterations before giving up.
        """
        esp32_blocked = self._esp32_obstacle_blocking()
        if esp32_blocked:
            self.get_logger().warn('ESP32 sensors blocked → stop')
            await self._bridge.stop()
            return True

        # Quick check: is anything actually close?
        min_clear = min(self._lidar_min_front, self._lidar_min_left,
                        self._lidar_min_right, self._lidar_min_rear)
        if min_clear >= self._AVOID_THRESHOLD_SLOW:
            return False

        # Try up to 3 escape maneuvers
        for attempt in range(3):
            direction, score = self._score_escape_directions()

            if direction == 'e_stop':
                self.get_logger().error(f'ALL zones blocked (attempt {attempt+1}) → E-STOP')
                await self._bridge.stop()
                return True

            vx, vy, omega = self._velocity_for_direction(direction)
            self.get_logger().info(
                f'LiDAR replan [{attempt+1}]: dir={direction} score={score:.2f} → '
                f'vx={vx:.0f} vy={vy:.0f} omega={omega:.0f}')
            await self._bridge.move(vx, vy, omega)
            await asyncio.sleep(0.4)

            # Check if clear now
            min_clear = min(self._lidar_min_front, self._lidar_min_left,
                            self._lidar_min_right, self._lidar_min_rear)
            if min_clear >= self._AVOID_THRESHOLD_CLEAR:
                self.get_logger().info(f'Path clear after attempt {attempt+1}')
                return True

        # After 3 attempts: E-STOP and keep stopped.  Do NOT hand back
        # to Nav2 — that would let it send the original goal command and
        # drive the robot into the same wall again.
        self.get_logger().error(
            'Escape attempts exhausted after 3 tries → E-STOP '
            '(Nav2 must not resume)')
        await self._bridge.stop()
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
        replan = await self._replan_escape_if_blocked()
        if replan:
            # If escape exhausted (e-stop) the path is permanently blocked.
            # Distinguish from a successful 0.5 s escape: only sleep + continue
            # if no e-stop is pending.  Without this gate, Nav2 would push
            # the robot back into the same wall.
            if self._esp32_obstacle_blocking():
                self.get_logger().error(
                    f'Nav2 aborted: ESP32 sensors still blocked at ({x:.2f}, {y:.2f})')
                return False
            # Check if LiDAR zones are all clear enough to attempt navigation
            min_clear = min(self._lidar_min_front, self._lidar_min_left,
                            self._lidar_min_right, self._lidar_min_rear)
            if min_clear < self._AVOID_THRESHOLD_SLOW:
                self.get_logger().error(
                    f'Nav2 aborted: LiDAR zones still too close '
                    f'(min={min_clear:.2f}m at ({x:.2f}, {y:.2f}))')
                return False
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

    # Start the autonomous cargo poll loop (IDLE → detect cargo → drive cycle).
    node._cargo_poll_task = asyncio.create_task(node._cargo_poll_loop())

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

    # Shutdown — cancel worker + health heartbeat + cargo poll before tearing down.
    for task in (node._job_worker_task, node._cargo_poll_task, node._health_task):
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
