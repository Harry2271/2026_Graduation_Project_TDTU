# Start.md — Command reference for the Pi

> **For the Pi operator (PhamVietHoang):** Every command below assumes you are SSH'd into the Pi as the `pi` user. Pick the row that matches the situation; each row is idempotent where possible.

---

## 0. Mental model — three layers

| Layer | What runs | Manager | Location on disk |
|---|---|---|---|
| **Web** (`web.nguyen-robot.io.vn`, port 3000) | Next.js production container | Docker Compose | `apps/web/` |
| **API** (`api.nguyen-robot.io.vn`, port 5000) | NestJS production container | Docker Compose | `apps/api/` |
| **Robot** (WS 9091, Camera 9092) | 9 ROS 2 nodes via PM2 | PM2 | `services/robot/` |

Public domains are reverse-proxied through a Cloudflare Tunnel that already runs on the Pi — **do not start a new proxy**.

---

## 1. State you are probably in

```bash
pm2 status
docker compose ps
ls -l /home/pi/actions-runner/_work/robot-for-nguyen/robot-for-nguyen/    # repo root
```

If `pm2` or `docker compose` is not installed, jump to section 7 (first-time setup).

---

## 2. Boot order on a fresh reboot

The canonical one-shot command:

```bash
cd ~/<path-to-repo>
./start-all.sh                # pull + docker compose + robot start.sh
```

Skip the network step if the Pi is offline but has fresh code on disk:

```bash
./start-all.sh --skip-git
```

`start-all.sh` runs these steps in order:
1. `git pull --ff-only`
2. Verifies `apps/api/.env` exists (copies from `.env.example` if missing — you must edit it afterwards)
3. `docker compose up -d --build` (API + Web)
4. `bash services/robot/start.sh` (9 PM2 processes)

---

## 3. Restart one layer

| Layer | Restart command |
|---|---|
| All (API + Web + Robot) | `./start-all.sh` |
| API only (rebuild + recreate container) | `docker compose up -d --build --force-recreate api` |
| Web only (rebuild + recreate container) | `docker compose up -d --build --force-recreate web` |
| Robot (all 9 PM2 processes, rebuilds colcon) | `bash services/robot/start.sh` |
| A single ROS node | `pm2 restart nexus-robot-<name>` (see full list below) |

`pm2 restart` preserves the file on disk; `pm2 delete && pm2 start` is only needed for env changes (see section 6).

After any code change in `services/robot/`, you must `bash services/robot/start.sh` (rebuilds the colcon workspace) — `pm2 restart` alone re-runs the same old binary.

After any `apps/web/.env.local` or `apps/api/.env` change, run `docker compose up -d --build --force-recreate api` or `... web`.

---

## 4. PM2 robot processes — full list

```bash
pm2 status
```

| PM2 name | Source | Restart cmd | Purpose |
|---|---|---|---|
| `nexus-robot-lidar` | `lidar_only_launch.py` | `pm2 restart nexus-robot-lidar` | RPLidar driver on `/dev/ttyUSB0` (symlink `/dev/robot-lidar`) |
| `nexus-robot-slam` | `slam_only_launch.py` | `pm2 restart nexus-robot-slam` | slam_toolbox online_async (MAPPING mode) |
| `nexus-robot-map-manager` | `map_manager_node.py` | `pm2 restart nexus-robot-map-manager` | 5-state machine + obstacle layer |
| `nexus-robot-web-bridge` | `web_bridge.py` | `pm2 restart nexus-robot-web-bridge` | WS server on 9091 — relays ROS → browser |
| `nexus-robot-esp32-telemetry` | `esp32_telemetry_node.py` | `pm2 restart nexus-robot-esp32-telemetry` | Reads `/dev/ttyACM0` (symlink `/dev/robot-esp32`), publishes `/esp32/status` |
| `nexus-robot-brain` | `brain_node.py` | `pm2 restart nexus-robot-brain` | High-level planner (Nav2 jobs) — needs `ROBOT_BRAIN_TOKEN` |
| `nexus-robot-vision` | `april_tag_node.py` | `pm2 restart nexus-robot-vision` | AprilTag detection |
| `nexus-robot-camera` | `camera_stream.py` | `pm2 restart nexus-robot-camera` | MJPEG `:9092` + `/snapshot` |
| `nexus-robot-nav2` | `nav2_launch.py` | `pm2 restart nexus-robot-nav2` | Nav2 stack (LIVE mode) — mutually exclusive with slam |

The 9-prefix `nexus-robot-` is set by `SERVICE_NAME_PREFIX` in `services/robot/start.sh`.

---

## 5. Logs

