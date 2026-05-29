#!/usr/bin/env python3
"""brain_node — odometry publisher + status reporter. No motors."""
import math
import rclpy
from rclpy.node import Node
from sensor_msgs.msg import LaserScan
from nav_msgs.msg import Odometry
from std_msgs.msg import String
from geometry_msgs.msg import TransformStamped
from tf2_ros import TransformBroadcaster

LINEAR_SPEED = 0.0    # m/s — 0 = robot is stationary, user physically moves it
                       #         frontend handles localization via scan matching


class BrainNode(Node):
    def __init__(self):
        super().__init__('brain_node')
        self.scan_sub  = self.create_subscription(LaserScan, '/scan',  self._on_scan, 10)
        self.status_pub = self.create_publisher(String, '/robot_status', 10)
        self.odom_pub   = self.create_publisher(Odometry, '/odom', 10)
        self.tf_broadcaster = TransformBroadcaster(self)

        self.x = 0.0
        self.y = 0.0
        self.theta = 0.0
        self.vx = 0.0
        self.vy = 0.0
        self.omega = 0.0
        self._last_time = self.get_clock().now()
        self._last_status = self._last_time
        self._scan_count = 0

        self.create_timer(0.1, self._tick)
        self.get_logger().info('Brain node started')

    def _on_scan(self, msg: LaserScan):
        self._scan_count += 1
        self.vx = LINEAR_SPEED  # 0 = stationary; frontend localizes via scan matching

    def _tick(self):
        now = self.get_clock().now()
        dt = (now - self._last_time).nanoseconds * 1e-9
        self._last_time = now

        self.x     += self.vx * dt
        self.theta += self.omega * dt

        odom = Odometry()
        odom.header.stamp    = now.to_msg()
        odom.header.frame_id = 'odom'
        odom.child_frame_id  = 'base_footprint'
        odom.pose.pose.position.x = self.x
        odom.pose.pose.position.y = self.y
        q = self._euler_to_quat(0, 0, self.theta)
        odom.pose.pose.orientation.x = q[0]
        odom.pose.pose.orientation.y = q[1]
        odom.pose.pose.orientation.z = q[2]
        odom.pose.pose.orientation.w = q[3]
        odom.twist.twist.linear.x = self.vx
        odom.twist.twist.angular.z = self.omega
        self.odom_pub.publish(odom)

        t = TransformStamped()
        t.header.stamp    = now.to_msg()
        t.header.frame_id = 'odom'
        t.child_frame_id  = 'base_footprint'
        t.transform.translation.x = self.x
        t.transform.translation.y = self.y
        t.transform.rotation.x = q[0]
        t.transform.rotation.y = q[1]
        t.transform.rotation.z = q[2]
        t.transform.rotation.w = q[3]
        self.tf_broadcaster.sendTransform(t)

        if (now - self._last_status).nanoseconds >= 1e9:
            self._last_status = now
            status = String()
            status.data = f'STATE=RUNNING x={self.x:.2f} y={self.y:.2f} scans={self._scan_count}'
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
