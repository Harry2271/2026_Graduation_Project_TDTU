import os
from launch import LaunchDescription
from launch.actions import IncludeLaunchDescription, DeclareLaunchArgument
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration, PythonExpression
from launch_ros.actions import Node
from launch_ros.substitutions import FindPackageShare

def generate_launch_description():
    # Declare launch arguments
    serial_port_arg = DeclareLaunchArgument(
        'serial_port',
        default_value='/dev/ttyUSB0',
        description='Specifying usb port to connected lidar'
    )
    
    lidar_model_arg = DeclareLaunchArgument(
        'lidar_model',
        default_value='a1',
        description='Lidar model (a1, a2m8, a3, etc.)'
    )

    serial_port = LaunchConfiguration('serial_port')
    lidar_model = LaunchConfiguration('lidar_model')

    # Get the launch directories for included packages
    sllidar_pkg_share = FindPackageShare('sllidar_ros2').find('sllidar_ros2')
    slam_toolbox_pkg_share = FindPackageShare('slam_toolbox').find('slam_toolbox')

    # Sử dụng PathJoinSubstitution để nối đường dẫn an toàn và động trong ROS 2
    from launch.substitutions import PathJoinSubstitution
    from launch_ros.actions import SetParameter

    # Cấu hình tăng tốc độ quay động cơ Lidar (12 Hz thay vì chuẩn 10 Hz) và chế độ nhạy cao
    lidar_speed_param = SetParameter(name='scan_frequency', value=12.0)
    lidar_mode_param = SetParameter(name='scan_mode', value='Sensitivity')

    # Include sllidar launch file
    sllidar_launch = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(
            PathJoinSubstitution([
                sllidar_pkg_share,
                'launch',
                PythonExpression(["'sllidar_' + '", lidar_model, "' + '_launch.py'"])
            ])
        ),
        launch_arguments={'serial_port': serial_port}.items()
    )

    # Đường dẫn file cấu hình SLAM Toolbox tối ưu cho Pi 5
    my_robot_pkg_share = FindPackageShare('my_robot_controller').find('my_robot_controller')
    slam_params_file = os.path.join(my_robot_pkg_share, 'config', 'slam_params.yaml')

    # Include slam_toolbox online_async launch file với cấu hình custom
    slam_toolbox_launch = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(
            os.path.join(slam_toolbox_pkg_share, 'launch', 'online_async_launch.py')
        ),
        launch_arguments={'slam_params_file': slam_params_file}.items()
    )

    # Fake TF: base_link -> laser (Dùng tham số tường minh cho Jazzy)
    base_link_to_laser_tf = Node(
        package='tf2_ros',
        executable='static_transform_publisher',
        name='base_link_to_laser',
        arguments=['--x', '0', '--y', '0', '--z', '0', '--yaw', '0', '--pitch', '0', '--roll', '0', '--frame-id', 'base_link', '--child-frame-id', 'laser']
    )

    # Fake TF: base_footprint -> base_link
    base_footprint_to_base_link_tf = Node(
        package='tf2_ros',
        executable='static_transform_publisher',
        name='base_footprint_to_base_link',
        arguments=['--x', '0', '--y', '0', '--z', '0', '--yaw', '0', '--pitch', '0', '--roll', '0', '--frame-id', 'base_footprint', '--child-frame-id', 'base_link']
    )

    # Tự động tính toán Odometry động (Dynamic Odom) từ tia laser thay vì đứng yên
    laser_odometry_node = Node(
        package='rf2o_laser_odometry',
        executable='rf2o_laser_odometry_node',
        name='rf2o_laser_odometry',
        output='screen',
        parameters=[{
            'laser_scan_topic': '/scan',
            'odom_topic': '/odom',
            'publish_tf': True,
            'base_frame_id': 'base_footprint',
            'odom_frame_id': 'odom',
            'init_pose_from_topic': '',
            'freq': 12.0
        }]
    )

    # Brain node
    brain_node = Node(
        package='my_robot_controller',
        executable='brain',
        name='brain_node',
        output='screen'
    )

    return LaunchDescription([
        serial_port_arg,
        lidar_model_arg,
        lidar_speed_param,
        lidar_mode_param,
        base_link_to_laser_tf,
        base_footprint_to_base_link_tf,
        laser_odometry_node,
        sllidar_launch,
        slam_toolbox_launch,
        brain_node
    ])
