"""Lidar-only launch — used by the hot-plug monitor in entrypoint.sh."""
import os

from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, IncludeLaunchDescription, SetEnvironmentVariable
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration, PythonExpression
from launch_ros.actions import SetParameter
from launch_ros.substitutions import FindPackageShare


def generate_launch_description():
    serial_port_arg = DeclareLaunchArgument(
        'serial_port', default_value='/dev/ttyUSB0',
        description='USB port for Slamtec SLLidar')
    lidar_model_arg = DeclareLaunchArgument(
        'lidar_model', default_value='a1',
        description='Lidar model (a1, a2m8, a3, etc.)')

    serial_port = LaunchConfiguration('serial_port')
    lidar_model = LaunchConfiguration('lidar_model')

    sllidar_pkg = FindPackageShare('sllidar_ros2').find('sllidar_ros2')

    return LaunchDescription([
        SetEnvironmentVariable('ROS_DOMAIN_ID', '0'),
        serial_port_arg,
        lidar_model_arg,
        SetParameter(name='scan_frequency', value=12.0),
        SetParameter(name='scan_mode', value='Sensitivity'),
        IncludeLaunchDescription(
            PythonLaunchDescriptionSource(
                os.path.join(sllidar_pkg, 'launch',
                             PythonExpression(["'sllidar_' + '", lidar_model, "' + '_launch.py'"]))),
            launch_arguments={'serial_port': serial_port}.items()),
    ])
