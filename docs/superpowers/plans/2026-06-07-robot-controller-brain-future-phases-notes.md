# Robot Controller Brain — Future Phase Notes (Phases 3-7)

**Companion to:** `2026-06-07-robot-controller-brain-plan.md` (Phases 0-2, shipped) and `docs/superpowers/specs/2026-06-07-robot-controller-brain-design.md` (the source of truth).

**Status:** Notes for the author. Each phase below is a separate implementation plan; do not start work on a phase without writing a fresh plan file (use the brainstorming + writing-plans skills).

---

## Phase 3 — Nav2 bringup

**Goal:** Real AMCL localization + global planner + DWA local planner on the saved SLAM map. Brain can now `NavigateToPose` to a slot.

### Files to modify
- `services/robot/src/my_robot_controller/launch/nav2_launch.py` — replace empty `LaunchDescription` with real Nav2 bringup (AMCL + planner_server + controller_server + bt_navigator + costmap_2d + lifecycle_manager)
- `services/robot/src/my_robot_controller/config/nav2_params.yaml` — replace the `amcl: use_sim_time: false` placeholder with the full per-node param tree

### New behavior
- AMCL localizes the robot on `/home/pi/robot_ws/maps/latest.pgm` at startup. Initial pose from a parameter (default: `0, 0, 0`) until Calibrate supplies a better estimate.
- Global planner: `navfn` (or `navfn_planner` if available in Jazzy) — simple, fast, no behavior-tree overhead.
- Local planner: `dwa_local_planner` with conservative parameters (low max_vel, tight footprint — the robot has a 5-DOF arm on top, so be careful).
- Lifecycle manager brings all nodes up in the right order; fails fast if `/map` or TF isn't ready.

### Brain-side consumer
- `brain_node` gains a Nav2 action client (`nav2_simple_commander`).
- New method: `async def navigate_to(self, x: float, y: float, theta: float) -> None` that wraps `BasicNavigator.goToPose`.
- During `JOB_NAV_TO_PICKUP` and `JOB_NAV_TO_DROPOFF`, the brain calls `navigate_to(slotX, slotY, facingTheta)`.

### Verification gates
- `ros2 launch my_robot_controller nav2_launch.py` — all 5 nodes come up
- `ros2 topic list` shows `/amcl_pose`, `/plan`, `/cmd_vel`
- `pm2 logs nexus-robot-nav2` — no errors after 30s
- Manual: `ros2 topic pub /initialpose ...` to seed AMCL, then drive the robot with `ros2 run teleop_twist_keyboard teleop_twist_keyboard`, verify TF doesn't jump

### Open questions to resolve before starting
- Do we want `dwb_plugins` (successor to DWA) or stay on `dwa_local_planner`? Default: stay on DWA for Jazzy compatibility.
- AMCL initial pose source: hard-coded parameter, or read from a `~/.robot/initial_pose.yaml` file written by the Calibrate page? Recommend: parameter, with Calibrate writing a known-good pose.
- Recovery behaviors: default Nav2 has 3 (rotate, back-up, wait). Tune or disable based on real-world behavior.

---

## Phase 4 — API Gateway (`/robot` namespace + Job entity)

**Goal:** The NestJS API can dispatch delivery jobs to the brain over a Socket.io namespace. The web "PHÁT LỆNH AGV" button now creates a `Job` and emits `job:dispatch` to the brain.

### New files
- `apps/api/src/modules/job/job.schema.ts` — Mongoose `Job` collection (see spec for full shape)
- `apps/api/src/modules/job/job-service.ts` — `dispatchMove()` (validates toSlot exists, has coordinates+tag, packageId set; creates Job; emits `job:dispatch` to `/robot` namespace; returns 202 with jobId)
- `apps/api/src/modules/job/job-controller.ts` — `GET /jobs`, `GET /jobs/:id` (operator viewing)
- `apps/api/src/modules/job/job.module.ts`
- `apps/api/src/modules/job/dto/dispatch-move.dto.ts` — `{ packageId, fromSlotCode, toSlotCode }`
- `apps/api/src/modules/robot/robot.gateway.ts` — Socket.io `@WebSocketGateway({ namespace: '/robot' })`, validates `ROBOT_BRAIN_TOKEN` on connect
- `apps/api/src/modules/robot/robot.service.ts` — holds the single brain client connection, exposes `dispatchJob(job)` and `setStatus(jobId, status)` methods
- `apps/api/src/modules/robot/robot.module.ts`

