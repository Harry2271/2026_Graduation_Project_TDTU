"""Core launch — SLAM, Brain, QR, WebBridge. No lidar driver (started by hot-plug monitor)."""
import os
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, SetEnvironmentVariable
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node
from launch_ros.substitutions import FindPackageShare


def generate_launch_description():
    esp32_port_arg = DeclareLaunchArgument(
        'esp32_port', default_value='/dev/ttyUSB1',
        description='USB port for ESP32-S3 motor controller')
    camera_device_arg = DeclareLaunchArgument(
        'camera_device', default_value='0',
        description='Camera device index for QR detection (0=/dev/video0)')

    esp32_port    = LaunchConfiguration('esp32_port')
    camera_device = LaunchConfiguration('camera_device')

    my_robot_pkg = FindPackageShare('my_robot_controller').find('my_robot_controller')

    # SLAM Toolbox
    slam_toolbox_pkg = FindPackageShare('slam_toolbox').find('slam_toolbox')
    slam_params_file = os.path.join(my_robot_pkg, 'config', 'slam_params.yaml')
    slam_toolbox_launch = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(
            os.path.join(slam_toolbox_pkg, 'launch', 'online_async_launch.py')),
        launch_arguments={'slam_params_file': slam_params_file}.items())

    # Static TF Publishers
    base_link_to_laser_tf = Node(
        package='tf2_ros', executable='static_transform_publisher',
        name='base_link_to_laser',
        arguments=['0', '0', '0', '0', '0', '0',
                   'base_link', 'laser'])
    base_footprint_to_base_link_tf = Node(
        package='tf2_ros', executable='static_transform_publisher',
        name='base_footprint_to_base_link',
        arguments=['0', '0', '0', '0', '0', '0',
                   'base_footprint', 'base_link'])
    odom_to_base_footprint_tf = Node(
        package='tf2_ros', executable='static_transform_publisher',
        name='odom_to_base_footprint',
        arguments=['0', '0', '0', '0', '0', '0',
                   'odom', 'base_footprint'])

    # Brain Node
    brain_node = Node(
        package='my_robot_controller',
        executable='brain',
        name='brain_node',
        output='screen',
        parameters=[{'esp32_port': esp32_port}],
        env={'ESP32_PORT': esp32_port, 'ROS_DOMAIN_ID': '0'})

    # QR Detector Node
    qr_detector_node = Node(
        package='my_robot_controller',
        executable='qr_detector',
        name='qr_detector_node',
        output='screen',
        parameters=[{'camera_device': camera_device,
                     'camera_width': 640, 'camera_height': 480}],
        env={'CAMERA_DEVICE': camera_device, 'ROS_DOMAIN_ID': '0'})

    # Web Bridge Node (WebSocket JSON server on port 9091)
    web_bridge_node = Node(
        package='my_robot_controller',
        executable='web_bridge',
        name='web_bridge',
        output='screen',
        env={'ROS_DOMAIN_ID': '0'})

    return LaunchDescription([
        SetEnvironmentVariable('ROS_DOMAIN_ID', '0'),
        esp32_port_arg,
        camera_device_arg,
        slam_toolbox_launch,
        base_link_to_laser_tf,
        base_footprint_to_base_link_tf,
        odom_to_base_footprint_tf,
        brain_node,
        qr_detector_node,
        web_bridge_node,
    ])


