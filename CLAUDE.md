# CLAUDE.md — Robot for Nguyen (Monorepo)

This is a **Turborepo + yarn-workspaces** monorepo containing the full-stack AGV SMART warehouse + robot control system. Four projects that used to be separate git repos now live in one repo with path-filtered CI/CD.

**Read the per-app `CLAUDE.md` before working in that app** — they carry the project-specific rules. This file covers the monorepo-level conventions and cross-cutting concerns.

---

## Projects Overview

| Directory | Role | Framework | Port | CI/CD |
|---|---|---|---|---|
| `apps/api/` | Backend API | NestJS 11 | `5000` | ✅ Docker (path-filtered) |
| `apps/web/` | Web Frontend | Next.js 16 | `3000` | ✅ Docker (path-filtered) |
| `apps/mobile/` | Mobile App | Expo 55 (Router) | — | ❌ none (per project decision) |
| `services/robot/` | Robot Bridge (Pi 5) | Python / ROS 2 | `9091` (WS) | ✅ path-filtered (direct PM2) |
| `firmware/` | ESP32-S3 real-time motor controller | PlatformIO / Arduino | USB CDC + UART `115200` | ❌ local flash (no CI/CD) |
| `packages/` | Shared libraries (future) | — | — | — |

Per-app `CLAUDE.md` files: `apps/api/CLAUDE.md`, `apps/web/CLAUDE.md`, `apps/mobile/CLAUDE.md`, `services/robot/CLAUDE.md`, `firmware/CLAUDE.md`.

---

## Project Context — AIoT Autonomous Logistics Robot

This section documents the physical robot and the firmware/software contract that the apps in this monorepo coordinate around. Read this before working on anything in `services/robot/` or any feature that touches motor control, SLAM, or the warehouse robot hardware.

### 1. Project Overview

- **Name:** AIoT Autonomous Logistics Robot.
- **Goal:** SLAM mapping, autonomous navigation, and logistics handling.
- **Core Strategy:** Raspberry Pi 5 làm bộ não xử lý cấp cao + ESP32-S3 làm hệ điều hành thời gian thực (Pi 5 = high-level brain, ESP32-S3 = real-time RTOS-style control).

### 2. Hardware Architecture

#### 2.1. Computing Units
- **Raspberry Pi 5 (8GB):** runs ROS 2 (slam_toolbox), Python bridge (`web_bridge.py`, robot manager), and the NestJS backend (`apps/api`).
- **ESP32-S3 WeAct (N16R8):** motor control, encoder reading, IMU + proximity sensor handling, hard-stop logic.

#### 2.2. Locomotion & Actuators
- **Wheels:** 4× Mecanum 97mm (omnidirectional motion).
- **Motors:** 4× JGB37-520 DC servo (12V, 333RPM, 330 pulses/rev on the main shaft encoder).
- **Drivers:** 4× BTS7960 43A (PWM + direction control).
- **Robotic Arm:** 5 degrees of freedom (6 servos: 3× MG966R + 3× SG90).

#### 2.3. Sensors & Perception
- **LiDAR:** RPLIDAR A1M8-R6 (12m range, 360°). Connected to Pi 5.
- **IMU:** MCU-055 (BNO055 9DOF Module).
  - *Connection:* I2C (Address 0x28 or 0x29).
  - *Feature:* Phần cứng tự tính toán Euler Angles/Quaternions.
  - *Role:* Cung cấp hướng (Heading) chuẩn cho Robot Manager xử lý SLAM.
- **IR Sensors:** 4× E18-D80NK (~20cm range). Connected to ESP32 for emergency stop.
- **Vision:** Logitech BRIO 100 FullHD.

### 3. Software Architecture