### Modified files
- `apps/api/src/modules/shelf/shelf-controller.ts` — `PUT /shelves/:slotCode/package { targetSlotCode }` rewired: instead of instant DB move, calls `JobService.dispatchMove()` and returns 202 `{ jobId, status: "dispatched" }` (BREAKING — web app must update)
- `apps/api/src/modules/shelf/shelf-service.ts` — `movePackage` keeps the old behavior but is no longer called from the controller; consider deprecating
- `apps/api/src/app.module.ts` — register `JobModule` and `RobotModule`
- `apps/api/src/gateway/events-gateway.ts` — emit `job:created`, `job:updated`, `job:blocked` events to the user-facing namespace
- `apps/web/src/app/inventory/page.tsx` — handle 202 + Job toast, subscribe to `job:updated` Socket.io events for live progress

### New env var
- `ROBOT_BRAIN_TOKEN` — shared secret for brain↔API auth. Stored in `apps/api/.env` and `services/robot/.env`. Generate with `openssl rand -hex 32`.

### Brain-side consumer (deferred to Phase 5)
For now, the gateway can dispatch to a stub brain (or no brain at all) — the events just queue in memory or get dropped. The real brain subscriber comes in Phase 5.

### Verification gates
- Unit tests for `JobService.dispatchMove()` with mocked gateway (verify 202 on success, 409 on occupied target, 400 on missing coords, 400 on missing package)
- `socket.io-client` smoke test: connect to `/robot` with the token, verify handshake
- Manual: open `https://web.nguyen-robot.io.vn/inventory`, click "PHÁT LỆNH AGV", verify the new 202 toast and the new `/jobs` row

### Open questions to resolve before starting
- Single-robot or multi-robot? Current design assumes one brain. If multi, add `robotId` to Job and a per-robot namespace.
- Should the brain re-validate the job (re-check slot availability via the API) before executing? Or trust the dispatch? Recommend: trust dispatch, but re-validate via AprilTag vision at arrival.
- Auto-cleanup job on `JOB_WAIT_FOR_CLEAR`: create as a separate `Job` (so the operator sees it in the UI) or a hidden internal task? Recommend: visible Job for operator awareness.

---

## Phase 5 — Brain wiring (API client + faked movement)

**Goal:** The brain connects to the API as a Socket.io client. It receives jobs, walks the state machine through `JOB_NAV_TO_PICKUP` → `JOB_NAV_TO_DROPOFF` → `JOB_PLACE` → `IDLE` (faked movement: just sleeps + emits status events). The web `/map` page shows live robot state.

### New files
- `services/robot/src/my_robot_controller/my_robot_controller/api_client.py` — `BrainApiClient` class wrapping the Socket.io client. Methods: `connect()`, `disconnect()`, `emit_state(state)`, `emit_pose(x, y, theta)`, `emit_job_status(job_id, status)`, `on_job_dispatch(callback)`. Implement with `python-socketio[asyncio_client]`.
- `services/robot/src/my_robot_controller/tests/test_api_client.py` — unit tests with a mock Socket.io client

### Modified files
- `services/robot/src/my_robot_controller/my_robot_controller/brain_node.py` — add API client, subscribe to `job:dispatch`, drive the state machine
  - New method: `_handle_job_dispatch(payload)` that creates a `Job` object and calls `_execute_job(job)` (a coroutine)
  - New method: `_execute_job(job)` walks the state machine, sleeps to fake movement, emits `job:status` events at each transition
  - State transitions publish to `robot:state` and `job:status` Socket.io events
  - `JOB_WAIT_FOR_CLEAR` flow: emit `job:blocked` with `blockerJobId: null`, then create an auto-cleanup job via API
- `services/robot/deploy.sh` — add `ROBOT_BRAIN_TOKEN` and `API_SOCKET_URL` env vars to the brain PM2 process
- `services/robot/install-pi.sh` — install `python-socketio[asyncio_client]`

### Verification gates
- `pm2 logs nexus-robot-brain` — connect, subscribe, idle
- Open web `https://web.nguyen-robot.io.vn/inventory`, click "PHÁT LỆNH AGV"
- `pm2 logs nexus-robot-brain` — see the state transitions: `state: IDLE -> JOB_NAV_TO_PICKUP`, sleep 5s, `state: -> JOB_NAV_TO_DROPOFF`, etc.
- `pm2 logs nexus-robot-api` — see the inbound `job:dispatch` and outbound `job:status` events
- Web `/map` page shows the live state in the footer
- Web `/inventory` shows the job lifecycle in real time

### Open questions to resolve before starting
- Should the brain publish pose at 2Hz continuously, or only on state transitions? Spec says 2Hz. Will the web client be able to keep up?
- Where does `ROBOT_BRAIN_TOKEN` live? Gitignored `.env` in both `apps/api/` and `services/robot/`. Document in both CLAUDE.md files.

