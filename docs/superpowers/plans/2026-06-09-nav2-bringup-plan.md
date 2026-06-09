# Phase 3 — Nav2 Bringup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Nav2 stub with a real bringup: map_server, AMCL, global planner (Navfn), local planner (DWA), bt_navigator, recoveries, lifecycle_manager — plus `navigate_to()` in brain_node.

**Architecture:** Two PM2 modes (MAPPING = slam_toolbox, LIVE = Nav2). Operator switches manually. Nav2 launch file self-contained (not using nav2_bringup templates) for full param control.

**Tech Stack:** ROS 2 Jazzy, nav2_amcl, nav2_map_server, nav2_planner, nav2_controller (DWA), nav2_simple_commander.

**Spec:** `docs/superpowers/specs/2026-06-09-nav2-bringup-design.md`

---

### Task 1: install-pi.sh — Nav2 packages

**Files:**
- Modify: `services/robot/install-pi.sh`
- Test: Pi apt install

- [ ] **Step 1: Add Nav2 packages to install-pi.sh**

```bash
# --- Nav2 packages ---
$SUDO apt install -y \
  ros-jazzy-navigation2 \
  ros-jazzy-nav2-dwa-planner \
  ros-jazzy-nav2-navfn-planner \
  ros-jazzy-nav2-simple-commander
```

Find the existing `$SUDO apt install -y` block in `install-pi.sh` and add these 4 lines at the bottom of it.

- [ ] **Step 2: Commit**

```bash
git add services/robot/install-pi.sh
git commit -m "feat(robot): add Nav2 apt packages to install-pi.sh"
```

---

### Task 2: config/nav2_params.yaml — Full Nav2 parameter tree

**Files:**
- Modify: `services/robot/src/my_robot_controller/config/nav2_params.yaml`

- [ ] **Step 1: Replace placeholder with full Nav2 params**

File: `config/nav2_params.yaml`

Replace the existing stub (which only has `amcl.ros__parameters.use_sim_time: false`) with:

