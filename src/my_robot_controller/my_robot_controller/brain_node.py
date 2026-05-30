#!/usr/bin/env python3
"""brain_node — odometry publisher + status reporter + scan-based pose estimation.

No motors — robot is pushed manually. Odometry is estimated from consecutive
lidar scans using a simplified ICP (Iterative Closest Point) approach:

  1. Extract valid points from consecutive LaserScan messages.
  2. ICP step 1 — Rotation: compute the angle between scan centroid displacement.
     Apply exponential smoothing so small jitter doesn't cause spin.
  3. ICP step 2 — Translation: transform the centroid delta into world frame
     using the smoothed rotation; apply exponential smoothing.
  4. Publish /odom and the odom→base_footprint transform.

No occupancy grid required. No encoder required. No SLAM toolbox required.
"""
import math
import numpy as np
import rclpy
from rclpy.node import Node
from sensor_msgs.msg import LaserScan
from nav_msgs.msg import Odometry
from std_msgs.msg import String
from geometry_msgs.msg import TransformStamped
from tf2_ros import TransformBroadcaster

# ── Scan-matching parameters ────────────────────────────────────────────────────
MIN_VALID_POINTS  = 20    # minimum scan points to attempt matching
TRANS_SMOOTH      = 0.90 # exponential smoothing for translation (0=new,1=old)
ROT_SMOOTH        = 0.85 # exponential smoothing for rotation
TRANS_THRESH      = 0.003 # m — ignore jitter below this
ROT_THRESH         = 0.01  # rad — ignore jitter below this


