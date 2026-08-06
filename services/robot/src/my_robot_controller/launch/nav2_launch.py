"""Nav2 bringup — map_server, AMCL, planner, controller, BT navigator.

Launched as: ros2 launch my_robot_controller nav2_launch.py
Managed by PM2 as nexus-robot-nav2.

Expects saved map at ~/robot_ws/maps/latest.yaml (set via MAP_YAML env var or default).
"""

import os
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, LogInfo, OpaqueFunction
from launch.substitutions import Command, LaunchConfiguration
from launch_ros.actions import Node
from launch_ros.substitutions import FindPackageShare


def generate_launch_description() -> LaunchDescription:
    map_yaml_arg = DeclareLaunchArgument(
        "map_yaml",
        default_value=os.path.expanduser("~/robot_ws/maps/latest.yaml"),
        description="Path to the saved map YAML file",
    )
    params_file_arg = DeclareLaunchArgument(
        "params_file",
        default_value=os.path.join(
            FindPackageShare("my_robot_controller").find("my_robot_controller"),
            "config",
            "nav2_params.yaml",
        ),
        description="Full path to the Nav2 params YAML file",
    )
    urdf_path_arg = DeclareLaunchArgument(
        "urdf_file",
        default_value=os.path.join(
            FindPackageShare("my_robot_controller").find("my_robot_controller"),
            "urdf",
            "agv.urdf.xacro",
        ),
        description="Full path to the URDF/Xacro file",
    )

    def check_map(context) -> list:
        map_yaml = LaunchConfiguration("map_yaml").perform(context)
        if not os.path.isfile(map_yaml):
            return [
                LogInfo(
                    msg=(
                        f"[nav2_launch] Map file not found at {map_yaml}. "
                        "Skipping Nav2 bringup. Run slam_toolbox to build and save a map first."
                    )
                )
            ]
        return []

    def launch_nodes(context) -> list:
        map_yaml = LaunchConfiguration("map_yaml").perform(context)
        params_file = LaunchConfiguration("params_file").perform(context)
        urdf_file = LaunchConfiguration("urdf_file").perform(context)

        return [
            # Robot description -> static TF for laser + IMU frames.
            Node(
                package="robot_state_publisher",
                executable="robot_state_publisher",
                name="robot_state_publisher",
                output="screen",
                parameters=[{
                    "robot_description": Command(["xacro ", urdf_file]),
                    "use_sim_time": False,
                }],
            ),
            Node(
                package="nav2_map_server",
                executable="map_server",
                name="map_server",
                output="screen",
                parameters=[params_file, {"yaml_filename": map_yaml}],
            ),
            Node(
                package="nav2_amcl",
                executable="amcl",
                name="amcl",
                output="screen",
                parameters=[params_file],
            ),
            Node(
                package="nav2_planner",
                executable="planner_server",
                name="planner_server",
                output="screen",
                parameters=[params_file],
            ),
            Node(
                package="nav2_controller",
                executable="controller_server",
                name="controller_server",
                output="screen",
                parameters=[params_file],
            ),
            Node(
                package="nav2_bt_navigator",
                executable="bt_navigator",
                name="bt_navigator",
                output="screen",
                parameters=[params_file],
            ),
            Node(
                package="nav2_behaviors",
                executable="behavior_server",
                name="behavior_server",
                output="screen",
                parameters=[params_file],
            ),
            Node(
                package="nav2_lifecycle_manager",
                executable="lifecycle_manager",
                name="lifecycle_manager",
                output="screen",
                parameters=[params_file],
            ),
        ]

    return LaunchDescription(
        [
            map_yaml_arg,
            params_file_arg,
            urdf_path_arg,
            OpaqueFunction(function=check_map),
            OpaqueFunction(function=launch_nodes),
        ]
    )
