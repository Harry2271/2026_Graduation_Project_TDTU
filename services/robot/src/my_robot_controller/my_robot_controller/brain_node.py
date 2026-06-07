"""Brain controller — high-level state machine for the warehouse robot.

Subscribes to /cmd_vel from Nav2, /mapping_status from map_manager, and
/detected_tags from april_tag_node. Connects to the NestJS API as a
Socket.io client on the /robot namespace.
"""
import rclpy
from rclpy.node import Node


class BrainNode(Node):
    def __init__(self) -> None:
        super().__init__('brain')
        self.get_logger().info('brain_node started (skeleton)')


def main() -> None:
    rclpy.init()
    node = BrainNode()
    rclpy.spin(node)
    rclpy.shutdown()


if __name__ == '__main__':
    main()
