"""Odometry publisher - reads ESP32 encoder + IMU ROS topics and publishes /odom.

Computes mecanum-wheel odometry from /esp32/encoder deltas (type-130) and
optionally corrects yaw with BNO055 heading from /esp32/imu (type-134).
Publishes:
  - /odom  (nav_msgs/Odometry) at 30 Hz
  - TF     odom -> base_footprint
  - /battery_state (sensor_msgs/BatteryState) at 1 Hz (from /esp32/power)

No serial connection needed — the existing esp32_telemetry_node.py already
forwards ESP32 frames to ROS topics. This node is pure ROS subscriber + publisher.

Geometry constants (must match URDF and firmware config.h):
  wheel_radius       = 0.0485 m  (97 mm mecanum)
  half_length        = 0.12 m    (front/rear axle distance / 2)
  half_width         = 0.13 m    (left/right axle distance / 2)
  encoder_counts_rev = 660       (11 PPR x 2 edges x 30 gear ratio)

Rotation sign convention:
  - Firmware MecanumDrive.h declares ``omega > 0`` as CW.
  - ROS yaw / nav_msgs/Odometry.twist.twist.angular.z is CCW-positive.
  - We compute omega from encoder deltas in the firmware convention,
    then negate once at the ROS boundary so /odom and Nav2 agree.
"""
from __future__ import annotations

import asyncio
import json
import math
import os
import threading
from typing import Optional

import rclpy
from geometry_msgs.msg import Quaternion, TransformStamped, Twist
from nav_msgs.msg import Odometry
from rclpy.executors import SingleThreadedExecutor
from rclpy.node import Node
from rclpy.time import Time as RosTime
from sensor_msgs.msg import BatteryState
from std_msgs.msg import Header, String
from tf2_ros import TransformBroadcaster

# Mecanum geometry constants. MUST match URDF agv.urdf + firmware Encoder.cpp.
# Firmware `Encoder.cpp` uses OUTPUT_CPR = MOTOR_ENCODER_CPR (22) * GEAR_RATIO (30)
# = 660 counts per output-shaft revolution. Any drift between this and the
# firmware constant directly multiplies into position error.
WHEEL_RADIUS_M      = 0.0485   # effective mecanum wheel radius (m)
HALF_LENGTH_M       = 0.12     # half-distance between front/rear axles (m)
HALF_WIDTH_M        = 0.13     # half-distance between left/right axles (m)
ENCODER_COUNTS_REV  = 660      # 11 PPR * 2 edges * 30 gear ratio (matches firmware)
METERS_PER_COUNT    = (2.0 * math.pi * WHEEL_RADIUS_M) / ENCODER_COUNTS_REV

PUBLISH_RATE_HZ     = 30.0
PUBLISH_PERIOD_S    = 1.0 / PUBLISH_RATE_HZ

# Sign flip applied at the ROS boundary: firmware omega is CW-positive,
# ROS twist.angular.z is CCW-positive. Verified by physical 90-deg test.
OMEGA_ROS_SIGN      = -1.0

# After this many seconds without a fresh encoder sample the published
# twist decays to zero, so Nav2 doesn't keep steering on stale velocity.
TWIST_STALE_AFTER_S = 0.15

