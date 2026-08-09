# On-Robot Tuning Checklist

> Run this AFTER deploying the latest code to the Pi 5.  
> **Do not skip steps.** Each item below is required for Nav2 navigation
> to work correctly in the warehouse.

---

## 1. Prerequisites

- [ ] `pm2 stop all` — no stale nodes running
- [ ] `ros2 topic list` shows `/scan`, `/tf`, `/esp32/*` topics
- [ ] LiDAR spinning: `ros2 topic hz /scan --window 20` → ≥8 Hz
- [ ] IMU flowing: `ros2 topic echo /esp32/imu --once` shows yaw
- [ ] Encoders flowing: `ros2 topic echo /esp32/encoder --once`
- [ ] ESP32 alive: `ros2 topic echo /esp32/alive --once`

---

## 2. Odometry Validation (Before Nav2)

Before running Nav2, confirm the odometry is correct.

### 2a. Forward drive test
- [ ] Place robot at a known point on a measured line (e.g. 1 m tape)
- [ ] Send forward PWM: `ros2 topic pub /esp32/cmd std_msgs/String '{"data":"{\"cmd\":\"move\",\"vx\":80,\"vy\":0,\"omega\":0}"}'`
- [ ] Wait 3 seconds then stop: `ros2 topic pub /esp32/cmd std_msgs/String '{"data":"{\"cmd\":\"stop\"}"}'`
- [ ] Check `/odom`: `ros2 topic echo /odom --once`
- [ ] **PASS:** reported distance ≈ 1.0 m (within 10%)
- [ ] **FAIL:** if distance is 2× too large → check `ENCODER_COUNTS_REV = 600` in `odom_node.py`

### 2b. Pure strafe test
- [ ] Strafe left for 2 seconds: `vx=0, vy=-80, omega=0`
- [ ] `/odom.twist.angular.z` should be ≈ 0 (less than 0.05 rad/s)
- [ ] If angular.z is large → check mecanum kinematics signs in `odom_node.py`

### 2c. Pure rotation test
- [ ] Rotate CW for 1 second: `vx=0, vy=0, omega=+80`
- [ ] `/odom.pose.pose.orientation` yaw should change by ~π/2 (±0.2 rad)
- [ ] Check rotation sign matches ROS convention (CCW positive in ROS, CW positive in firmware)

---

## 3. TF Tree Check

Nav2 requires the TF tree: `map → odom → base_footprint`

- [ ] `ros2 run tf2_ros tf2_echo map odom` — shows translation + rotation
- [ ] `ros2 run tf2_ros tf2_echo odom base_footprint` — shows translation + rotation
- [ ] `ros2 run tf2_ros tf2_echo map base_footprint` — shows the full transform
- [ ] No TF conflict: only ONE node should publish `odom → base_footprint`
  - `slam_only_launch.py` → odom_node does this
  - `nav2_launch.py` → odom_node does this  
  - brain_node must NOT publish TF directly

---

## 4. SLAM Tuning (mode:=slam)

Run: `ros2 launch my_robot_controller full_launch.py mode:=slam`

### 4a. Initial map quality
- [ ] Robot starts in IDLE state
- [ ] Send 'start' via web UI or: `ros2 topic pub /demo/cmd std_msgs/String '{"data":"START"}'`
- [ ] Push robot around the space for 2–3 minutes
- [ ] Check `/map` is published: `ros2 topic echo /map --once`
- [ ] Inspect map in web UI — walls should be sharp (not fuzzy)
- [ ] **If walls are fuzzy:** increase `minimum_travel_distance` in `slam_params.yaml`

### 4b. Save map
- [ ] `ros2 run nav2_map_server map_saver_cli -f ~/robot_ws/maps/latest`
- [ ] Verify file exists: `ls -la ~/robot_ws/maps/latest.yaml`
- [ ] `cat ~/robot_ws/maps/latest.yaml` shows `resolution: 0.05` and correct origin

---

## 5. Nav2 Tuning (mode:=nav)

