#!/usr/bin/env python3
"""
RL Navigation Agent — PPO-based autonomous navigation using stable-baselines3.

State space: LiDAR (72 points), IMU heading, waypoint bearing/distance, action history,
             collision flag, battery SOC
Action space: continuous (vx, vy, omega) ∈ [-1, 1]
Reward: waypoint reach (+10), collision (-5), progress (-0.1*dist), efficiency penalty,
        smoothness bonus, exploration penalty

Training: Gazebo sim (10k episodes) → real-world fine-tuning (100 episodes)
Model persistence: ~/robot_ws/models/rl_nav_ppo_best.zip
"""

import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy, HistoryPolicy
from sensor_msgs.msg import LaserScan
from nav_msgs.msg import Odometry
from geometry_msgs.msg import Twist, PoseStamped
from std_msgs.msg import String, Float32, Bool
from std_srvs.srv import Trigger, Empty

import numpy as np
import json
import os
import math
from pathlib import Path
from collections import deque
from typing import Optional, Tuple, Dict, Any

try:
    from stable_baselines3 import PPO
    from stable_baselines3.common.env_util import make_vec_env
    from stable_baselines3.common.callbacks import CheckpointCallback
    import gymnasium as gym
    from gymnasium import spaces
    SB3_AVAILABLE = True
except ImportError:
    SB3_AVAILABLE = False
    print("Warning: stable-baselines3 not installed. RL training disabled.")