```yaml
amcl:
  ros__parameters:
    use_sim_time: false
    alpha1: 0.2
    alpha2: 0.2
    alpha3: 0.2
    alpha4: 0.2
    alpha5: 0.2
    base_frame_id: base_footprint
    beam_skip_distance: 0.5
    beam_skip_error_threshold: 0.9
    beam_skip_threshold: 0.3
    do_beamskip: false
    global_frame_id: map
    lambda_short: 0.1
    laser_likelihood_max_dist: 2.0
    laser_max_range: 12.0
    laser_min_range: 0.2
    laser_model_type: likelihood_field
    max_beams: 60
    max_particles: 2000
    min_particles: 500
    odom_frame_id: odom
    pf_err: 0.05
    pf_z: 0.99
    recovery_alpha_fast: 0.0
    recovery_alpha_slow: 0.0
    resample_interval: 1
    robot_model_type: nav2_amcl::DifferentialMotionModel
    save_pose_rate: 0.5
    sigma_hit: 0.2
    tf_broadcast: true
    transform_tolerance: 1.0
    update_min_a: 0.2
    update_min_d: 0.25
    z_hit: 0.5
    z_max: 0.05
    z_rand: 0.5
    z_short: 0.05
    set_initial_pose: true
    initial_pose:
      x: 0.0
      y: 0.0
      yaw: 0.0
    first_map_only: false

map_server:
  ros__parameters:
    use_sim_time: false
    yaml_filename: "latest.yaml"

# Global costmap (Navfn)
global_costmap:
  global_costmap:
    ros__parameters:
      use_sim_time: false
      robot_base_frame: base_footprint
      global_frame: map
      footprint: [[0.15,0.15],[0.15,-0.15],[-0.15,-0.15],[-0.15,0.15]]
      footprint_padding: 0.1
      plugins: ["static_layer", "obstacle_layer", "inflation_layer"]
      static_layer:
        plugin: "nav2_costmap_2d::StaticLayer"
        map_subscribe_transient_local: true
      obstacle_layer:
        plugin: "nav2_costmap_2d::ObstacleLayer"
        enabled: true
        observation_sources: scan
        scan:
          topic: /scan
          max_obstacle_height: 1.0
          clearing: true
          marking: true
          data_type: "LaserScan"
          raytrace_max_range: 3.0
          raytrace_min_range: 0.2
          obstacle_max_range: 2.5
          obstacle_min_range: 0.2
      inflation_layer:
        plugin: "nav2_costmap_2d::InflationLayer"
        cost_scaling_factor: 3.0
        inflation_radius: 0.3
      track_unknown_space: true

# Local costmap (DWA)
local_costmap:
  local_costmap:
    ros__parameters:
      use_sim_time: false
      robot_base_frame: base_footprint
      global_frame: odom
      footprint: [[0.15,0.15],[0.15,-0.15],[-0.15,-0.15],[-0.15,0.15]]
      footprint_padding: 0.1
      width: 3.0
      height: 3.0
      resolution: 0.05
      plugins: ["voxel_layer", "inflation_layer"]
      voxel_layer:
        plugin: "nav2_costmap_2d::VoxelLayer"
        enabled: true
        observation_sources: scan
        scan:
          topic: /scan
          max_obstacle_height: 1.0
          clearing: true
          marking: true
          data_type: "LaserScan"
          raytrace_max_range: 3.0
          raytrace_min_range: 0.2
          obstacle_max_range: 2.5
          obstacle_min_range: 0.2
        publish_voxel_map: false
        origin_z: 0.0
        z_resolution: 0.05
        z_voxels: 16
        unknown_threshold: 15
        mark_threshold: 0
      inflation_layer:
        plugin: "nav2_costmap_2d::InflationLayer"
        cost_scaling_factor: 3.0
        inflation_radius: 0.3
      track_unknown_space: true

# Navfn global planner
planner_server:
  ros__parameters:
    use_sim_time: false
    planner_plugins: ["GridBased"]
    GridBased:
      plugin: "nav2_navfn_planner::NavfnPlanner"
      tolerance: 0.5
      use_astar: false
      allow_unknown: true

# DWA local planner
controller_server:
  ros__parameters:
    use_sim_time: false
    controller_plugins: ["FollowPath"]
    FollowPath:
      plugin: "dwa_local_planner::DWAPlanner"
      min_vel_x: -0.1
      max_vel_x: 0.3
      min_vel_y: -0.1
      max_vel_y: 0.15
      max_vel_theta: 0.5
      min_speed_xy: 0.05
      max_speed_xy: 0.35
      min_speed_theta: 0.1
      acc_lim_x: 0.2
      acc_lim_y: 0.15
      acc_lim_theta: 0.4
      decel_lim_x: -0.3
      decel_lim_y: -0.2
      decel_lim_theta: -0.6
      vx_samples: 10
      vy_samples: 5
      vtheta_samples: 20
      sim_time: 1.5
      sim_granularity: 0.025
      angular_sim_granularity: 0.025
      path_distance_bias: 32.0
      goal_distance_bias: 24.0
      occdist_scale: 0.02
      forward_point_distance: 0.1
      oscillation_reset_dist: 0.05
      escape_vel: -0.1
      holonomic_robot: true
      max_vel_trans: 0.35
      max_vel_rot: 0.5

# Behavior tree navigator
bt_navigator:
  ros__parameters:
    use_sim_time: false
    bt_xml_filename: "navigate_w_recovery_and_replanning_only_if_path_becomes_invalid.xml"
    autostart: true
    plugin_lib_names:
      - nav2_compute_path_to_pose_action_bt_node
      - nav2_follow_path_action_bt_node
      - nav2_back_up_action_bt_node
      - nav2_spin_action_bt_node
      - nav2_wait_action_bt_node
      - nav2_clear_costmap_service_bt_node
      - nav2_is_stuck_condition_bt_node
      - nav2_goal_reached_condition_bt_node
      - nav2_goal_updated_condition_bt_node
      - nav2_initial_pose_received_condition_bt_node
      - nav2_reinitialize_global_localization_service_bt_node
      - nav2_rate_controller_bt_node
      - nav2_distance_controller_bt_node
      - nav2_speed_controller_bt_node
      - nav2_truncate_path_action_bt_node
      - nav2_goal_updated_controller_bt_node
      - nav2_recovery_node_bt_node
      - nav2_pipeline_sequence_bt_node
      - nav2_round_robin_node_bt_node
      - nav2_transform_available_condition_bt_node
      - nav2_time_expired_condition_bt_node
      - nav2_distance_traveled_condition_bt_node
      - nav2_single_trigger_bt_node
      - nav2_is_battery_low_condition_bt_node
      - nav2_navigate_through_poses_action_bt_node
      - nav2_navigate_to_pose_action_bt_node
      - nav2_remove_passed_goals_action_bt_node
      - nav2_planner_selector_bt_node
      - nav2_controller_selector_bt_node
      - nav2_goal_checker_bt_node
      - nav2_controller_cancel_bt_node
      - nav2_path_longer_on_approach_bt_node
      - nav2_wait_cancel_bt_node
      - nav2_spin_cancel_bt_node
      - nav2_back_up_cancel_bt_node

# Recovery behaviors
recoveries_server:
  ros__parameters:
    use_sim_time: false
    recovery_plugins: ["spin", "backup", "wait"]
    spin:
      plugin: "nav2_recoveries::Spin"
      simulate_ahead_time: 2.0
      max_rotational_vel: 0.5
      min_rotational_vel: 0.1
      rotational_acc_lim: 0.4
    backup:
      plugin: "nav2_recoveries::BackUp"
      simulate_ahead_time: 2.0
      max_vel_y: 0.0
      min_vel_y: 0.0
      max_vel_x: -0.1
      min_vel_x: -0.05
      acc_lim_x: -0.2
      decel_lim_x: -0.2
      backup_vel_lim: -0.1
    wait:
      plugin: "nav2_recoveries::Wait"

# Lifecycle manager
lifecycle_manager:
  ros__parameters:
    use_sim_time: false
    autostart: true
    node_names:
      - map_server
      - amcl
      - planner_server
      - controller_server
      - recoveries_server
      - bt_navigator
    bond_timeout: 4.0
    attempt_start_late: true
```

