# robot-controller — Web Bridge API Reference

> **Purpose:** This document describes the WebSocket JSON API that the frontend can use to receive live robot data for map visualization. It is intended for the frontend developer building the web map/dashboard application.

---

## Architecture Overview

```
[Robot Hardware]
   |
   +-- Slamtec A1M8 Lidar  -->  /scan  (LaserScan)
   +-- slam_toolbox         -->  /map  (OccupancyGrid)
   +-- TF2 (map frame)     -->  /tf   (robot pose)
   +-- brain_node          -->  /robot_status
   |
   v
[web_bridge.py]  <-- ROS 2 subscriptions
   |
   +-- Converts /scan  -->  cartesian {x, y} points
   +-- Converts /map   -->  flat occupancy grid JSON
   +-- Polls /tf      -->  {x, y, theta} pose
   +-- Forwards /robot_status
   |
   v
[WebSocket server]  ws://<robot-ip>:9091
   |
   v
[Your Web App]  (no ROS dependencies, plain WebSocket + Canvas/SVG)
```

**No ROS dependencies required in the frontend.** The web app connects via plain WebSocket on port 9091.

---

## Connection

| Parameter | Value |
|---|---|
| Protocol | WebSocket (plain, not WSS) |
| Host | `<robot-ip>` (the machine running docker-compose) |
| Port | `9091` |
| URL | `ws://<robot-ip>:9091` |

**Example:**
```javascript
const ws = new WebSocket('ws://192.168.1.100:9091');
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  handleMessage(msg);
};
```

---

## Message Protocol

Every message is a JSON object with at minimum a `type` field.

### 1. `scan` — Live Lidar Point Cloud

Sent every time the lidar produces a scan (~12 Hz for A1M8).

```json
{
  "type": "scan",
  "data": {
    "points": [
      { "x": 1.234, "y": 0.567 },
      { "x": 1.200, "y": 0.610 },
      ...
    ],
    "count": 360
  }
}
```

- **Coordinate system:** Robot-centric. The robot stands at `(0, 0)` facing angle `0` (positive X direction).
- **x-axis:** Forward / facing direction of the robot
- **y-axis:** Left of the robot
- `count`: number of valid (non-infinity) points in this scan
- Invalid readings (inf/nan or out of range) are **omitted** from the array.

**Frontend rendering tip:** Draw each point on a `<canvas>` using `ctx.fillRect()` or `ctx.arc()`, scaled by your display resolution. You can also compute a local map by accumulating points over time.

---

### 2. `map` — Occupancy Grid

Sent by slam_toolbox whenever the map updates (every ~1.5 seconds).

```json
{
  "type": "map",
  "data": {
    "width": 384,
    "height": 384,
    "resolution": 0.05,
    "origin_x": -9.6,
    "origin_y": -9.6,
    "origin_theta": 0.0,
    "data": [0, 0, 100, -1, 0, ...]
  }
}
```

| Field | Description |
|---|---|
| `width` / `height` | Grid dimensions in cells |
| `resolution` | Meters per cell (0.05 = 5 cm/pixel) |
| `origin_x` / `origin_y` | World position of cell `[0,0]` (bottom-left in grid coords) |
| `origin_theta` | Rotation of the grid (usually 0) |
| `data` | Flat array, row-major order. Length = `width × height` |

**Cell values:**

| Value | Meaning |
|---|---|
| `0` | Free space |
| `100` | Occupied (wall) |
| `-1` | Unknown / no data |

**Coordinate conversion (grid → world):**
```javascript
function gridToWorld(cellX, cellY, map) {
  return {
    x: map.data.origin_x + cellX * map.data.resolution,
    y: map.data.origin_y + cellY * map.data.resolution,
  };
}
```

**Coordinate conversion (world → grid):**
```javascript
function worldToGrid(worldX, worldY, map) {
  return {
    x: Math.floor((worldX - map.data.origin_x) / map.data.resolution),
    y: Math.floor((worldY - map.data.origin_y) / map.data.resolution),
  };
}
```

