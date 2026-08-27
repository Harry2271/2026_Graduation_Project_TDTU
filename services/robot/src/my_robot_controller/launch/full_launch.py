"""full_launch.py — Unified launch file for the warehouse robot.

Starts all ROS 2 nodes in the correct order:
  1. LiDAR driver (must start before SLAM)
  2. SLAM / map_manager
  3. ESP32 telemetry bridge
  4. Camera stream (MJPEG)
  5. Brain node (state machine + AprilTag)
  6. Web bridge (WebSocket dashboard)

Usage:
  ros2 launch my_robot_controller full_launch.py
  ros2 launch my_robot_controller full_launch.py mode:=nav
  ros2 launch my_robot_controller full_launch.py use_sim_time:=true

Requires PM2 services to be stopped first:
  pm2 stop all
"""
from __future__ import annotations

import os

from launch import LaunchDescription
from launch.actions import (
    DeclareLaunchArgument,
    ExecuteProcess,
    GroupAction,
    IncludeLaunchDescription,
    LogInfo,
    RegisterEventHandler,
)
from launch.event_handlers import OnProcessExit, OnProcessStart
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration, PythonExpression
from launch_ros.actions import Node
from launch_ros.parameter_descriptions import ParameterValue
from launch.conditions import IfCondition

# ── Constants ──────────────────────────────────────────────────────────────────
ROBOT_PKG = 'my_robot_controller'
LAUNCH_DIR = os.path.dirname(__file__)
ROBOT_WS = os.path.expanduser('~/robot_ws')
URDF_FILE = os.path.join(os.path.dirname(LAUNCH_DIR), 'urdf', 'agv.urdf.xacro')
MAP_PATH = os.path.join(ROBOT_WS, 'maps', 'latest')
SLAM_CONFIG = os.path.join(ROBOT_WS, 'src', ROBOT_PKG, 'config', 'slam_params.yaml')
NAV2_CONFIG = os.path.join(ROBOT_WS, 'src', ROBOT_PKG, 'config', 'nav2_params.yaml')

