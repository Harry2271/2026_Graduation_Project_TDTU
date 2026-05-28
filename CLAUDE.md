# robot-controller — Web Bridge API Reference

> **Purpose:** This document describes the WebSocket JSON API that the frontend can use to receive live robot data for map visualization. It is intended for the frontend developer building the web map/dashboard application.

---

## Architecture Overview

```
[Robot Hardware]
   |
   +-- Slamtec A1M8 Lidar  -->  /scan  (LaserScan ~12 Hz)
   +-- TF2 (map frame)     -->  /tf   (robot pose ~10 Hz)
   |
   v
[map_manager_node.py]  <-- Custom two-map builder
   |
   +-- persistent_grid  -->  saved to /app/saved_map.json
   +-- temporary_grid  -->  2m radius, auto-clears after 5 scans
   +-- combined_grid   -->  persistent + temporary overlaid
   |
   v
[/map_combined]  <-- OccupancyGrid
   |
   v
[web_bridge.py]  <-- ROS 2 subscriptions
   |
   v
[WebSocket server]  ws://0.0.0.0:9091
   |
   v
[Web App]  wss://map.nguyen-robot.io.vn
```

---

## Two-Map System

| Map | Purpose | Update Rule | Size |
|---|---|---|---|
| `persistent_grid` | Room layout — walls, furniture | Only when robot moves > 15cm | 40×40m (800×800 cells @ 5cm) |
| `temporary_grid` | Dynamic obstacles — people, bags | Every scan, 2m radius | Same grid, cleared after 5 scans without detection |
| `combined_grid` | What you see on screen | Every publish | `persistent` + `temporary` overlaid |

### Modes

| Mode | Persistent | Temporary | Use Case |
|---|---|---|---|
| `IDLE` | not updated | not updated | Starting state |
| `MAPPING` | grows on movement | none | Scanning a room |
| `LIVE` | static (saved map) | rebuilt every scan | Navigation |

**MAPPING auto-stop:** Switches to LIVE when the bounding box of mapped area stops growing for 10 seconds.

**Saved map:** Persistent grid is saved to `/app/saved_map.json` on disk (persists across container restarts via Docker volume).

---

## Connection

| Parameter | Value |
|---|---|
| Protocol | WebSocket (plain) |
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
      ...
    ],
    "count": 360
  }
}
```

- **Coordinate system:** Robot-centric. The robot stands at `(0, 0)` facing angle `0` (positive X direction).
- `count`: number of valid (non-infinity) points in this scan
- Invalid readings are **omitted** from the array.

---

### 2. `map` — Combined Occupancy Grid

Sent by map_manager every ~1s. Contains `persistent_grid` + `temporary_grid` overlaid.

```json
{
  "type": "map",
  "data": {
    "width": 800,
    "height": 800,
    "resolution": 0.05,
    "origin_x": -20.0,
    "origin_y": -20.0,
    "origin_theta": 0.0,
    "data": [0, 0, 100, -1, 0, ...]
  }
}
```

| Field | Description |
|---|---|
| `width` / `height` | Grid dimensions in cells (800×800) |
| `resolution` | Meters per cell (0.05 = 5 cm/pixel) |
| `origin_x` / `origin_y` | World position of cell `[0,0]` |
| `data` | Flat array, row-major. Length = `width × height` |

**Cell values:**

| Value | Meaning |
|---|---|
| `0` | Free space |
| `100` | Occupied (wall — persistent OR temporary) |
| `-1` | Unknown |

**Coordinate conversion (world → grid):**
```javascript
function worldToGrid(worldX, worldY, map) {
  return {
    x: Math.floor((worldX - map.data.origin_x) / map.data.resolution),
    y: Math.floor((worldY - map.data.origin_y) / map.data.resolution),
  };
}
```

---

### 3. `pose` — Robot Pose in World Coordinates

Broadcast at 10 Hz.

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

- `x`, `y`: Robot position in meters
- `theta`: Heading in radians (0 = facing +X, π/2 = facing +Y, CCW positive)

---

### 4. `status` — Robot / Mapping State String

```json
{
  "type": "status",
  "data": "LIVE: localizing"
}
```

Values: `MAPPING: scanning...` | `LIVE: localizing` | `IDLE`

---

### 5. `mode` — Mode Change Event

Emitted when the robot switches between MAPPING and LIVE mode.

```json
{ "type": "mode", "data": "live" }
```

---

### 6. `info` — Device Availability

Sent every 5 seconds.

```json
{
  "type": "info",
  "data": {
    "lidar": true,
    "map": true,
    "pose": false,
    "mode": "live",
    "coverage_pct": 0
  }
}
```

| Field | Meaning |
|---|---|
| `lidar` | `true` = Lidar is publishing scans |
| `map` | `true` = Combined map is available |
| `pose` | `true` = Robot pose is available (TF converged) |
| `mode` | `"mapping"` or `"live"` |
| `coverage_pct` | (reserved for future) |

---

### 7. `ping` — Keepalive

Sent every 5 seconds.

```json
{ "type": "ping" }
```

---

## Sending Commands (Web → Robot)

Send any JSON object to control the robot:

```javascript
// Start mapping mode (scan the room)
ws.send(JSON.stringify({
  type: 'cmd',
  action: 'mapping',
  command: 'start',
}));

