# AprilTag Scan Notification Feature

## Overview

This feature automatically shows a notification with package information when the robot's camera scans an AprilTag. The notification appears in real-time on the web dashboard.

---

## Architecture

```
Robot Camera (Logitech BRIO 100)
    ↓
april_tag_node.py (ROS 2)
    ↓ publishes to /detected_tags
web_bridge.py (ROS 2 → WebSocket)
    ↓ emits 'detected_tags' event
Frontend WebSocket Listener (useAprilTagScan hook)
    ↓ receives tag_id
GET /packages/by-tag/:tagId (NestJS API)
    ↓ queries MongoDB
Ant Design Notification (top-right corner)
```

---

## Implementation Details

### Backend (NestJS API)

**New Endpoint:** `GET /packages/by-tag/:tagId`

**Location:** `apps/api/src/modules/package/package-controller.ts`

**Validation:**
- tagId must be a number between 0-586
- Returns 404 if no package found
- Returns 400 if tagId is invalid

**Response Example:**
```json
{
  "_id": "65a1b2c3d4e5f6789abcdef0",
  "packageName": "Kiện hàng A",
  "status": "IN_PROGRESS",
  "tagId": 42,
  "zoneCode": "S2",
  "createdAt": "2024-01-12T10:30:00.000Z",
  "updatedAt": "2024-01-12T11:45:00.000Z"
}
```

### Frontend (Next.js Web)

**New Hook:** `useAprilTagScan()`

**Location:** `apps/web/src/hooks/useAprilTagScan.tsx`

**Features:**
- Listens to WebSocket `detected_tags` events
- Debounces notifications (3 second cooldown per tag)
- Fetches package info via RTK Query
- Shows success notification with package details
- Shows warning if tag not found in database

**Integrated In:** `apps/web/src/components/MainLayout.tsx`
- Active on all pages while user is logged in

---

## WebSocket Event Format

**Event Name:** `detected_tags`

**Payload:**
```json
{
  "type": "detected_tags",
  "data": {
    "ts": 1787808500.123,
    "tags": [
      {
        "tag_id": 42,
        "x": 0.31,
        "y": 0.02,
        "z": 0.85,
        "yaw": 1.57,
        "pitch": 0.0,
        "roll": 0.0,
        "confidence": 0.92,
        "size_m": 0.166
      }
    ]
  }
}
```

---

## Notification Display

**Success Notification:**
```
✅ Quét thành công AprilTag #42

Kiện hàng A
Trạng thái: Đang xử lý
Khu: S2
```

**Warning Notification (tag not found):**
```
⚠️ AprilTag #42 không tìm thấy

Không có kiện hàng nào được gán với mã tag này.
```

---

## Testing

### 1. Backend Test

```bash
# On the Pi
curl http://localhost:5000/packages/by-tag/0

# Expected: 200 OK with package JSON, or 404 if no package has tagId=0
```

### 2. Frontend Test

```bash
# Local development
cd apps/web
yarn dev

# Open http://localhost:3000
# Login to dashboard
# Point robot camera at a printed tag25h9 AprilTag
```

### 3. End-to-End Test

1. Create a package in the inventory page
2. Note its assigned `tagId` (shown in database, 0-586)
3. Print an AprilTag with that ID from: https://github.com/AprilRobotics/apriltag-imgs/tree/master/tag25h9
4. Hold the printed tag (at least 10cm × 10cm) in front of the robot camera (30-50cm distance)
5. Notification should appear within 1 second

---

## Files Changed

### Backend
- `apps/api/src/modules/package/package-controller.ts` — Added endpoint
- `apps/api/src/modules/package/package-service.ts` — Added service method
- `apps/api/src/modules/package/package-repository.ts` — Added repository query
- `apps/api/src/modules/package/interfaces/package-service.interface.ts` — Updated interface
- `apps/api/src/modules/package/interfaces/package-repository.interface.ts` — Updated interface

### Frontend
- `apps/web/src/store/services/inventoryApi.ts` — Added RTK Query endpoint
- `apps/web/src/hooks/useAprilTagScan.tsx` — **NEW** WebSocket listener + notification logic
- `apps/web/src/components/MainLayout.tsx` — Integrated hook

---

## Key Configuration

### Robot (Pi 5)

**AprilTag Node:**
- Family: `tag25h9`
- Camera: `/dev/video0` (Logitech BRIO 100)
- Resolution: 640×480
- Rate: 10 Hz
- Topic: `/detected_tags` (std_msgs/String JSON)

**Web Bridge:**
- Port: 9091 (WebSocket)
- Forwards `/detected_tags` as `type: 'detected_tags'` event

### Package Model

**Field:** `tagId`
- Type: `number | null`
- Range: 0-586 (587 total tags)
- Auto-allocated when package is created
- Cleared when package status is `FINISHED`
- Sparse unique index (only non-null values checked)

---

## Notes

- **Debouncing:** Same tag won't trigger notification within 3 seconds
- **Tag Family:** Robot is configured for `tag25h9` (not tag36h11 or tag16h5)
- **Print Size:** Tags should be at least 10cm × 10cm for reliable detection
- **Distance:** Hold tag 30-50cm from camera for best results
- **Lighting:** Good lighting improves detection accuracy
- **Two Tag Systems:**
  - `Package.tagId` (0-586) — Dynamic, assigned to packages
  - `ShelfSlot.aprilTagId` (0-586) — Fixed physical tags at shelf slots

---

## Troubleshooting

### Notification doesn't appear

1. **Check WebSocket connection:**
   ```bash
   # In browser console
   # Should see: [Socket] Connected: <socket-id>
   ```

2. **Check robot camera:**
   ```bash
   # On Pi
   pm2 logs nexus-robot-vision --lines 30
   # Should see: april_tag_node ready: device=/dev/video0
   ```

3. **Test tag detection:**
   ```bash
   # On Pi
   ros2 topic echo /detected_tags
   # Hold tag in front of camera, should see JSON output
   ```

4. **Check package has tagId:**
   ```bash
   # In MongoDB or via API
   GET http://localhost:5000/packages
   # Verify package has non-null tagId field
   ```

### Wrong tag family

- Robot expects `tag25h9`
- Download from: https://github.com/AprilRobotics/apriltag-imgs/tree/master/tag25h9
- Other families (tag36h11, tag16h5) won't be detected

### Tag too small

- Minimum recommended size: 10cm × 10cm
- Configured size in node: 16.6cm × 16.6cm
- Smaller tags work but detection distance is reduced

---

## Future Enhancements

1. **Show tag in 3D space:** Display tag position (x, y, z) from camera frame
2. **History log:** Track all scanned tags with timestamp
3. **Sound notification:** Play beep when tag is detected
4. **Batch scan:** Show list when multiple tags detected simultaneously
5. **Package photo:** Display package image if available
6. **Confidence indicator:** Show detection confidence percentage

---

## Related Documentation

- Robot Setup: `services/robot/CLAUDE.md`
- AprilTag Node: `services/robot/src/my_robot_controller/my_robot_controller/april_tag_node.py`
- WebSocket Bridge: `services/robot/src/my_robot_controller/my_robot_controller/web_bridge.py`
- Package API: `apps/api/src/modules/package/`
- Frontend Store: `apps/web/src/store/services/inventoryApi.ts`