# ── Launch arguments ───────────────────────────────────────────────────────────
def generate_launch_description():
    mode_arg = DeclareLaunchArgument(
        'mode',
        default_value='slam',
        description='Operating mode: slam (mapping) or nav (navigation)',
    )

    use_sim = DeclareLaunchArgument(
        'use_sim_time',
        default_value='false',
        description='Use simulation time',
    )

    mode = LaunchConfiguration('mode')

    # ── 1. LiDAR driver ────────────────────────────────────────────────────────
    lidar_node = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(
            os.path.join(LAUNCH_DIR, 'lidar_only_launch.py')
        ),
        launch_arguments={
            'serial_port': '/dev/robot-lidar',
            'serial_baudrate': '115200',
        }.items(),
    )

    # ── 2a. SLAM mode ──────────────────────────────────────────────────────────
    slam_node = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(
            os.path.join(LAUNCH_DIR, 'slam_only_launch.py')
        ),
        condition=IfCondition(PythonExpression(["'", mode, "' == 'slam'"])),
    )

    # ── 2b. Nav mode (Nav2) ────────────────────────────────────────────────────
    nav2_node = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(
            os.path.join(LAUNCH_DIR, 'nav2_launch.py')
        ),
        condition=IfCondition(PythonExpression(["'", mode, "' == 'nav'"])),
    )

    # ── 3. Map manager (relay + 5-state FSM) ───────────────────────────────────
    map_manager = Node(
        package=ROBOT_PKG,
        executable='map_manager',
        name='map_manager',
        output='screen',
        parameters=[{
            'use_sim_time': LaunchConfiguration('use_sim_time'),
        }],
    )

    # ── 4. Odometry node (encoder + IMU -> /odom + TF) ─────────────────────────
    odom_node = Node(
        package=ROBOT_PKG,
        executable='odom',
        name='odom',
        output='screen',
        parameters=[{
            'use_sim_time': LaunchConfiguration('use_sim_time'),
        }],
    )

    # ── 5. ESP32 telemetry bridge ──────────────────────────────────────────────
    esp32_telem = Node(
        package=ROBOT_PKG,
        executable='esp32_telemetry_node',
        name='esp32_telemetry',
        output='screen',
        parameters=[{
            'esp32_port': os.environ.get('ESP32_PORT', '/dev/robot-esp32'),
            'esp32_baud': int(os.environ.get('ESP32_BAUD', '115200')),
            'use_sim_time': LaunchConfiguration('use_sim_time'),
        }],
        emulate_tty=True,
    )

    # ── 5. Camera stream (MJPEG on port 9092) ──────────────────────────────────
    camera_stream = Node(
        package=ROBOT_PKG,
        executable='camera_stream',
        name='camera_stream',
        output='screen',
        parameters=[{
            'use_sim_time': LaunchConfiguration('use_sim_time'),
        }],
    )

    # ── 6. Brain node (state machine + AprilTag) ───────────────────────────────
    brain_node = Node(
        package=ROBOT_PKG,
        executable='brain',
        name='brain',
        output='screen',
        parameters=[{
            'use_sim_time': LaunchConfiguration('use_sim_time'),
        }],
        additional_env={
            'USE_REAL_BRIDGE': os.environ.get('USE_REAL_BRIDGE', '1'),
            'ESP32_PORT': os.environ.get('ESP32_PORT', '/dev/robot-esp32'),
            'APRILTAG_FAMILY': os.environ.get('APRILTAG_FAMILY', 'tag36h11'),
            'APRILTAG_SIZE_M': os.environ.get('APRILTAG_SIZE_M', '0.166'),
        },
    )

    # ── 7. AprilTag detector ───────────────────────────────────────────────────
    apriltag_node = Node(
        package=ROBOT_PKG,
        executable='april_tag_node',
        name='april_tag_node',
        output='screen',
        parameters=[{
            'use_sim_time': LaunchConfiguration('use_sim_time'),
        }],
        additional_env={
            'APRILTAG_FAMILY': os.environ.get('APRILTAG_FAMILY', 'tag36h11'),
            'APRILTAG_SIZE_M': os.environ.get('APRILTAG_SIZE_M', '0.166'),
            'CAMERA_DEVICE': os.environ.get('CAMERA_DEVICE', '/dev/video0'),
            'CAMERA_SNAPSHOT_URL': os.environ.get(
                'CAMERA_SNAPSHOT_URL', 'http://127.0.0.1:9092/snapshot'),
            'CAMERA_WIDTH': os.environ.get('CAMERA_WIDTH', '640'),
            'CAMERA_HEIGHT': os.environ.get('CAMERA_HEIGHT', '480'),
        },
    )

    # ── 8. Web bridge (WebSocket :9091) ────────────────────────────────────────
    web_bridge = Node(
        package=ROBOT_PKG,
        executable='web_bridge',
        name='web_bridge',
        output='screen',
        parameters=[{
            'use_sim_time': LaunchConfiguration('use_sim_time'),
        }],
        additional_env={
            'WS_AUTH_TOKEN': os.environ.get(
                'WS_AUTH_TOKEN', os.environ.get('ROBOT_BRAIN_TOKEN', '')),
        },
    )

    # ── Build launch description ────────────────────────────────────────────────
    # Start order matters: LiDAR first, then SLAM/Nav2, then brain last
    return LaunchDescription([
        mode_arg,
        use_sim,

        # Startup message
        LogInfo(msg=[
            '=====================================================\n',
            '  Warehouse Robot — Full System Launch\n',
            '  Mode: ', mode, '\n',
            '=====================================================',
        ]),

        # Phase 1: Sensors
        lidar_node,
        camera_stream,

        # Phase 2: SLAM or Nav2 (mutually exclusive, controlled by `mode`)
        slam_node,
        nav2_node,
        # Default = slam.  Switch to nav by passing mode:=nav:
        #   ros2 launch my_robot_controller full_launch.py mode:=nav
        # Map Manager and Brain adapt: brain_node only drives Nav2 in nav
        # mode; in slam mode it uses Auto-Explore to build the map.

        # Phase 3: Infrastructure
        odom_node,
        map_manager,
        esp32_telem,

        # Phase 4: Application layer
        brain_node,
        apriltag_node,
        web_bridge,
    ])
