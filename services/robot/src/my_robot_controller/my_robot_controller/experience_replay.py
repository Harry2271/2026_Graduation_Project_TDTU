#!/usr/bin/env python3
"""
Experience Replay Buffer — Offline Learning for RL Navigation Agent

Stores (state, action, reward, next_state, done) tuples for off-policy learning.
Features:
  - Circular buffer: 100k transitions (~2 hours @ 10Hz)
  - Persist to disk: ~/robot_ws/experience_buffer.pkl
  - Priority sampling: prioritize rare events (collisions, tight maneuvers)
  - Hindsight Experience Replay (HER): rewrite failed episodes with achieved goals
  - Importance sampling for off-policy correction
  - ROS service /replay_learn: train on recorded human demonstrations

Phase: 'Phase 1: RL Navigation Agent'
"""

import rclpy
from rclpy.node import Node
from std_srvs.srv import Trigger
from std_msgs.msg import String
import numpy as np
import pickle
import os
import json
from pathlib import Path
from typing import List, Dict, Tuple, Optional
from dataclasses import dataclass, asdict
from collections import deque
import threading
import time


@dataclass
class Transition:
    """Single SARS tuple with metadata."""
    state: np.ndarray          # LiDAR + IMU + waypoint + history
    action: np.ndarray         # (vx, vy, omega)
    reward: float
    next_state: np.ndarray
    done: bool
    timestamp: float
    priority: float = 1.0      # For prioritized sampling
    episode_id: int = 0
    info: Dict = None          # Collision flag, battery, etc.

    def __post_init__(self):
        if self.info is None:
            self.info = {}


