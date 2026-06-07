"""AprilTag detector — reads from /dev/video0 and publishes /detected_tags."""
import rclpy
from rclpy.node import Node


class AprilTagNode(Node):
    def __init__(self) -> None:
        super().__init__('april_tag_node')
        self.get_logger().info('april_tag_node started (skeleton)')


def main() -> None:
    rclpy.init()
    node = AprilTagNode()
    rclpy.spin(node)
    rclpy.shutdown()


if __name__ == '__main__':
    main()
