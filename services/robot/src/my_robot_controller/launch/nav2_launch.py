"""Nav2 bringup — map_server, AMCL, planner, controller, BT navigator, recoveries.

Launched as: ros2 launch my_robot_controller nav2_launch.py
Managed by PM2 as nexus-robot-nav2.

Expects saved map at ~/robot_ws/maps/latest.yaml (set via MAP_YAML env var or default).
"""

import os
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, LogInfo, OpaqueFunction
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node
from launch_ros.substitutions import FindPackageShare


def generate_launch_description() -> LaunchDescription:
    # Arguments
    map_yaml_arg = DeclareLaunchArgument(
        "map_yaml",
        default_value=os.path.expanduser("~/robot_ws/maps/latest.yaml"),
        description="Path to the saved map YAML file",
    )
    use_sim_time_arg = DeclareLaunchArgument(
        "use_sim_time", default_value="false", description="Use simulation time"
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
        use_sim_time = LaunchConfiguration("use_sim_time").perform(context)
        params_file = LaunchConfiguration("params_file").perform(context)

        return [
            Node(
                package="nav2_map_server",
                executable="map_server",
                name="map_server",
                output="screen",
                parameters=[{"use_sim_time": use_sim_time, "yaml_filename": map_yaml}],
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
                package="nav2_recoveries",
                executable="recoveries_server",
                name="recoveries_server",
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
                package="nav2_lifecycle_manager",
                executable="lifecycle_manager",
                name="lifecycle_manager",
                output="screen",
                parameters=[
                    {
                        "use_sim_time": use_sim_time,
                        "autostart": True,
                        "node_names": [
                            "map_server",
                            "amcl",
                            "planner_server",
                            "controller_server",
                            "recoveries_server",
                            "bt_navigator",
                        ],
                    }
                ],
            ),
        ]

    return LaunchDescription(
        [
            map_yaml_arg,
            use_sim_time_arg,
            params_file_arg,
            OpaqueFunction(function=check_map),
            OpaqueFunction(function=launch_nodes),
        ]
    )