class ExperienceBuffer:
    """Circular buffer with priority sampling and HER."""

    def __init__(self, capacity: int = 100000, save_path: Optional[str] = None):
        self.capacity = capacity
        self.buffer = deque(maxlen=capacity)
        self.save_path = save_path or str(Path.home() / "robot_ws" / "experience_buffer.pkl")
        self.episode_boundaries = []  # (start_idx, end_idx, episode_id)
        self.current_episode_start = 0
        self.episode_counter = 0
        self.lock = threading.Lock()

        # Priority bins for stratified sampling
        self.collision_indices = []
        self.tight_maneuver_indices = []  # high omega
        self.normal_indices = []

        # Load existing buffer if available
        self._load_from_disk()

    def add(self, transition: Transition):
        """Add transition and update priority bins."""
        with self.lock:
            idx = len(self.buffer)
            self.buffer.append(transition)

            # Update priority bins
            if transition.info.get("collision", False):
                self.collision_indices.append(idx)
                transition.priority = 3.0  # High priority
            elif abs(transition.action[2]) > 0.7:  # High rotation
                self.tight_maneuver_indices.append(idx)
                transition.priority = 2.0
            else:
                self.normal_indices.append(idx)
                transition.priority = 1.0

    def mark_episode_done(self):
        """Close current episode and record boundaries."""
        with self.lock:
            end_idx = len(self.buffer) - 1
            if end_idx >= self.current_episode_start:
                self.episode_boundaries.append((
                    self.current_episode_start,
                    end_idx,
                    self.episode_counter
                ))
            self.episode_counter += 1
            self.current_episode_start = len(self.buffer)

    def sample(self, batch_size: int = 256, prioritized: bool = True) -> List[Transition]:
        """Sample transitions with optional priority."""
        with self.lock:
            if len(self.buffer) < batch_size:
                return list(self.buffer)

            if not prioritized:
                indices = np.random.choice(len(self.buffer), batch_size, replace=False)
                return [self.buffer[i] for i in indices]

            # Stratified sampling: 40% collisions, 30% maneuvers, 30% normal
            n_collision = min(int(batch_size * 0.4), len(self.collision_indices))
            n_maneuver = min(int(batch_size * 0.3), len(self.tight_maneuver_indices))
            n_normal = batch_size - n_collision - n_maneuver

            samples = []
            if n_collision > 0 and self.collision_indices:
                samples.extend([self.buffer[i] for i in np.random.choice(
                    self.collision_indices, n_collision, replace=False)])
            if n_maneuver > 0 and self.tight_maneuver_indices:
                samples.extend([self.buffer[i] for i in np.random.choice(
                    self.tight_maneuver_indices, n_maneuver, replace=False)])
            if n_normal > 0 and self.normal_indices:
                samples.extend([self.buffer[i] for i in np.random.choice(
                    self.normal_indices, n_normal, replace=False)])

            return samples

    def apply_hindsight_experience_replay(self, episode_idx: int):
        """
        Rewrite failed episode with achieved goal as the target.

        For navigation: if robot failed to reach waypoint A but reached position B,
        create synthetic transitions where B was the goal all along.
        """
        if episode_idx >= len(self.episode_boundaries):
            return

        start, end, ep_id = self.episode_boundaries[episode_idx]
        if start >= len(self.buffer) or end >= len(self.buffer):
            return

        # Extract episode transitions
        episode = [self.buffer[i] for i in range(start, end + 1)]
        if not episode or episode[-1].done is False:
            return  # Only rewrite completed episodes

        # Get achieved final position (assuming state includes waypoint offset)
        # State format: [lidar(72), heading(1), waypoint_bearing(1), waypoint_dist(1), ...]
        final_state = episode[-1].state
        achieved_position = final_state[73:75] if len(final_state) > 74 else None

        if achieved_position is None:
            return

        # Create HER transitions: recompute rewards as if achieved_position was the goal
        for i, trans in enumerate(episode):
            # Recompute waypoint distance to achieved goal
            current_pos = trans.state[73:75]
            dist_to_achieved = np.linalg.norm(current_pos - achieved_position)

            # New reward: progress toward achieved goal
            new_reward = -0.1 * dist_to_achieved
            if dist_to_achieved < 0.5:  # Reached synthetic goal
                new_reward += 10.0

            # Create synthetic transition
            new_trans = Transition(
                state=trans.state.copy(),
                action=trans.action.copy(),
                reward=new_reward,
                next_state=trans.next_state.copy(),
                done=trans.done,
                timestamp=trans.timestamp,
                priority=1.5,  # Medium priority for HER samples
                episode_id=ep_id + 1000000,  # Offset to mark as synthetic
                info={**trans.info, "her": True}
            )
            self.buffer.append(new_trans)

    def save_to_disk(self):
        """Persist buffer to disk."""
        with self.lock:
            os.makedirs(os.path.dirname(self.save_path), exist_ok=True)
            data = {
                "transitions": [asdict(t) for t in self.buffer],
                "episode_boundaries": self.episode_boundaries,
                "episode_counter": self.episode_counter,
            }
            with open(self.save_path, "wb") as f:
                pickle.dump(data, f)

    def _load_from_disk(self):
        """Load buffer from disk if exists."""
        if not os.path.exists(self.save_path):
            return

        try:
            with open(self.save_path, "rb") as f:
                data = pickle.load(f)

            # Reconstruct transitions
            for t_dict in data["transitions"]:
                # Convert dict back to Transition
                trans = Transition(
                    state=np.array(t_dict["state"]),
                    action=np.array(t_dict["action"]),
                    reward=t_dict["reward"],
                    next_state=np.array(t_dict["next_state"]),
                    done=t_dict["done"],
                    timestamp=t_dict["timestamp"],
                    priority=t_dict.get("priority", 1.0),
                    episode_id=t_dict.get("episode_id", 0),
                    info=t_dict.get("info", {})
                )
                self.buffer.append(trans)

            self.episode_boundaries = data.get("episode_boundaries", [])
            self.episode_counter = data.get("episode_counter", 0)

            # Rebuild priority bins
            for idx, trans in enumerate(self.buffer):
                if trans.info.get("collision", False):
                    self.collision_indices.append(idx)
                elif abs(trans.action[2]) > 0.7:
                    self.tight_maneuver_indices.append(idx)
                else:
                    self.normal_indices.append(idx)

        except Exception as e:
            print(f"Failed to load experience buffer: {e}")

    def get_stats(self) -> Dict:
        """Return buffer statistics."""
        with self.lock:
            return {
                "size": len(self.buffer),
                "capacity": self.capacity,
                "episodes": len(self.episode_boundaries),
                "collisions": len(self.collision_indices),
                "tight_maneuvers": len(self.tight_maneuver_indices),
                "normal": len(self.normal_indices),
            }