Run: `ros2 launch my_robot_controller full_launch.py mode:=nav`

### 5a. AMCL localization
- [ ] Nav2 lifecycle manager starts all nodes automatically
- [ ] Check: `ros2 lifecycle get /amcl` → `active`
- [ ] Robot publishes `map → odom` TF via AMCL
- [ ] Check: `ros2 topic echo /particlecloud --once` shows particles
- [ ] Robot localises within 30 seconds of being pushed

### 5b. Navigate to a goal
- [ ] Use the web UI or:
```bash
ros2 action send_goal /navigate_to_pose nav2_msgs/action/NavigateToPose \
  "{pose: {header: {frame_id: 'map'}, pose: {position: {x: 1.0, y: 0.0}, orientation: {w: 1.0}}}}"
```
- [ ] Robot follows a global path (visible in web UI costmap)
- [ ] Robot reaches goal within 10 cm, 0.1 rad tolerance
- [ ] If robot oscillates → increase `acc_lim_x` in `nav2_params.yaml`

### 5c. Holonomic motion verification
- [ ] Navigate to a goal that requires strafe (e.g. goal with y offset)
- [ ] Robot uses mecanum strafe, not rotate-then-forward
- [ ] If robot always rotates to face goal first → check `max_vel_y` in `nav2_params.yaml` is > 0

### 5d. Obstacle response
- [ ] Place a box in the path, send a navigation goal
- [ ] Robot replans around the obstacle
- [ ] Robot does not touch the obstacle
- [ ] **If robot tries to go through obstacle:** check obstacle_layer in costmaps

---

## 6. Parameter Field-Tune Reference

All values below are marked `@field-tune` in `nav2_params.yaml`. They MUST
be validated and adjusted on the real robot. Use this table to record your
final values.

| Parameter | Current default | On-robot value | Notes |
|---|---|---|---|
| `amcl.alpha1` | 0.2 | | Motion noise from odometry |
| `amcl.alpha2` | 0.2 | | Rotation noise from odometry |
| `amcl.alpha3` | 0.2 | | Motion noise from odom measurement |
| `amcl.alpha4` | 0.2 | | Rotation noise from odom measurement |
| `amcl.alpha5` | 0.2 | | All-beacon measurement noise |
| `amcl.min_particles` | 500 | | Min particles (smaller warehouse → lower) |
| `amcl.max_particles` | 2000 | | Max particles (large warehouse → higher) |
| `robot_radius` | 0.22 m | | Half the widest point (chassis + arm) |
| `footprint` | ±0.20 m square | | Actual chassis footprint in metres |
| `global_costmap.inflation_radius` | 0.32 m | | Must match local |
| `local_costmap.inflation_radius` | 0.32 m | | Must match global |
| `cost_scaling_factor` | 4.0 | | ↑ softer gradient, ↓ sharper boundary |
| `local_costmap.width` | 4.0 m | | Must exceed max_vel × sensor_range |
| `local_costmap.height` | 4.0 m | | Same as width |
| `FollowPath.max_vel_x` | 0.30 m/s | | Max forward speed (firmware limit) |
| `FollowPath.max_vel_y` | 0.20 m/s | | Max strafe speed |
| `FollowPath.max_vel_theta` | 0.50 rad/s | | Max rotation speed |
| `FollowPath.acc_lim_x` | 0.20 m/s² | | ↑ faster accel, ↓ smoother start |
| `FollowPath.acc_lim_y` | 0.20 m/s² | | Same for strafe |
| `FollowPath.acc_lim_theta` | 0.40 rad/s² | | Same for rotation |
| `controller_frequency` | 12 Hz | | ↑ if Pi CPU headroom; ↓ if overloaded |
| `transform_tolerance` | 0.25 s | | ↑ if TF is lagging; ↓ for tighter tracking |

---

## 7. CPS Watchdog + E-stop Validation

These tests must be done on the real robot with serial connected.