**Frontend rendering tip:** The map is the **authoritative floor plan**. Render it once when received. Draw free cells white/light-gray, occupied cells dark (e.g., `#333`), unknown cells transparent or light gray.

---

### 3. `pose` — Robot Pose in World Coordinates

Broadcast at 10 Hz. Sent only when the TF transform `map → base_footprint` is available (i.e., after SLAM localizer has converged).

```json
{
  "type": "pose",
  "data": {
    "x": 2.345,
    "y": 1.234,
    "theta": 1.5708
  }
}
```

- `x`, `y`: Robot position in the **world/map** coordinate frame (meters)
- `theta`: Robot heading in **radians** (0 = facing +X, π/2 = facing +Y, CCW positive)

**Frontend rendering tip:** Draw the robot as an arrow or triangle centered at `(x, y)` rotated by `theta`. Position it on the map using `worldToGrid()` to get screen coordinates.

---

### 4. `status` — Robot State String

Sent by brain_node every 1 second.

```json
{
  "type": "status",
  "data": "STATE=SCANNING QR=PKG-001 pickups=2 goods_retrieved=true goods_deposited=false"
}
```

Parse this string to display the current mission state in your UI.

---

### 5. `ping` — Keepalive

Sent by the server every 5 seconds. No payload. Use to detect connection health.

```json
{ "type": "ping" }
```

---

### 6. `info` — Device Availability

Sent by the server every 5 seconds. Tells the frontend which devices are currently connected.

```json
{
  "type": "info",
  "data": {
    "lidar": true,
    "map": true,
    "pose": false
  }
}
```

| Field | Meaning |
|---|---|
| `lidar` | `true` = Lidar is publishing scans |
| `map` | `true` = SLAM has produced a map |
| `pose` | `true` = Robot pose is available (TF converged) |

Use this to show connection status indicators in your UI (e.g., "Lidar: Connected", "Map: Waiting...").

---

## Sending Commands (Optional)

The web bridge also **receives** messages. Send any JSON object to control the robot:

```javascript
// Example: set robot speed
ws.send(JSON.stringify({
  type: 'cmd',
  action: 'set_speed',
  linear: 0.2,
  angular: 0.0,
}));
```

*(Command handling is currently a pass-through stub — wire up `web_bridge.py` `_handle_command()` to forward to the appropriate ROS topic as needed.)*

---

## Complete Example — Minimal Map Viewer

