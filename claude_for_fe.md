# Robot WebSocket API — Frontend Reference

> **Source:** robot-controller (`robot-core` container, `map_manager_node.py` + `web_bridge.py`)
> **Endpoint:** `wss://map.nguyen-robot.io.vn`
> **No ROS dependencies required.** Plain WebSocket + Canvas/SVG only.

---

## Architecture

```
[Robot]
  |
  +-- Lidar (/scan ~12 Hz)
  +-- TF2 (/tf — robot pose)
  |
  v
map_manager_node.py  (custom two-map builder)
  |
  +-- persistent_grid  →  saved to /app/saved_map.json
  +-- temporary_grid   →  2m radius, clears unseen objects
  |
  v
/map_combined  (OccupancyGrid: persistent + temporary overlaid)
  |
  v
web_bridge.py  →  WebSocket
                          |
                          v
              [Web App]  wss://map.nguyen-robot.io.vn
```

---

## Two-Map System

The robot has **two independent maps**:

| Map | Purpose | Update | Size |
|---|---|---|---|
| `persistent_grid` | Room layout — walls, furniture | Only when robot moves | 40×40m (800×800 cells @ 5cm) |
| `temporary_grid` | Dynamic obstacles — people, bags | Every scan, 2m radius | Same grid, cleared after 5 scans |
| `combined_grid` | What you see on screen | Every publish | persistent + temporary overlaid |

**Mode `mapping`:** Persistent grid grows. No temporary layer. Auto-stops when room is fully scanned.

**Mode `live`:** Saved persistent grid + live temporary obstacles overlaid. Objects not seen for 5 scans are removed.

---

## Connection

```javascript
const ws = new WebSocket('wss://map.nguyen-robot.io.vn');

ws.onopen = () => console.log('Connected');
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  // msg.type: 'scan' | 'map' | 'pose' | 'status' | 'mode' | 'info' | 'ping'
};
```

---

## Message Types

### `scan` — Live Lidar Point Cloud (~12 Hz)

```json
{
  "type": "scan",
  "data": {
    "points": [{ "x": 1.234, "y": 0.567 }, ...],
    "count": 360
  }
}
```

Robot-centric: robot at `(0, 0)`, facing +X. Invalid readings omitted.

### `map` — Combined Occupancy Grid (~2 Hz)

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

| Cell value | Meaning |
|---|---|
| `0` | Free space |
| `100` | Wall / occupied (from persistent or temporary) |
| `-1` | Unknown |

```javascript
// world -> grid
function worldToGrid(wx, wy, map) {
  return {
    x: Math.floor((wx - map.origin_x) / map.resolution),
    y: Math.floor((wy - map.origin_y) / map.resolution),
  };
}
```

### `pose` — Robot Pose in World Coordinates (10 Hz)

```json
{ "type": "pose", "data": { "x": 2.345, "y": 1.234, "theta": 1.5708 } }
```

x, y in meters. theta in radians (0 = facing +X, CCW positive).

### `status` — Mapping / Robot State String (1 Hz)

```json
{ "type": "status", "data": "LIVE: localizing" }
```

Values: `MAPPING: scanning...` | `LIVE: localizing` | `IDLE`

### `mode` — Mode Change (event)

Emitted when mode switches between `mapping` and `live`.

```json
{ "type": "mode", "data": "live" }
```

### `info` — Device + Mode Status (every 5s)

```json
{
  "type": "info",
  "data": {
    "lidar": true,
    "map": true,
    "pose": true,
    "mode": "live",
    "coverage_pct": 0
  }
}
```

| Field | Meaning |
|---|---|
| `lidar` | true = Lidar publishing |
| `map` | true = Map available |
| `pose` | true = Pose available |
| `mode` | `"mapping"` or `"live"` |
| `coverage_pct` | (reserved for future use) |

### `ping` — Keepalive (every 5s)

```json
{ "type": "ping" }
```

---

## Controlling the Robot (Web -> Robot)

Send commands via WebSocket:

```javascript
// Start mapping mode (scan room)
ws.send(JSON.stringify({ type: 'cmd', action: 'mapping', command: 'start' }));

// Stop mapping, switch to live mode (save map)
ws.send(JSON.stringify({ type: 'cmd', action: 'mapping', command: 'stop' }));

// Reset: clear temporary obstacles (useful in live mode)
ws.send(JSON.stringify({ type: 'cmd', action: 'mapping', command: 'reset' }));
```

