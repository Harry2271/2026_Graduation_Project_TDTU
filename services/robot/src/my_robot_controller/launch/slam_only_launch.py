"""SLAM-only launch - starts slam_toolbox for online SLAM.

The odom -> base_footprint transform is now provided by the odom_node
(encoder + IMU fusion), not by a static identity. slam_toolbox publishes
map -> odom which corrects for wheel-encoder drift.
"""
import os
from launch import LaunchDescription
from launch.actions import IncludeLaunchDescription, SetEnvironmentVariable
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch_ros.actions import Node
from launch_ros.substitutions import FindPackageShare


def generate_launch_description():
    slam_toolbox_pkg = FindPackageShare('slam_toolbox').find('slam_toolbox')
    slam_params_file = os.path.join(
        FindPackageShare('my_robot_controller').find('my_robot_controller'),
        'config', 'slam_params.yaml')
    robot_desc = os.path.join(
        FindPackageShare('my_robot_controller').find('my_robot_controller'),
        'urdf', 'agv.urdf.xacro')

    return LaunchDescription([
        SetEnvironmentVariable('ROS_DOMAIN_ID', '0'),

        # Robot description (URDF) -> robot_state_publisher
        # Publishes TF for all the static links in the URDF, including
        # base_link -> laser (LiDAR) and base_link -> base_imu (BNO055).
        Node(
            package='robot_state_publisher',
            executable='robot_state_publisher',
            name='robot_state_publisher',
            parameters=[{
                'robot_description': open(robot_desc).read(),
                'use_sim_time': False,
            }],
        ),

        IncludeLaunchDescription(
            PythonLaunchDescriptionSource(
                os.path.join(slam_toolbox_pkg, 'launch', 'online_async_launch.py')),
            launch_arguments={'slam_params_file': slam_params_file}.items()),
    ])