| Target | Command |
|---|---|
| All robot processes (tail follow) | `pm2 logs` |
| One robot process, last N lines | `pm2 logs nexus-robot-<name> --lines 100 --nostream` |
| API container | `docker compose logs -f api` |
| Web container | `docker compose logs -f web` |
| ROS 2 topic rate | `source /opt/ros/jazzy/setup.bash && source ~/robot_ws/install/setup.bash && ros2 topic hz /esp32/status` |
| ROS 2 topic echo | `ros2 topic echo /map --once` |

---

## 6. Change env vars (token, URL, port)

PM2 captures env vars at `start` time; `restart` does not pick up new vars. After changing tokens or URLs:

```bash
# Robot example — change API_SOCKET_URL
pm2 delete nexus-robot-brain
API_SOCKET_URL=https://api.nguyen-robot.io.vn ROBOT_BRAIN_TOKEN=<your-token> \
    pm2 start "bash" --name nexus-robot-brain --exp-backoff-restart-delay=1000 --max-restarts 50 \
    -- -c "source /opt/ros/jazzy/setup.bash && source ~/robot_ws/install/setup.bash && \
           ros2 run my_robot_controller brain"
pm2 save

# Or simpler: re-run start.sh to rebuild env from current shell:
bash services/robot/start.sh
```

Same idea for `API_PORT`, `MONGO_URI`, `MAPS_DIR` — edit `apps/api/.env`, then:

```bash
docker compose up -d --build --force-recreate api
```

For `NEXT_PUBLIC_*` web vars, edits to `apps/web/.env.local` (or the GitHub vars pulled into the compose build args) require:

```bash
docker compose up -d --build --force-recreate web
```

These `NEXT_PUBLIC_*` are **build-time** — a rebuild is mandatory, not a restart.

---

## 7. First-time setup on a new Pi

```bash
# 1. Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# log out + back in

# 2. Install Node 22 + Yarn 1.x
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g yarn

# 3. Install ROS 2 Jazzy + colcon + pyserial-asyncio
sudo apt-get install -y ros-jazzy-desktop python3-colcon-common-extensions python3-serial-asyncio ffmpeg

# 4. Install PM2 + udev rules + clone the repo
sudo npm install -g pm2
sudo usermod -aG dialout $USER
# log out + back in

# Clone the repo under actions-runner workspace (or wherever CI expects)
cd ~/<target-dir>
# (clone from GitHub)

# 5. Bring everything up
./start-all.sh
```

Stable device names (udev rules) are auto-provided by the `99-robot-ports.rules` file under `services/robot/config/udev/`. If symlinks `/dev/robot-esp32` or `/dev/robot-lidar` are missing after a reboot, install them:

```bash
sudo bash services/robot/tools/install_udev_rules.sh
```

---

## 8. Diagnostic one-liners

```bash
# Who holds the ESP32 serial port right now?
sudo lsof /dev/ttyACM0 /dev/robot-esp32

# Is the LiDAR receiving anything?
ros2 topic hz /scan --window 10

# ESP32 alive frames flowing?
pm2 logs nexus-robot-esp32-telemetry --lines 30 --nostream | tail -20

# Camera server up?
curl -I http://localhost:9092/   # health
curl -I http://localhost:9092/snapshot

# WebSocket bridge up?
sudo lsof -i :9091

# Disk + memory sanity
df -h ~ && free -h
```

---

## 9. Why the manual `pm2 restart` step is needed after a `git pull`

`pm2 start` runs the Python interpreter **once** at startup, then keeps the process alive. The compiled bytecode is cached in memory. When the repo changes:

- `pm2 restart nexus-robot-<name>` re-execs the same `bash -c "...ros2 run ..."` command — but **the `ros2 run` runner resolves the entry-point at start time from `~/robot_ws/install/`**, not from the repo you just updated. So `restart` is a no-op against code changes.
- `bash services/robot/start.sh` is the right tool because it copies `services/robot/src/my_robot_controller` into `~/robot_ws/src/`, runs `colcon build`, then re-`pm2 start`s every ROS node — which means the entry-point re-resolves against the rebuilt install.

For local one-line fixes (env vars only, no Python change), `pm2 restart` is enough. For any `.py` change you brought in, use `bash services/robot/start.sh`.

CI/CD normally does this for you (`.github/workflows/deploy.yml` calls `bash services/robot/deploy.sh` on every push to `master`). When CI is down or you skipped it, run `start.sh` manually.

---

## 10. Quick reference card

```bash
# I rebooted the Pi
./start-all.sh

# I only changed code under services/robot/
bash services/robot/start.sh

# I only changed apps/api/ or apps/web/ .env
docker compose up -d --build --force-recreate api   # or web

# Only one robot process is wedged
pm2 restart nexus-robot-<name>

# I need to see what's wrong
pm2 logs --lines 50                                # all robot logs
docker compose logs -f api                          # API
docker compose logs -f web                          # Web

# ESP32 panel shows "undefined" or stale
pm2 restart nexus-robot-esp32-telemetry

# Camera CORS error in browser
pm2 restart nexus-robot-camera
```
