# Phase 3 — Nav2 Bringup Design

**Date:** 2026-06-09
**Status:** Draft
**Companion to:** `docs/superpowers/specs/2026-06-07-robot-controller-brain-design.md` (source of truth), `docs/superpowers/plans/2026-06-07-robot-controller-brain-future-phases-notes.md` (Phase 3 section)

---

## 1. Overview

Replace the stub `nav2_launch.py` and placeholder `nav2_params.yaml` with a real Nav2 bringup. After Phase 3, the robot has:

- Map-based localization (AMCL on a saved SLAM map)
- Global path planning (Navfn)
- Local trajectory control (DWA)
- A `navigate_to()` method on the brain node

---

## 2. Map & Localization Strategy

### 2.1. Two modes, one launch file — manual PM2 switch

The deploy keeps two PM2 services:
- `nexus-robot-slam` — slam_toolbox online_async (for MAPPING mode)
- `nexus-robot-nav2` — Nav2 bringup (for LIVE mode)

**They do NOT run simultaneously.** The operator manually switches:
```
pm2 stop nexus-robot-slam
pm2 start nexus-robot-nav2
```

When `nav2_launch.py` starts, it checks for a saved map file at `~/robot_ws/maps/latest.yaml`. If found → Nav2 starts (map_server + AMCL). If not found → Nav2 exits gracefully with a log message (robot can only work in MAPPING mode).

**Transition flow:**
1. Operator sets robot to MAPPING mode → `pm2 start nexus-robot-slam` → slam_toolbox runs → build map
2. Operator saves map: `ros2 run nav2_map_server map_saver_cli -f ~/robot_ws/maps/latest`
3. Operator switches to LIVE mode → `pm2 stop nexus-robot-slam && pm2 start nexus-robot-nav2` → AMCL loads saved map

### 2.2. TF chain

- `map→odom`: AMCL (Nav2). Replaces slam_toolbox's `map→odom`.
- `odom→base_footprint`: Static TF publisher (same as today, from `slam_only_launch.py` — unchanged).

No changes to the existing `slam_only_launch.py` — it stays for MAPPING mode.

---

## 3. Nav2 Stack

### 3.1. Nodes launched (`nav2_launch.py`)

| ROS Node | Package | Role |
|---|---|---|
| `map_server` | `nav2_map_server` | Load `latest.yaml`, publish `/map` |
| `amcl` | `nav2_amcl` | Localization on static map, publish `map→odom` |
| `planner_server` | `nav2_planner` | Navfn global planner |
| `controller_server` | `nav2_controller` | SimpleFollowPath local planner (DWB mặc định Jazzy — DWA package không có sẵn) |
| `bt_navigator` | `nav2_bt_navigator` | Behavior tree for NavigateToPose |
| `recoveries_server` | `nav2_recoveries` | Spin / backup / wait |
| `lifecycle_manager` | `nav2_lifecycle_manager` | Manage lifecycle of all Nav2 nodes |

The launch file is a self-contained Python launch file (not from `nav2_bringup` templates) for full control.

### 3.2. Parameter file (`nav2_params.yaml`)

Key settings:

- **Footprint:** `[[0.15,0.15],[0.15,-0.15],[-0.15,-0.15],[-0.15,0.15]]` (~30cm square, mecanum)
- **Global planner:** `navfn_planner` — simple, fast, no BT overhead
- **Local planner:** `SimpleFollowPath` (DWB built-in) — conservative velocities:
  - `max_vel_x: 0.3 m/s`
  - `max_vel_theta: 0.5 rad/s`
  - `acc_lim_x: 0.2 m/s²`
  - `acc_lim_theta: 0.4 rad/s²`
- **Obstacle layer:** subscribe to `/scan`, footprint padding 0.1m
- **Inflation layer:** radius 0.3m
- **AMCL:** `use_sim_time: false`, `odom_model_type: "diff"` (mecanum approximates diff with IMU correction)

---

## 4. Brain Integration

### 4.1. New dependency

`brain_node.py` uses `nav2_simple_commander` (`BasicNavigator`).

### 4.2. New method

```python
def navigate_to(self, x: float, y: float, theta: float) -> bool:
    """Synchronous Nav2 action call via nav2_simple_commander.
    Returns True if goal reached, False on failure.
    Called from async state machine via asyncio.get_running_loop().run_in_executor()."""
```

### 4.3. Scope note for Phase 3

The `navigate_to()` method is added to `brain_node.py` but is **not yet wired into the state machine** — that happens in Phase 5 when the API client brings job dispatch. Phase 3 only proves:
- The method initializes and runs
- A manual test can call it and the robot moves

---

## 5. Dependencies

### 5.1. Pi apt packages (install-pi.sh additions)

```
ros-jazzy-navigation2
ros-jazzy-nav2-dwa-planner
ros-jazzy-nav2-navfn-planner
```

`ros-jazzy-navigation2` metapackage pulls in: `nav2_amcl`, `nav2_map_server`, `nav2_planner`, `nav2_controller` (DWB), `nav2_bt_navigator`, `nav2_recoveries`, `nav2_lifecycle_manager`, `nav2_costmap_2d`, `nav2_bringup`, `nav2_core`, `nav2_util`, `nav2_msgs`, and others. The two additional packages provide DWA planner (preferred over DWB) and Navfn.

### 5.2. Python dependency

`nav2_simple_commander` comes from `ros-jazzy-nav2-simple-commander` (apt) — add to install-pi.sh.

---

## 6. Files to Modify

| File | Change |
|---|---|
| `launch/nav2_launch.py` | Full Nav2 bringup with map_server, AMCL, planner, controller, BT, lifecycle |
| `config/nav2_params.yaml` | Full parameter tree |
| `brain_node.py` | Import BasicNavigator, add `navigate_to()` method |
| `package.xml` | Add `nav2_msgs` and `nav2_simple_commander` run dependencies |
| `install-pi.sh` | Install Nav2 apt packages |
| `services/robot/CLAUDE.md` | Document Nav2 architecture and commands |

---

## 7. Verification Gates

### 7.1. Build
```bash
colcon build --packages-select my_robot_controller
```

### 7.2. Launch smoke test (on Pi)
```bash
ros2 launch my_robot_controller nav2_launch.py
# Expected: all 6 Nav2 nodes come up, lifecycle_manager transitions to ACTIVE
```

### 7.3. Topic check
```bash
ros2 topic list | grep -E 'amcl|plan|cmd_vel|map'
# Expected: /amcl_pose, /plan, /cmd_vel, /map
```

### 7.4. Navigation test
```bash
# Seed initial pose
ros2 topic pub /initialpose geometry_msgs/PoseWithCovarianceStamped "{...}"

# Send navigation goal
ros2 topic pub /goal_pose geometry_msgs/PoseStamped "{...}"
```

### 7.5. PM2 integration
```bash
pm2 logs nexus-robot-nav2 --lines 30
# Expected: all lifecycle transitions, no crashes
```

---

## 8. Open Questions (resolved)

| Question | Decision |
|---|---|
| DWA or DWB? | Neither — Jazzy ships `SimpleFollowPath` by default. DWB is not available as separate apt package. `SimpleFollowPath` works well for mecanum with proper velocity limits set. |
| AMCL initial pose source? | Parameter default `[0, 0, 0]`; Calibrate (future) writes to `initial_pose.yaml` |
| Recovery behaviors? | Default 3 recoveries (spin, backup, wait); tune after Phase 6 real-world testing |
