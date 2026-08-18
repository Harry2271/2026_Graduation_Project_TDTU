# services/robot — ROS 2 Brain, Bridge & Telemetry (Pi 5)

> **Purpose:** This document describes the ROS 2 Python nodes running on the Raspberry Pi 5. They bridge the web dashboard (WebSocket), the NestJS API (Socket.io), the ESP32 motor controller (USB CDC serial), and the SLAM/navigation stack (Nav2 + slam_toolbox).

---

## ROS 2 Distro

**Jazzy Jalisco** (not Humble). All launch files source `/opt/ros/jazzy/setup.bash`.

---

## Architecture Overview

```
[Robot Hardware — Raspberry Pi 5 + Slamtec A1M8 Lidar]
   |
   +-- Lidar  -->  /scan  (LaserScan ~12 Hz)
   |
   v
[rplidar_ros2 driver]  <-- lidar_only_launch.py
   |
   +-- /scan  -->  [slam_toolbox]  -->  TF (map→odom→base_footprint)
   |                                    /map (OccupancyGrid)
   |
   +-- /scan  -->  [map_manager_node.py]  -->  /map_combined
   |                    (reads TF for pose)      /obstacle_layer
   |                    (reads /map from slam)
   |
   +-- /scan  -->  [web_bridge.py]  ws://0.0.0.0:9091
   |                    (reads TF for pose)
   |
   v
[Web App]
```

**ROS 2 nodes (managed by PM2 via deploy.sh):**
1. `rplidar_ros2` — RPLidar driver (apt package `ros-jazzy-rplidar-ros2`), publishes `/scan`
2. `slam_toolbox` (online_async) — scan-matching, TF, map building
3. `my_robot_controller/map_manager` — state machine, obstacle awareness zone
4. `my_robot_controller/esp32_telemetry_node` — opens `/dev/robot-esp32`, forwards ESP32 type-130/131/133/134/140/144/145 frames to ROS topics
5. `my_robot_controller/web_bridge` — WebSocket server on port 9091 (token auth required)
6. `my_robot_controller/brain_node` — high-level state machine (EXPLORE, MAPPING_DONE, IDLE, JOB_*, WAREHOUSE_*, E_STOP), drives ESP32 via `esp32_telemetry_node`
7. `my_robot_controller/odom_node` — odometry fusion (encoders + IMU) published on `/odom`
8. `my_robot_controller/teleop_node` — keyboard/remote teleop via `/cmd_vel`
                                                ↓
                                              Browser
```

---

## Five-State Map System

| State | What it does |
|---|---|
| `IDLE` | No mapping active. slam_toolbox running but not building map. |
| `MAPPING_IDLE` | 'start' received, slam_toolbox building map, waiting for robot to move. |
| `MAPPING_ACTIVE` | Robot moved, slam_toolbox recording. Map relayed to frontend. |
| `SCAN_OBSTACLE` | 'stop' received. Accumulates clean 360° scan; builds 2m awareness zone. |
| `LIVE` | Shows slam map + 2m dynamic obstacle overlay. Updates in real-time. |

---

## Nav2 Bringup (Phase 3)

Two modes via PM2 — operator must **not** run both at the same time:

| Mode | PM2 service | What it does |
|---|---|---|
| MAPPING | `nexus-robot-slam` | slam_toolbox online_async — build/live-update map |
| LIVE | `nexus-robot-nav2` | map_server + AMCL + Navfn + SimpleFollowPath — localization + planning on saved map |

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
- `controller_server` — SimpleFollowPath local planner (holonomic, mecanum)
- `bt_navigator` — NavigateToPose action server
- `recoveries_server` — spin / backup / wait
- `lifecycle_manager` — orchestrates startup

### Brain integration
`brain_node.navigate_to(x, y, theta)` uses `nav2_simple_commander`. Called from state machine via `run_in_executor()` (wired in Phase 5).

### Param file
`config/nav2_params.yaml` — footprint: ~30cm square (mecanum), max vel: 0.3 m/s linear / 0.5 rad/s angular. Conservative for arm stability.

---

## Running on the Pi

**First-time setup** (one-time on the Pi):
```bash
sudo ./install-pi.sh
```

**Deploy / restart all nodes:**
```bash
./deploy.sh
```

**Restart a single node:**
```bash
pm2 restart nexus-robot-lidar
pm2 restart nexus-robot-slam
pm2 restart nexus-robot-map-manager
pm2 restart nexus-robot-web-bridge
pm2 restart nexus-robot-esp32-telemetry
```

**Check node status:**
```bash
pm2 status
```

**View node logs:**
```bash
pm2 logs nexus-robot-web-bridge
pm2 logs nexus-robot-slam
pm2 logs nexus-robot-map-manager
```

**Verify ROS 2 topics:**
```bash
ros2 topic list
ros2 topic echo /map --once
ros2 run tf2_ros tf2_echo map base_footprint
```

---

## Connection

| Parameter | Value |
|---|---|
| Protocol | WebSocket (requires token) |
| Host | `<robot-ip>` |
| Port | `9091` |
| URL | `ws://<robot-ip>:9091?token=<token>` |
| Auth | `WS_AUTH_TOKEN` env var (falls back to `ROBOT_BRAIN_TOKEN`) |

