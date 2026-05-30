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
[sllidar_ros2 driver]  <-- sllidar_a1_launch.py
   |
   +-- /scan  -->  [brain_node.py]  -->  /odom
   |              [map_manager_node.py]
   |              [web_bridge.py]  ws://0.0.0.0:9091
   |
   v
[Web App]
```

**ROS 2 nodes (managed by PM2 via deploy.sh):**
1. `sllidar_ros2` — SLLidar driver, publishes `/scan`
2. `my_robot_controller/brain` — scan-based odometry (`/odom`) + TF
3. `my_robot_controller/map_manager` — builds occupancy grid
4. `my_robot_controller/web_bridge` — WebSocket server on port 9091

---

## Five-State Map System

| State | What it does |
|---|---|
| `IDLE` | No mapping active. |
| `MAPPING_IDLE` | 'start' received, waiting for robot to move > 15cm or 15°. |
| `MAPPING_ACTIVE` | Movement threshold exceeded. After 0.5–1.0s settling time, records a clean snapshot. Repeats on each subsequent movement. |
| `SCAN_OBSTACLE` | 'stop' received. Accumulates clean 360° scan; filters to 2m awareness zone. Publishes `/obstacle_layer`. |
| `LIVE` | Shows 2m radius around robot — dynamic obstacles only. |

**Smart Movement Trigger:** Map update only fires when robot has moved > 15cm linear OR rotated > 15° from last recorded pose. After each trigger the robot waits a randomised 0.5–1.0s (settling time) before taking the snapshot, minimising lidar motion blur.

**Voxel Grid Filtering:** Point cloud is downsampled to 5cm voxel bins (nearest-point rule) before every grid update. CPU savings are significant at full 360° / 12 Hz lidar rates.

**Post-Mapping Obstacle Scan:** After 'stop', a clean 360° scan accumulates all points within 2m of the robot. These are published as a separate `obstacle_layer` OccupancyGrid and rendered by the frontend as a semi-transparent overlay on top of the static map.

**No SLAM Toolbox** — pose comes from `brain_node.py` ICP-based scan matching. Sufficient for single-room scanning.

**Map parameters:** 800×800 cells, 5cm/cell → 40m × 40m world. Origin at center.

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
pm2 restart nexus-robot-brain
pm2 restart nexus-robot-map-manager
pm2 restart nexus-robot-web-bridge
pm2 restart nexus-robot-lidar
```

**Check node status:**
```bash
pm2 status
```

**View node logs:**
```bash
pm2 logs nexus-robot-web-bridge
pm2 logs nexus-robot-brain
```

**Verify ROS 2 topics:**
```bash
ros2 topic list
ros2 topic echo /odom
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

### `map_layer` — Persistent Occupancy Grid (≤5 Hz)

Built during MAPPING states; shows the full 40×40m grid. In LIVE, shows only 2m radius.

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

Only published once after `SCAN_OBSTACLE` completes. Cells within 2m of the robot's final position that contained obstacle points are marked `100`. Render as a semi-transparent overlay on top of `map_layer`.

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

### `pose` — Robot Pose (~10 Hz)

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
// START — enter MAPPING_IDLE, wait for robot to move
ws.send(JSON.stringify({ type: 'cmd', command: 'start' }));

// STOP — enter SCAN_OBSTACLE, then LIVE (2m awareness zone published)
ws.send(JSON.stringify({ type: 'cmd', command: 'stop' }));

// IDLE — cancel mapping, return to IDLE
ws.send(JSON.stringify({ type: 'cmd', 'command': 'idle' }));
```

---

## Data Flow Summary

| Source | Topic | Message Type | Frequency | WebSocket field |
|---|---|---|---|---|
| sllidar driver | `/scan` | LaserScan | ~12 Hz | `scan.points[]` (throttled to 5 Hz) |
| map_manager | `/map_combined` | OccupancyGrid | ≤5 Hz | `map_layer.*` |
| map_manager | `/obstacle_layer` | OccupancyGrid | one-shot | `obstacle_layer.*` |
| brain_node | `/odom` | Odometry | ~10 Hz | (internal — drives map_manager) |
| map_manager | `/mapping_status` | String | on change | `status.*`, `mode.*` |
| web_bridge | — | — | 5s | `info.*` |

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| WebSocket never connects | Wrong IP, or port 9091 not reachable — check `pm2 status` |
| `map_layer` all gray | `map_manager` not running — check `pm2 status` |
| Map stays blank | Robot hasn't moved > 15cm or rotated > 15° yet — move the robot |
| No `pose` data | brain_node not publishing `/odom` — check `ros2 topic echo /odom` |
| `obstacle_layer` not arriving | Not yet in SCAN_OBSTACLE state — 'stop' must be sent first |
| Map grows in LIVE mode | Still in MAPPING_ACTIVE — send `command: 'stop'` |
| Port 9091 already in use | Kill the stray process: `sudo lsof -ti :9091 | xargs kill` |
| Scan points appear blurred | Settling time < 0.5s — robot moved during lidar sweep; move more slowly |

**Verify from Pi:**
```bash
pm2 status
ros2 topic list
ros2 topic echo /odom
sudo lsof -i :9091
```
