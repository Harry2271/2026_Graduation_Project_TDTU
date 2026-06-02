"""SLAM-only launch — starts slam_toolbox for online SLAM.

Includes a static odom→base_footprint transform so slam_toolbox can
start processing scans even without an odometry source. slam_toolbox
then publishes map→odom which corrects for drift.
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

    return LaunchDescription([
        SetEnvironmentVariable('ROS_DOMAIN_ID', '0'),

        # Static identity transform: odom → base_footprint
        # slam_toolbox requires this TF to exist before it can process scans.
        # slam_toolbox then publishes map→odom which provides the real pose.
        Node(
            package='tf2_ros',
            executable='static_transform_publisher',
            name='odom_to_base_footprint',
            arguments=['0', '0', '0', '0', '0', '0', 'odom', 'base_footprint'],
            parameters=[{'use_sim_time': False}],
        ),

        IncludeLaunchDescription(
            PythonLaunchDescriptionSource(
                os.path.join(slam_toolbox_pkg, 'launch', 'online_async_launch.py')),
            launch_arguments={'slam_params_file': slam_params_file}.items()),
    ])