**Authentication:** The WebSocket server requires a token. Provide it via one of:
1. Query string: `?token=<token>`
2. Header: `Authorization: Bearer <token>`
3. Subprotocol: `bearer, <token>`

Connections without a valid token are rejected with HTTP 401.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `API_SOCKET_URL` | `https://api.nguyen-robot.io.vn` | NestJS Socket.io URL used by `BrainApiClient` |
| `ROBOT_BRAIN_TOKEN` | none | Required shared secret for API `/robot` namespace auth |
| `WS_AUTH_TOKEN` | falls back to `ROBOT_BRAIN_TOKEN` | Required token for raw WebSocket clients on port 9091 |
| `ESP32_PORT` | `/dev/robot-esp32` | USB CDC serial device |
| `ESP32_BAUD` | `115200` | Serial baud (ignored for USB CDC) |
| `CAMERA_DEVICE` | `/dev/video0` | V4L2 camera device |
| `CAMERA_PORT` | `9092` | MJPEG camera HTTP port |
| `LIDAR_MODEL` | `a1` | RPLidar model selected by launch/deploy scripts |

Never commit any token or secret. The API and raw WebSocket bridges use constant-time token comparisons.

---

## Message Protocol

Every message is a JSON object with at minimum a `type` field.

### `scan` — Live Lidar Point Cloud (≤5 Hz, throttled)

Robot-centric. Robot at `(0, 0)`.

```json
{ "type": "scan", "data": { "points": [{ "x": 1.234, "y": 0.567 }], "count": 360 } }
```

### `map_layer` — Slam Map (≤5 Hz, gzip-compressed)

During MAPPING: slam_toolbox's raw `/map`. During LIVE: slam map merged with 2m obstacle overlay.

```json
{
  "type": "map_layer",
  "data": {
    "width": 800, "height": 800,
    "resolution": 0.05,
    "origin_x": -20.0, "origin_y": -20.0,
    "data": [0, 0, 100, -1, 0, ...]
  }
}
```

### `obstacle_layer` — 2m Awareness Zone (one-shot, after 'stop')

Published once after `SCAN_OBSTACLE` completes. Cells within 2m of the robot's final position that contained obstacle points are marked `100`.

```json
{
  "type": "obstacle_layer",
  "data": {
    "width": 800, "height": 800,
    "resolution": 0.05,
    "origin_x": -20.0, "origin_y": -20.0,
    "data": [-1, -1, 100, -1, 0, ...]
  }
}
```

| Cell value | Meaning |
|---|---|
| `0` | Free space |
| `100` | Occupied (wall or obstacle) |
| `-1` | Unknown |

### `pose` — Robot Pose (~10 Hz, from TF)

```json
{ "type": "pose", "data": { "x": 2.345, "y": 1.234, "theta": 1.5708 } }
```

### `status` — Human-Readable State String

```json
{ "type": "status", "data": "MAPPING: recording..." }
```
Values: `IDLE: waiting` | `MAPPING: waiting for movement...` | `MAPPING: recording...` | `MAPPING: scanning obstacles...` | `LIVE: localizing`

### `mode` — Machine State (5-state)

```json
{ "type": "mode", "data": "mapping_active" }
```
Values: `idle` | `mapping_idle` | `mapping_active` | `scan_obstacle` | `live`