# Status frame carries IR + Sharp + power + cylinder. Wheel encoder RPM and
# counts come from /esp32/encoder (type-130 frames).
class OdomNode(Node):
    """ROS2 node publishing wheel-encoder odometry + TF + battery state.

    Architecture:
      - Main thread: asyncio loop driving ESP32 bridge.
      - Background thread: rclpy SingleThreadedExecutor spinning this node.
      - Bridge callbacks (asyncio) call into node publish methods, which
        are rclpy-thread-safe.
    """

    def __init__(self) -> None:
        super().__init__('odom')
        self._odom_pub = self.create_publisher(Odometry, '/odom', 50)
        self._battery_pub = self.create_publisher(BatteryState, '/battery_state', 10)
        self._tf_broadcaster = TransformBroadcaster(self)

        # Subscribers to ESP32 telemetry topics published by esp32_telemetry_node.
        # /esp32/encoder  = type-130 wheel encoder counts + RPM (10 Hz)
        # /esp32/imu      = type-134 BNO055 heading (20 Hz)
        # /esp32/power    = type-133 INA226 battery (1 Hz)
        self._encoder_sub = self.create_subscription(
            String, '/esp32/encoder', self._on_encoder_msg, 10)
        self._imu_sub = self.create_subscription(
            String, '/esp32/imu', self._on_imu_msg, 10)
        self._power_sub = self.create_subscription(
            String, '/esp32/power', self._on_power_msg, 10)

        # Pose (planar, integrated from encoders).
        self._x: float = 0.0
        self._y: float = 0.0
        self._yaw: float = 0.0
        self._vx: float = 0.0
        self._vy: float = 0.0
        self._omega: float = 0.0

        # Last encoder counts by wheel [FL, FR, RL, RR].
        self._last_counts: Optional[list[int]] = None
        self._last_encoder_msg_time: float = 0.0
        # Integration timestamp (used for Odometry header stamp so the
        # twist is associated with the sample time, not publish time).
        self._last_integration_time: float = 0.0

        # Wheel-only yaw integral for fallback when IMU is stale.
        self._yaw_wheel_integral: float = 0.0
        # Last raw IMU yaw reading (radians, continuous / unwrapped).
        self._imu_yaw_continuous: Optional[float] = None

        # Battery cache from type-133.
        self._last_power: dict = {}
        self._last_power_msg_time: float = 0.0

        # IMU heading (radians, optional yaw correction).
        self._imu_yaw: Optional[float] = None
        self._imu_yaw_time: float = 0.0

        # Timer that publishes /odom + TF at PUBLISH_RATE_HZ.
        self._timer = self.create_timer(PUBLISH_PERIOD_S, self._publish_odom)
        # Timer that publishes /battery_state at 1 Hz (cheap, only when fresh data).
        self._battery_timer = self.create_timer(1.0, self._publish_battery)

        self.get_logger().info(
            f'odom_node ready (rate={PUBLISH_RATE_HZ} Hz, '
            f'wheel_r={WHEEL_RADIUS_M:.3f}m, cpr={ENCODER_COUNTS_REV})'
        )

    # ── Subscription callbacks (called from rclpy thread) ───────────────────

    def _on_encoder_msg(self, msg: String) -> None:
        """Parse type-130 ``data.motors`` and integrate counts by motor id."""
        try:
            frame = json.loads(msg.data)
            if not isinstance(frame, dict):
                return
            payload = frame.get('data', frame)
            motors = payload.get('motors') if isinstance(payload, dict) else None
            if not isinstance(motors, list):
                return

            by_id: dict[int, int] = {}
            for motor in motors:
                if not isinstance(motor, dict):
                    continue
                motor_id = int(motor['id'])
                if motor_id not in range(4):
                    continue
                raw_count = motor.get('cnt', motor.get('count'))
                if raw_count is None:
                    return
                by_id[motor_id] = int(raw_count)
            if len(by_id) != 4:
                return
            counts = [by_id[i] for i in range(4)]

            now = self.get_clock().now().nanoseconds / 1e9
            if self._last_counts is not None:
                dt = now - self._last_encoder_msg_time
                if dt > 0.0:
                    self._integrate(self._last_counts, counts, dt)
            self._last_counts = counts
            self._last_encoder_msg_time = now
        except (json.JSONDecodeError, KeyError, TypeError, ValueError) as e:
            self.get_logger().debug(f'encoder parse error: {e}')

    def _on_imu_msg(self, msg: String) -> None:
        """Cache and *unwrap* type-134 BNO055 heading into a continuous yaw.

        Firmware ``JsonStatus::emitIMU`` emits ``heading`` in degrees (0-360).
        Unwrapping successive readings keeps the yaw continuous across the
        0/360° boundary so the integrator doesn't see a 360° discontinuity.
        """
        try:
            data = json.loads(msg.data)
            payload = data.get('data', data) if isinstance(data, dict) else {}
            yaw_deg = float(payload.get('heading', payload.get('yaw', 0.0)))
            yaw_rad = math.radians(yaw_deg)
            now = self.get_clock().now().nanoseconds / 1e9

            if self._imu_yaw_continuous is None:
                self._imu_yaw_continuous = yaw_rad
            else:
                diff = yaw_rad - self._imu_yaw_continuous
                # Wrap diff to [-pi, pi] so +180 → -180 crossing stays small.
                diff = (diff + math.pi) % (2 * math.pi) - math.pi
                self._imu_yaw_continuous += diff

            self._imu_yaw = self._imu_yaw_continuous
            self._imu_yaw_time = now
        except (json.JSONDecodeError, TypeError, ValueError) as e:
            self.get_logger().debug(f'imu parse error: {e}')

    def _on_power_msg(self, msg: String) -> None:
        """Cache type-133 INA226 power data.

        Firmware `JsonStatus::emitPower` emits ``voltage_v`` and
        ``battery_pct`` (0-100). Older draft protocol used ``bus_v`` /
        ``pct``; accept both.
        """
        try:
            data = json.loads(msg.data)
            self._last_power = data.get('data', data) if isinstance(data, dict) else {}
            # Normalize to a single internal field set so /battery_state
            # publisher only needs to look at one place.
            if 'bus_v' not in self._last_power and 'voltage_v' in self._last_power:
                self._last_power['bus_v'] = self._last_power['voltage_v']
            if 'pct' not in self._last_power and 'battery_pct' in self._last_power:
                self._last_power['pct'] = self._last_power['battery_pct']
            self._last_power_msg_time = self.get_clock().now().nanoseconds / 1e9
        except (json.JSONDecodeError, TypeError, ValueError) as e:
            self.get_logger().debug(f'power parse error: {e}')

    # ── Wheel odometry integration ──────────────────────────────────────────

    def _integrate(
        self,
        prev_counts: list[int],
        new_counts: list[int],
        dt: float,
    ) -> None:
        """Mecanum inverse kinematics: encoder deltas -> body twist -> pose delta.

        Wheel order [FL, FR, RL, RR] — matches firmware MecanumDrive.cpp
        X-pattern: FL=//, FR=\\, RL=\\, RR=//.

        Rotation sign note
        ------------------
        Firmware ``MecanumDrive.h`` declares omega>0 as CW.  ROS yaw and
        ``nav_msgs/Odometry.twist.angular.z`` are CCW-positive.  We compute
        wheel displacement in firmware coordinates here, then flip omega once
        in ``_publish_odom`` so /odom and Nav2 agree with the ROS convention.
        """
        dFL = (new_counts[0] - prev_counts[0]) * METERS_PER_COUNT
        dFR = (new_counts[1] - prev_counts[1]) * METERS_PER_COUNT
        dRL = (new_counts[2] - prev_counts[2]) * METERS_PER_COUNT
        dRR = (new_counts[3] - prev_counts[3]) * METERS_PER_COUNT

        # Forward and lateral mecanum components (FL=//, FR=\\, RL=\\, RR=//).
        # Derivation in CLAUDE.md "Mecanum Wheel Kinematics".
        vx_w = (dFL + dFR + dRL + dRR) / 4.0
        vy_w = (-dFL + dFR + dRL - dRR) / 4.0

        # omega in *firmware* convention (CW-positive)
        omega_firm = (-dFL + dFR - dRL + dRR) / (
            4.0 * (HALF_LENGTH_M + HALF_WIDTH_M)
        )

        self._vx = vx_w / dt
        self._vy = vy_w / dt

        # --- YAW: complementary fusion — IMU as primary, wheel as fallback ---
        now = self.get_clock().now().nanoseconds / 1e9
        imu_fresh = (
            self._imu_yaw is not None
            and (now - self._imu_yaw_time) < 0.2
        )

        if imu_fresh:
            # IMU is fresh — use it as the absolute yaw reference.
            self._yaw = self._imu_yaw
            # Reset wheel-only integral to match (avoids discontinuity).
            self._yaw_wheel_integral = self._yaw
        else:
            # IMU stale — integrate wheel omega (drifts, but no alternative).
            self._yaw += omega_firm
            self._yaw_wheel_integral = self._yaw

        # Project body-frame displacement into odom frame using corrected yaw.
        cos_y = math.cos(self._yaw)
        sin_y = math.sin(self._yaw)
        self._x += vx_w * cos_y - vy_w * sin_y
        self._y += vx_w * sin_y + vy_w * cos_y

        # omega_w is the firmware-frame angular velocity; sign flip to ROS CCW+
        # is applied once in _publish_odom, not here.
        self._omega = omega_firm / dt
        self._last_integration_time = now

    # ── Periodic publishers ────────────────────────────────────────────────

    def _publish_odom(self) -> None:
        """Publish Odometry + TF at PUBLISH_RATE_HZ.

        Stamps the header with the most recent integration time so the
        twist isn't associated with publish time.  Decays the twist to
        zero if no fresh encoder sample arrived within ``TWIST_STALE_AFTER_S``.
        """
        now_sec = self.get_clock().now().nanoseconds / 1e9
        age = now_sec - self._last_encoder_msg_time

        vx = self._vx if age <= TWIST_STALE_AFTER_S else 0.0
        vy = self._vy if age <= TWIST_STALE_AFTER_S else 0.0
        omega_ros = self._omega * OMEGA_ROS_SIGN
        if age > TWIST_STALE_AFTER_S:
            omega_ros = 0.0

        if self._last_integration_time > 0.0:
            stamp = RosTime(nanoseconds=int(self._last_integration_time * 1e9)).to_msg()
        else:
            stamp = self.get_clock().now().to_msg()
        q = self._yaw_to_quat(self._yaw)

        odom = Odometry()
        odom.header = Header(stamp=stamp, frame_id='odom')
        odom.child_frame_id = 'base_footprint'
        odom.pose.pose.position.x = self._x
        odom.pose.pose.position.y = self._y
        odom.pose.pose.position.z = 0.0
        odom.pose.pose.orientation = q
        odom.twist.twist = Twist()
        odom.twist.twist.linear.x = vx
        odom.twist.twist.linear.y = vy
        odom.twist.twist.angular.z = omega_ros
        # Covariance: diagonal values only; pose 0.05 m^2 + 0.05 rad^2; twist 0.05.
        for i in (0, 7, 14, 21, 28, 35):
            odom.pose.covariance[i] = 0.05
        for i in (0, 7, 14, 21, 28, 35):
            odom.twist.covariance[i] = 0.05
        self._odom_pub.publish(odom)

        # Broadcast odom -> base_footprint TF.
        tf = TransformStamped()
        tf.header = Header(stamp=stamp, frame_id='odom')
        tf.child_frame_id = 'base_footprint'
        tf.transform.translation.x = self._x
        tf.transform.translation.y = self._y
        tf.transform.translation.z = 0.0
        tf.transform.rotation = q
        self._tf_broadcaster.sendTransform(tf)

    def _publish_battery(self) -> None:
        """Publish /battery_state from cached type-133 power data."""
        if not self._last_power:
            return
        now = self.get_clock().now().nanoseconds / 1e9
        if (now - self._last_power_msg_time) > 5.0:
            return  # stale, don't publish

        p = self._last_power
        bs = BatteryState()
        bs.header = Header(stamp=self.get_clock().now().to_msg())
        bs.voltage = float(p.get('bus_v', 0.0))
        bs.current = float(p.get('current_a', 0.0))
        bs.power_supply_status = BatteryState.POWER_SUPPLY_STATUS_DISCHARGING
        bs.power_supply_health = BatteryState.POWER_SUPPLY_HEALTH_GOOD
        bs.present = True
        pct = p.get('pct')
        if pct is not None:
            bs.percentage = float(pct) / 100.0
        self._battery_pub.publish(bs)

    @staticmethod
    def _yaw_to_quat(yaw: float) -> Quaternion:
        """Convert planar yaw to geometry_msgs/Quaternion (z-axis only)."""
        q = Quaternion()
        q.x = 0.0
        q.y = 0.0
        q.z = math.sin(yaw / 2.0)
        q.w = math.cos(yaw / 2.0)
        return q


def _spin_node(node: Node) -> tuple[SingleThreadedExecutor, threading.Thread]:
    executor = SingleThreadedExecutor()
    executor.add_node(node)
    thread = threading.Thread(target=executor.spin, daemon=True, name='odom-spin')
    thread.start()
    return executor, thread


def main() -> None:
    rclpy.init()
    node = OdomNode()
    executor, _thread = _spin_node(node)
    try:
        # Keep node alive; everything is timer/subscription-driven.
        while rclpy.ok():
            rclpy.get_global_executor() if False else None
            import time
            time.sleep(1.0)
    except KeyboardInterrupt:
        pass
    finally:
        executor.shutdown()
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == '__main__':
    main()