class RobotNavEnv(gym.Env):
    """
    Gymnasium environment for robot navigation.
    Bridges ROS2 state to RL agent.
    """

    def __init__(self, node_ref):
        super().__init__()
        self.node = node_ref

        # State space: [72 LiDAR points, heading, target_bearing, target_distance,
        #                last_5_actions (15), collision_flag, battery_soc]
        # Total: 72 + 1 + 1 + 1 + 15 + 1 + 1 = 92 dimensions
        self.observation_space = spaces.Box(
            low=-np.inf,
            high=np.inf,
            shape=(92,),
            dtype=np.float32
        )

        # Action space: continuous (vx, vy, omega) in [-1, 1]
        self.action_space = spaces.Box(
            low=-1.0,
            high=1.0,
            shape=(3,),
            dtype=np.float32
        )

        self.last_actions = deque(maxlen=5)
        for _ in range(5):
            self.last_actions.append(np.zeros(3))

        self.visited_cells = set()
        self.last_position = None
        self.episode_steps = 0
        self.max_episode_steps = 1000

    def reset(self, seed=None, options=None):
        super().reset(seed=seed)

        self.last_actions.clear()
        for _ in range(5):
            self.last_actions.append(np.zeros(3))

        self.visited_cells.clear()
        self.last_position = None
        self.episode_steps = 0

        obs = self._get_observation()
        info = {}

        return obs, info

    def step(self, action):
        self.episode_steps += 1
        self.last_actions.append(action)

        # Execute action via ROS2
        self.node._execute_rl_action(action)

        # Get new observation
        obs = self._get_observation()

        # Calculate reward
        reward, done, info = self._calculate_reward(action)

        truncated = self.episode_steps >= self.max_episode_steps

        return obs, reward, done, truncated, info

    def _get_observation(self) -> np.ndarray:
        # Downsample LiDAR from 360 to 72 points (every 5th point)
        lidar_raw = self.node.latest_scan
        if lidar_raw is None or len(lidar_raw) == 0:
            lidar_downsampled = np.zeros(72, dtype=np.float32)
        else:
            lidar_downsampled = np.array(lidar_raw[::5][:72], dtype=np.float32)
            # Pad if insufficient points
            if len(lidar_downsampled) < 72:
                lidar_downsampled = np.pad(lidar_downsampled, (0, 72 - len(lidar_downsampled)), constant_values=0.0)

        # IMU heading (normalized to [-pi, pi])
        heading = self.node.latest_heading if self.node.latest_heading is not None else 0.0

        # Target waypoint bearing and distance
        target_bearing, target_distance = self._compute_target_vector()

        # Flatten last 5 actions
        actions_flat = np.concatenate(list(self.last_actions))

        # Collision flag
        collision_flag = 1.0 if self.node.collision_detected else 0.0

        # Battery SOC
        battery_soc = self.node.latest_battery_soc if self.node.latest_battery_soc is not None else 1.0

        # Concatenate all features
        obs = np.concatenate([
            lidar_downsampled,
            [heading],
            [target_bearing],
            [target_distance],
            actions_flat,
            [collision_flag],
            [battery_soc]
        ]).astype(np.float32)

        return obs

    def _compute_target_vector(self) -> Tuple[float, float]:
        if self.node.target_waypoint is None or self.node.current_pose is None:
            return 0.0, 10.0  # Default: 10m ahead

        tx, ty = self.node.target_waypoint
        cx, cy = self.node.current_pose[:2]
        cyaw = self.node.current_pose[2]

        dx = tx - cx
        dy = ty - cy
        distance = math.sqrt(dx**2 + dy**2)

        global_bearing = math.atan2(dy, dx)
        relative_bearing = self._normalize_angle(global_bearing - cyaw)

        return relative_bearing, distance

    def _calculate_reward(self, action: np.ndarray) -> Tuple[float, bool, Dict[str, Any]]:
        reward = 0.0
        done = False
        info = {}

        # Waypoint reached (+10)
        _, distance = self._compute_target_vector()
        if distance < 0.3:
            reward += 10.0
            done = True
            info['success'] = True
            return reward, done, info

        # Collision penalty (-5)
        if self.node.collision_detected:
            reward -= 5.0
            done = True
            info['collision'] = True
            return reward, done, info

        # Progress reward (-0.1 * distance)
        reward -= 0.1 * distance

        # Energy efficiency penalty (-0.05 * sum(|actions|))
        action_magnitude = np.sum(np.abs(action))
        reward -= 0.05 * action_magnitude

        # Smoothness bonus (low jerk)
        if len(self.last_actions) >= 2:
            prev_action = list(self.last_actions)[-2]
            jerk = np.linalg.norm(action - prev_action)
            if jerk < 0.2:
                reward += 0.5

        # Exploration penalty (visited cells)
        if self.node.current_pose is not None:
            cx, cy = self.node.current_pose[:2]
            cell = (int(cx * 2), int(cy * 2))  # 0.5m grid
            if cell in self.visited_cells:
                reward -= 2.0
            else:
                self.visited_cells.add(cell)

        info['distance'] = distance
        info['action_magnitude'] = action_magnitude

        return reward, done, info

    @staticmethod
    def _normalize_angle(angle: float) -> float:
        while angle > math.pi:
            angle -= 2 * math.pi
        while angle < -math.pi:
            angle += 2 * math.pi
        return angle


