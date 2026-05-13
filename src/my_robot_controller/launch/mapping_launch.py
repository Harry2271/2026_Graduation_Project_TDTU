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

    # Include slam_toolbox online_async launch file
    slam_toolbox_launch = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(
            os.path.join(slam_toolbox_pkg_share, 'launch', 'online_async_launch.py')
        )
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
        sllidar_launch,
        slam_toolbox_launch,
        brain_node
    ])