### `info` — Device Availability (every 5s)

```json
{ "type": "info", "data": { "lidar": true, "map": true, "pose": false, "mode": "live" } }
```

### `esp32_imu` — BNO055 IMU Telemetry (~20 Hz)

Forwarded from `/esp32/imu`. Used by the brain for heading correction and the right-side IMU tab in the UI.

```json
{
  "type": "esp32_imu",
  "data": {
    "ts": 1053920, "type": 134,
    "yaw": 1.57, "pitch": 0.02, "roll": 0.01,
    "quat": [0.707, 0.0, 0.707, 0.0],
    "accel": [0.0, 0.0, 9.81],
    "gyro": [0.0, 0.0, 0.0],
    "temp_c": 28,
    "cal": {"sys": 3, "gyr": 3, "acc": 3, "mag": 0},
    "safety": {
      "config_rev": 1, "enforcement": false, "sample_valid": true,
      "tilt_deg": 0.2, "linear_accel_mps2": 0.1, "gyro_dps": 0.3,
      "tilt_warning": false, "tilt_observed": false,
      "shock_candidate": false, "shock_observed": false,
      "event": "none"
    }
  }
}
```

### `esp32_power` — INA226 Battery/Power Telemetry (0.2 Hz)

Forwarded from `/esp32/power`. Battery state-of-charge is calculated in firmware from the pack voltage using a piecewise curve: 20.5 V = 100%, 14.0 V = 0%, with linear interpolation between calibrated points. A fresh `noload=true` frame means no source is connected and must not be displayed as a real 0% battery.

```json
{
  "type": "esp32_power",
  "data": {
    "type": 133,
    "voltage_v": 20.1, "current_a": 0.45, "power_w": 9.0,
    "battery_pct": 92, "battery_status": "ok", "noload": false
  }
}
```

### `ack` — Command Acknowledgement (per command)

```json
{ "type": "ack", "data": { "command": "start", "ok": true, "ts": 1053920 } }
```

### `esp32_status` — Raw ESP32 Type-131 Frame (as emitted by firmware)

Forwarded verbatim from `/esp32/status`, which `esp32_telemetry_node.py`
populates by reading `/dev/robot-esp32` directly. Consumed by the right-side
"ESP32" tab in the web UI.

```json
{
  "type": "esp32_status",
  "data": {
    "ts": 1053920, "type": 131, "mode": "AUTO_ROAM",
    "estop": false, "max_pct": 100, "nav": [0, 0, 0],
    "motors": [{"t": 30, "r": 0}, {"t": 30, "r": 0}, {"t": 30, "r": 0}, {"t": 30, "r": 0}],
    "ir": [false, false, false, false],
    "st": {"imu": false, "pwr": false, "sharp": 22, "obs": false, "tof_mm": 9999, "cyl": "idle"}
  }
}
```

### `esp32_encoder` — Raw ESP32 Type-130 Frame (per-motor encoder counts + RPM)

```json
{
  "type": "esp32_encoder",
  "data": [
    {"id": 0, "name": "fl", "count": 12345, "rpm": 0},
    {"id": 1, "name": "fr", "count": 12350, "rpm": 0}
  ]
}
```

### `ping` — Keepalive (every 5s)

```json
{ "type": "ping" }
```

---

## Sending Commands (Web → Robot)

```javascript
// START — enter MAPPING_IDLE, begin slam_toolbox mapping
ws.send(JSON.stringify({ type: 'cmd', command: 'start' }));

// STOP — enter SCAN_OBSTACLE, then LIVE (2m awareness zone published)
ws.send(JSON.stringify({ type: 'cmd', command: 'stop' }));

// IDLE — cancel mapping, return to IDLE
ws.send(JSON.stringify({ type: 'cmd', command: 'idle' }));

// RESET — clear obstacle layer, reset slam_toolbox, return to IDLE
ws.send(JSON.stringify({ type: 'cmd', command: 'reset' }));
```

---

## Data Flow Summary

