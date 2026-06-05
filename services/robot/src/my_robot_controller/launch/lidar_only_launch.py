"""Lidar-only launch.

Wraps Slamtec's `rplidar_ros` driver (from the `ros2` branch), which is built
from source into the colcon workspace at deploy time (no apt package is
available on the Pi's Jazzy repos). The driver supports the Slamtec RPLidar
A1M8 out of the box; the wrapper just `IncludeLaunchDescription`s its
`rplidar_a1_launch.py`.
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
        description='Serial baud rate (A1M8 standard: 115200)')

    serial_port = LaunchConfiguration('serial_port')
    serial_baudrate = LaunchConfiguration('serial_baudrate')

    rplidar_share = FindPackageShare('rplidar_ros').find('rplidar_ros')
    rplidar_launch = f'{rplidar_share}/launch/rplidar_a1_launch.py'

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