- [ ] **Step 2: Commit**

```bash
git add services/robot/src/my_robot_controller/config/nav2_params.yaml
git commit -m "feat(robot): full Nav2 parameter tree with DWA, Navfn, costmaps"
```

---

### Task 3: launch/nav2_launch.py — Full Nav2 bringup

**Files:**
- Modify: `services/robot/src/my_robot_controller/launch/nav2_launch.py`

- [ ] **Step 1: Replace stub with full Nav2 launch**

File: `launch/nav2_launch.py`

Replace the existing stub (`return LaunchDescription([])`) with:

```python
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
            # Map server — load saved map
            Node(
                package="nav2_map_server",
                executable="map_server",
                name="map_server",
                output="screen",
                parameters=[{"use_sim_time": use_sim_time, "yaml_filename": map_yaml}],
            ),
            # AMCL — localize on static map
            Node(
                package="nav2_amcl",
                executable="amcl",
                name="amcl",
                output="screen",
                parameters=[params_file],
            ),
            # Planner server (Navfn global planner)
            Node(
                package="nav2_planner",
                executable="planner_server",
                name="planner_server",
                output="screen",
                parameters=[params_file],
            ),
            # Controller server (DWA local planner)
            Node(
                package="nav2_controller",
                executable="controller_server",
                name="controller_server",
                output="screen",
                parameters=[params_file],
            ),
            # Recoveries server
            Node(
                package="nav2_recoveries",
                executable="recoveries_server",
                name="recoveries_server",
                output="screen",
                parameters=[params_file],
            ),
            # BT navigator — action server for NavigateToPose
            Node(
                package="nav2_bt_navigator",
                executable="bt_navigator",
                name="bt_navigator",
                output="screen",
                parameters=[params_file],
            ),
            # Lifecycle manager — bring all nodes up in order
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
```

- [ ] **Step 2: Commit**

```bash
git add services/robot/src/my_robot_controller/launch/nav2_launch.py
git commit -m "feat(robot): full Nav2 bringup launch file"
```

---

### Task 4: brain_node.py — Add navigate_to() method

**Files:**
- Modify: `services/robot/src/my_robot_controller/my_robot_controller/brain_node.py`
- Test: `services/robot/src/my_robot_controller/tests/test_brain_node.py` (new test)

- [ ] **Step 1: Read existing brain_node.py to find where to add**

Read `brain_node.py` to understand its structure (class name, import section, existing method patterns).

- [ ] **Step 2: Add BasicNavigator import and navigate_to method**

After the last existing import, add:

```python
from nav2_simple_commander.nav2_to_pose import BasicNavigator
```

Inside the `BrainNode` class, add a new method (place near the end, before `main()` if that exists in the class, or as the last method):

```python
    def navigate_to(self, x: float, y: float, theta: float) -> bool:
        """Send a navigation goal to Nav2. Blocks until done.

        Args:
            x: X coordinate in the map frame (meters).
            y: Y coordinate in the map frame (meters).
            theta: Yaw angle (radians).

        Returns:
            True if the goal was reached, False on failure or cancellation.
        """
        try:
            navigator = BasicNavigator()
            navigator.waitUntilNav2Active()

            goal_pose = PoseStamped()
            goal_pose.header.frame_id = "map"
            goal_pose.header.stamp = navigator.get_clock().now().to_msg()
            goal_pose.pose.position.x = x
            goal_pose.pose.position.y = y
            goal_pose.pose.orientation.z = math.sin(theta / 2.0)
            goal_pose.pose.orientation.w = math.cos(theta / 2.0)

            navigator.goToPose(goal_pose)
            while not navigator.isGoalReached():
                time.sleep(0.1)

            return navigator.isGoalReached()
        except Exception as e:
            self.get_logger().error(f"navigate_to failed: {e}")
            return False
        finally:
            if navigator:
                navigator.lifecycleShutdown()
```

And add the imports at the top of the file:

```python
import math
import time
from geometry_msgs.msg import PoseStamped
```

- [ ] **Step 3: Write the test**

Test file: `tests/test_brain_node.py`

