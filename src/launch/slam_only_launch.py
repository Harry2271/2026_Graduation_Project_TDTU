"""SLAM-only launch — starts slam_toolbox for online SLAM."""
import os
from launch import LaunchDescription
from launch.actions import IncludeLaunchDescription, SetEnvironmentVariable
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch_ros.substitutions import FindPackageShare


def generate_launch_description():
    slam_toolbox_pkg = FindPackageShare('slam_toolbox').find('slam_toolbox')
    slam_params_file = os.path.join(
        FindPackageShare('my_robot_controller').find('my_robot_controller'),
        '..', 'config', 'slam_params.yaml')

    return LaunchDescription([
        SetEnvironmentVariable('ROS_DOMAIN_ID', '0'),
        IncludeLaunchDescription(
            PythonLaunchDescriptionSource(
                os.path.join(slam_toolbox_pkg, 'launch', 'online_async_launch.py')),
            launch_arguments={'slam_params_file': slam_params_file}.items()),
    ])