```
┌────────────────────────────────────────────────────────────┐
│  Sensing Layer (SLAM source — ROS 2 Jazzy/Python)          │
│  web_bridge.py → LiDAR + raw WebSocket (port 9091)         │
│  slam_toolbox → map + TF (map → odom → base_footprint)     │
└────────────────┬───────────────────────────────────────────┘
                 │ ROS 2 topics
┌────────────────▼───────────────────────────────────────────┐
│  Gateway Layer (Robot brain + telemetry node)              │
│  • esp32_telemetry_node is sole serial owner              │
│  • brain_node → Nav2 + job workflow                        │
│  • Encoder + IMU → odometry and heading correction         │
└────────────────┬───────────────────────────────────────────┘
                 │ Serial (115200 baud)
┌────────────────▼───────────────────────────────────────────┐
│  Control Layer (ESP32-S3 firmware)                          │
│  • PID loop on 4 motors                                     │
│  • IR hard-stop interrupt (distance < 20cm)                 │
│  • IMU read + telemetry up to Pi 5                          │
└────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────┐
│  Interface Layer (NestJS Backend — apps/api)                │
│  Web + Mobile frontends, MongoDB persistence.               │
└────────────────────────────────────────────────────────────┘
```

The four layers map onto the monorepo:

| Layer | Lives in |
|---|---|
| Sensing (LiDAR + SLAM) | `services/robot/src/web_bridge.py` |
| Gateway (robot manager) | `services/robot/src/my_robot_controller/` (Python nodes) |
| Control (ESP32 firmware) | `firmware/` (PlatformIO, Arduino framework) |
| Interface (backend) | `apps/api/` |

### 4. Technical Specifications & Formulas

#### 4.1. Mecanum Kinematics

Wheel velocities ($v_n$) from chassis velocities ($V_x, V_y, \omega$). The firmware (`firmware/src/modules/MecanumDrive.cpp`) is authoritative and works in PWM units: $\omega$ is pre-scaled by the caller, so there is no explicit $(L+W)$ term and the sign convention is:

```
v_fl = Vx − Vy + ω
v_fr = Vx + Vy − ω
v_rl = Vx + Vy + ω
v_rr = Vx − Vy − ω
```

Results are proportionally normalized to `MECANUM_MAX_SPEED` (255) so no wheel saturates. The classic physical form (with an explicit $\omega(L+W)$ term, where $L$ and $W$ are the half-axle distances) is equivalent once $\omega$ is scaled; match the code signs above when editing either side.

#### 4.2. Communication Protocol (Pi ↔ ESP32)

The contract between `services/robot/` and `firmware/`. Both sides must agree byte-for-byte; changes here require a coordinated update in `firmware/src/modules/CommandParser.cpp` and the corresponding Python serial handler in `services/robot/`.

- **Physical:** USB CDC (`/dev/ttyACM0` on Pi 5, managed exclusively by `esp32_telemetry_node.py`). Backup: UART2 on ESP32-S3 (GPIO 43 TX / GPIO 44 RX). **Baud:** 115200, 8N1, newline-terminated.
- **Framing:** JSON preferred, with an ASCII fallback for debugging and the web UI.
- **Only one process may own the serial link** — `esp32_telemetry_node` is that process; all other ROS 2 nodes talk to the ESP32 via `/esp32/cmd`.

**JSON commands (Pi → ESP32):**

| JSON | Purpose |
|---|---|
| `{"cmd":"move","vx":100,"vy":0,"omega":0}` | Mecanum velocity (vx,vy in PWM units, omega scaled) |
| `{"cmd":"individual","speeds":[fl,fr,rl,rr]}` | Direct per-wheel speeds (-255..255) |
| `{"cmd":"set_speed","motor_id":0,"speed":150}` | Single motor speed |
| `{"cmd":"set_all_speed","speeds":[100,100,100,100]}` | All 4 motors at once |
| `{"cmd":"stop"}` / `{"cmd":"e_stop"}` | Brake / hard disable |
| `{"cmd":"get_encoder"}` / `{"cmd":"reset_encoder"}` | Encoder query / zero |
| `{"cmd":"set_pid","motor_id":0,"kp":1.0,"ki":0.1,"kd":0.01}` | PID gain update |
| `{"cmd":"heartbeat"}` | Reset watchdog (Pi must send within `HEARTBEAT_TIMEOUT_MS`, default 2000) |
| `{"cmd":"cylinder_extend"}` | Extend electric cylinder (dock) |
| `{"cmd":"cylinder_retract"}` | Retract electric cylinder |
| `{"cmd":"cylinder_stop"}` | Stop cylinder immediately |
| `{"cmd":"begin_dock"}` | Start full docking/unload sequence |
| `{"cmd":"cancel_dock"}` | Cancel docking sequence |
| `{"cmd":"obstacle_left"\|"obstacle_right"\|"obstacle_front"\|"obstacle_front_left"\|"obstacle_front_right"\|"obstacle_rear"\|"obstacle_rear_left"\|"obstacle_rear_right"\|"obstacle_clear"}` | Reactive obstacle events (see `ObstacleAvoidance` module). Optional `distance_m` (0–12 m) and `severity` (0–1) payload on left/right/compound directions. |

