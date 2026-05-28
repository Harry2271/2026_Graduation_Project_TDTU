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
[lidar_only_launch.py]  <-- SLLidar ROS 2 driver
   |
   +-- /scan  -->  [map_manager_node.py]
   |              [brain_node.py]  -->  /odom
   |              [web_bridge.py]
   |
   v
[WebSocket server]  ws://0.0.0.0:9091
   |
   v
[Web App]
```

**Nodes started by entrypoint.sh:**
1. `lidar_only_launch.py` — SLLidar driver, publishes `/scan`
2. `static_transform_publisher` x2 — TF: `base_footprint → base_link → laser`
3. `map_manager_node.py` — builds occupancy grid, two modes
4. `brain_node.py` — publishes simulated odometry (`/odom`) and robot TF
5. `web_bridge.py` — WebSocket server on port 9091

---

## Two-Mode Map System

| Mode | What it does |
|---|---|
| `MAPPING` | Builds a full occupancy grid of the room. Updates when robot moves > 15cm. |
| `LIVE` | Shows only 2m radius around the robot — dynamic obstacles only. |

**No SLAM Toolbox** — pose comes from `brain_node.py` simulated odometry. Sufficient for single-room scanning.

**Map parameters:** 800×800 cells, 5cm/cell → 40m × 40m world. Origin at center.

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

### `scan` — Live Lidar Point Cloud (~12 Hz)

Robot-centric. Robot at `(0, 0)`.

```json
{ "type": "scan", "data": { "points": [{ "x": 1.234, "y": 0.567 }], "count": 360 } }
```

### `map` — Occupancy Grid (~1 Hz)

```json
{
  "type": "map",
  "data": {
    "width": 800, "height": 800,
    "resolution": 0.05,
    "origin_x": -20.0, "origin_y": -20.0,
    "data": [0, 0, 100, -1, 0, ...]
  }
}
```

| Cell value | Meaning |
|---|---|
| `0` | Free space |
| `100` | Occupied (wall) |
| `-1` | Unknown |

### `pose` — Robot Pose (~10 Hz)

```json
{ "type": "pose", "data": { "x": 2.345, "y": 1.234, "theta": 1.5708 } }
```

### `status` — State String

```json
{ "type": "status", "data": "MAPPING: scanning..." }
```
Values: `MAPPING: scanning...` | `LIVE: localizing`

### `mode` — Mode Change

```json
{ "type": "mode", "data": "live" }
```

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
// START — begin mapping mode
ws.send(JSON.stringify({ type: 'cmd', command: 'start' }));

// STOP — switch to LIVE mode (2m radius)
ws.send(JSON.stringify({ type: 'cmd', command: 'stop' }));
```

---

## Data Flow Summary

| Source | Topic | Message Type | Frequency | WebSocket field |
|---|---|---|---|---|
| lidar driver | `/scan` | LaserScan | ~12 Hz | `scan.points[]` |
| map_manager | `/map_combined` | OccupancyGrid | ~1 Hz | `map.*` |
| brain_node | `/odom` | Odometry | ~10 Hz | (internal — drives map_manager) |
| map_manager | `/mapping_status` | String | on change | `status.*`, `mode.*` |
| web_bridge | — | — | 5s | `info.*` |

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| WebSocket never connects | Wrong IP, or port 9091 not reachable |
| `map` all gray | `map_manager` not running |
| `map` stays blank | Robot hasn't moved > 15cm yet — move the robot |
| No `pose` data | brain_node not publishing `/odom` |
| Map grows in LIVE mode | Still in MAPPING mode — send `command: 'stop'` |
| Port 9091 already in use | Kill the stray process: `sudo lsof -ti :9091 | xargs kill` |

**Verify from Pi:**
```bash
docker exec robot_core ps aux | grep python3 | grep -v grep
docker exec robot_core ros2 topic list
sudo lsof -i :9091
```