---

## Complete MapViewer Component

```tsx
// src/components/MapViewer.tsx
"use client";

import { useEffect, useRef, useState } from "react";

interface MapData {
  width: number;
  height: number;
  resolution: number;
  origin_x: number;
  origin_y: number;
  data: number[];
}

interface Pose { x: number; y: number; theta: number; }
interface Point { x: number; y: number; }

function worldToGrid(wx: number, wy: number, map: MapData) {
  return {
    x: Math.floor((wx - map.origin_x) / map.resolution),
    y: Math.floor((map.height - 1) - (wy - map.origin_y) / map.resolution),
  };
}

export default function MapViewer() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState("Connecting...");
  const [mode, setMode] = useState("live");
  const [devices, setDevices] = useState({ lidar: false, map: false, pose: false });
  const [pose, setPose] = useState<Pose | null>(null);

  useEffect(() => {
    let ws: WebSocket;

    function connect() {
      ws = new WebSocket("wss://map.nguyen-robot.io.vn");
      ws.onopen = () => setStatus("Connected");
      ws.onclose = () => {
        setStatus("Disconnected — reconnecting...");
        setTimeout(connect, 3000);
      };
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        switch (msg.type) {
          case "map":    renderMap(msg.data); break;
          case "pose":   setPose(msg.data); break;
          case "status": setStatus(msg.data); break;
          case "mode":   setMode(msg.data); break;
          case "info":   setDevices(msg.data); break;
          case "ping":   break;
        }
      };
    }

    connect();
    return () => ws?.close();
  }, []);

  function renderMap(mapData: MapData) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = mapData.width;
    canvas.height = mapData.height;
    const ctx = canvas.getContext("2d")!;
    const img = ctx.createImageData(mapData.width, mapData.height);

    for (let i = 0; i < mapData.data.length; i++) {
      const v = mapData.data[i];
      const j = i * 4;
      if (v === -1)        { img.data[j]=60;   img.data[j+1]=60;   img.data[j+2]=80;   img.data[j+3]=255; }
      else if (v === 100) { img.data[j]=25;   img.data[j+1]=25;   img.data[j+2]=25;   img.data[j+3]=255; }
      else                 { img.data[j]=245;  img.data[j+1]=245;  img.data[j+2]=240;  img.data[j+3]=255; }
    }
    ctx.putImageData(img, 0, 0);

    if (pose) {
      const rp = worldToGrid(pose.x, pose.y, mapData);
      ctx.fillStyle = "#00d4ff";
      ctx.beginPath();
      ctx.moveTo(rp.x + 10, rp.y);
      ctx.lineTo(rp.x - 6, rp.y - 6);
      ctx.lineTo(rp.x - 6, rp.y + 6);
      ctx.closePath();
      ctx.fill();
    }
  }

  return (
    <div className="relative">
      <canvas ref={canvasRef} className="block" />
      <div className="absolute top-2 left-2 text-xs text-gray-400 space-y-1">
        <div>{status}</div>
        <div className="flex gap-2">
          {devices.lidar ? "🟢" : "⚪"} Lidar{" "}
          {devices.map ? "🟢" : "⚪"} Map{" "}
          {devices.pose ? "🟢" : "⚪"} Pose{" "}
          <span className={mode === "mapping" ? "text-yellow-400" : "text-green-400"}>
            [{mode.toUpperCase()}]
          </span>
        </div>
        {pose && (
          <div>
            x={pose.x.toFixed(2)} y={pose.y.toFixed(2)} θ={pose.theta.toFixed(2)}
          </div>
        )}
      </div>
    </div>
  );
}
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Map is all gray | No map published — check `info.map` is true |
| Map is messy/noisy | Run in MAPPING mode, move slowly step-by-step |
| Pose jumps around | Lidar not localized — need to move slowly in LIVE mode |
| WebSocket disconnects | Check Cloudflare tunnel pointing to Pi IP port 9091 |
| Temporary objects don't clear | Wait 5+ scans — they clear automatically |