### 7a. Bridge health watchdog
- [ ] `ros2 topic echo /esp32/bridge_health` → shows `HEALTHY`
- [ ] Unplug ESP32 USB for 3 seconds
- [ ] **PASS:** `/esp32/bridge_health` shows `STALE` within 2.5 seconds
- [ ] **PASS:** `ros2 topic echo /robot/errors` shows `ESP32_BRIDGE_STALE`
- [ ] **PASS:** robot is stopped (motors disabled)
- [ ] Re-plug ESP32 USB
- [ ] **PASS:** `/esp32/bridge_health` returns to `HEALTHY` within 5 seconds

### 7b. E-stop edge event
- [ ] From ESP32 serial console (or PIO monitor), press `K` (e-stop)
- [ ] **PASS:** `/esp32/e_stop` publishes a message within 0.5 seconds
- [ ] **PASS:** `brain_node` logs "ESP32 e-stop" and enters E_STOP
- [ ] **PASS:** robot is stopped (motors disabled)
- [ ] Verify brain does not send new motor commands while latched:
  - `ros2 topic echo /esp32/cmd` shows no `move` messages

### 7c. E-stop clear path
- [ ] From brain API: `brain.clear_safety_latch()` returns True
- [ ] **PASS:** brain transitions to IDLE
- [ ] **PASS:** new motor commands are accepted

---

## 8. Performance Baseline (Pi 5)

Capture these metrics during a 10-minute navigation session.

```bash
# Run on Pi before starting Nav2:
top -bn1 | grep -E '%Cpu|MiB'

# During Nav2 navigation, sample every 30 seconds for 5 minutes:
ros2 topic hz /scan --window 20          # ≥8 Hz
ros2 topic hz /odom --window 20          # ≥10 Hz
ros2 topic hz /esp32/imu --window 20     # ≥15 Hz
ros2 topic hz /tf --window 20            # ≥10 Hz
ros2 run tf2_ros tf2_echo map base_footprint  # latency < 0.1 s
```

| Metric | Minimum | Target | Actual |
|---|---|---|---|
| `/scan` Hz | 8 | 10 | |
| `/odom` Hz | 10 | 15 | |
| `/esp32/imu` Hz | 15 | 20 | |
| `/tf` Hz | 10 | 15 | |
| CPU load (all cores) | — | < 70% | |
| RAM usage | — | < 6 GB | |

If CPU exceeds 70%: reduce `controller_frequency` to 10 Hz.

---

## 9. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Robot spins in place | AMCL particles diverged, no TF lock | Re-localize: `ros2 service call /initialpose geometry_msgs/PoseWithCovarianceStamped` |
| Robot oscillates at goal | `acc_lim_x` too low, or `controller_frequency` too low | Increase `acc_lim_x` to 0.30 |
| Robot tries to rotate before strafe | `max_vel_y = 0` (holonomic disabled) | Set `max_vel_y: 0.20` |
| Nav2 won't start | `lifecycle_manager` can't find all nodes | Check `pm2 logs` — ensure SLAM is stopped (`pm2 stop nexus-robot-slam`) |
| STALE never fires | `alive` frames not flowing | Check `ros2 topic echo /esp32/alive --once` |
| E-stop not received | `/esp32/e_stop` not published | Check `esp32_telemetry_node` is running: `pm2 list` |

---

## 10. Final Sign-Off

Once all tests pass, record:

- **Date:** _______________
- **Pi hostname:** _______________
- **Firmware commit:** `git -C ~/robot_ws/src/firmware rev-parse HEAD`
- **ROS code commit:** `git -C ~/robot_ws/src/robot-for-nguyen rev-parse HEAD`
- **Nav2 params used:** `~/robot_ws/src/my_robot_controller/config/nav2_params.yaml`
- **Saved map:** `~/robot_ws/maps/latest.yaml`
- **Signed by:** _______________

---

> **Do NOT merge Nav2 tuning changes to `master` until this checklist is
> fully signed off.** All `@field-tune` values in `nav2_params.yaml` must
> have a corresponding entry in the table above before they are considered
> final.
