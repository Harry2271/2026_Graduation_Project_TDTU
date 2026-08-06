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
  encoder_counts_rev = 330       (11 PPR x 30 gear ratio x 2 edge decode)
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
WHEEL_RADIUS_M      = 0.0485   # effective mecanum wheel radius (m)
HALF_LENGTH_M       = 0.12     # half-distance between front/rear axles (m)
HALF_WIDTH_M        = 0.13     # half-distance between left/right axles (m)
ENCODER_COUNTS_REV  = 330      # 11 PPR * 30 gear ratio * 2 edge decode
METERS_PER_COUNT    = (2.0 * math.pi * WHEEL_RADIUS_M) / ENCODER_COUNTS_REV

PUBLISH_RATE_HZ     = 30.0
PUBLISH_PERIOD_S    = 1.0 / PUBLISH_RATE_HZ

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
        """type-130 list of {id, count, rpm}."""
        try:
            motors = json.loads(msg.data)
            if not isinstance(motors, list) or len(motors) < 4:
                return
            counts = [int(m.get('count', 0)) for m in motors[:4]]
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
        """Cache type-134 BNO055 yaw in degrees (or radians if marked).

        Firmware `JsonStatus::emitIMU` emits ``heading`` (degrees, 0-360).
        Older draft protocol used ``yaw``; accept both for forward-compat.
        """
        try:
            data = json.loads(msg.data)
            # Firmware wraps payload under `data`; some legacy frames put
            # it flat at the root. Handle both shapes.
            payload = data.get('data', data) if isinstance(data, dict) else {}
            yaw_deg = float(payload.get('heading', payload.get('yaw', 0.0)))
            units = str(payload.get('yaw_unit', 'deg')).lower()
            self._imu_yaw = (
                yaw_deg if units in ('rad', 'radian', 'radians')
                else math.radians(yaw_deg)
            )
            self._imu_yaw_time = self.get_clock().now().nanoseconds / 1e9
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

        Wheel order [FL, FR, RL, RR].  Sign convention: forward motion -> +
        forward displacement for FL and FR; rotation positive (CCW) increases
        FR/RL wheel contribution.  Tune the per-wheel sign to match the
        firmware's BTS7960 dir field if your robot drives backwards.
        """
        dFL = (new_counts[0] - prev_counts[0]) * METERS_PER_COUNT
        dFR = (new_counts[1] - prev_counts[1]) * METERS_PER_COUNT
        dRL = (new_counts[2] - prev_counts[2]) * METERS_PER_COUNT
        dRR = (new_counts[3] - prev_counts[3]) * METERS_PER_COUNT

        # Forward and lateral mecanum components (FL=//, FR=\\, RL=\\, RR=//).
        # Derivation in CLAUDE.md "Mecanum Wheel Kinematics".
        vx_w = (dFL + dFR + dRL + dRR) / 4.0
        vy_w = (-dFL + dFR + dRL - dRR) / 4.0
        omega_w = (-dFL + dFR - dRL + dRR) / (
            4.0 * (HALF_LENGTH_M + HALF_WIDTH_M)
        )

        self._vx = vx_w / dt
        self._vy = vy_w / dt
        self._omega = omega_w / dt

        # Yaw from wheel integration (drifts on mecanum wheels).
        dtheta_w = omega_w

        # Optionally correct yaw with IMU when fresh (< 0.2s).
        now = self.get_clock().now().nanoseconds / 1e9
        if (self._imu_yaw is not None
                and (now - self._imu_yaw_time) < 0.2):
            # Blend 80% wheel yaw, 20% IMU to suppress mecanum slip.
            self._yaw = 0.8 * (self._yaw + dtheta_w) + 0.2 * self._imu_yaw
        else:
            self._yaw += dtheta_w

        # Project body-frame displacement into odom frame.
        cos_y = math.cos(self._yaw)
        sin_y = math.sin(self._yaw)
        self._x += vx_w * cos_y - vy_w * sin_y
        self._y += vx_w * sin_y + vy_w * cos_y

    # ── Periodic publishers ────────────────────────────────────────────────

    def _publish_odom(self) -> None:
        """Publish Odometry + TF at PUBLISH_RATE_HZ."""
        stamp = self.get_clock().now().to_msg()
        q = self._yaw_to_quat(self._yaw)

        # Nav2 wants pose-covariance and twist-covariance to be set; we use
        # placeholders that don't violate NAV2 requirements.  Tune after
        # field tests with the encoder_odometry covariance tutorial.
        odom = Odometry()
        odom.header = Header(stamp=stamp, frame_id='odom')
        odom.child_frame_id = 'base_footprint'
        odom.pose.pose.position.x = self._x
        odom.pose.pose.position.y = self._y
        odom.pose.pose.position.z = 0.0
        odom.pose.pose.orientation = q
        odom.twist.twist = Twist()
        odom.twist.twist.linear.x = self._vx
        odom.twist.twist.linear.y = self._vy
        odom.twist.twist.angular.z = self._omega
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