class BrainNode(Node):
    def __init__(self):
        super().__init__('brain_node')
        self.scan_sub    = self.create_subscription(LaserScan, '/scan', self._on_scan, 10)
        self.status_pub  = self.create_publisher(String, '/robot_status', 10)
        self.odom_pub    = self.create_publisher(Odometry, '/odom', 10)
        self.control_sub = self.create_subscription(String, '/mapping/control', self._on_control, 10)
        self.tf_broadcaster = TransformBroadcaster(self)

        self.x     = 0.0
        self.y     = 0.0
        self.theta = 0.0

        self._prev_ranges  = None
        self._prev_angles = None
        self._last_time   = None
        self._scan_count  = 0
        self._mapping_mode = False
        self._last_status  = self.get_clock().now()

        self._publish_odom(self.get_clock().now(), 0.0, 0.0, 0.0)
        self.get_logger().info('Brain node started — ICP-free lidar odometry. Move robot.')

    def _on_control(self, msg: String):
        cmd = msg.data.strip().lower()
        self._mapping_mode = cmd == 'start'
        self.get_logger().info(f'Brain: mapping mode = {self._mapping_mode}')

    def _on_scan(self, msg: LaserScan):
        self._scan_count += 1

        ranges = np.array(msg.ranges, dtype=np.float32)
        angles = np.arange(len(ranges)) * msg.angle_increment + msg.angle_min
        valid  = ~(np.isinf(ranges) | np.isnan(ranges))
        valid &= (ranges >= msg.range_min) & (ranges <= msg.range_max)
        cur_r  = ranges[valid]
        cur_a  = angles[valid]

        now = self.get_clock().now()

        if self._prev_ranges is None:
            self._prev_ranges  = cur_r
            self._prev_angles = cur_a
            self._last_time   = now
            return

        dt = (now - self._last_time).nanoseconds * 1e-9
        self._last_time = now

        if cur_r.size < MIN_VALID_POINTS or dt <= 0:
            return

        # ── ICP step 1: rotation from centroid displacement angle ─────────────
        prev_pts  = np.stack([self._prev_ranges * np.cos(self._prev_angles),
                              self._prev_ranges * np.sin(self._prev_angles)], axis=0)
        cur_pts   = np.stack([cur_r * np.cos(cur_a), cur_r * np.sin(cur_a)], axis=0)
        prev_mean = prev_pts.mean(axis=1)
        cur_mean  = cur_pts.mean(axis=1)

        delta_mean_x = cur_mean[0] - prev_mean[0]
        delta_mean_y = cur_mean[1] - prev_mean[1]

        raw_dth = math.atan2(delta_mean_y, delta_mean_x)
        if abs(raw_dth) > ROT_THRESH:
            self.theta = self._wrap_angle(self.theta + raw_dth * ROT_SMOOTH)

        # ── ICP step 2: translation — move previous pose by the raw centroid delta
        #    This is dead-reckoning: each scan pair gives Δx, Δy in robot's frame.
        #    Transform the delta into the world frame using the current smoothed theta.
        cos_t = math.cos(self.theta)
        sin_t = math.sin(self.theta)
        # In world frame: delta_world = R(theta) · delta_robot
        world_dx =  cos_t * delta_mean_x + sin_t * delta_mean_y
        world_dy = -sin_t * delta_mean_x + cos_t * delta_mean_y

        if abs(world_dx) > TRANS_THRESH:
            self.x = TRANS_SMOOTH * self.x + (1 - TRANS_SMOOTH) * (self.x + world_dx)
        if abs(world_dy) > TRANS_THRESH:
            self.y = TRANS_SMOOTH * self.y + (1 - TRANS_SMOOTH) * (self.y + world_dy)

        self._prev_ranges  = cur_r
        self._prev_angles = cur_a

        self._publish_odom(now, self.x, self.y, self.theta)
        self._maybe_publish_status(now)

        self.get_logger().debug(
            f'scan #{self._scan_count}: pose=({self.x:.3f},{self.y:.3f},'
            f'{math.degrees(self.theta):.1f}°)')

    @staticmethod
    def _wrap_angle(a):
        while a >  math.pi: a -= 2 * math.pi
        while a < -math.pi: a += 2 * math.pi
        return a

    def _publish_odom(self, now, x, y, theta):
        q = self._euler_to_quat(0, 0, theta)
        odom = Odometry()
        odom.header.stamp    = now.to_msg()
        odom.header.frame_id = 'odom'
        odom.child_frame_id  = 'base_footprint'
        odom.pose.pose.position.x = x
        odom.pose.pose.position.y = y
        odom.pose.pose.orientation.x = q[0]
        odom.pose.pose.orientation.y = q[1]
        odom.pose.pose.orientation.z = q[2]
        odom.pose.pose.orientation.w = q[3]
        self.odom_pub.publish(odom)

        t = TransformStamped()
        t.header.stamp    = now.to_msg()
        t.header.frame_id = 'odom'
        t.child_frame_id  = 'base_footprint'
        t.transform.translation.x = x
        t.transform.translation.y = y
        t.transform.rotation.x = q[0]
        t.transform.rotation.y = q[1]
        t.transform.rotation.z = q[2]
        t.transform.rotation.w = q[3]
        self.tf_broadcaster.sendTransform(t)

    def _maybe_publish_status(self, now):
        if (now - self._last_status).nanoseconds < 1e9:
            return
        self._last_status = now
        status = String()
        mode_tag = 'MAPPING' if self._mapping_mode else 'LIVE'
        status.data = f'STATE={mode_tag} x={self.x:.2f} y={self.y:.2f} scans={self._scan_count}'
        self.status_pub.publish(status)

    @staticmethod
    def _euler_to_quat(r, p, y):
        cr, sr = math.cos(r * 0.5), math.sin(r * 0.5)
        cp, sp = math.cos(p * 0.5), math.sin(p * 0.5)
        cy, sy = math.cos(y * 0.5), math.sin(y * 0.5)
        return (
            sr * cp * cy - cr * sp * sy,
            cr * sp * cy + sr * cp * sy,
            cr * cp * sy - sr * sp * cy,
            cr * cp * cy + sr * sp * sy,
        )


def main():
    rclpy.init()
    node = BrainNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
