# Plan: Two-Map System with Smart Mapping

## Context

The robot uses SLAM Toolbox for map building but lacks:
1. Smart mapping (only update when robot moves, stop when room is fully scanned)
2. Two-map system (persistent map + temporary dynamic obstacles)
3. Temporary map integration with navigation (brain_node obstacle avoidance)

**Answers from user:**
- Corner detection: Manual start → auto stop when coverage stops growing
- Mode switch: Automatic after corner scan
- Navigation: Temporary map affects brain_node obstacle avoidance

---

## Architecture

```
/scan (LaserScan ~12 Hz)
    │
    ▼
map_manager_node.py  (custom occupancy grid builder)
    │
    ├── Subscribes to /tf (robot pose)
    ├── Builds TWO grids from scratch using raycasting
    │     │
    │     ├── persistent_grid[] — only grows in mapping mode
    │     └── temporary_grid[]  — 2m radius, clears unseen objects
    │
    ├── Publishes /map_combined (nav_msgs/OccupancyGrid)
    │     Combined: persistent + temporary overlaid
    │
    ├── Publishes /temporary_map (nav_msgs/OccupancyGrid)
    │     Only the temporary layer
    │
    ├── Publishes /mapping_status (std_msgs/String)
    │     "MAPPING: scanning..." | "MAPPING: complete" | "LIVE: localizing"
    │
    └── web_bridge.py receives /map_combined and forwards to WebSocket
          (frontend gets ONE combined map — simpler rendering)

brain_node.py:
    └── Subscribes to /temporary_map
          Uses temporary grid for obstacle avoidance (replaces raw scan)
```

---

## Phase 1: map_manager_node.py

### Grid Parameters (configurable via YAML)
- `grid_resolution`: 0.05 m/cell (5 cm — same as slam_toolbox default)
- `grid_size_meters`: 40.0 (800×800 cells, covers 30m room with margin)
- `grid_origin_x/y`: -20.0 (centered at origin)
- `temp_radius`: 2.0 meters (temporary map radius around robot)
- `temp_clear_threshold`: 3 (remove cell after N consecutive non-detections)
- `travel_threshold`: 0.15 m (minimum movement to trigger map update)

### ROS API
| Topic | Type | Direction | Description |
|---|---|---|---|
| `/scan` | LaserScan | sub | Lidar scan data |
| `/tf` | TF | sub | Robot pose (from TF2 buffer) |
| `/mapping/control` | String | sub | "start", "stop", "reset" |
| `/map_combined` | OccupancyGrid | pub | Persistent + temporary combined |
| `/temporary_map` | OccupancyGrid | pub | Temporary obstacles only |
| `/mapping_status` | String | pub | Current mapping state |

### Modes

#### MAPPING Mode
1. Robot_pose from TF buffer
2. Check if robot moved > `travel_threshold` from last update
3. If moved: raycast each lidar beam → mark free/occupied cells in **persistent_grid**
4. Track bounding box of all seen occupied cells
5. Track `coverage_stable_time` — time since last grid change
6. If `coverage_stable_time > 10s`: emit "MAPPING: complete" → switch to LIVE mode
7. Save persistent_grid to file on mode switch

#### LIVE Mode
1. Every scan: build **temporary_grid** from scratch (2m radius only)
   - For each cell within 2m of robot: raycast
   - Mark cell as occupied if hit, free if no hit
2. Track hit count per cell across scans
3. If cell not seen for `temp_clear_threshold` consecutive scans: mark as free (-1)
4. Combine: `combined_grid = persistent_grid` with `temporary_grid` overlaid
   - Temporary occupied (100) overrides persistent (0, 100, -1)
   - Temporary free (-1) clears persistent occupied (100)
5. Publish both grids

### Raycasting Algorithm
For each lidar beam (angle, range):
- Start at robot position, step in direction by `resolution`
- Mark each cell as FREE until `range - resolution`
- Mark final cell as OCCUPIED
- Skip if range is inf/nan or beyond `max_laser_range`

---

## Phase 2: Update web_bridge.py

- Subscribe to `/map_combined` instead of `/map` from slam_toolbox
- Add `mode` field to `info` message: `"mapping"` | `"live"`
- Forward `mapping_status` as `status` type
- Add `mapping_status` field to info message

### New WebSocket Message: `mode`
```json
{ "type": "mode", "data": "mapping" | "live" }
```

### Updated `info` message
```json
{
  "type": "info",
  "data": {
    "lidar": true,
    "map": true,
    "pose": true,
    "mode": "live",
    "coverage_pct": 87
  }
}
```

---

## Phase 3: Update slam_params.yaml

For the initial mapping phase (before map_manager_node replaces it):
```yaml
# Only update map when robot moves significantly
minimum_travel_distance: 0.15
minimum_travel_heading: 0.05
# Faster updates while mapping
map_update_interval: 1.0
# Once live mode starts, slam_toolbox can be paused
```

---

## Phase 4: Update brain_node.py

- Subscribe to `/temporary_map` (OccupancyGrid)
- Parse temporary grid into lidar-style range data for obstacle avoidance
- OR: just use the grid directly — check cells in front/sides of robot

### New Obstacle Avoidance Strategy (LIVE mode)
```
def obstacle_in_front() -> float:
    # Check temporary_grid cells in front sector
    # Return minimum distance to occupied cell
    # Return inf if no occupied cells in sector
```

---

## Phase 5: Update entrypoint.sh

- Add `map_manager` node to launch
- `slam_only_launch.py` stays for initial map building (or is replaced by map_manager)

---

## Phase 6: Update CLAUDE.md & claude_for_fe.md

New messages and updated architecture for frontend.

---

## Files to Create/Modify

| File | Action | Description |
|---|---|---|
| `src/.../map_manager_node.py` | CREATE | Two-map occupancy grid builder |
| `src/.../web_bridge.py` | MODIFY | Subscribe to /map_combined, add mode info |
| `src/.../brain_node.py` | MODIFY | Use /temporary_map for obstacle avoidance |
| `src/.../config/map_manager_params.yaml` | CREATE | Grid and threshold parameters |
| `src/.../slam_params.yaml` | MODIFY | Add travel thresholds |
| `entrypoint.sh` | MODIFY | Add map_manager to launch |
| `setup.py` | MODIFY | Add map_manager entry point |
| `CLAUDE.md` | MODIFY | Document new messages and architecture |
| `claude_for_fe.md` | MODIFY | Add mode info and new messages |

---

## Risk Assessment

- **map_manager_node** builds its own grid (doesn't use slam_toolbox output) — avoids conflict
- Frontend only sees combined map — no API change needed, just new message fields
- brain_node gets both raw `/scan` (for now) and `/temporary_map` — can be phased in
- File saving on Pi: use `/app/saved_map.json` (persistent across container restarts via volume)
