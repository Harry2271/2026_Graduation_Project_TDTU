import os
from launch import LaunchDescription
from launch.actions import IncludeLaunchDescription, DeclareLaunchArgument, SetEnvironmentVariable
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration, PythonExpression
from launch_ros.actions import Node
from launch_ros.substitutions import FindPackageShare


def generate_launch_description():
    # Launch arguments
    serial_port_arg = DeclareLaunchArgument(
        'serial_port',
        default_value='/dev/ttyUSB0',
        description='USB port for Slamtec SLLidar'
    )

    esp32_port_arg = DeclareLaunchArgument(
        'esp32_port',
        default_value='/dev/ttyUSB1',
        description='USB port for ESP32-S3 motor controller'
    )

    lidar_model_arg = DeclareLaunchArgument(
        'lidar_model',
        default_value='a1',
        description='Lidar model (a1, a2m8, a3, etc.)'
    )

    camera_device_arg = DeclareLaunchArgument(
        'camera_device',
        default_value='0',
        description='Camera device index for QR detection (0=/dev/video0)'
    )

    serial_port   = LaunchConfiguration('serial_port')
    esp32_port    = LaunchConfiguration('esp32_port')
    lidar_model   = LaunchConfiguration('lidar_model')
    camera_device = LaunchConfiguration('camera_device')

    # Package share path
    my_robot_pkg_share = FindPackageShare('my_robot_controller').find('my_robot_controller')

    # Slamtec SLLidar launch
    sllidar_pkg_share = FindPackageShare('sllidar_ros2').find('sllidar_ros2')
    sllidar_launch = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(
            os.path.join(sllidar_pkg_share, 'launch',
                         PythonExpression(["'sllidar_' + '", lidar_model, "' + '_launch.py'"])
                         )
        ),
        launch_arguments={'serial_port': serial_port}.items()
    )

    # SLAM Toolbox launch
    slam_toolbox_pkg_share = FindPackageShare('slam_toolbox').find('slam_toolbox')
    slam_params_file = os.path.join(my_robot_pkg_share, 'config', 'slam_params.yaml')
    slam_toolbox_launch = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(
            os.path.join(slam_toolbox_pkg_share, 'launch', 'online_async_launch.py')
        ),
        launch_arguments={'slam_params_file': slam_params_file}.items()
    )

    # ---- Lidar speed/mode params (override driver defaults) ----
    from launch.substitutions import PathJoinSubstitution
    from launch_ros.actions import SetParameter
    lidar_speed_param = SetParameter(name='scan_frequency', value=12.0)
    lidar_mode_param  = SetParameter(name='scan_mode',      value='Sensitivity')

    # ---- Static TF Publishers ----
    base_link_to_laser_tf = Node(
        package='tf2_ros', executable='static_transform_publisher',
        name='base_link_to_laser',
        arguments=['--x', '0', '--y', '0', '--z', '0',
                   '--yaw', '0', '--pitch', '0', '--roll', '0',
                   '--frame-id', 'base_link', '--child-frame-id', 'laser']
    )
    base_footprint_to_base_link_tf = Node(
        package='tf2_ros', executable='static_transform_publisher',
        name='base_footprint_to_base_link',
        arguments=['--x', '0', '--y', '0', '--z', '0',
                   '--yaw', '0', '--pitch', '0', '--roll', '0',
                   '--frame-id', 'base_footprint', '--child-frame-id', 'base_link']
    )
    odom_to_base_footprint_tf = Node(
        package='tf2_ros', executable='static_transform_publisher',
        name='odom_to_base_footprint',
        arguments=['--x', '0', '--y', '0', '--z', '0',
                   '--yaw', '0', '--pitch', '0', '--roll', '0',
                   '--frame-id', 'odom', '--child-frame-id', 'base_footprint']
    )

    # ---- Brain Node ----
    brain_node = Node(
        package='my_robot_controller',
        executable='brain',
        name='brain_node',
        output='screen',
        parameters=[{
            'esp32_port': esp32_port,
        }],
        env={
            'ESP32_PORT': esp32_port,
            'ROS_DOMAIN_ID': '0',
        }
    )

    # ---- QR Detector Node ----
    qr_detector_node = Node(
        package='my_robot_controller',
        executable='qr_detector',
        name='qr_detector_node',
        output='screen',
        parameters=[{
            'camera_device': camera_device,
            'camera_width': 640,
            'camera_height': 480,
        }],
        env={
            'CAMERA_DEVICE': camera_device,
            'ROS_DOMAIN_ID': '0',
        }
    )

    # ---- Web Bridge Node (WebSocket JSON server on port 8080) ----
    web_bridge_node = Node(
        package='my_robot_controller',
        executable='web_bridge',
        name='web_bridge',
        output='screen',
        env={
            'ROS_DOMAIN_ID': '0',
        }
    )

    return LaunchDescription([
        SetEnvironmentVariable('ROS_DOMAIN_ID', '0'),
        serial_port_arg,
        esp32_port_arg,
        lidar_model_arg,
        camera_device_arg,
        lidar_speed_param,
        lidar_mode_param,
        base_link_to_laser_tf,
        base_footprint_to_base_link_tf,
        odom_to_base_footprint_tf,
        sllidar_launch,
        slam_toolbox_launch,
        brain_node,
        qr_detector_node,
        web_bridge_node,
    ])