// Stop mapping and save map (switch to live mode)
ws.send(JSON.stringify({
  type: 'cmd',
  action: 'mapping',
  command: 'stop',
}));

// Reset temporary obstacles (in live mode)
ws.send(JSON.stringify({
  type: 'cmd',
  action: 'mapping',
  command: 'reset',
}));
```

---

## Complete Example — Minimal Map Viewer

```html
<!DOCTYPE html>
<html>
<head>
  <style>
    body { margin: 0; background: #111; }
    canvas { display: block; }
    #scanCanvas { position: fixed; top: 0; left: 0; pointer-events: none; }
    #status  { position: fixed; top: 8px;  left: 8px;  color: #aaa; font: 13px monospace; }
    #devices { position: fixed; top: 24px; left: 8px;  color: #555; font: 12px monospace; }
    #pose    { position: fixed; top: 40px; left: 8px;  color: #aaa; font: 13px monospace; }
  </style>
</head>
<body>
  <canvas id="mapCanvas"></canvas>
  <canvas id="scanCanvas"></canvas>
  <div id="status">Connecting...</div>
  <div id="devices"></div>
  <div id="pose"></div>

  <script>
    const canvas = document.getElementById('mapCanvas');
    const scanCanvas = document.getElementById('scanCanvas');
    const ctx = canvas.getContext('2d');
    const scanCtx = scanCanvas.getContext('2d');
    const statusEl  = document.getElementById('status');
    const devicesEl = document.getElementById('devices');
    const poseEl   = document.getElementById('pose');

    let mapData = null;
    let robotPose = null;
    let scanPoints = [];
    let mode = 'live';
    let lastScanTime = 0;
    let deviceInfo = {};  // holds latest info from 'info' message

    const ws = new WebSocket('wss://map.nguyen-robot.io.vn');

    ws.onopen = () => statusEl.textContent = 'Connected';

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      switch (msg.type) {
        case 'map':    mapData = msg.data; renderMap(); break;
        case 'scan':   scanPoints = msg.data.points; lastScanTime = Date.now(); renderScan(); break;
        case 'pose':   robotPose = msg.data; break;  // pose renders in rAF loop
        case 'status': statusEl.textContent = msg.data; break;
        case 'mode':   mode = msg.data; break;
        case 'info':   deviceInfo = msg.data; updateDeviceStatus(deviceInfo); break;
        case 'ping':   break;
      }
    };

    // Render pose and arrow on every animation frame — independent of scan arrival.
    // Also calls renderScan every frame so lidar points appear continuously,
    // not just when a new scan message arrives.
    function renderPose() {
      const now = Date.now();

      if (!robotPose) {
        poseEl.textContent = deviceInfo.pose === false ? 'Locating...' : '';
      } else {
        // Show "Locating..." when robot is at origin and pose not yet established.
        // When the robot has actually moved (x²+y² > 0.01), show real coords.
        const distSq = robotPose.x * robotPose.x + robotPose.y * robotPose.y;
        if (distSq < 0.01 && !deviceInfo.pose) {
          poseEl.textContent = 'Locating...';
        } else {
          poseEl.textContent =
            `x=${robotPose.x.toFixed(2)} y=${robotPose.y.toFixed(2)} θ=${robotPose.theta.toFixed(2)}` +
            (scanPoints.length > 0 ? ` [${scanPoints.length} pts]` : '');
        }
      }

      // Draw scan + robot arrow every frame (60 fps) so lidar dots are always visible
      renderScan();

      requestAnimationFrame(renderPose);
    }
    requestAnimationFrame(renderPose);

    function updateDeviceStatus(info) {
      const dot = (ok) => ok ? '🟢' : '⚪';
      const modeColor = info.mode === 'mapping' ? 'color:#f59e0b' : 'color:#22c55e';
      devicesEl.innerHTML =
        `${dot(info.lidar)} Lidar ` +
        `${dot(info.map)} Map ` +
        `${dot(info.pose)} Pose ` +
        `<span style="${modeColor}">[${info.mode.toUpperCase()}]</span>`;
    }

    function worldToScreen(wx, wy) {
      if (!mapData) return { x: 0, y: 0 };
      const sx = (wx - mapData.origin_x) / mapData.resolution;
      const sy = (mapData.height - 1) - (wy - mapData.origin_y) / mapData.resolution;
      return { x: sx, y: sy };
    }

    // Convert robot-centric scan point to world coordinates using robot pose
    function scanToWorld(sx, sy) {
      if (!robotPose) return null;
      const cos = Math.cos(robotPose.theta);
      const sin = Math.sin(robotPose.theta);
      return {
        x: robotPose.x + sx * cos - sy * sin,
        y: robotPose.y + sx * sin + sy * cos,
      };
    }

    // Fade old scan points so recent points appear brighter.
    // Called every animation frame (60 fps) so lidar dots are always visible,
    // not just when a new scan message arrives (~12 Hz).
    function renderScan() {
      const now = Date.now();
      const fade = Math.max(0.05, 1 - (now - lastScanTime) / 2000); // fade over 2s

      // Always sync scan canvas size to map canvas (works even before first map arrives)
      const targetW = canvas.width  || 800;
      const targetH = canvas.height || 800;
      if (scanCanvas.width !== targetW || scanCanvas.height !== targetH) {
        scanCanvas.width  = targetW;
        scanCanvas.height = targetH;
      }

      // Clear and fade
      scanCtx.clearRect(0, 0, scanCanvas.width, scanCanvas.height);
      scanCtx.fillStyle = `rgba(0, 212, 255, ${fade * 0.15})`;
      scanCtx.fillRect(0, 0, scanCanvas.width, scanCanvas.height);

      // Guard point rendering: need both map (for world->screen transform) and pose
      if (!mapData || !robotPose) return;

      // Draw scan points as bright cyan dots
      scanCtx.fillStyle = `rgba(0, 212, 255, ${Math.min(1, fade + 0.3)})`;
      for (const pt of scanPoints) {
        const w = scanToWorld(pt.x, pt.y);
        if (!w) continue;
        const s = worldToScreen(w.x, w.y);
        scanCtx.beginPath();
        scanCtx.arc(s.x, s.y, 1, 0, Math.PI * 2);
        scanCtx.fill();
      }

      // Draw robot heading arrow
      const rp = worldToScreen(robotPose.x, robotPose.y);
      scanCtx.save();
      scanCtx.translate(rp.x, rp.y);
      scanCtx.rotate(-robotPose.theta);
      scanCtx.fillStyle = '#00d4ff';
      scanCtx.beginPath();
      scanCtx.moveTo(12, 0);
      scanCtx.lineTo(-8, 7);
      scanCtx.lineTo(-8, -7);
      scanCtx.closePath();
      scanCtx.fill();
      scanCtx.restore();
    }

    function renderMap() {
      if (!mapData) return;
      canvas.width  = mapData.width;
      canvas.height = mapData.height;
      scanCanvas.width = mapData.width;
      scanCanvas.height = mapData.height;
      const img = ctx.createImageData(mapData.width, mapData.height);

      for (let i = 0; i < mapData.data.length; i++) {
        const v = mapData.data[i];
        const j = i * 4;
        if      (v === -1)  { img.data[j]=60;   img.data[j+1]=60;   img.data[j+2]=80;   img.data[j+3]=255; }
        else if (v === 100) { img.data[j]=25;   img.data[j+1]=25;   img.data[j+2]=25;   img.data[j+3]=255; }
        else                { img.data[j]=245;  img.data[j+1]=245;  img.data[j+2]=240;  img.data[j+3]=255; }
      }
      ctx.putImageData(img, 0, 0);
      renderScan();
    }
  </script>