class RLNavigationAgent(Node):
    """
    ROS2 node for RL-based navigation using PPO.
    """

    def __init__(self):
        super().__init__('rl_navigation_agent')

        # State variables
        self.latest_scan = None
        self.latest_heading = None
        self.target_waypoint = None
        self.current_pose = None  # (x, y, yaw)
        self.collision_detected = False
        self.latest_battery_soc = 1.0

        self.training_mode = False
        self.model_loaded = False

        # Model paths
        home = Path.home()
        self.models_dir = home / 'robot_ws' / 'models'
        self.logs_dir = home / 'robot_ws' / 'logs' / 'rl_nav'
        self.models_dir.mkdir(parents=True, exist_ok=True)
        self.logs_dir.mkdir(parents=True, exist_ok=True)

        self.model_path = self.models_dir / 'rl_nav_ppo_best.zip'

        # Initialize RL environment and model
        self.env = None
        self.model = None
        if SB3_AVAILABLE:
            self.env = RobotNavEnv(self)
            self._load_or_create_model()

        # QoS profiles
        sensor_qos = QoSProfile(
            reliability=ReliabilityPolicy.BEST_EFFORT,
            history=HistoryPolicy.KEEP_LAST,
            depth=10
        )

        reliable_qos = QoSProfile(
            reliability=ReliabilityPolicy.RELIABLE,
            history=HistoryPolicy.KEEP_LAST,
            depth=10
        )

        # Subscribers
        self.scan_sub = self.create_subscription(
            LaserScan,
            '/scan',
            self._scan_callback,
            sensor_qos
        )

        self.odom_sub = self.create_subscription(
            Odometry,
            '/odom',
            self._odom_callback,
            reliable_qos
        )

        self.imu_sub = self.create_subscription(
            String,
            '/esp32/imu',
            self._imu_callback,
            reliable_qos
        )

        self.target_sub = self.create_subscription(
            PoseStamped,
            '/target_waypoint',
            self._target_callback,
            reliable_qos
        )

        self.collision_sub = self.create_subscription(
            Bool,
            '/collision_detected',
            self._collision_callback,
            reliable_qos
        )

        self.battery_sub = self.create_subscription(
            Float32,
            '/battery_soc',
            self._battery_callback,
            reliable_qos
        )

        # Publishers
        self.cmd_vel_pub = self.create_publisher(Twist, '/cmd_vel', 10)
        self.diagnostics_pub = self.create_publisher(String, '/rl_diagnostics', 10)

        # Services
        self.train_srv = self.create_service(
            Trigger,
            '/rl_train',
            self._train_callback
        )

        self.load_model_srv = self.create_service(
            Trigger,
            '/rl_load_model',
            self._load_model_callback
        )

        # Control timer (10 Hz inference)
        self.control_timer = self.create_timer(0.1, self._control_loop)

        # Training metrics
        self.episode_count = 0
        self.total_reward = 0.0
        self.step_count = 0

        self.get_logger().info('RL Navigation Agent initialized')
        if not SB3_AVAILABLE:
            self.get_logger().warn('stable-baselines3 not available. Install with: pip install stable-baselines3[extra]')

    def _load_or_create_model(self):
        if self.model_path.exists():
            self.get_logger().info(f'Loading model from {self.model_path}')
            self.model = PPO.load(str(self.model_path), env=self.env)
            self.model_loaded = True
        else:
            self.get_logger().info('Creating new PPO model')
            self.model = PPO(
                'MlpPolicy',
                self.env,
                verbose=1,
                tensorboard_log=str(self.logs_dir),
                learning_rate=3e-4,
                n_steps=2048,
                batch_size=64,
                n_epochs=10,
                gamma=0.99,
                gae_lambda=0.95,
                clip_range=0.2,
                ent_coef=0.01
            )
            self.model_loaded = False

    # ========== ROS2 Callbacks ==========

    def _scan_callback(self, msg: LaserScan):
        self.latest_scan = list(msg.ranges)

    def _odom_callback(self, msg: Odometry):
        pos = msg.pose.pose.position
        orient = msg.pose.pose.orientation

        # Convert quaternion to yaw
        siny_cosp = 2.0 * (orient.w * orient.z + orient.x * orient.y)
        cosy_cosp = 1.0 - 2.0 * (orient.y * orient.y + orient.z * orient.z)
        yaw = math.atan2(siny_cosp, cosy_cosp)

        self.current_pose = (pos.x, pos.y, yaw)

    def _imu_callback(self, msg: String):
        try:
            data = json.loads(msg.data)
            if data.get('type') == 134:
                self.latest_heading = math.radians(data['data'].get('yaw', 0.0))
        except (json.JSONDecodeError, KeyError):
            pass

    def _target_callback(self, msg: PoseStamped):
        self.target_waypoint = (msg.pose.position.x, msg.pose.position.y)

    def _collision_callback(self, msg: Bool):
        self.collision_detected = msg.data

    def _battery_callback(self, msg: Float32):
        self.latest_battery_soc = max(0.0, min(1.0, msg.data))

    # ========== Control Loop ==========

    def _control_loop(self):
        if not SB3_AVAILABLE or self.model is None or self.target_waypoint is None:
            return

        if self.training_mode:
            return  # Training handles its own loop

        # Get observation and predict action
        obs, _ = self.env.reset() if self.step_count == 0 else (self.env._get_observation(), {})
        action, _states = self.model.predict(obs, deterministic=True)

        # Execute action
        self._execute_rl_action(action)

        # Publish diagnostics
        self._publish_diagnostics(action, obs)

        self.step_count += 1

    def _execute_rl_action(self, action: np.ndarray):
        # Scale action from [-1, 1] to physical velocities
        # vx, vy in m/s, omega in rad/s
        MAX_LINEAR_VEL = 0.5  # m/s
        MAX_ANGULAR_VEL = 1.0  # rad/s

        twist = Twist()
        twist.linear.x = float(action[0]) * MAX_LINEAR_VEL
        twist.linear.y = float(action[1]) * MAX_LINEAR_VEL
        twist.angular.z = float(action[2]) * MAX_ANGULAR_VEL

        self.cmd_vel_pub.publish(twist)

    def _publish_diagnostics(self, action: np.ndarray, obs: np.ndarray):
        diag = {
            'timestamp': self.get_clock().now().to_msg().sec,
            'training_mode': self.training_mode,
            'model_loaded': self.model_loaded,
            'episode': self.episode_count,
            'step': self.step_count,
            'action': action.tolist(),
            'observation_dims': len(obs),
            'target_distance': float(obs[74]) if len(obs) > 74 else None,
            'collision': self.collision_detected,
            'battery_soc': self.latest_battery_soc
        }

        msg = String()
        msg.data = json.dumps(diag)
        self.diagnostics_pub.publish(msg)

    # ========== Service Callbacks ==========

    def _train_callback(self, request: Trigger.Request, response: Trigger.Response):
        if not SB3_AVAILABLE:
            response.success = False
            response.message = 'stable-baselines3 not available'
            return response

        if self.training_mode:
            response.success = False
            response.message = 'Training already in progress'
            return response

        self.training_mode = True
        self.get_logger().info('Starting RL training (10k episodes)')

        try:
            # Checkpoint callback: save every 1000 steps
            checkpoint_callback = CheckpointCallback(
                save_freq=1000,
                save_path=str(self.models_dir),
                name_prefix='rl_nav_ppo'
            )

            # Train for 10k episodes (~2M steps with 2048 steps/episode)
            total_timesteps = 2_000_000
            self.model.learn(
                total_timesteps=total_timesteps,
                callback=checkpoint_callback,
                log_interval=10,
                tb_log_name='ppo_nav'
            )

            # Save final model
            self.model.save(str(self.model_path))
            self.get_logger().info(f'Training complete. Model saved to {self.model_path}')

            response.success = True
            response.message = f'Trained {total_timesteps} steps'

        except Exception as e:
            self.get_logger().error(f'Training failed: {e}')
            response.success = False
            response.message = str(e)

        finally:
            self.training_mode = False

        return response

    def _load_model_callback(self, request: Trigger.Request, response: Trigger.Response):
        if not SB3_AVAILABLE:
            response.success = False
            response.message = 'stable-baselines3 not available'
            return response

        try:
            if not self.model_path.exists():
                response.success = False
                response.message = f'Model not found at {self.model_path}'
                return response

            self.model = PPO.load(str(self.model_path), env=self.env)
            self.model_loaded = True
            self.step_count = 0

            self.get_logger().info(f'Model reloaded from {self.model_path}')
            response.success = True
            response.message = 'Model loaded successfully'

        except Exception as e:
            self.get_logger().error(f'Model load failed: {e}')
            response.success = False
            response.message = str(e)

        return response


def main(args=None):
    rclpy.init(args=args)
    node = RLNavigationAgent()

    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()