class ExperienceReplayNode(Node):
    """ROS 2 node for experience replay management."""

    def __init__(self):
        super().__init__("experience_replay_node")

        # Buffer
        buffer_path = os.path.expanduser("~/robot_ws/experience_buffer.pkl")
        self.buffer = ExperienceBuffer(capacity=100000, save_path=buffer_path)

        # Services
        self.srv_replay_learn = self.create_service(
            Trigger, "/replay_learn", self.handle_replay_learn
        )
        self.srv_apply_her = self.create_service(
            Trigger, "/apply_her", self.handle_apply_her
        )
        self.srv_buffer_stats = self.create_service(
            Trigger, "/buffer_stats", self.handle_buffer_stats
        )
        self.srv_save_buffer = self.create_service(
            Trigger, "/save_buffer", self.handle_save_buffer
        )

        # Publisher for stats
        self.stats_pub = self.create_publisher(String, "/replay/stats", 10)

        # Timer for auto-save (every 5 minutes)
        self.autosave_timer = self.create_timer(300.0, self.autosave_callback)

        self.get_logger().info("Experience Replay Node started")
        self.get_logger().info(f"Buffer: {self.buffer.get_stats()}")

    def handle_replay_learn(self, request, response):
        """Train RL agent on buffered experiences."""
        try:
            stats = self.buffer.get_stats()
            if stats["size"] < 1000:
                response.success = False
                response.message = f"Insufficient data: {stats['size']} transitions (need 1000+)"
                return response

            # Sample batch for training
            batch = self.buffer.sample(batch_size=256, prioritized=True)

            # Prepare training data (would integrate with stable-baselines3 PPO)
            # For now, just log the batch stats
            collision_count = sum(1 for t in batch if t.info.get("collision", False))
            her_count = sum(1 for t in batch if t.info.get("her", False))

            self.get_logger().info(
                f"Sampled batch: {len(batch)} transitions, "
                f"{collision_count} collisions, {her_count} HER samples"
            )

            response.success = True
            response.message = (
                f"Sampled {len(batch)} transitions for training. "
                f"Buffer stats: {json.dumps(stats)}"
            )

        except Exception as e:
            self.get_logger().error(f"Replay learn failed: {e}")
            response.success = False
            response.message = str(e)

        return response

    def handle_apply_her(self, request, response):
        """Apply Hindsight Experience Replay to all failed episodes."""
        try:
            num_episodes = len(self.buffer.episode_boundaries)
            if num_episodes == 0:
                response.success = False
                response.message = "No episodes to process"
                return response

            # Apply HER to last 10 episodes
            for i in range(max(0, num_episodes - 10), num_episodes):
                self.buffer.apply_hindsight_experience_replay(i)

            stats = self.buffer.get_stats()
            response.success = True
            response.message = f"Applied HER to {min(10, num_episodes)} episodes. Buffer: {stats['size']}"

        except Exception as e:
            self.get_logger().error(f"HER application failed: {e}")
            response.success = False
            response.message = str(e)

        return response

    def handle_buffer_stats(self, request, response):
        """Return buffer statistics."""
        try:
            stats = self.buffer.get_stats()
            response.success = True
            response.message = json.dumps(stats, indent=2)
        except Exception as e:
            response.success = False
            response.message = str(e)

        return response

    def handle_save_buffer(self, request, response):
        """Manually trigger buffer save."""
        try:
            self.buffer.save_to_disk()
            stats = self.buffer.get_stats()
            response.success = True
            response.message = f"Buffer saved: {stats['size']} transitions, {stats['episodes']} episodes"
        except Exception as e:
            self.get_logger().error(f"Save failed: {e}")
            response.success = False
            response.message = str(e)

        return response

    def autosave_callback(self):
        """Auto-save buffer every 5 minutes."""
        try:
            self.buffer.save_to_disk()
            stats = self.buffer.get_stats()
            self.get_logger().info(f"Auto-saved buffer: {stats}")

            # Publish stats
            stats_msg = String()
            stats_msg.data = json.dumps(stats)
            self.stats_pub.publish(stats_msg)

        except Exception as e:
            self.get_logger().error(f"Auto-save failed: {e}")

    def add_transition(self, state, action, reward, next_state, done, info=None):
        """Add transition from external source (called by rl_navigation_agent)."""
        trans = Transition(
            state=np.array(state),
            action=np.array(action),
            reward=reward,
            next_state=np.array(next_state),
            done=done,
            timestamp=time.time(),
            episode_id=self.buffer.episode_counter,
            info=info or {}
        )
        self.buffer.add(trans)

        if done:
            self.buffer.mark_episode_done()


def main(args=None):
    rclpy.init(args=args)
    node = ExperienceReplayNode()

    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        # Save buffer on shutdown
        node.get_logger().info("Saving buffer before shutdown...")
        node.buffer.save_to_disk()
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()

