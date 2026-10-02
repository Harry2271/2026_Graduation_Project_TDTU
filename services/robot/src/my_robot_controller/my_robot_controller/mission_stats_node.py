"""mission_stats_node — Mission statistics tracker for the robot.

Tracks key performance indicators across the robot's operational lifetime:
- Total distance traveled (integrated from /odom)
- Total runtime (uptime)
- Deliveries completed (count dock_complete events from type 140)
- Average speed (distance / runtime)
- Total energy consumed (integrated from type 133 power telemetry)

Publishes aggregated stats to /mission_stats as JSON for dashboard consumption.
Stats are persisted to disk and survive node restarts.
"""
from __future__ import annotations

import json
import math
import os
import time
from pathlib import Path
from typing import Optional

import rclpy
from nav_msgs.msg import Odometry
from rclpy.node import Node
from std_msgs.msg import String


class MissionStatsNode(Node):
    """Track mission KPIs and publish to /mission_stats."""

    def __init__(self) -> None:
        super().__init__('mission_stats')

        # Stats storage path (persisted across restarts)
        self._stats_file = Path(os.environ.get(
            'MISSION_STATS_FILE',
            '/home/pi/robot_ws/mission_stats.json'
        ))

        # Load persisted stats or initialize fresh
        self._stats = self._load_stats()

        # Runtime tracking
        self._node_start_time = time.time()
        self._last_odom_time: Optional[float] = None
        self._last_odom_x: Optional[float] = None
        self._last_odom_y: Optional[float] = None
        self._last_power_time: Optional[float] = None

        # Subscribe to odometry for distance tracking
        self._odom_sub = self.create_subscription(
            Odometry, '/odom', self._on_odom, 10)

        # Subscribe to ESP32 telemetry for power and dock events
        self._power_sub = self.create_subscription(
            String, '/esp32/power', self._on_power, 10)
        self._unload_state_sub = self.create_subscription(
            String, '/esp32/unload_state', self._on_unload_state, 10)

        # Publish stats periodically
        self._stats_pub = self.create_publisher(String, '/mission_stats', 10)
        self._publish_timer = self.create_timer(1.0, self._publish_stats)

        # Persist stats every 10 seconds
        self._persist_timer = self.create_timer(10.0, self._persist_stats)

        self.get_logger().info(
            f'mission_stats_node ready (stats file: {self._stats_file})')

    def _load_stats(self) -> dict:
        """Load persisted stats from disk or return defaults."""
        if self._stats_file.exists():
            try:
                with open(self._stats_file, 'r') as f:
                    stats = json.load(f)
                self.get_logger().info(
                    f'loaded stats: {stats["total_distance_m"]:.2f}m, '
                    f'{stats["deliveries_completed"]} deliveries')
                return stats
            except Exception as e:
                self.get_logger().warning(f'failed to load stats: {e}')

        # Default stats structure
        return {
            'total_distance_m': 0.0,
            'total_runtime_s': 0.0,
            'deliveries_completed': 0,
            'total_energy_wh': 0.0,
            'session_start_time': time.time(),
        }

    def _persist_stats(self) -> None:
        """Write current stats to disk."""
        try:
            # Update runtime before persisting
            current_runtime = time.time() - self._node_start_time
            self._stats['total_runtime_s'] += current_runtime
            self._node_start_time = time.time()  # Reset for next interval

            self._stats_file.parent.mkdir(parents=True, exist_ok=True)
            with open(self._stats_file, 'w') as f:
                json.dump(self._stats, f, indent=2)
        except Exception as e:
            self.get_logger().error(f'failed to persist stats: {e}')

    def _on_odom(self, msg: Odometry) -> None:
        """Integrate distance from odometry."""
        current_time = time.time()
        x = msg.pose.pose.position.x
        y = msg.pose.pose.position.y

        if self._last_odom_x is not None and self._last_odom_y is not None:
            # Calculate Euclidean distance traveled since last update
            dx = x - self._last_odom_x
            dy = y - self._last_odom_y
            distance = math.sqrt(dx * dx + dy * dy)

            # Sanity check: ignore jumps > 1m (likely a map/odom reset)
            if distance < 1.0:
                self._stats['total_distance_m'] += distance

        self._last_odom_x = x
        self._last_odom_y = y
        self._last_odom_time = current_time

    def _on_power(self, msg: String) -> None:
        """Integrate energy consumption from INA226 power telemetry (type 133)."""
        try:
            data = json.loads(msg.data)
            power_w = data.get('power_w', 0.0)
            current_time = time.time()

            if self._last_power_time is not None and power_w > 0:
                # dt in hours for watt-hours calculation
                dt_h = (current_time - self._last_power_time) / 3600.0
                energy_wh = power_w * dt_h

                # Sanity check: ignore unrealistic power spikes
                if energy_wh < 100.0:  # < 100 Wh per sample (reasonable for 2Hz)
                    self._stats['total_energy_wh'] += energy_wh

            self._last_power_time = current_time
        except (json.JSONDecodeError, KeyError) as e:
            self.get_logger().debug(f'power parse error: {e}')

    def _on_unload_state(self, msg: String) -> None:
        """Count completed deliveries from dock FSM state 7 (COMPLETE)."""
        try:
            data = json.loads(msg.data)
            state = data.get('state')

            # state=7 is UNLOAD_STATE_COMPLETE (see firmware AutoRoam)
            if state == 7:
                self._stats['deliveries_completed'] += 1
                self.get_logger().info(
                    f'delivery completed (total: '
                    f'{self._stats["deliveries_completed"]})')
        except (json.JSONDecodeError, KeyError) as e:
            self.get_logger().debug(f'unload_state parse error: {e}')

    def _publish_stats(self) -> None:
        """Publish aggregated stats to /mission_stats."""
        current_runtime = time.time() - self._node_start_time
        total_runtime_s = self._stats['total_runtime_s'] + current_runtime

        # Calculate average speed (avoid division by zero)
        avg_speed_mps = (
            self._stats['total_distance_m'] / total_runtime_s
            if total_runtime_s > 0 else 0.0
        )

        payload = {
            'total_distance_m': round(self._stats['total_distance_m'], 2),
            'total_runtime_s': round(total_runtime_s, 1),
            'deliveries_completed': self._stats['deliveries_completed'],
            'average_speed_mps': round(avg_speed_mps, 3),
            'total_energy_wh': round(self._stats['total_energy_wh'], 2),
            'ts': time.time(),
        }

        self._stats_pub.publish(String(data=json.dumps(payload)))


def main() -> None:
    rclpy.init()
    node = MissionStatsNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        # Final persist before shutdown
        node._persist_stats()
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == '__main__':
    main()