</body>
</html>
```

---

## Data Flow Summary

| Source | Topic | Message Type | Frequency | WebSocket Field |
|---|---|---|---|---|
| map_manager | `/map_combined` | OccupancyGrid | ~1 Hz | `map.*` (800×800 cells @ 5cm) |
| Lidar driver | `/scan` | LaserScan | ~12 Hz | `scan.points[]` (rendered as cyan dots) |
| slam_toolbox | `/pose` | PoseWithCovarianceStamped | ~10 Hz | `pose.{x,y,theta}` |
| map_manager | `/mapping_status` | String | on change | `mode.*`, `status.data` |
| web_bridge | — | — | 5s | `info.*` (device status) |

**Hot-plug:** All devices are hot-pluggable. The `info` message tells you what's currently available.

---

## Troubleshooting

| Symptom | Likely Cause |
|---|---|
| WebSocket never connects | Wrong IP address, or Cloudflare tunnel pointing to wrong port |
| `map` all gray | map_manager not running or `/map_combined` not published |
| `map` stays blank while scanning | Normal — the map only updates when the robot physically moves > 15cm. Move the robot around to see the grid grow |
| `pose` jumps around | TF not converged — robot needs to move slowly |
| Map keeps growing in LIVE mode | Still in MAPPING mode — send `command: 'stop'` |
| Scan points not visible | The HTML viewer now renders live lidar points on a separate canvas layer (cyan dots). Make sure your viewer includes the `scan` message renderer |
| Temporary objects never clear | Normal — they clear after 5 consecutive scans without detection |

To verify the robot is publishing data, SSH into the container and run:
```bash
ros2 topic list
ros2 topic echo /map_combined --once
ros2 topic pub --once /mapping/control std_msgs/String "data: 'start'"
```
