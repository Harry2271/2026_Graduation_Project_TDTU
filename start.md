# start.md — Tham khảo lệnh khởi chạy toàn hệ thống trên Pi

> **Dành cho người vận hành Pi (PhamVietHoang):** Mọi lệnh bên dưới giả định bạn đã SSH vào Pi với user `pi`. Chọn đúng mục khớp với tình huống; mỗi lệnh đều idempotent trong khả năng có thể.

---

## 0. Mô hình tổng quan — ba lớp

| Lớp | Địa chỉ public | Chạy gì | Trình quản lý | Mã nguồn nằm ở |
|---|---|---|---|---|
| **Web** (`web.nguyen-robot.io.vn`, cổng 3000) | Next.js production container | Docker Compose | `apps/web/` |
| **API** (`api.nguyen-robot.io.vn`, cổng 5000) | NestJS production container | Docker Compose | `apps/api/` |
| **Robot** (WS 9091, Camera 9092) | 9 ROS 2 node qua PM2 | PM2 | `services/robot/` |

Các domain public đã được Cloudflare Tunnel reverse-proxy sẵn trên Pi — **không cần tự dựng proxy mới**.

---

## 1. Kiểm tra nhanh trạng thái hiện tại

```bash
pm2 status
docker compose ps
ls -l ~/<đường-dẫn-tới-repo>/   # thư mục gốc của repo
```

Nếu `pm2` hoặc `docker compose` chưa có, nhảy sang mục 7 (cài đặt lần đầu).

---

## 2. Khởi động sau khi reboot Pi

Lệnh một lần duy nhất, đúng chuẩn:

```bash
cd ~/<đường-dẫn-tới-repo>
./start-all.sh                # pull code + docker compose + robot start.sh
```

Nếu Pi mất mạng nhưng code trên đĩa đã mới, bỏ qua bước pull:

```bash
./start-all.sh --skip-git
```

`start-all.sh` chạy theo thứ tự:
1. `git pull --ff-only`
2. Kiểm tra `apps/api/.env` (nếu thiếu thì copy từ `.env.example` — bạn phải tự sửa secrets sau)
3. `docker compose up -d --build` (API + Web)
4. `bash services/robot/start.sh` (9 process PM2)

---

## 3. Khởi động lại một lớp cụ thể

| Lớp | Lệnh khởi động lại |
|---|---|
| Tất cả (API + Web + Robot) | `./start-all.sh` |
| Chỉ API (rebuild + tạo lại container) | `docker compose up -d --build --force-recreate api` |
| Chỉ Web (rebuild + tạo lại container) | `docker compose up -d --build --force-recreate web` |
| Robot (toàn bộ 9 process PM2, rebuild colcon) | `bash services/robot/start.sh` |
| Một ROS node | `pm2 restart nexus-robot-<tên>` (xem danh sách đầy đủ bên dưới) |

`pm2 restart` giữ nguyên file trên đĩa; `pm2 delete && pm2 start` chỉ cần khi đổi biến môi trường (xem mục 6).

Sau khi sửa bất kỳ file `.py` nào trong `services/robot/`, **phải** chạy `bash services/robot/start.sh` (script này rebuild colcon) — `pm2 restart` một mình sẽ chạy lại binary cũ.

Sau khi đổi `apps/web/.env.local` hoặc `apps/api/.env`, phải chạy `docker compose up -d --build --force-recreate api` (hoặc `... web`) để áp dụng.

---

## 4. Danh sách đầy đủ 9 process PM2 của robot

```bash
pm2 status
```

| Tên PM2 | Source | Lệnh restart | Vai trò |
|---|---|---|---|
| `nexus-robot-lidar` | `lidar_only_launch.py` | `pm2 restart nexus-robot-lidar` | Driver RPLidar trên `/dev/ttyUSB0` (symlink `/dev/robot-lidar`) |
| `nexus-robot-slam` | `slam_only_launch.py` | `pm2 restart nexus-robot-slam` | slam_toolbox online_async (chế độ MAPPING) |
| `nexus-robot-map-manager` | `map_manager_node.py` | `pm2 restart nexus-robot-map-manager` | Máy trạng thái 5-trạng-thái + obstacle layer |
| `nexus-robot-web-bridge` | `web_bridge.py` | `pm2 restart nexus-robot-web-bridge` | WS server cổng 9091 — chuyển tiếp ROS → trình duyệt |
| `nexus-robot-esp32-telemetry` | `esp32_telemetry_node.py` | `pm2 restart nexus-robot-esp32-telemetry` | Đọc `/dev/ttyACM0` (symlink `/dev/robot-esp32`), publish `/esp32/status` |
| `nexus-robot-brain` | `brain_node.py` | `pm2 restart nexus-robot-brain` | Bộ lập kế hoạch cao cấp (job Nav2) — cần `ROBOT_BRAIN_TOKEN` |
| `nexus-robot-vision` | `april_tag_node.py` | `pm2 restart nexus-robot-vision` | Nhận diện AprilTag |
| `nexus-robot-camera` | `camera_stream.py` | `pm2 restart nexus-robot-camera` | MJPEG `:9092` + `/snapshot` |
| `nexus-robot-nav2` | `nav2_launch.py` | `pm2 restart nexus-robot-nav2` | Stack Nav2 (chế độ LIVE) — loại trừ với slam |

Tiền tố `nexus-robot-` được đặt bởi biến `SERVICE_NAME_PREFIX` trong `services/robot/start.sh`.

---

## 5. Xem log