---

## Phase 6 — Real movement (RealEsp32Bridge + Nav2)

**Goal:** Replace `FakeEsp32Bridge` with `RealEsp32Bridge` backed by `pyserial-asyncio`. The brain drives the real motors via Nav2. No arm yet — operator loads/unloads packages manually.

### Files to modify
- `services/robot/src/my_robot_controller/my_robot_controller/brain_node.py` — `RealEsp32Bridge` instantiated in `__init__`, connected in `on_start` (new lifecycle hook), disconnected on shutdown
- `services/robot/src/my_robot_controller/my_robot_controller/esp32_bridge.py` — add a `_reader_loop` task in `RealEsp32Bridge.connect()` that parses incoming `type:128/129/130/131` JSON lines and fires the four `on_*` callbacks (reviewer I2 from final code review)
- `services/robot/install-pi.sh` — install `pyserial-asyncio`
- `services/robot/deploy.sh` — set ESP32 UART device path env var (`ESP32_UART=/dev/ttyAMA0` on Pi 5)

### Hardware setup
- Connect ESP32-S3 UART2 (GPIO 43 TX, GPIO 44 RX) to Pi 5 UART
- Verify UART is enabled in `/boot/firmware/config.txt` (need `enable_uart=1` and `dtoverlay=disable-bt` to free up the UART pins)
- Verify ESP32 firmware responds to `{"cmd":"heartbeat"}` with `{"type":128,"data":{"cmd":"heartbeat"}}` (existing firmware supports this; no firmware changes needed for Phase 6)