**JSON responses (ESP32 → Pi):**

| Type | Payload |
|---|---|
| `128` | `{"type":128,"data":{...}}` — command ACK |
| `129` | `{"type":129,"data":{"error":"..."}}` — error |
| `130` | `{"type":130,"data":{"encoders":[{id,name,count,rpm},...]}}` — encoder snapshot |
| `131` | `{"type":131,"data":{uptime_ms,mode,e_stop,pid,max_pct,motors:[...],ir:[...],st:{...}}}` — full status |
| `132` | `{"type":132,"data":{"seq":N,"status":"accepted"}}` — move ack (with sequence ID) |
| `133` | `{"type":133,"data":{"voltage_v":...,"current_a":...,"power_w":...,"battery_pct":...,"battery_status":"..."}}` — battery/power (INA226) |
| `134` | `{"type":134,"data":{"yaw":...,"pitch":...,"roll":...,"temp":...,"cal":{...}}}` — IMU heading (BNO055, 20 Hz) |
| `135` | `{"type":135,"data":{"ir":[bool,bool,bool,bool]}}` — IR proximity sensor state |
| `136` | `{"type":136,"data":{"distance_mm":...,"obstacle":bool}}` — front VL53L1X distance sensor |
| `138` | `{"type":138,"data":{"distance_mm":...,"at_unload":bool}}` — rear VL53L0X ToF (dock sensor) |
| `139` | `{"type":139,"data":{"state":"...","extended":bool,"moving":bool}}` — cylinder actuator status |
| `140` | `{"type":140,"data":{"state":N,"error":bool}}` — cylinder unload state (0-7, see firmware/AutoRoam) |
| `142` | `{"type":142,"data":{"uptime_ms":...,"battery":{...},"robot":{...},"modules":[...]}}` — health monitor |
| `143` | `{"type":143,"data":{"mode":"...","nav":[vx,vy,omega],"motors":[...]}}` — compact tick telemetry (500ms) |
| `144` | `{"type":144,"data":{"uptime_ms":N,"alive":N,"e_stop":bool,"mode":"..."}}` — alive heartbeat every 500 ms; Pi uses this to detect firmware liveness (was type 141 before Aug 2026) |
| `145` | `{"type":145,"data":{"present":bool,"debounce_ms":N}}` — cargo bed presence (on-demand via `get_cargo` cmd) |

**ASCII fallback (one command per line, useful for `pio device monitor` and the web UI):**

```
F 150   forward            S        stop (brake)
B 100   backward           D / K    e-stop / clear e-stop
L 80    strafe left        M fl fr rl rr   manual motors
R 80    strafe right       Z        heartbeat
Q 60    rotate CCW         V        status JSON
E 60    rotate CW          P kp ki kd      set PID
T       test sequence      X 75     max speed %
?       help
```

See `firmware/CLAUDE.md` for the full command reference and `firmware/MODULES.md` for the module breakdown.

### 5. Development Notes