| Mục tiêu | Lệnh |
|---|---|
| Tất cả process robot (tail realtime) | `pm2 logs` |
| Một process robot, N dòng cuối | `pm2 logs nexus-robot-<tên> --lines 100 --nostream` |
| Container API | `docker compose logs -f api` |
| Container Web | `docker compose logs -f web` |
| Tốc độ một ROS topic | `source /opt/ros/jazzy/setup.bash && source ~/robot_ws/install/setup.bash && ros2 topic hz /esp32/status` |
| Xem nhanh một ROS topic | `ros2 topic echo /map --once` |

---

## 6. Đổi biến môi trường (token, URL, port)

PM2 chỉ chụp biến môi trường lúc `start`; `restart` không nhặt biến mới. Khi đổi token hoặc URL:

```bash
# Ví dụ: đổi API_SOCKET_URL
pm2 delete nexus-robot-brain
API_SOCKET_URL=https://api.nguyen-robot.io.vn ROBOT_BRAIN_TOKEN=<token-của-bạn> \
    pm2 start "bash" --name nexus-robot-brain --exp-backoff-restart-delay=1000 --max-restarts 50 \
    -- -c "source /opt/ros/jazzy/setup.bash && source ~/robot_ws/install/setup.bash && \
           ros2 run my_robot_controller brain"
pm2 save

# Hoặc đơn giản hơn: chạy lại start.sh để script nhặt env từ shell hiện tại:
bash services/robot/start.sh
```

Tương tự với `API_PORT`, `MONGO_URI`, `MAPS_DIR` — sửa `apps/api/.env`, sau đó:

```bash
docker compose up -d --build --force-recreate api
```

Với biến `NEXT_PUBLIC_*` của web, sửa `apps/web/.env.local` (hoặc đợi CI đẩy từ GitHub vars vào build args) rồi:

```bash
docker compose up -d --build --force-recreate web
```

Lưu ý: `NEXT_PUBLIC_*` là **build-time** — bắt buộc phải rebuild, không dùng restart được.

---

## 7. Cài đặt lần đầu trên Pi mới

```bash
# 1. Cài Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# logout + login lại

# 2. Cài Node 22 + Yarn 1.x
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g yarn

# 3. Cài ROS 2 Jazzy + colcon + pyserial-asyncio
sudo apt-get install -y ros-jazzy-desktop python3-colcon-common-extensions python3-serial-asyncio ffmpeg

# 4. Cài PM2 + udev rules + clone repo
sudo npm install -g pm2
sudo usermod -aG dialout $USER
# logout + login lại

# Clone repo vào workspace
cd ~/<thư-mục-đích>
# git clone từ GitHub

# 5. Khởi động tất cả
./start-all.sh
```

Quy tắc udev đặt tên cổng ổn định nằm trong `services/robot/config/udev/99-robot-ports.rules`. Nếu symlink `/dev/robot-esp32` hoặc `/dev/robot-lidar` mất sau reboot, cài lại:

```bash
sudo bash services/robot/tools/install_udev_rules.sh
```

---

## 8. Một-lệnh chẩn đoán

```bash
# Ai đang giữ cổng serial ESP32 ngay lúc này?
sudo lsof /dev/ttyACM0 /dev/robot-esp32

# LiDAR có nhận tín hiệu không?
source /opt/ros/jazzy/setup.bash && source ~/robot_ws/install/setup.bash
ros2 topic hz /scan --window 10

# ESP32 alive frames có chạy không?
pm2 logs nexus-robot-esp32-telemetry --lines 30 --nostream | tail -20

# Camera server còn sống không?
curl -I http://localhost:9092/        # health
curl -I http://localhost:9092/snapshot

# WebSocket bridge còn sống không?
sudo lsof -i :9091

# Disk + RAM sanity
df -h ~ && free -h
```

---

## 9. Tại sao phải `pm2 restart` (hoặc `start.sh`) thủ công sau `git pull`

`pm2 start` chạy trình thông dịch Python **đúng một lần** lúc khởi động, giữ process sống trong bộ nhớ. Khi repo đổi code:

- `pm2 restart nexus-robot-<tên>` chạy lại cùng câu lệnh `bash -c "...ros2 run ..."` — nhưng **runner `ros2 run` resolve entry-point từ `~/robot_ws/install/` chứ không phải từ repo mới**. Nên `restart` là vô hiệu đối với thay đổi code.
- `bash services/robot/start.sh` mới đúng công cụ: copy `services/robot/src/my_robot_controller` vào `~/robot_ws/src/`, chạy `colcon build`, sau đó `pm2 start` lại từng node — từ đó entry-point resolve lại từ install đã rebuild.

Với sửa env var một dòng (không đổi Python), `pm2 restart` đủ. Với bất kỳ đổi file `.py` nào, dùng `bash services/robot/start.sh`.

Bình thường CI/CD làm việc này cho bạn (`.github/workflows/deploy.yml` gọi `bash services/robot/deploy.sh` mỗi lần push `master`). Khi CI chết hoặc muốn áp fix ngoài luồng, chạy `start.sh` thủ công.

---

## 10. Thẻ tra nhanh — copy paste được

```bash
# Tôi vừa reboot Pi
./start-all.sh

# Tôi chỉ đổi code dưới services/robot/
bash services/robot/start.sh

# Tôi chỉ đổi apps/api/ hoặc apps/web/ .env
docker compose up -d --build --force-recreate api   # hoặc web

# Chỉ một process robot bị kẹt
pm2 restart nexus-robot-<tên>

# Tôi cần xem log lỗi
pm2 logs --lines 50                                # tất cả log robot
docker compose logs -f api                          # API
docker compose logs -f web                          # Web

# Panel ESP32 hiển thị "undefined" hoặc cũ
pm2 restart nexus-robot-esp32-telemetry

# Trình duyệt báo lỗi CORS camera
pm2 restart nexus-robot-camera
```
