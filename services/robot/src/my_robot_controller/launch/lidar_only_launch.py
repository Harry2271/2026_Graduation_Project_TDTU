"""Lidar-only launch — used by the hot-plug monitor in entrypoint.sh.

Wraps the apt-installed `ros-jazzy-rplidar-ros2` driver (which supports the
Slamtec RPLidar A1M8 out of the box). The driver lives in the system ROS 2
prefix at /opt/ros/jazzy, so the wrapper just `IncludeLaunchDescription`s
its `view_rplidar_a1_launch.py`.
"""
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, IncludeLaunchDescription, SetEnvironmentVariable
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration
from launch_ros.substitutions import FindPackageShare


def generate_launch_description():
    serial_port_arg = DeclareLaunchArgument(
        'serial_port', default_value='/dev/ttyUSB0',
        description='USB port for Slamtec RPLidar A1M8')
    serial_baudrate_arg = DeclareLaunchArgument(
        'serial_baudrate', default_value='115200',
        description='Serial baud rate (A1M8 standard: 115200; the Slamtec SDK '
                    'flashes 256000 via rplidar_ros2 param below if needed)')

    serial_port = LaunchConfiguration('serial_port')
    serial_baudrate = LaunchConfiguration('serial_baudrate')

    rplidar_share = FindPackageShare('rplidar_ros2').find('rplidar_ros2')
    rplidar_launch = f'{rplidar_share}/launch/view_rplidar_a1_launch.py'

    return LaunchDescription([
        SetEnvironmentVariable('ROS_DOMAIN_ID', '0'),
        serial_port_arg,
        serial_baudrate_arg,
        IncludeLaunchDescription(
            PythonLaunchDescriptionSource(rplidar_launch),
            launch_arguments={
                'serial_port': serial_port,
                'serial_baudrate': serial_baudrate,
                'frame_id': 'laser',
            }.items()),
    ])