### Verification gates
- `RealEsp32Bridge` heartbeat task runs, ESP32 receives heartbeats, sends `type:131` status every 5s
- Brain's `on_e_stop` callback fires when ESP32 reports `e_stop: true` (test by manually sending `{"cmd":"e_stop"}` via `pio device monitor`)
- Brain drives the robot to a slot — real wheels turn, real motors respond
- AMCL stays localized throughout the drive (TF doesn't jump)
- Operator can manually load a package at S1A1, brain navigates there, returns, navigates to S2C3, operator unloads

### Open questions to resolve before starting
- Wheel odometry: do we trust AMCL scan-matching, or also fuse wheel encoder counts? Spec says "Coordinate accuracy for SLAM is the top concern" — recommend wheel-encoder fusion via `robot_localization` package.
- Camera streaming: is `/camera` page live yet? If not, deferred to Phase 7.
- Safety: who presses the physical e-stop button, and how does the brain react?

---

## Phase 7 — Arm + pickup/place (firmware-side, deferred per spec)

**Goal:** The 5-DOF robotic arm on top of the robot picks up packages from the source shelf and places them at the destination.

### Status
The `firmware/CLAUDE.md` "What the ESP32 Needs to Do Next" section is the source of truth for the firmware work. None of this code exists yet.

### Firmware tasks (separate plan, not in this repo)
- `firmware/src/modules/brain_bridge.cpp` — decodes `move` JSON over UART into `MecanumDrive::compute()` calls
- `firmware/src/modules/odometry_publisher.cpp` — publishes encoder counts every 50ms
- `firmware/src/modules/imu_bno055.cpp` — initializes BNO055, publishes Euler angles
- `firmware/src/modules/battery_monitor.cpp` — ADC read, emits type-133 telemetry
- `firmware/src/modules/arm_controller.cpp` — 6-servo arm (3× MG996R + 3× SG90)
- `firmware/CLAUDE.md` already documents the new UART message types 132 (move ACK with seq) and 133 (battery/telemetry), the BNO055 pin assignments, the tightened heartbeat contract (50ms from Pi, 2s timeout on ESP32)

### Pi-side consumers (in this repo)
- `RealEsp32Bridge` learns the new type-132 (move ACK) and type-133 (telemetry) messages
- `brain_node` adds `JOB_PLACE` and `JOB_PICKUP` arm-control states
- `april_tag_node` reaches steady state — `pupil_apriltags` + OpenCV running at ~10Hz
- New `JOB_PICKUP` state: drive to source slot, scan AprilTag on package, lower arm, close gripper, raise arm, transition to `JOB_NAV_TO_DROPOFF`
- New `JOB_PLACE` state: drive to destination slot, scan AprilTag on slot, lower arm, open gripper, raise arm, emit `job:status: completed`, transition to `IDLE`

### Verification gates
- Hardware-in-loop: real robot, real LiDAR, real ESP32 with real arm
- Operator places a real package on shelf S1A1
- Web user clicks "PHÁT LỆNH AGV" with destination S2C3
- Brain navigates, picks up, navigates, places
- Web UI shows the full lifecycle in real time

### Open questions to resolve before starting
- Grip force sensing: do we add a load cell, or trust current-limiting on the servos? Spec says "do not introduce a loadcell" — recommend current-limiting.
- Camera placement: where on the arm, and what FOV? Need to scan both the package tag and the shelf tag at pickup/place time.
- Recovery: if the arm misses the package, what's the retry strategy? After 3 misses, transition to `ERROR` and emit `robot:alarm`.

---

## Cross-cutting concerns for all future phases

### Testing
- New `apps/api` endpoints need NestJS unit tests with mocked `RobotGateway` (consistent with the existing testing pattern). The API project currently has no test framework installed — `apps/api/CLAUDE.md` says "No testing framework installed. Do not add tests unless explicitly requested." The plan-execution pattern in this work explicitly requested tests, so they're allowed. Future work should keep them.
- The Python tests already work. Add tests for each new `brain_node` method and `api_client` method as you write them.

### Configuration
- All new env vars (ROBOT_BRAIN_TOKEN, API_SOCKET_URL, MAPS_DIR, ESP32_UART) need to be in both `apps/api/.env` and `services/robot/.env`, and documented in `apps/api/CLAUDE.md` and `services/robot/CLAUDE.md`.
- `apps/api/.env.example` should be created if it doesn't exist (reviewer M2 from final code review).

### Deployment
- Each phase must be independently shippable and reversible (per the spec's rollout section). Don't bundle Phase 3 + 4 + 5 into a single PR.

### Code organization
- Keep `brain_node.py` focused on state machine + event routing. Move heavy logic to dedicated modules:
  - `api_client.py` (Phase 5)
  - `nav2_client.py` (Phase 3)
  - `job_executor.py` (Phase 5 — the `_execute_job` coroutine)
  - `calibration.py` (Phase 7 — the pick/place arm sequence)

### Performance
- Brain state machine latency: 100ms target. Any synchronous work in a state handler must not exceed this.
- Nav2 control loop: 20Hz (Nav2 default). Brain must forward `/cmd_vel` at this rate when in `JOB_NAV_*` states.
- AprilTag detection: 5Hz. `april_tag_node` should throttle `/detected_tags` publishes.

### Open architectural questions to resolve before Phase 4
- **Multi-robot:** does the design extend to multiple robots? If yes, add `robotId` to `Job` and a per-robot namespace `/robot-{id}`. If no, document the assumption.
- **Multi-floor:** the SLAM map is for one floor. If the warehouse is multi-floor, add a `mapId` to `ShelfSlot` and a map-switching state to the brain.
- **Multiple packages per slot:** the schema currently allows one `packageId` per slot. If a slot can hold multiple packages, change to a `packageIds: ObjectId[]` array and update the brain's job lifecycle.

---

## Verification across all phases

### Pre-merge gates
- All TypeScript builds pass: `yarn turbo run build --filter=...`
- All Python tests pass: `pytest services/robot/src/my_robot_controller/tests/`
- Lint passes: `yarn turbo run lint --filter=...`

### Post-merge smoke test (every deploy to Pi)
```bash
pm2 list | grep -E 'nexus-robot-(brain|nav2|map-manager|web-bridge|lidar|slam|vision)'
curl -s http://localhost:5000/api/docs.json | head -c 200
pm2 logs nexus-robot-brain --lines 20
ros2 topic list | grep -E 'cmd_vel|map|amcl'
pm2 logs nexus-robot-vision --lines 20 | grep "camera"
# Open https://web.nguyen-robot.io.vn/map in a browser, verify live state
```

### Hardware-in-loop (Phase 7)
- Real robot, real LiDAR, real ESP32 with real arm
- Drive through Calibrate → Explore → Move job → Pickup/Place
- A real package moves between two real shelves

---

## Reference

- **Spec:** `docs/superpowers/specs/2026-06-07-robot-controller-brain-design.md` — source of truth
- **Plan (Phases 0-2, shipped):** `docs/superpowers/plans/2026-06-07-robot-controller-brain-plan.md`
- **Final code review notes:** see the "Recommended follow-up" section in the final code review report (the one I produced for Phases 0-2)
- **Firmware CLAUDE.md:** `firmware/CLAUDE.md` "What the ESP32 Needs to Do Next (Brain Integration)" — the firmware-side contract

When you start a phase, run the `brainstorming` skill first (even for an "obvious" phase), then `writing-plans` to produce a fresh plan file. Don't try to execute a phase from these notes alone — they're context, not a plan.
