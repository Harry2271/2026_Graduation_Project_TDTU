# Robot Controller (Brain) — Design Spec

**Date:** 2026-06-07
**Status:** Approved (pending user review of this document)
**Owner:** brain_node.py author

## Context

The `robot-for-nguyen` monorepo today has a half-built robot stack. The Pi 5
runs `slam_toolbox` + `map_manager_node.py` + `web_bridge.py`, and the
firmware/ESP32 has reactive motor control. The two halves do not talk to
each other — there is no `brain_node.py` (declared in `setup.py` but the
file is missing), no `esp32_bridge.py` (the Pi↔ESP32 UART wrapper
referenced in `services/robot/CLAUDE.md` was never merged), no Nav2, no
AprilTag pipeline, and the API has no concept of a `Job`.

The user wants the robot to:
1. Autonomously explore a room and draw a SLAM map.
2. After the map is done, accept delivery jobs from the warehouse web UI.
3. Each job: pick up a package from one shelf slot, carry it to another.
4. If the destination shelf is occupied, stop and wait for a "move out"
   command (the user's exact rule).

Shelf slots have a fixed `(slotX, slotY)` in the SLAM map frame **and** a
fixed `aprilTagId` (0..586). Tags are physically printed and stuck on
each slot during warehouse setup. The robot auto-discovers shelf
positions at runtime by scanning AprilTags, looking up the
`(tagId → slot)` map in the API.

The **ESP32 firmware is out of scope for this design.** The brain
talks to it through an abstract `Esp32Bridge` interface; the bridge is
fully unit-testable with a `FakeEsp32Bridge` so the brain can be
developed and validated before the firmware is implemented.

## Approach (chosen)

**Option A — Single `brain_node.py` + new Nav2 layer (recommended, accepted).**

- `brain_node.py` (new) is the high-level state machine, single owner of
  "what is the robot doing right now."
- It talks to Nav2 via `nav2_simple_commander` for path planning.
- It drives the ESP32 via the new `esp32_bridge.py` over UART.
- It runs the AprilTag vision pipeline via the new `april_tag_node.py`.
- It connects to the API as a Socket.io client on a new `/robot`
  namespace and exchanges `job:*` / `robot:*` events.

The existing `map_manager_node.py` and `web_bridge.py` are **unchanged**.
The brain subscribes to `map_manager`'s `/mapping_status` to know when
the map is ready, then drives its own state machine on top.

## Architecture

```
┌───────────────────────────────────────────────────────────────┐
│          NestJS API (apps/api) on Pi 5                       │
│  • RobotGateway (NEW) — Socket.io namespace /robot           │
│  • JobService (NEW)  — Job CRUD, dispatch, auto-cleanup     │
│  • ShelfService UPDATE — adds slotX, slotY, aprilTagId       │
│  • SlotStatus UPDATE — adds RESERVED, TRANSIT                 │
│  • PackageService UPDATE — auto-assigns on create             │
└────────────────────┬──────────────────────────────────────────┘
                     │ Socket.io (namespace: /robot)
                     │ events: job:dispatch, job:status, robot:state, robot:pose
┌────────────────────▼──────────────────────────────────────────┐
│        brain_node.py (NEW) — Pi 5 — PM2 process               │
│  • High-level state machine                                  │
│    (BOOT, EXPLORE, MAPPING_DONE, IDLE, JOB_*, E_STOP, ERROR) │
│  • Subscribes to /cmd_vel from Nav2 → ESP32Bridge.move()      │
│  • Subscribes to /mapping_status from map_manager             │
│  • Runs frontier-explore algorithm when in EXPLORE           │
│  • AprilTag vision coordination via /detected_tags            │
│  • Socket.io client to API                                    │
└──┬──────────┬───────────┬────────────────┬──────────────────┘
   │ ROS 2    │ ROS 2     │ UART 115200    │ Camera /dev/video0
   │ /cmd_vel │ /mapping/ │ JSON line-     │ Logitech BRIO
   │          │  status   │ terminated     │
┌──▼───────┐ ┌▼─────────┐ ┌▼──────────────┐ ┌▼─────────────────┐
│  Nav2    │ │ map_mgr  │ │ ESP32-S3      │ │ april_tag_node   │
│  (NEW)   │ │ unchanged│ │ firmware:     │ │ (NEW)            │
│  planner │ │ + web_   │ │  deferred     │ │                  │
│  + local │ │  bridge  │ │  phase        │ │                  │
│  planner │ │ unchanged│ │               │ │                  │
└──────────┘ └──────────┘ └───────────────┘ └──────────────────┘
```

### PM2 processes on the Pi (new + existing)

| PM2 name | Process | Status |
|---|---|---|
| `nexus-robot-lidar` | `ros2 launch my_robot_controller lidar_only_launch.py` | existing |
| `nexus-robot-slam` | `ros2 launch my_robot_controller slam_only_launch.py` | existing |
| `nexus-robot-map-manager` | `ros2 run my_robot_controller map_manager` | existing |
| `nexus-robot-web-bridge` | `ros2 run my_robot_controller web_bridge` | existing |
| `nexus-robot-nav2` | `ros2 launch my_robot_controller nav2_launch.py` | **NEW** |
| `nexus-robot-brain` | `ros2 run my_robot_controller brain` | **NEW** |
| `nexus-robot-vision` | `ros2 run my_robot_controller april_tag_node` | **NEW** |

`deploy.sh` is updated to start the 3 new PM2 processes after
`colcon build`.

## Brain state machine (7+ states)

Single owner of "what is the robot doing right now."

| State | Enter | Exit | Publishes to API |
|---|---|---|---|
| `BOOT` | PM2 starts node | All subsystems (Nav2, ESP32 UART, camera, API socket) report healthy | `robot:state: BOOT` |
| `EXPLORE` | User sends `cmd: explore` (or `BOOT` finishes and no map exists) | Frontier exploration finds no more frontiers | `robot:state: EXPLORE`, periodic `robot:explore_progress` |
| `MAPPING_DONE` | `EXPLORE` exhausts frontiers | slam_toolbox saves map to YAML+PGM (set `use_map_saver: true`) | `robot:state: MAPPING_DONE`, `robot:map_saved` |
| `IDLE` | `MAPPING_DONE` or job completed or `cmd: idle` | Job received | `robot:state: IDLE` |
| `JOB_NAV_TO_PICKUP` | Job `status` → `in_progress`, scan AprilTag at source slot | Nav2 reports `GoalReached` | `robot:state`, `job:status: at_pickup` |
| `JOB_WAIT_FOR_CLEAR` | Tried to place at destination but slot is occupied | User sends `cmd: clear_shelf` (auto-cleanup job completes) | `robot:state`, `job:blocked: <reason>` |
| `JOB_NAV_TO_DROPOFF` | Pickup complete, destination confirmed free | Nav2 reports `GoalReached` | `robot:state`, `job:status: at_dropoff` |
| `JOB_PLACE` | Reached destination | AprilTag re-scanned + placed | `robot:state`, `job:status: placed` |
| `E_STOP` | IR sensor trip, low battery, API `cmd: e_stop`, ESP32 reports `e_stop: true` | `cmd: e_stop_clear` | `robot:state: E_STOP`, `robot:alarm` |
| `ERROR` | Lost SLAM localization, ESP32 UART timeout > 2s, camera read fail | Operator `cmd: reset` | `robot:state: ERROR`, `robot:error` |

## Slot state machine (ShelfSlot.status)

| Status | Meaning | Transitions |
|---|---|---|
| `AVAILABLE` | empty, robot can place here | → `RESERVED` (job created) or `OCCUPIED` (manual assign) |
| `RESERVED` | job created but not yet picked up; package still at previous slot | → `TRANSIT` (brain picks up) or `AVAILABLE` (job cancelled) |
| `OCCUPIED` | has a package, robot not moving it | → `TRANSIT` (brain picks up) or `AVAILABLE` (manual remove) |
| `TRANSIT` | package is on the robot (not at any slot) | → `OCCUPIED` (placed at destination) or `OCCUPIED` (rolled back to source on failure) |

## Job flow

```
Web (inventory page)          API (RobotGateway/JobService)        Brain (Pi 5)                  ESP32
─────────────────────         ─────────────────────────────        ──────────────                ──────
                              Seed: ShelfSlot.slotX/Y/AprilTagId
                              preloaded by Calibrate page
                              │
User clicks "PHÁT LỆNH AGV"   │
PUT /shelves/S1A1/package    │
{targetSlotCode: S2C3}       │
        │                     │
        ▼                     │
JobService.dispatchMove()    │
  1. Check toSlot exists,    │
     has slotX/Y/AprilTagId  │
  2. Check toSlot.status     │
     == AVAILABLE            │
  3. Check fromSlot.status   │
     == OCCUPIED             │
  4. Create Job {            │
     type: 'move',           │
     from: S1A1, to: S2C3,   │
     status: 'pending'}      │
  5. fromSlot → RESERVED     │
  6. emit('job:dispatch') ───►│ Brain subscribes via Socket.io /robot namespace
  7. return 202 {jobId}      │
                              ▼
                        ┌─────────────────────────────────────┐
                        │ Brain receives job:dispatch         │
                        │ 1. state: IDLE → JOB_NAV_TO_PICKUP  │
                        │ 2. Look up fromSlot.slotX/Y + tagId │
                        │ 3. Nav2 NavigateToPose(...)         │
                        │ 4. Nav2 plans, publishes /cmd_vel  │
                        │ 5. Esp32Bridge subscribes /cmd_vel, │
                        │    sends move JSON to ESP32          │
                        │ 6. ESP32 drives, encoder back       │
                        │ 7. Nav2 localizes, adjusts          │
                        │ 8. On GoalReached → state:          │
                        │    JOB_NAV_TO_DROPOFF               │
                        │ 9. NavigateToPose(toSlot)           │
                        │ 10. On arrival → scan AprilTag at   │
                        │    toSlot via /detected_tags        │
                        │    a. tag matches expected + free   │
                        │       → state: JOB_PLACE            │
                        │    b. tag occupied by another pkg   │
                        │       → state: JOB_WAIT_FOR_CLEAR   │
                        │ 11. After place → emit 'job:status: │
                        │     completed'                      │
                        │     API:                             │
                        │       - fromSlot → AVAILABLE         │
                        │       - toSlot → OCCUPIED            │
                        │       - PackageService.update()     │
                        │       - emit 'shelf:updated'         │
                        └─────────────────────────────────────┘
                              │
                              ▼
Web receives 'job:status'     │
event, updates UI:           │
"Đã giao kiện hàng"          │
```

### The "wait for clear" rule

When the brain arrives at the destination and the AprilTag reports it's
occupied (or the vision sees a different package's tag there), the
brain enters `JOB_WAIT_FOR_CLEAR`:

1. Brain emits `job:blocked { jobId, blockerJobId: null, reason: "destination_occupied" }` to the API.
2. API patches the original `Job.status` to `blocked`.
3. API auto-creates a new `Job` of `type: "move"` to relocate the
   blocker package to the nearest free slot.
4. Brain executes the auto-cleanup job first (returns to
   `JOB_NAV_TO_PICKUP` for the cleanup).
5. After the cleanup completes, brain re-enters the original
   `JOB_NAV_TO_DROPOFF` step.

If the cleanup job also gets blocked (rare, would mean the warehouse
is full), the brain emits `robot:alarm` and waits for the operator.

### The "package removed" flows (manual, no robot)

| User action | What happens | Robot involvement |
|---|---|---|
| `DELETE /packages/:id` | API clears slot, deletes package, emits `package:deleted` | **None** — human took the package out |
| `DELETE /shelves/:slotCode/package` | API clears slot, marks package FINISHED, emits `shelf:updated` | **None** — human took the package out |
| `PUT /shelves/:slotCode/package { targetSlotCode }` | **NEW:** creates `Job`, dispatches to brain, returns 202 | **Yes** — robot physically moves it |
| `POST /shelves/:slotCode/package { packageId }` | API assigns package to empty slot, emits `shelf:updated` | **None** — operator places it manually |

There is no special "delete" job type. A delete is a `move` to a
designated "out" slot (e.g. `S0OUT` or any free slot). The web UI will
add a "Lấy ra khỏi kệ" button that issues a `move` job to slot `OUT`.

## Contracts

### Contract 1: `Esp32Bridge` (Python, brain ↔ ESP32)

Lives in `services/robot/src/my_robot_controller/my_robot_controller/esp32_bridge.py`.
Pure async. Two implementations:
- `RealEsp32Bridge` (production, `pyserial-asyncio`)
- `FakeEsp32Bridge` (tests, in-memory queue)

```python
class Esp32Bridge(Protocol):
    async def connect(self) -> None: ...
    async def disconnect(self) -> None: ...
    async def move(self, vx: int, vy: int, omega: int) -> None: ...
    async def stop(self) -> None: ...
    async def e_stop(self) -> None: ...
    async def clear_e_stop(self) -> None: ...
    async def heartbeat(self) -> None: ...
    async def get_status(self) -> dict: ...
    async def get_encoder(self) -> list[dict]: ...

    @property
    def on_status_update(self) -> Callable[[dict], None]: ...
    @property
    def on_encoder_update(self) -> Callable[[list[dict]], None]: ...
    @property
    def on_e_stop(self) -> Callable[[], None]: ...
    @property
    def on_error(self) -> Callable[[str], None]: ...
```

**Rules:**
- Heartbeat task is its own coroutine, started by `connect()`, 50ms interval.
- Send queue with backpressure: drop oldest non-heartbeat command if
  UART write blocks > 50ms (robot safety).
- All public methods are idempotent and safe to call concurrently; the
  bridge serializes writes internally with an `asyncio.Lock`.
- `FakeEsp32Bridge` records every command sent + every event raised
  for assertion in tests.

### Contract 2: RobotGateway Socket.io events (`/robot` namespace)

| Direction | Event | Payload |
|---|---|---|
| API → Brain | `job:dispatch` | `{ jobId, type: "move", packageId, fromSlot, toSlot, fromTag, toTag }` |
| API → Brain | `cmd:e_stop` | `{}` |
| API → Brain | `cmd:idle` | `{}` |
| API → Brain | `cmd:explore` | `{}` |
| API → Brain | `cmd:reset` | `{}` |
| Brain → API | `robot:state` | `{ state, jobId?, message? }` |
| Brain → API | `robot:pose` | `{ x, y, theta }` (2 Hz) |
| Brain → API | `robot:battery` | `{ pct, voltage }` (0.1 Hz) |
| Brain → API | `job:ack` | `{ jobId, accepted, reason? }` (within 1s of dispatch) |
| Brain → API | `job:status` | `{ jobId, status, error? }` |
| Brain → API | `job:blocked` | `{ jobId, blockerJobId, reason }` |
| Brain → API | `robot:alarm` | `{ type, message }` (operator must clear) |
| Brain → API | `robot:error` | `{ component, message }` (soft fault) |

**Auth:** static token `ROBOT_BRAIN_TOKEN`, validated on connect via
Socket.io `auth` field. Stored in `apps/api/.env` and `services/robot/.env`.

## Data model changes

### `ShelfSlot` schema additions

```typescript
@Prop({ required: false })
slotX?: number;  // meters in SLAM map frame, set during Calibrate

@Prop({ required: false })
slotY?: number;  // meters in SLAM map frame, set during Calibrate

@Prop({ required: false })
aprilTagId?: number;  // fixed tag ID for this slot (0..586)

@Prop({ required: false, default: null })
facingTheta?: number;  // radians, the yaw the robot must face when stopped at this slot
```

### `ShelfSlot.status` enum addition

`RESERVED`, `TRANSIT` (existing: `AVAILABLE`, `OCCUPIED`).

### `Package` schema additions

```typescript
@Prop({ required: false })
targetSlotCode?: string;  // set when user picks destination in web UI

@Prop({ required: false })
sourceSlotCode?: string;  // set when user picks source in web UI
```

### New `Job` collection

```typescript
{
  _id: ObjectId,
  type: "move" | "explore" | "calibrate",
  packageId?: ObjectId,
  fromSlotCode: string,
  toSlotCode?: string,
  status: "pending" | "dispatched" | "in_progress" | "at_pickup"
        | "at_dropoff" | "placed" | "completed" | "failed"
        | "blocked" | "cancelled",
  brainJobId?: string,
  errorMessage?: string,
  blockedByJobId?: ObjectId,
  createdAt, startedAt?, completedAt?,
}
```

### New env vars

- `apps/api/.env`: `ROBOT_BRAIN_TOKEN` — shared secret for brain↔API auth.
- `services/robot/.env`: same `ROBOT_BRAIN_TOKEN`, plus
  `API_SOCKET_URL` (e.g. `http://localhost:5000/robot`),
  `MONGO_TRANSIT_RETENTION_HOURS` (default 24).

## Frontend changes (apps/web)

### `PUT /shelves/:slotCode/package` response change

- **Old:** 200 with updated slot
- **New:** 202 with `{ jobId, status: "dispatched" }`

The inventory page's "PHÁT LỆNH AGV" button is updated to handle the
202 response and show a "Job in progress" toast until `job:status:
completed` arrives via Socket.io.

### New `/calibrate` page (one-time warehouse setup)

- Shows the SLAM map (PNG loaded via a new `GET /api/robot/map-image`).
- Sidebar lists 64 slots.
- Click a slot → click on the map to set `(slotX, slotY)`. Drag a
  handle to set `facingTheta`.
- Separate "AprilTag assignment" section: scan or manually enter
  `aprilTagId` (0-586).
- Save → `PUT /shelves/:slotCode/coordinates` (per-slot) or
  `PUT /shelves/coordinates/batch` (bulk).
- Slots with `slotX === undefined` are excluded from job dispatch.
- Bulk mode: click 4 corners of each shelf, page auto-distributes 16
  slots in a 4×4 grid.

## Files to create / modify

### New files (controller)

| File | Purpose |
|---|---|
| `services/robot/src/my_robot_controller/my_robot_controller/brain_node.py` | High-level state machine, Nav2 client, vision coordination, API client |
| `services/robot/src/my_robot_controller/my_robot_controller/esp32_bridge.py` | Pi↔ESP32 UART wrapper, with `RealEsp32Bridge` and `FakeEsp32Bridge` |
| `services/robot/src/my_robot_controller/my_robot_controller/april_tag_node.py` | Camera + AprilTag detector, publishes `/detected_tags` |
| `services/robot/src/my_robot_controller/launch/nav2_launch.py` | Nav2 bringup |
| `services/robot/src/my_robot_controller/config/nav2_params.yaml` | Nav2 tuning |
| `services/robot/deploy.sh` | UPDATE — start 3 new PM2 processes |
| `services/robot/setup.py` | UPDATE — register `brain` and `april_tag_node` entry points (entry point already declared for `brain`, just needs the file) |
| `services/robot/install-pi.sh` | UPDATE — install `nav2-bringup`, `nav2-simple-commander`, `pupil-apriltags`, `pyserial-asyncio` |

### New files (API)

| File | Purpose |
|---|---|
| `apps/api/src/modules/robot/robot.gateway.ts` | Socket.io `/robot` namespace, brain auth |
| `apps/api/src/modules/robot/robot.service.ts` | Holds the single brain client connection, forwards events |
| `apps/api/src/modules/job/job.schema.ts` | Mongoose `Job` schema |
| `apps/api/src/modules/job/job-service.ts` | Job CRUD, dispatch, auto-cleanup |
| `apps/api/src/modules/job/job-controller.ts` | `GET /jobs`, `GET /jobs/:id` (operator viewing) |
| `apps/api/src/modules/job/job.module.ts` | NestJS wiring |
| `apps/api/src/modules/job/dto/` | DTOs |
| `apps/api/src/modules/shelf/shelf-service.ts` | UPDATE — `assignCoordinates()`, `assignAprilTag()` |
| `apps/api/src/modules/shelf/shelf-controller.ts` | UPDATE — `PUT /shelves/:slotCode/coordinates`, `PUT /shelves/coordinates/batch` |
| `apps/api/src/modules/shelf/schemas/shelf-slot.schema.ts` | UPDATE — add `slotX, slotY, aprilTagId, facingTheta`; extend `SlotStatus` |
| `apps/api/src/modules/shelf/shelf.module.ts` | UPDATE — register `MapsController` |
| `apps/api/src/modules/maps/maps.controller.ts` | NEW — `GET /api/robot/map-image` (static file serve) |
### Updated flow: package auto-assign to slot by package tag

Two separate AprilTag concepts exist in this design:

- **Shelf slot tag** (`ShelfSlot.aprilTagId`, 0..586): printed and
  physically stuck on the shelf. Set once during Calibrate. The robot
  reads it to localize itself at the slot.
- **Package tag** (`Package.tagId`, 0..586): printed and stuck on the
  package. Set by `PackageService.create()` from the existing
  `pickLowestFreeTagId()` pool. Used to identify *which* package is at
  a slot.

**Package auto-assign rule:** when a new package is created
(`POST /packages`), `PackageService` records it with `status: CREATED`
and an auto-allocated `tagId`. It does **not** auto-assign to a slot.
The operator (or upstream system) then places it on a shelf either
manually (using the existing `POST /shelves/:slotCode/package`) or via
a robot job. This is unchanged from today.

**Robot "auto assign" rule:** during a robot job, the brain uses
AprilTag vision to identify *which* slot a package belongs to. The
flow is:
1. Brain arrives at the destination slot.
2. Vision reads the **package's** `tagId` from the package on the
   robot's tray.
3. Vision reads the **shelf slot's** `aprilTagId` from the shelf.
4. API looks up: `ShelfSlot.findOne({ aprilTagId: slotTagSeen })`
   → that's the destination.
5. If that slot is already `OCCUPIED` by a different packageId,
   brain enters `JOB_WAIT_FOR_CLEAR`.

So the user's "new package created must auto assign to the shelf" is
realized by **the AprilTag vision pipeline** at job-execution time, not
at package-create time. The `POST /packages` endpoint behavior is
unchanged from today.

### API files (final)

| File | Purpose |
|---|---|
| `apps/api/src/modules/robot/robot.gateway.ts` | Socket.io `/robot` namespace, brain auth |
| `apps/api/src/modules/robot/robot.service.ts` | Holds the single brain client connection, forwards events |
| `apps/api/src/modules/job/job.schema.ts` | Mongoose `Job` schema |
| `apps/api/src/modules/job/job-service.ts` | Job CRUD, dispatch, auto-cleanup |
| `apps/api/src/modules/job/job-controller.ts` | `GET /jobs`, `GET /jobs/:id` (operator viewing) |
| `apps/api/src/modules/job/job.module.ts` | NestJS wiring |
| `apps/api/src/modules/job/dto/` | DTOs |
| `apps/api/src/modules/shelf/shelf-service.ts` | UPDATE — `assignCoordinates()`, `assignAprilTag()` |
| `apps/api/src/modules/shelf/shelf-controller.ts` | UPDATE — `PUT /shelves/:slotCode/coordinates`, `PUT /shelves/coordinates/batch`; `PUT /shelves/:slotCode/package` returns 202 |
| `apps/api/src/modules/shelf/schemas/shelf-slot.schema.ts` | UPDATE — add `slotX, slotY, aprilTagId, facingTheta`; extend `SlotStatus` |
| `apps/api/src/modules/shelf/shelf.module.ts` | UPDATE — register `MapsController` |
| `apps/api/src/modules/maps/maps.controller.ts` | NEW — `GET /api/robot/map-image` (static file serve) |
| `apps/api/src/modules/package/schemas/package.schema.ts` | UPDATE — add `targetSlotCode, sourceSlotCode` |
| `apps/api/src/app.module.ts` | UPDATE — import `JobModule`, `MapsModule`, `RobotModule` |

### New files (web)

| File | Purpose |
|---|---|
| `apps/web/src/app/calibrate/page.tsx` | One-time warehouse setup |
| `apps/web/src/app/calibrate/CalibrateClient.tsx` | Interactive map + sidebar |
| `apps/web/src/app/inventory/page.tsx` | UPDATE — handle 202 + Job toast on "PHÁT LỆNH AGV" |
| `apps/web/src/app/map/page.tsx` | UPDATE — show live robot state from new `/robot` events |

### New files (firmware, deferred — NOT in this design)

The following are **out of scope** for this design and will be a
separate design pass. They are listed here so the rollout is
unambiguous about what the next firmware phase needs to do.

- `firmware/src/modules/brain_bridge.cpp` — receives `move` JSON over UART
- `firmware/src/modules/odometry_publisher.cpp` — publishes encoder counts
- `firmware/src/modules/imu_bno055.cpp` — initializes BNO055
- `firmware/src/modules/arm_controller.cpp` — 6-servo arm
- `firmware/CLAUDE.md` — UPDATE — describe the new brain protocol
  (this is the one firmware-side deliverable **included in this
  design pass** as a "what the ESP32 needs to do next" reference doc,
  not a code change)

## Rollout

| Phase | Scope | Rollback |
|---|---|---|
| **0: Skeleton** | New modules with empty `main()`, entry points registered | `git revert` |
| **1: Data model + Calibrate** | Shelf schema adds fields, Calibrate page, `PUT /shelves/:slotCode/coordinates` | `git revert` (additive) |
| **2: Esp32Bridge + tests** | Pure Python with full coverage; brain is a thin shell | `pm2 delete nexus-robot-brain` |
| **3: Nav2 bringup** | `nav2_launch.py` + `nav2_params.yaml`; AMCL localizes, no movement | `pm2 delete nexus-robot-nav2` |
| **4: API Gateway** | RobotGateway namespace, JobService, Job schema; "PHÁT LỆNH AGV" creates a `pending` Job | `git revert` (additive) |
| **5: Brain wiring** | Brain connects to API, receives jobs, fakes movement (sleeps + emits status) | `pm2 stop nexus-robot-brain` |
| **6: Real movement (no arm)** | Brain drives real ESP32 via Nav2 + LiDAR; operator loads/unloads manually | `pm2 stop nexus-robot-brain` |
| **7: Arm + pickup/place** | (Later) ESP32 firmware gets arm + IMU + odometry; brain does full pick/place | later design |

## Verification

### Pre-merge gates (Phases 0-2)

| Layer | Test | Pass criteria |
|---|---|---|
| Unit (Python) | `Esp32Bridge` against `FakeEsp32Bridge` via `pytest` | `fake.recv({"cmd":"move","vx":100,"vy":0,"omega":0})` matches expected bytes |
| Unit (Python) | `BrainNode` state machine with mocked Nav2, ESP32, vision, API | Drives through every state transition including `JOB_WAIT_FOR_CLEAR` |
| Unit (NestJS) | `JobService.dispatchMove()` with mocked `RobotGateway` | 202 success, 409 occupied, 400 missing coords |
| Build | `yarn turbo run build --filter=...` | All builds pass |
| Lint | `yarn turbo run lint --filter=...` | No lint errors |

### Post-merge smoke test (every deploy to Pi)

```bash
# 1. PM2 processes
pm2 list | grep -E 'nexus-robot-(brain|nav2|map-manager|web-bridge|lidar|slam|vision)'

# 2. API responds
curl -s http://localhost:5000/api/docs.json | head -c 200

# 3. Brain sees ESP32
pm2 logs nexus-robot-brain --lines 20 | grep "esp32"

# 4. Brain sees Nav2
ros2 topic list | grep -E 'cmd_vel|map|amcl'

# 5. Brain sees camera
pm2 logs nexus-robot-vision --lines 20 | grep "camera"

# 6. Web UI shows live robot state at /map
```

### Hardware-in-loop (Phase 6)

Real robot, real LiDAR, real ESP32 with real motors, **no arm yet**.
Drive through Calibrate → Explore → Move job. A real package moves
between two real shelves.

## Risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | Nav2 doesn't localize well | Phase 3 is a canary; fallback to a hand-rolled `PurePursuitController` (~200 lines) |
| 2 | AprilTag detection unreliable | Tag size 5cm; add camera feed to UI; fall back to `(slotX, slotY)` only |
| 3 | Brain dies mid-job | Slot stays `TRANSIT`; hourly `reconcileSlots()` cron rolls back if `Job.status === 'in_progress'` is silent > 5 min |
| 4 | API loses brain connection | Mark brain `disconnected` after 10s silence; new moves return 503; on reconnect, brain asks for in-progress jobs |
| 5 | ESP32 UART noise | Newline-delimited JSON; bytes without `\n` in 100ms discarded; 2s silence → `ERROR` state |
| 6 | 64-slot calibration tedious | Bulk mode: click 4 corners, page auto-distributes 16 slots in 4×4 |
| 7 | TRANSIT rollback is racy | Optimistic concurrency via `Job.version` int; cron is the safety net |

## Open questions (not blocking)

1. Map image serving: static file via `MapsController`, or proxied from brain? Defer to Phase 1.
2. Re-trigger Calibrate after moving a shelf: "edit coordinates" mode. Defer to Phase 1.
3. Multi-robot: API doesn't model multiple robots yet. `Job.robotId` is a future field; current design doesn't preclude it.
4. Camera stream to web UI: vision node should also publish MJPEG. Out of scope.
