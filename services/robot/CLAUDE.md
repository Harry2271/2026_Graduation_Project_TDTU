# robot-controller — Web Bridge API Reference

> **Purpose:** This document describes the WebSocket JSON API that the frontend can use to receive live robot data for map visualization.

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
4. `my_robot_controller/web_bridge` — WebSocket server on port 9091
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
| Protocol | WebSocket (plain) |
| Host | `<robot-ip>` |
| Port | `9091` |
| URL | `ws://<robot-ip>:9091` |

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
| web_bridge | — | — | 5s | `info.*` |

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