| Source | Topic | Message Type | Frequency | WebSocket field |
|---|---|---|---|---|
| rplidar driver (`ros-jazzy-rplidar-ros2`) | `/scan` | LaserScan | ~10 Hz | `scan.points[]` (throttled to 5 Hz) |
| slam_toolbox | `/map` | OccupancyGrid | dynamic | relayed as `map_layer.*` via map_manager |
| map_manager | `/obstacle_layer` | OccupancyGrid | one-shot | `obstacle_layer.*` |
| slam_toolbox | TF (`map→base_footprint`) | TransformStamped | ~10 Hz | `pose.*` (via web_bridge TF lookup) |
| map_manager | `/mapping_status` | String | on change | `status.*`, `mode.*` |
| ESP32 (`/dev/robot-esp32`) | `/esp32/status`, `/esp32/encoder` | std_msgs/String | ~2 Hz (status), on event (encoder) | `esp32_status.*`, `esp32_encoder.*` |
| web_bridge | — | — | 5s | `info.*` |

---

## Brain Node State Machine

`brain_node.py` implements the high-level warehouse workflow:

```text
BOOT → EXPLORE → EXPLORE_SEARCH_TAG → EXPLORE_REVERSE → MAPPING_DONE → IDLE
  ↓ (job received)
JOB_NAV_TO_DROPOFF → JOB_DOCK_UNLOAD → JOB_RETURN_HOME → IDLE
```

States:
- `BOOT` — Waits for initial sensor/esp32 ready
- `EXPLORE` — Autonomous SLAM exploration; robot drives forward and builds map
- `EXPLORE_SEARCH_TAG` — Looking for an AprilTag to anchor the mapping coordinate frame
- `EXPLORE_REVERSE` — Backing up to avoid obstacles during exploration
- `MAPPING_DONE` — Map saved; brain publishes `map_saved` and transitions to IDLE
- `IDLE` — Waiting for a job from the API (`job:dispatch` via Socket.io)
- `JOB_NAV_TO_DROPOFF` — Nav2 navigating to the destination slot
- `JOB_DOCK_UNLOAD` — Robot at dock; firmware controls cylinder extend/retract
- `JOB_RETURN_HOME` — Navigating back to the home pose after dropoff
- `WAREHOUSE_SCAN`, `WAREHOUSE_NAV_TAG`, `WAREHOUSE_DOCK`, `WAREHOUSE_UNLOAD`, `WAREHOUSE_LEAVE_DOCK`, `WAREHOUSE_RETURN_HOME` — Extended warehouse workflow states (firmware-assisted)

The brain sends `move` JSON to the ESP32 via `esp32_telemetry_node`'s `/esp32/cmd` topic. Nav2 commands are issued through `BasicNavigator` (nav2_simple_commander).

---

## LiDAR → ESP32 obstacle events

`brain_node.py` derives front-left, front-center, front-right, left, right, and rear zones from `/scan`. Events are sent through `esp32_telemetry_node` using debounced, hysteretic commands:

- obstacle threshold: 1.5 m
- clear threshold: 1.7 m
- transition debounce: 150 ms
- same-zone resend only after a 0.20 m distance change
- stale scans (>0.5 s) do not emit new events

Supported commands are `obstacle_front`, `obstacle_front_left`, `obstacle_front_right`, `obstacle_left`, `obstacle_right`, `obstacle_rear`, `obstacle_rear_left`, `obstacle_rear_right`, and `obstacle_clear`. Events may include `distance_m` and normalized `severity`. Local ESP32 IR/Sharp telemetry has priority: a LiDAR clear is withheld while those sensors report a physical obstacle. The Pi velocity planner remains primary; ESP32 events are a fast safety/dodge hint.

## ESP32 Telemetry Node

`esp32_telemetry_node.py` is the **sole owner** of the ESP32 USB CDC serial link (`/dev/robot-esp32`). All other nodes interact with the ESP32 exclusively through this node's ROS topics.

### ROS topics

