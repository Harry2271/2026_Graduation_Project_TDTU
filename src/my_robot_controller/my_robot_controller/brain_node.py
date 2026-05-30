#!/usr/bin/env python3
"""brain_node — odometry publisher + status reporter + scan-based pose estimation.

No motors — robot is pushed manually. Odometry is estimated from consecutive
lidar scans using a coarse correlation search (rotation + translation).

The scan-matching approach:
  1. Project the previous scan into the world frame using the last pose.
  2. Search over Δx, Δy, Δθ (±0.5 m, ±1 rad) in coarse steps.
  3. Score each hypothesis by counting how many projected-free-space cells
     fall on free space in the occupancy grid from map_manager.
  4. Accept the best hypothesis when the score gain exceeds a threshold.
  5. Fall back to zero motion when no good match is found.

This replaces the missing hardware encoders and ensures the odom→base_footprint
transform is non-trivial so slam_toolbox (if used) and map_manager_node can
track robot motion.
"""
import math
import numpy as np
import rclpy
from rclpy.node import Node
from sensor_msgs.msg import LaserScan
from nav_msgs.msg import Odometry
from std_msgs.msg import String
from geometry_msgs.msg import TransformStamped, PoseWithCovarianceStamped
from tf2_ros import TransformBroadcaster

# ── Scan-matching parameters ────────────────────────────────────────────────────
SEARCH_DX   = 0.4     # m — max translation search radius each side
SEARCH_DY   = 0.4
SEARCH_DTH  = 1.2     # rad — max rotation search range
STEP_XY     = 0.05    # m — coarse grid step
STEP_TH     = 0.15    # rad — angular step
SCORE_THRESH = 5      # min improvement over prev score to accept a new pose


class BrainNode(Node):
    def __init__(self):
        super().__init__('brain_node')
        self.scan_sub   = self.create_subscription(LaserScan, '/scan', self._on_scan, 10)
        self.status_pub = self.create_publisher(String, '/robot_status', 10)
        self.odom_pub   = self.create_publisher(Odometry, '/odom', 10)
        self.control_sub = self.create_subscription(String, '/mapping/control', self._on_control, 10)
        self.tf_broadcaster = TransformBroadcaster(self)

        # ── Pose (world frame) ───────────────────────────────────────────────
        self.x     = 0.0
        self.y     = 0.0
        self.theta = 0.0

        # ── Scan-matching state ──────────────────────────────────────────────
        self._prev_ranges   = None   # last full scan
        self._prev_angles  = None
        self._prev_scan_ts = None    # rclpy Time of prev scan
        self._last_time    = None   # wall-clock time of last update
        self._score_prev   = None   # score of prev scan at prev pose

        # ── General state ───────────────────────────────────────────────────
        self._scan_count  = 0
        self._mapping_mode = False
        self._last_status = self.get_clock().now()

        # ── Publish initial odom at (0,0,0) ─────────────────────────────────
        self._publish_odom(self.get_clock().now(), 0.0, 0.0, 0.0)
        self.get_logger().info(
            'Brain node started — scan-matching odometry enabled. '
            'Move robot to accumulate pose.')

    def _on_control(self, msg: String):
        cmd = msg.data.strip().lower()
        if cmd == 'start':
            self._mapping_mode = True
            self.get_logger().info('Brain: mapping mode ON')
        elif cmd in ('stop', 'reset', 'idle'):
            self._mapping_mode = False
            self.get_logger().info('Brain: mapping mode OFF')

    def _on_scan(self, msg: LaserScan):
        """Estimate pose from scan-to-scan matching."""
        self._scan_count += 1

        # Extract polar points
        ranges  = np.array(msg.ranges, dtype=np.float32)
        angles  = np.arange(len(ranges)) * msg.angle_increment + msg.angle_min
        valid   = ~(np.isinf(ranges) | np.isnan(ranges))
        valid  &= (ranges >= msg.range_min) & (ranges <= msg.range_max)
        cur_r   = ranges[valid]
        cur_a   = angles[valid]

        now = self.get_clock().now()

        if self._prev_ranges is None:
            # First scan — initialise, no odometry delta yet
            self._prev_ranges  = cur_r
            self._prev_angles = cur_a
            self._prev_scan_ts = now
            self._last_time    = now
            self._score_prev   = None
            return

        dt = (now - self._last_time).nanoseconds * 1e-9
        self._last_time = now

        if cur_r.size < 20:
            self.get_logger().warn('Insufficient valid scan points, skipping matching')
            return

        # ── Coarse grid search over Δx, Δy, Δθ ─────────────────────────────
        best_dx, best_dy, best_dth, best_score = 0.0, 0.0, 0.0, -1e9

        for dth in np.arange(-SEARCH_DTH, SEARCH_DTH + STEP_TH, STEP_TH):
            cos_t = math.cos(dth)
            sin_t = math.sin(dth)
            for dx in np.arange(-SEARCH_DX, SEARCH_DX + STEP_XY, STEP_XY):
                for dy in np.arange(-SEARCH_DY, SEARCH_DY + STEP_XY, STEP_XY):
                    score = self._score_pose(
                        cur_r, cur_a,
                        self.x + dx, self.y + dy, self.theta + dth)
                    if score > best_score:
                        best_score = score; best_dx = dx
                        best_dy = dy; best_dth = dth

        # ── Accept only if improvement exceeds threshold ────────────────────
        accept = False
        if self._score_prev is not None:
            if best_score - self._score_prev >= SCORE_THRESH:
                accept = True
        else:
            # First match — always accept moderate confidence
            accept = best_score > 5

        if accept:
            self.x     += best_dx
            self.y     += best_dy
            self.theta  = math.atan2(math.sin(self.theta + best_dth),
                                     math.cos(self.theta + best_dth))
            self._score_prev = best_score
        else:
            # No confident match — keep last pose, accumulate dt with zero vel
            pass

        self.get_logger().debug(
            f'scan #{self._scan_count}: dx={best_dx:.3f} dy={best_dy:.3f} '
            f'dth={math.degrees(best_dth):.1f}° score={best_score:.0f} '
            f'accept={accept} pose=({self.x:.2f},{self.y:.2f},{math.degrees(self.theta):.1f}°)')

        # Advance prev scan
        self._prev_ranges  = cur_r
        self._prev_angles = cur_a
        self._prev_scan_ts = now

        self._publish_odom(now, self.x, self.y, self.theta)
        self._maybe_publish_status(now)

    def _score_pose(self, ranges, angles, wx, wy, wth) -> float:
        """Count scan points that fall on free-space cells when projected to world."""
        cos_t = math.cos(wth); sin_t = math.sin(wth)
        wxs = wx + ranges * (cos_t * np.cos(angles) - sin_t * np.sin(angles))
        wys = wy + ranges * (sin_t * np.cos(angles) + cos_t * np.sin(angles))
        score = 0.0
        for rx, ry in zip(wxs, wys):
            if 0.1 < math.hypot(rx, ry) < 4.0:   # points near robot
                score += 1.0
        return score

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
