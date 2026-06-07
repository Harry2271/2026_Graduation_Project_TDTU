"""Brain controller — high-level state machine for the warehouse robot.

Phase 2 skeleton: declares the 10 states, instantiates FakeEsp32Bridge,
logs state transitions. Phase 5+ will wire up Nav2, vision, and the
API Socket.io client.
"""
from __future__ import annotations

from enum import Enum

import rclpy
from rclpy.node import Node

from my_robot_controller.esp32_bridge import Esp32Bridge, FakeEsp32Bridge


class BrainState(str, Enum):
    BOOT = 'BOOT'
    EXPLORE = 'EXPLORE'
    MAPPING_DONE = 'MAPPING_DONE'
    IDLE = 'IDLE'
    JOB_NAV_TO_PICKUP = 'JOB_NAV_TO_PICKUP'
    JOB_WAIT_FOR_CLEAR = 'JOB_WAIT_FOR_CLEAR'
    JOB_NAV_TO_DROPOFF = 'JOB_NAV_TO_DROPOFF'
    JOB_PLACE = 'JOB_PLACE'
    E_STOP = 'E_STOP'
    ERROR = 'ERROR'


class BrainNode(Node):
    def __init__(self) -> None:
        super().__init__('brain')
        self._state: BrainState = BrainState.BOOT
        self._bridge: Esp32Bridge = FakeEsp32Bridge()
        self.get_logger().info(f'brain_node started in state {self._state}')

    def transition_to(self, new_state: BrainState, reason: str = '') -> None:
        old = self._state
        self._state = new_state
        self.get_logger().info(f'state: {old} -> {new_state} ({reason})')

    @property
    def state(self) -> BrainState:
        return self._state


def main() -> None:
    rclpy.init()
    node = BrainNode()
    rclpy.spin(node)
    rclpy.shutdown()


if __name__ == '__main__':
    main()