```html
<!DOCTYPE html>
<html>
<head>
  <style>
    body { margin: 0; background: #111; }
    canvas { display: block; }
    #status  { position: fixed; top: 8px;  left: 8px;  color: #aaa; font: 13px monospace; }
    #devices { position: fixed; top: 24px; left: 8px;  color: #555; font: 12px monospace; }
    #pose    { position: fixed; top: 40px; left: 8px;  color: #aaa; font: 13px monospace; }
  </style>
</head>
<body>
  <canvas id="mapCanvas"></canvas>
  <div id="status">Connecting...</div>
  <div id="devices"></div>
  <div id="pose"></div>

  <script>
    const canvas = document.getElementById('mapCanvas');
    const ctx = canvas.getContext('2d');
    const statusEl  = document.getElementById('status');
    const devicesEl = document.getElementById('devices');
    const poseEl   = document.getElementById('pose');

    let mapData = null;
    let robotPose = null;
    let scanPoints = [];
    const ROBOT_IP = '192.168.1.100'; // <-- CHANGE THIS

    const ws = new WebSocket(`wss://map.nguyen-robot.io.vn`);

    ws.onopen = () => statusEl.textContent = 'Connected';

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      switch (msg.type) {
        case 'map':    mapData = msg.data; renderMap(); break;
        case 'scan':   scanPoints = msg.data.points; break;
        case 'pose':   robotPose = msg.data; renderMap(); break;
        case 'status': statusEl.textContent = msg.data; break;
        case 'info':   updateDeviceStatus(msg.data); break;
        case 'ping':   break; // connection alive
      }
    };

    function updateDeviceStatus(info) {
      const dot = (ok) => ok ? '🟢' : '⚪';
      devicesEl.textContent = `${dot(info.lidar)} Lidar ${dot(info.map)} Map ${dot(info.pose)} Pose`;
    }

    function worldToScreen(wx, wy) {
      if (!mapData) return { x: 0, y: 0 };
      const sx = (wx - mapData.origin_x) / mapData.resolution;
      const sy = (mapData.height - 1) - (wy - mapData.origin_y) / mapData.resolution;
      return { x: sx, y: sy };
    }

    function renderMap() {
      if (!mapData) return;
      canvas.width  = mapData.width;
      canvas.height = mapData.height;
      const img = ctx.createImageData(mapData.width, mapData.height);

      for (let i = 0; i < mapData.data.length; i++) {
        const v = mapData.data[i];
        const j = i * 4;
        if      (v === -1)  { img.data[j]=80;  img.data[j+1]=80;  img.data[j+2]=80;  img.data[j+3]=255; }
        else if (v === 100) { img.data[j]=30;  img.data[j+1]=30;  img.data[j+2]=30;  img.data[j+3]=255; }
        else                { img.data[j]=240; img.data[j+1]=240; img.data[j+2]=240; img.data[j+3]=255; }
      }
      ctx.putImageData(img, 0, 0);

      // Draw lidar points (robot-centric, overlay on map)
      if (robotPose) {
        ctx.fillStyle = 'rgba(0, 200, 255, 0.4)';
        for (const pt of scanPoints) {
          const wx = robotPose.x + pt.x * Math.cos(robotPose.theta) - pt.y * Math.sin(robotPose.theta);
          const wy = robotPose.y + pt.x * Math.sin(robotPose.theta) + pt.y * Math.cos(robotPose.theta);
          const s = worldToScreen(wx, wy);
          ctx.fillRect(s.x, s.y, 2, 2);
        }

        // Draw robot triangle
        const rp = worldToScreen(robotPose.x, robotPose.y);
        ctx.save();
        ctx.translate(rp.x, rp.y);
        ctx.rotate(-robotPose.theta);
        ctx.fillStyle = '#00d4ff';
        ctx.beginPath();
        ctx.moveTo(10, 0);
        ctx.lineTo(-6, 6);
        ctx.lineTo(-6, -6);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }

      if (robotPose) {
        poseEl.textContent = `x=${robotPose.x.toFixed(2)} y=${robotPose.y.toFixed(2)} θ=${robotPose.theta.toFixed(2)}`;
      }
    }
  </script>
</body>
</html>
```

---

## Data Flow Summary

| Source | Topic | Message Type | Frequency | WebSocket Field |
|---|---|---|---|---|
| Lidar driver | `/scan` | LaserScan | ~12 Hz | `scan.points[]` |
| SLAM Toolbox | `/map` | OccupancyGrid | ~0.7 Hz | `map.*` |
| TF2 | `map→base_footprint` | TF | 10 Hz | `pose.{x,y,theta}` |
| brain_node | `/robot_status` | String | 1 Hz | `status.data` |
| web_bridge | — | — | 5s | `info.*` (device status) |

**Hot-plug:** All devices are hot-pluggable. If the lidar is unplugged, `scan` messages stop and resume automatically when reconnected. The `info` message tells you what's currently available.

---

## Troubleshooting

| Symptom | Likely Cause |
|---|---|
| WebSocket never connects | Wrong IP address, or Cloudflare tunnel pointing to wrong port |
| `scan.points` is always empty | Lidar not connected — check `info.lidar` is `true` |
| `pose` never arrives | SLAM not yet localized — robot needs to move to produce map features |
| `map.data` is all `-1` | SLAM not running or lidar not connected yet |
| Laggy map | Network latency or browser canvas rendering too slow — reduce render frequency |

To verify the robot is publishing data, SSH into the container and run:
```bash
ros2 topic list
ros2 topic echo /scan --once
ros2 topic echo /map --once
```
