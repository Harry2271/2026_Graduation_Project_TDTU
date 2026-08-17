# AprilTag Route — Implementation Scope & Limitations

> Created: 2026-08-16
> Scope: `services/robot/` + `firmware/` only. No changes to Web, API, Mobile, or deploy.

## What changed

AprilTag recognition in `brain_node.py` now validates each detection against the
expected tag ID with multi-frame confirmation, rejects stale/low-confidence
observations, and performs bounded in-place rotation recovery when the expected
tag is not found. The robot no longer blindly nudges forward during dock
alignment if the camera loses the tag.

## What is deliberately unchanged

| Area | Why it is not in scope |
|---|---|
| `apps/web/` | UI would need new status badges, retry/skip buttons, and tag-display changes — out of scope per request |
| `apps/api/` | API contract already delivers `dropoff.tag_id`; no new fields needed for brain-side verification |
| `apps/mobile/` | Same as web — operator feedback comes via ROS logs and `/demo/status` |
| `docker-compose.yml` / `.github/workflows/` | Deployment unchanged; robot deploy job already picks up `services/robot/**` changes automatically |
| Firmware signal command | Deferred pending hardware pin confirmation (see below) |

## Operator-visible behavior after this change

### Successful path
```
Robot arrives at approach pose
  → Stops
  → Camera searches for the expected AprilTag
  → Tag found with enough confident frames
  → Robot aligns dock (rotate + forward/back)
  → Firmware executes unload
  → Robot leaves dock
```

### Failure: tag not found
```
Robot arrives at approach pose
  → Stops, camera waits (grace period)
  → No tag seen
  → Robot rotates in-place left, then right (bounded angles)
  → Still not found
  → Robot STOPS and stays stopped
  → Error logged: TAG_NOT_FOUND
  → /robot/errors receives severity=error, code=TAG_NOT_FOUND
  → /demo/status receives state=FAILED
  → Robot does NOT autonomously return home
```

### Failure: wrong tag visible
```
Robot arrives at approach pose
  → Camera sees a tag, but it is not the expected ID
  → Robot STOPS immediately
  → Error logged: WRONG_TAG with detected_id
  → Robot does NOT dock to the wrong tag
  → Robot does NOT attempt to find the right tag by driving forward
```

### Failure: tag unstable
```
Robot arrives at approach pose
  → Tag appears briefly then disappears
  → Robot STOPS, does not begin alignment
  → Error logged: TAG_UNSTABLE
  → Operator re-dispatches or manually teleops
```

## Physical alerting (LED / buzzer) — NOT IMPLEMENTED

The original plan included LED/buzzer signaling via firmware GPIO.
This was **cancelled** after discovering:

- **GPIO2** is `CYLINDER_IN1_PIN` (`firmware/include/config.h:295`) —
  it drives the L298N H-bridge for the electric cylinder.
  The firmware's early `pinMode(2, OUTPUT); digitalWrite(2, LOW)` in
  `setupHardware()` was a legacy LED init that was always overridden by
  the cylinder actuator `begin()`. It has been corrected to a no-op comment.

- **No free output-capable GPIO** exists on the WeAct ESP32-S3 N16R8
  after allocating: 16 motor PWM, 4 encoder PCNT, 4 IR digital input,
  1 Sharp ADC, 1 I2C bus (3 devices), 2 cylinder L298N, 2 cargo/limit
  switch, 1 limit switch retract, 2 UART (Pi link). See `firmware/PIN_MAP.md`.

- Physical alerting requires adding a buzzer module (passive tone or
  active beep) to a new GPIO, plus a transistor/driver if current draw
  exceeds 12 mA. This needs a wiring review and pin reassignment.

**Until hardware is confirmed**, all error signaling is via:
- ROS log output (`pm2 logs nexus-robot-brain`)
- ROS topic `/robot/errors` (JSON)
- ROS topic `/demo/status` (JSON, demo/route path)
- Best-effort `robot:error` Socket.io event to API (if API is reachable)

Firmware type-129 frames on `/esp32/error` remain reserved for firmware faults;
they do not represent Pi-side AprilTag recognition failures.

## ROS error codes for tag-related failures

| Code | Severity | Meaning |
|---|---|---|
| `TAG_NOT_FOUND` | error | Expected tag not visible after grace period + rotation recovery |
| `WRONG_TAG` | error | A different tag was visible but not the expected one |
| `TAG_LOW_CONFIDENCE` | warning | Tag visible but below confidence threshold |
| `TAG_UNSTABLE` | error | Tag appeared then disappeared during verification |
| `TAG_RECOVERY_FAILED` | error | Rotation recovery completed but tag still not found |
| `TAG_TOO_FAR` | warning | Tag visible but distance exceeds valid dock range |
| `TAG_TOO_CLOSE` | warning | Robot too close to tag for safe alignment |
| `CAMERA_OFFLINE` | proposed | Requires a detector heartbeat; this change safely reports `TAG_NOT_FOUND` instead because an empty scene and an offline camera are indistinguishable without a heartbeat |
| `DOCK_ALIGN_TIMEOUT` | error | Alignment procedure timed out (existing, unchanged) |
| `NAV_FAILED` | error | Nav2 failed to reach approach pose (existing, unchanged) |

## Safety defaults

- **No forward movement** during tag search/recovery. Only in-place rotation.
- **Stop immediately** when tag is lost during alignment. No blind nudge.
- **Do not dock** unless tag has been verified through the multi-frame pipeline.
- **Do not return home** autonomously after a tag failure. Operator must re-dispatch.
- **Never substitute** a visible wrong tag for the expected one.