- **Priority:** Coordinate accuracy for SLAM is the top concern.
- **Strategy:** Use IMU to compensate for mecanum wheel slip — do **not** introduce a loadcell.
- **Safety:** IR sensors are handled directly on the ESP32 to guarantee minimum latency. Do not move that logic to the Pi.

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Robot Hardware (Raspberry Pi 5 + Slamtec A1M8 Lidar)      │
│  ROS 2 + web_bridge.py                                     │
└────────────────┬────────────────────────────────────────────┘
                 │ WebSocket (ws://robot-ip:9091)
                 ▼
┌─────────────────────────────────────────────────────────────┐
│  apps/api (NestJS)          apps/web (Next.js)              │
│  Port 5000                  Port 3000                       │
│  • REST API (packages, shelves)  • Warehouse dashboard      │
│  • Socket.io (real-time)         • SLAM map viewer          │
│  • MongoDB                       • Real-time sync           │
└────────────────┬────────────────────────────────────────────┘
                 │ REST API
                 ▼
┌─────────────────────────────────────────────────────────────┐
│  apps/mobile (Expo React Native)                            │
│  • On-the-go warehouse ops, QR scanning, camera stream     │
└─────────────────────────────────────────────────────────────┘
```

---

## Monorepo Commands

All commands run from the repo root.

```bash
# Install (hoists to root /node_modules)
yarn install

# Build / lint all affected apps
yarn build
yarn lint

# Run a specific app's dev server
yarn dev:api       # NestJS on :5000
yarn dev:web       # Next.js on :3000
yarn dev:mobile    # Expo dev server

# Turborepo (advanced)
yarn turbo run build --filter=@robot-for-nguyen/api
yarn turbo run lint --filter=...[origin/master]   # only affected

# Docker (production containers on the Pi)
docker compose up -d                  # start API + Web
docker compose up -d --build api      # rebuild + restart only API
docker compose up -d --build web      # rebuild + restart only Web
docker compose logs -f api            # follow API logs
docker compose ps                     # check status
```

The per-app dev workflow hasn't changed — `yarn start:dev` in `apps/api/`, `yarn dev` in `apps/web/`, `yarn start` in `apps/mobile/`. Yarn workspaces resolves dependencies from the hoisted `node_modules/` at the root.

---

## CI/CD

**Two workflows, both at `.github/workflows/`:**

### `ci.yml` — Affected build
- Triggers: push to `master`, PR.
- Runs on `ubuntu-latest`.
- Uses `yarn turbo run lint build --filter=...` to build only changed apps.

### `deploy.yml` — Path-filtered deploy
- Triggers: push to `master`, manual dispatch.
- Uses `dorny/paths-filter@v3` to detect which app(s) changed.
- Three jobs: `deploy-api`, `deploy-web`, `deploy-robot`. Each is gated on its own filter and runs on `self-hosted` (the Pi).
- Path filters:
  - `api` → `apps/api/**` (also `docker-compose.yml`, `scripts/postinstall-hoist-next.js`, `.github/workflows/deploy.yml`)
  - `web` → `apps/web/**` (also `docker-compose.yml`, `scripts/postinstall-hoist-next.js`, `.github/workflows/deploy.yml`)
  - `robot` → `services/robot/**` (also `.github/workflows/deploy.yml`)
- **Mobile is intentionally not in any filter** — there is no CI/CD for it. Build via `eas build` (cloud) or `expo start` (local) using your EAS account.

**What each deploy job does:**

| Job | What it runs |
|---|---|
| `deploy-api` | Writes `apps/api/.env` from GitHub secrets/vars → `docker compose up -d --build --force-recreate api` → healthcheck via `docker compose exec` curl |
| `deploy-web` | `docker compose up -d --build --force-recreate web` (with `NEXT_PUBLIC_*` as build args) → healthcheck via curl |
| `deploy-robot` | `services/robot/deploy.sh` → colcon build + PM2 → verify `/scan` ROS topic |

**Environment variables per job (sourced from GitHub Actions vars + secrets):**

`deploy-api` writes `apps/api/.env`:

| Variable | Source | Default |
|---|---|---|
| `API_PORT` | `vars.API_PORT` | `5000` |
| `MONGO_URI` | `secrets.MONGO_URI` | — (required) |
| `JWT_SIGN_SECRET` | `secrets.JWT_SIGN_SECRET` | — (required) |
| `ROBOT_BRAIN_TOKEN` | `secrets.ROBOT_BRAIN_TOKEN` | — (required) |
| `MAPS_DIR` | `vars.MAPS_DIR` | `/home/pi/robot_ws/maps` |
| `API_SOCKET_URL` | `vars.API_SOCKET_URL` | `https://api.nguyen-robot.io.vn` |

`deploy-web` passes build args to `docker compose` (baked into the JS bundle):

| Variable | Source | Default |
|---|---|---|
| `WEB_PORT` | `vars.WEB_PORT` | `3000` |
| `NEXT_PUBLIC_API_BASE_URL` | `vars.NEXT_PUBLIC_API_BASE_URL` | `https://api.nguyen-robot.io.vn` |
| `NEXT_PUBLIC_WS_URL` | `vars.NEXT_PUBLIC_WS_URL` | `wss://map.nguyen-robot.io.vn` |
| `NEXT_PUBLIC_CAMERA_STREAM_URL` | `vars.NEXT_PUBLIC_CAMERA_STREAM_URL` | `https://cam.nguyen-robot.io.vn/stream` |

`deploy-robot` exports into `services/robot/deploy.sh`:

| Variable | Source | Default |
|---|---|---|
| `ROBOT_BRAIN_TOKEN` | `secrets.ROBOT_BRAIN_TOKEN` | — |
| `API_SOCKET_URL` | `vars.API_SOCKET_URL` | `https://api.nguyen-robot.io.vn` |
| `LIDAR_MODEL` | hardcoded in `deploy.sh` | `a1` |

**Path change examples:**

| Changed path | Jobs that run |
|---|---|
| `apps/api/src/...` | `detect` + `deploy-api` |
| `apps/web/src/...` | `detect` + `deploy-web` |
| `services/robot/src/...` | `detect` + `deploy-robot` |
| `docker-compose.yml` | `detect` + `deploy-api` + `deploy-web` |
| `scripts/postinstall-hoist-next.js` | `detect` + `deploy-api` + `deploy-web` |
| `.github/workflows/deploy.yml` | `detect` + all 3 deploy jobs (so workflow edits get tested) |
| `apps/mobile/...` | `detect` only (no deploy job gated on it) |
| `apps/web/.env` | `detect` only (env files are gitignored, this is illustrative) |

---

## Deploy Scripts

| Script | What it does |
|---|---|
| `docker-compose.yml` (root) | Production containers for API + Web. Robot is NOT Dockerized — it needs serial ports, ROS 2, LiDAR, IMU, camera. |
| `apps/api/Dockerfile` | Multi-stage build for NestJS API. Context = monorepo root. |
| `apps/web/Dockerfile` | Multi-stage build for Next.js standalone. `NEXT_PUBLIC_*` are build-time ARGs (baked into JS bundles). |
| `services/robot/deploy.sh` | Used by `deploy-robot` CI/CD job. colcon build + PM2 (idempotent in CI context). |
| `services/robot/start.sh` | **Manual** start for the robot service. Stops existing PM2 processes, rebuilds colcon workspace, starts 9 ROS 2 nodes. Idempotent — safe to run repeatedly. |
| `start-all.sh` (root) | **All-in-one recovery command.** Pulls code (best-effort), starts Docker containers for API + Web, then starts the robot. Use after a Pi reboot or when CI/CD is broken. |
| `start-all.sh --skip-git` | Same as above, but skips `git pull` — use when the Pi is offline but has fresh code already on disk. |

---

## Cross-Project Conventions

These apply everywhere in the monorepo. Per-app `CLAUDE.md` files add project-specific rules on top.

- **Package manager:** Yarn (classic, 1.22.22). No npm, no pnpm.
- **Language:** TypeScript with strict mode in all Node projects. No `any`.
- **UI language:** All user-facing text is **Vietnamese** (apps/web and apps/mobile).
- **Testing:** No testing framework installed. Do not add tests unless explicitly requested.
- **Cross-project types:** `Package`, `Shelf`, `ShelfSlot`, `SelectedCell` are duplicated across apps today. A future `packages/shared-types/` is reserved for these.
- **State management:**
  - `apps/api` — NestJS DI (no frontend state)
  - `apps/web` — Redux Toolkit + RTK Query
  - `apps/mobile` — Zustand (NOT Redux)
- **Backend circular dependency:** `PackageModule` and `ShelfModule` use `forwardRef` — keep this pattern.

---

## Environment Variables

| Where | Variable | Notes |
|---|---|---|
| `apps/api/.env` | `API_PORT`, `MONGO_URI`, `MAPS_DIR`, `JWT_SIGN_SECRET`, `ROBOT_BRAIN_TOKEN`, `API_SOCKET_URL` | runtime vars, written by `deploy.yml` from GitHub secrets + vars |
| `apps/web/.env.local` | `WEB_PORT`, `NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_WS_URL`, `NEXT_PUBLIC_CAMERA_STREAM_URL` | `NEXT_PUBLIC_*` are build-time (baked into JS bundles) |
| `apps/mobile/.env` | `EXPO_PUBLIC_API_BASE_URL`, `EXPO_PUBLIC_CAMERA_STREAM_URL` | set at build time, baked into the bundle |
| `services/robot` env | `LIDAR_MODEL` (e.g. `a1`), `ESP32_PORT`, `CAMERA_DEVICE`, `API_SOCKET_URL`, `ROBOT_BRAIN_TOKEN` | set in `deploy.sh` / `start.sh` |

`.env` files are gitignored. The `.env.example` files in `apps/api/` and `apps/web/` are the canonical reference for all available variables and are checked in. The `deploy.yml` job writes `apps/api/.env` from GitHub secrets + vars; the Web container reads `NEXT_PUBLIC_*` from `docker-compose.yml` build args.

---

## Migrating from the old polyrepo

The four old repos (`nguyen-tdtu`, `nguyen-web-app`, `nguyen-mobile-app`, `robot-controller`) were merged into this monorepo via `git subtree add`. The original git histories are preserved in the merge commits. The old repos can be archived once the team is comfortable with the monorepo.

If you need to pull new commits from an old repo into the monorepo later, use `git subtree pull --prefix=apps/api <old-repo-url-or-path> master`.

---

## File Index (monorepo-level)

| File | Purpose |
|---|---|
| `package.json` | Root — yarn workspaces, turbo scripts |
| `turbo.json` | Turborepo task graph |
| `.gitignore` | Monorepo-level ignore patterns (per-app `.gitignore` files remain) |
| `.dockerignore` | Controls what enters Docker build context |
| `docker-compose.yml` | Production containers for API + Web (built by CI/CD, also used by `start-all.sh`) |
| `start-all.sh` | All-in-one recovery command (Docker for API/Web + PM2 for robot) |
| `CLAUDE.md` | This file |
| `apps/api/Dockerfile` | Multi-stage Docker build for the NestJS API |
| `apps/web/Dockerfile` | Multi-stage Docker build for the Next.js standalone app |
| `services/robot/start.sh` | Manual idempotent start script for the robot (colcon + PM2) |
| `services/robot/deploy.sh` | Used by CI/CD (`deploy-robot` job) — not intended for manual use |
| `docs/superpowers/specs/2026-06-02-monorepo-restructure-design.md` | The design doc that drove this restructure |
| `docs/superpowers/specs/2026-06-07-robot-controller-brain-design.md` | Brain controller design: Pi 5 high-level state machine (autonomous mapping + job dispatch via Nav2 + AprilTag + ESP32 UART) |
| `docs/superpowers/plans/2026-06-07-robot-controller-brain-plan.md` | Implementation plan for Phases 0-2 of the brain controller (skeleton, Calibrate data model, Esp32Bridge) |
| `.github/workflows/ci.yml` | Affected build + lint |
| `.github/workflows/deploy.yml` | Path-filtered Docker deploy (API/Web) + PM2 deploy (robot) |
| `firmware/` | ESP32-S3 PlatformIO project (see `firmware/CLAUDE.md` + `firmware/MODULES.md`) — flashed via `pio run --target upload`, no CI/CD |
| `packages/` | Reserved for future shared types / utils (currently empty) |
