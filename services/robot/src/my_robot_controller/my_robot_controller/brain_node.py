"""Brain controller — high-level state machine for the warehouse robot.

Phase 5: Receives jobs from the API via Socket.io, walks the state machine
through faked movement (asyncio.sleep). Real movement (Nav2 + RealEsp32Bridge)
comes in Phase 6.
"""
from __future__ import annotations

import asyncio
import math
import time
from enum import Enum

import rclpy
from geometry_msgs.msg import PoseStamped
from nav2_simple_commander.robot_navigator import BasicNavigator
from rclpy.node import Node

from my_robot_controller.api_client import BrainApiClient
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
        self._api_client = BrainApiClient()
        self._api_client.on_job_dispatch(self._handle_job_dispatch)
        self.get_logger().info(f'brain_node started in state {self._state}')

    def transition_to(self, new_state: BrainState, reason: str = '') -> None:
        old = self._state
        self._state = new_state
        self.get_logger().info(f'state: {old} -> {new_state} ({reason})')

    @property
    def state(self) -> BrainState:
        return self._state

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

    async def _handle_job_dispatch(self, payload: dict) -> None:
        """Called when a job:dispatch event is received from the API."""
        job_id = payload.get('_id', 'unknown')
        self.get_logger().info(f'Received job dispatch: {job_id}')
        asyncio.create_task(self._execute_job(payload))

    async def _execute_job(self, job: dict) -> None:
        """Walk the state machine with faked movement."""
        job_id = job.get('_id', 'unknown')
        self.get_logger().info(f'Starting job {job_id}')
        try:
            self.transition_to(BrainState.JOB_NAV_TO_PICKUP, f'job {job_id}')
            await self._api_client.emit_job_status(job_id, 'IN_PROGRESS')
            await asyncio.sleep(5)

            self.transition_to(BrainState.JOB_NAV_TO_DROPOFF, f'job {job_id}')
            await asyncio.sleep(5)

            self.transition_to(BrainState.JOB_PLACE, f'job {job_id}')
            await asyncio.sleep(3)

            self.transition_to(BrainState.IDLE, f'job {job_id} completed')
            await self._api_client.emit_job_status(job_id, 'COMPLETED')
            self.get_logger().info(f'Job {job_id} completed successfully')
        except Exception as e:
            self.get_logger().error(f'Job {job_id} failed: {e}')
            await self._api_client.emit_job_status(job_id, 'FAILED')
            self.transition_to(BrainState.ERROR, f'job {job_id} failed')


_RECONNECT_INTERVAL = 30.0  # seconds between background reconnection attempts


async def _run_async(node: BrainNode) -> None:
    """Async ROS spin loop that keeps the Socket.io client alive.

    The API connection is non-fatal — if the backend is unreachable the brain
    keeps spinning ROS and periodically retries the connection.  This prevents
    PM2 crash-looping 1500+ times when the backend is temporarily down.
    """
    node.get_logger().info('Attempting initial API connection...')
    await node._api_client.connect()

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

    await node._api_client.disconnect()


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