Add a new test at the end:

```python
def test_navigate_to_method_exists(brain_node):
    """Verify the brain node has a navigate_to method (actual Nav2 not available in test)."""
    assert hasattr(brain_node, "navigate_to")
    assert callable(brain_node.navigate_to)
```

- [ ] **Step 4: Run the test**

```bash
pytest services/robot/src/my_robot_controller/tests/test_brain_node.py::test_navigate_to_method_exists -v
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/robot/src/my_robot_controller/my_robot_controller/brain_node.py
git add services/robot/src/my_robot_controller/tests/test_brain_node.py
git commit -m "feat(robot): add navigate_to method to brain_node"
```

---

### Task 5: package.xml — Add Nav2 dependencies

**Files:**
- Modify: `services/robot/src/my_robot_controller/package.xml`

- [ ] **Step 1: Add run dependencies**

In the `<run_depend>` section of `package.xml`, add:

```xml
  <run_depend>nav2_msgs</run_depend>
  <run_depend>nav2_simple_commander</run_depend>
  <run_depend>nav2_amcl</run_depend>
  <run_depend>nav2_map_server</run_depend>
  <run_depend>nav2_planner</run_depend>
  <run_depend>nav2_controller</run_depend>
  <run_depend>nav2_bt_navigator</run_depend>
  <run_depend>nav2_recoveries</run_depend>
  <run_depend>nav2_lifecycle_manager</run_depend>
  <run_depend>nav2_costmap_2d</run_depend>
```

- [ ] **Step 2: Commit**

```bash
git add services/robot/src/my_robot_controller/package.xml
git commit -m "feat(robot): add Nav2 package run dependencies"
```

---

### Task 6: deploy.sh — Update PM2 environment for nav2

**Files:**
- Modify: `services/robot/deploy.sh`

- [ ] **Step 1: Ensure nav2 PM2 service is configured**

The deploy.sh already has a `nexus-robot-nav2` entry pointing to `ros2 launch my_robot_controller nav2_launch.py`. Verify it exists. If not, add it:

```
start_ros_node "${SERVICE_NAME_PREFIX}-nav2" "ros2 launch my_robot_controller nav2_launch.py"
```

- [ ] **Step 2: Commit**

```bash
git add services/robot/deploy.sh
git commit -m "feat(robot): ensure nav2 PM2 service in deploy"
```

---

### Task 7: services/robot/CLAUDE.md — Document Nav2 architecture

**Files:**
- Modify: `services/robot/CLAUDE.md`

- [ ] **Step 1: Add Nav2 section**

Add to `services/robot/CLAUDE.md` after the SLAM section:

```markdown
## Nav2 Bringup (Phase 3)

Two modes via PM2 — operator must **not** run both at the same time:

| Mode | PM2 service | What it does |
|---|---|---|
| MAPPING | `nexus-robot-slam` | slam_toolbox online_async — build/live-update map |
| LIVE | `nexus-robot-nav2` | map_server + AMCL + Navfn + DWA — localization + planning on saved map |

### Switching modes
```bash
pm2 stop nexus-robot-slam && pm2 start nexus-robot-nav2
```

### Save map (from MAPPING mode)
```bash
ros2 run nav2_map_server map_saver_cli -f ~/robot_ws/maps/latest
```

### Key nodes (LIVE mode)
- `map_server` — loads `~/robot_ws/maps/latest.yaml`
- `amcl` — publishes `map→odom`
- `planner_server` — Navfn global planner
- `controller_server` — DWA local planner (holonomic, mecanum)
- `bt_navigator` — NavigateToPose action server
- `recoveries_server` — spin / backup / wait
- `lifecycle_manager` — orchestrates startup

### Brain integration
`brain_node.navigate_to(x, y, theta)` uses `nav2_simple_commander`. Called from state machine via `run_in_executor()` (wired in Phase 5).

### Param file
`config/nav2_params.yaml` — footprint: ~30cm square (mecanum), max vel: 0.3 m/s linear / 0.5 rad/s angular. Conservative for arm stability.
```

- [ ] **Step 2: Commit**

```bash
git add services/robot/CLAUDE.md
git commit -m "docs(robot): document Nav2 architecture in CLAUDE.md"
```

---

## Verification

After all tasks, run these checks:

```bash
# Build
cd ~/robot_ws && colcon build --packages-select my_robot_controller

# Tests
pytest services/robot/src/my_robot_controller/tests/ -v

# Smoke test (on Pi, with saved map at ~/robot_ws/maps/latest.yaml)
ros2 launch my_robot_controller nav2_launch.py

# Topic check
ros2 topic list | grep -E 'amcl|plan|cmd_vel|map'
# Expected: /amcl_pose, /plan, /cmd_vel, /map

# PM2 integration
pm2 logs nexus-robot-nav2 --lines 20
```