| Topic | Direction | Content |
|---|---|---|
| `/esp32/cmd` | ROS → serial | JSON command (move, stop, e_stop, heartbeat, set_speed, cylinder_extend, begin_dock, cancel_dock, etc.) |
| `/esp32/status` | serial → ROS | ESP32 type-131 status frame (~2 Hz) |
| `/esp32/encoder` | serial → ROS | ESP32 type-130 encoder snapshot |
| `/esp32/imu` | serial → ROS | ESP32 type-134 BNO055 IMU data (20 Hz) |
| `/esp32/power` | serial → ROS | ESP32 type-133 INA226 power telemetry (0.2 Hz) |
| `/esp32/unload_state` | serial → ROS | ESP32 type-140 unload state: `{state: 0..7, state_name, error, error_code, error_name}`. An `error=true` frame aborts the current route leg. |
| `/esp32/cargo` | serial → ROS | ESP32 type-145 cargo sensor status (on-demand) |
| `/esp32/alive` | serial → ROS | ESP32 type-144 alive heartbeat (500 ms) |
| `/esp32/alive` | serial → ROS | ESP32 heartbeat liveness flag |
| `/esp32/cmd_status` | ROS | Command accepted/rejected/queue-overflow status |

---

## Cylinder / Dock Commands

The firmware supports an L298N-driven electric cylinder for warehouse dock/unload operations:

```json
{"cmd":"cylinder_extend"}    // Extend cylinder (lower robot onto dock)
{"cmd":"cylinder_retract"}   // Retract cylinder (lift robot off dock)
{"cmd":"cylinder_stop"}      // Stop cylinder immediately
{"cmd":"begin_dock"}         // Start full docking sequence (firmware state machine)
{"cmd":"cancel_dock"}        // Cancel docking sequence mid-operation
```

The brain orchestrates cylinder timing via `job:phase` updates (`NAVIGATE_DROPOFF` → `AT_DOCK` → `UNLOADING` → `RETURNING`).

---

## Cancel Job Handshake

When an operator cancels a job via `DELETE /jobs/:id`:

1. API emits `job:cancel` to the brain via the `/robot` namespace
2. API starts a 500 ms timeout waiting for `job:cancel:ack`
3. Brain acknowledges via `job:cancel:ack` → API releases the destination slot
4. If the brain doesn't respond in time, the slot is released with a warning

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| WebSocket never connects | Wrong IP, or port 9091 not reachable — check `pm2 status` |
| `map_layer` all gray | slam_toolbox not publishing `/map` — check `pm2 logs nexus-robot-slam` |
| Map stays blank | Robot hasn't moved enough — push the robot to trigger slam_toolbox updates |
| No `pose` data | TF tree not available — check `ros2 run tf2_ros tf2_echo map base_footprint` |
| `obstacle_layer` not arriving | Not yet in SCAN_OBSTACLE state — 'stop' must be sent first |
| Map grows in LIVE mode | Still in MAPPING_ACTIVE — send `command: 'stop'` |
| Port 9091 already in use | Kill the stray process: `sudo lsof -ti :9091 | xargs kill` |
| TF conflict / robot jumps | Two nodes publishing same TF — ensure brain_node is NOT running alongside slam_toolbox |

**Verify from Pi:**
```bash
pm2 status
ros2 topic list
ros2 topic echo /map --once
ros2 run tf2_ros tf2_echo map base_footprint
sudo lsof -i :9091
```

---

## Camera Stream (MJPEG)

The camera stream runs on **port 9092** (separate from the 9091 web bridge). It reads frames from the USB camera and serves them as MJPEG for the web UI.

### Endpoints

| Endpoint | Port | Description |
|---|---|---|
| `GET /stream` | `9092` | MJPEG multipart stream (`multipart/x-mixed-replace`) |
| `GET /snapshot` | `9092` | Single JPEG frame |
| `GET /` | `9092` | Health check (JSON: `{"camera": true, "device": "/dev/video0", ...}`) |

### Configuration (env vars)

| Variable | Default | Description |
|---|---|---|
| `CAMERA_DEVICE` | `/dev/video0` | V4L2 device path |
| `CAMERA_WIDTH` | `640` | Capture width |
| `CAMERA_HEIGHT` | `480` | Capture height |
| `CAMERA_FPS` | `15` | Target FPS |
| `CAMERA_QUALITY` | `80` | JPEG quality (1-100) |
| `CAMERA_PORT` | `9092` | HTTP listen port |

### Check camera node:
```bash
pm2 status nexus-robot-camera
pm2 logs nexus-robot-camera --lines 10

# Health check
curl http://localhost:9092/

# Snapshot
curl -o snap.jpg http://localhost:9092/snapshot

# Stream (open in browser)
# http://<pi-ip>:9092/stream
```
