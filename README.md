# 🤖 AGV SMART — Robot Logistics Tự Hành (AIoT)

> **Monorepo** chứa toàn bộ hệ thống kho hàng tự động: backend, web dashboard, mobile app, ROS 2 robot bridge và firmware ESP32-S3. Dự án tốt nghiệp — sinh viên Trần Đức Nguyên (TDTU).

[![CI](https://github.com/.../actions/workflows/ci.yml/badge.svg)](.github/workflows/ci.yml)
[![Deploy](https://github.com/.../actions/workflows/deploy.yml/badge.svg)](.github/workflows/deploy.yml)

---

## 1. Giới thiệu dự án

Hệ thống gồm một **robot vận chuyển tự hành** hoạt động trong kho hàng, kết hợp với **dashboard quản lý kho** (web + mobile) để theo dõi vị trí kiện hàng, trạng thái kệ và tình trạng robot theo thời gian thực.

**Mục tiêu cốt lõi:**

- 🗺️  **SLAM & lập bản đồ kho** — robot tự dò đường bằng LiDAR và xây dựng bản đồ occupancy grid.
- 🧭  **Điều hướng tự động** — bám theo bản đồ đã học và tự né vật cản.
- 📦  **Vận chuyển hàng tự động** — di chuyển các kiện giữa các ô trong kệ (slot-to-slot).
- 📱  **Dashboard thời gian thực** — xem trạng thái kho + bản đồ SLAM trên web và điện thoại.
- 🤖  **Tay máy 5 bậc** — robot có cánh tay robot gắn trên lưng để gắp/nhả kiện (firmware hỗ trợ, đang tích hợp).

**Chiến lược kiến trúc** — chia đôi rõ ràng giữa xử lý cao cấp và điều khiển thời gian thực:

- **Raspberry Pi 5 (8GB)** — chạy ROS 2, SLAM, xử lý LiDAR, cầu nối sang backend. Làm "bộ não" cấp cao.
- **ESP32-S3 (WeAct N16R8)** — chạy vòng điều khiển động cơ ở tần số 50Hz, đọc encoder, chạy PID, xử lý cảm biến an toàn. Làm "hệ điều hành thời gian thực".

Hai bên giao tiếp qua **UART 115200 baud** bằng giao thức JSON (xem [mục 8](#8-giao-thức-pi--esp32)).

---

## 2. Cấu trúc thư mục

```
robot-for-nguyen/                         # monorepo root
├── package.json                          # yarn workspaces + turbo scripts
├── turbo.json                            # task graph
├── .github/workflows/
│   ├── ci.yml                            # Lint + build affected apps
│   └── deploy.yml                        # Path-filtered deploy to Pi
│
├── apps/                                 # các app Node/TypeScript
│   ├── api/                              # @robot-for-nguyen/api  — NestJS backend
│   ├── web/                              # @robot-for-nguyen/web  — Next.js dashboard
│   └── mobile/                           # @robot-for-nguyen/mobile — Expo (Expo Router)
│
├── services/
│   └── robot/                            # ROS 2 + Python  — cầu nối trên Pi 5
│       └── src/my_robot_controller/
│           ├── map_manager_node.py       # State machine cho mapping
│           ├── web_bridge.py             # WebSocket server (port 9091)
│           ├── launch/                   # ROS 2 launch files
│           └── config/                   # SLAM params, v.v.
│
├── firmware/                             # ESP32-S3 PlatformIO project
│   ├── platformio.ini                    # target: weact-esp32s3-n16r8
│   ├── src/                              # main.cpp + modules/
│   └── include/                          # config.h + modules/
│
├── tools/deploy/                         # Toolkit SSH thủ công (deploy-all.sh, ...)
├── scripts/                              # Helper scripts (postinstall-hoist-next.js)
├── packages/                             # Dành cho shared types (đang trống)
└── docs/superpowers/specs/               # Design specs
```

| Thư mục         | Vai trò                              | Tech stack              | Port     | CI/CD          |
|-----------------|--------------------------------------|-------------------------|----------|----------------|
| `apps/api`      | Backend quản lý kho + real-time      | NestJS 11 + Mongoose    | `5000`   | ✅ path-filter |
| `apps/web`      | Dashboard kho                        | Next.js 16 + Redux       | `3000`   | ✅ path-filter |
| `apps/mobile`   | App mobile cho nhân viên kho         | Expo 55 + Expo Router   | —        | ❌ (theo yêu cầu) |
| `services/robot`| ROS 2 nodes + WebSocket bridge        | Python 3 + ROS 2        | `9091` WS| ✅ path-filter |
| `firmware`      | Điều khiển động cơ + cảm biến        | PlatformIO + Arduino    | UART     | ❌ flash thủ công |
| `tools/deploy`  | SSH toolkit cho deploy thủ công      | bash                    | —        | —              |

---

## 3. Kiến trúc tổng thể

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  PHẦN CỨNG ROBOT                                                            │
│  ┌────────────────────┐  ┌──────────────┐  ┌──────────────┐                  │
│  │  RPLIDAR A1M8-R6   │  │  Webcam      │  │  Tay máy 5DOF│                  │
│  │  (360°, 12m)       │  │  (QR scan)   │  │  (6 servos)  │                  │
│  └─────────┬──────────┘  └──────┬───────┘  └──────┬───────┘                  │
│            │ USB                │ USB            │ I2C                       │
│            ▼                    ▼                ▼                          │
│  ┌────────────────────────────────────────────────────────┐                  │
│  │  RASPBERRY PI 5 (Ubuntu 22.04 + ROS 2 Humble)          │                  │
│  │  ┌──────────────────┐  ┌──────────────────────────┐    │                  │
│  │  │  sllidar_ros2    │─▶│  slam_toolbox             │    │                  │
│  │  │  /scan (12 Hz)   │  │  TF + /map                │    │                  │
│  │  └──────────────────┘  └──────────────────────────┘    │                  │
│  │            │                       │                    │                  │
│  │            ▼                       ▼                    │                  │
│  │  ┌────────────────────────────────────────────┐        │                  │
│  │  │  map_manager_node  (state machine)         │        │                  │
│  │  │  web_bridge.py  →  ws://0.0.0.0:9091       │        │                  │
│  │  └────────────────┬───────────────────────────┘        │                  │
│  │                   │ UART 115200                         │                  │
│  │                   ▼                                     │                  │
│  │  ┌────────────────────────────────────────────┐        │                  │
│  │  │  apps/api  (NestJS)  ← cùng máy Pi 5      │        │                  │
│  │  │  port 5000 — REST + Socket.io              │        │                  │
│  │  └────────────────────────────────────────────┘        │                  │
│  └────────────────────────┬───────────────────────────────┘                  │
│                           │                                                  │
└───────────────────────────┼──────────────────────────────────────────────────┘
                            │
              ┌─────────────┴─────────────┐
              ▼                           ▼
  ┌──────────────────────────┐  ┌────────────────────────┐
  │  apps/web (Next.js)      │  │  apps/mobile (Expo)    │
  │  port 3000               │  │  Expo Go / native      │
  │  Dashboard kho           │  │  App nhân viên         │
  │  + SLAM map viewer       │  │  + QR scanner          │
  │  + Socket.io real-time   │  │  + camera stream       │
  └──────────────────────────┘  └────────────────────────┘
```

**Bốn lớp chức năng** trong monorepo:

| Lớp                 | Module trong repo                                    |
|---------------------|-------------------------------------------------------|
| Sensing (LiDAR/SLAM)| `services/robot/src/my_robot_controller/web_bridge.py` + `map_manager_node.py` |
| Gateway             | `services/robot/src/my_robot_controller/` (Python nodes) |
| Control (firmware)  | `firmware/` (ESP32-S3)                                 |
| Interface (backend) | `apps/api/`                                            |

---

## 4. Các thành phần chi tiết

### 4.1. `apps/api` — Backend NestJS

**Mục đích:** REST API + WebSocket cho dashboard kho. Lưu trữ thông tin kệ, kiện hàng và broadcast thay đổi real-time đến web/mobile.

- **Cổng:** `5000` (cấu hình qua `PORT`).
- **Cơ sở dữ liệu:** MongoDB qua Mongoose ODM (`MONGO_URI`).
- **API docs:** Swagger UI tại `/api/docs`.

**Các module NestJS** (`src/modules/`):

| Module     | Đường dẫn gốc                            | Vai trò                                     |
|------------|------------------------------------------|----------------------------------------------|
| `app`      | `src/app.controller.ts`                  | Health check + root module                   |
| `gateway`  | `src/gateway/events-gateway.ts`          | Global Socket.io broadcast                  |
| `package`  | `src/modules/package/`                   | CRUD kiện hàng + phân trang                 |
| `shelf`    | `src/modules/shelf/`                     | Quản lý kệ + 64 ô (4 kệ × 4 hàng × 4 cột) |

**Endpoint chính:**

- `GET /packages` — danh sách kiện (phân trang: `page`, `limit`)
- `POST /packages` — tạo kiện mới
- `GET /packages/:id` — chi tiết kiện
- `PUT /packages/:id` — cập nhật
- `DELETE /packages/:id` — xóa (đồng thời giải phóng ô)
- `GET /shelves` — 4 kệ `S1`–`S4`
- `GET /shelves/slots` — 64 ô
- `POST /shelves/:slotCode/package` — gán kiện vào ô
- `PUT /shelves/:slotCode/package` — chuyển kiện sang ô khác

**Sự kiện Socket.io** (broadcast real-time):

| Sự kiện          | Khi nào                                          |
|------------------|--------------------------------------------------|
| `package:created`| Sau khi tạo kiện                                 |
| `package:updated`| Sau khi cập nhật                                 |
| `package:deleted`| Sau khi xóu kiện                                 |
| `shelf:updated`  | Khi slot bị thay đổi (gán / chuyển / giải phóng) |

**Pattern chính:**
- Controller → Service → Repository (3 lớp tách biệt rõ ràng).
- Interface + DI token (ví dụ: `IPACKAGE_REPOSITORY`) để giảm coupling.
- `PackageModule` ↔ `ShelfModule` có **circular dependency** → xử lý bằng `forwardRef`.

Đọc thêm tại `apps/api/CLAUDE.md`.

---

### 4.2. `apps/web` — Frontend Next.js

**Mục đích:** Dashboard quản lý kho cho nhân viên vận hành.

- **Cổng:** `3000` (dev + prod).
- **Framework:** Next.js 16 (App Router) + React 19 + TypeScript strict mode.
- **UI library:** Ant Design 6 + Tailwind v4 + Lucide icons.
- **State:** Redux Toolkit (store trung tâm) + RTK Query (server state).

**Các trang chính** (`src/app/`):

| Route          | Mục đích                                                     |
|----------------|--------------------------------------------------------------|
| `/`            | Redirect → `/inventory`                                      |
| `/inventory`   | Lưới quản lý kho: chọn ô nguồn, ô đích, gửi lệnh di chuyển  |
| `/map`         | SLAM map viewer (WebSocket thô từ Pi 5)                      |
| `/camera`      | Hiển thị camera stream từ robot                              |
| `/products`    | Catalog sản phẩm legacy (route động `/products/[id]`)        |

**Cấu trúc Redux** (`src/store/`):

- `store.ts` — store chính (đang dùng)
- `apiSlice.ts` — RTK Query: `getPackages`, `submitMoveCommand` (mock in-memory)
- `inventorySlice.ts` — UI state: ô nguồn/đích đang chọn
- `services/baseApi.ts` + `services/productApi.ts` — pattern `injectEndpoints`

**Socket.io:**
- `src/lib/socket.ts` kết nối tới `NEXT_PUBLIC_API_BASE_URL`.
- Cache tự cập nhật qua `onCacheEntryAdded` lifecycle của RTK Query.
- Bảng sự kiện web subscribe:

  | Sự kiện       | Ảnh hưởng cache                                |
  |---------------|------------------------------------------------|
  | `package:created` | Prepend vào `getPackages` cache             |
  | `package:updated` | Replace trong `getPackages` cache           |
  | `package:deleted` | Xóa khỏi `getPackages` cache                |
  | `shelf:updated`   | Upsert vào `getAllSlots` cache             |

**WebSocket thô (raw):**
- `map/page.tsx` kết nối `ws://<robot-ip>:9091` (xem [mục 4.4](#44-servicesrobot--ros-2--websocket-bridge)).
- Nhận dữ liệu SLAM map + LiDAR points + pose robot.

**Bilingual UI:** mọi text hiển thị cho người dùng **đều bằng tiếng Việt** (`message.success('Thành công!')`, `message.error('Lỗi!')`, ...).

Đọc thêm tại `apps/web/CLAUDE.md`.

---

### 4.3. `apps/mobile` — App Expo

**Mục đích:** App cho nhân viên kho dùng trên điện thoại — quét QR, xem camera, nhận thông báo real-time.

- **Framework:** Expo 55 (Expo Router) + React Native 0.83.
- **Routing:** Expo Router (file-based, giống Next.js App Router).
- **State:** Zustand (theo quy ước monorepo — KHÔNG dùng Redux).

**Cấu trúc:**

```
apps/mobile/
├── app/                    # Expo Router file-based routes
├── assets/                 # Ảnh, font
├── src/                    # source code
├── scripts/                # Helper scripts
├── app.json                # Expo config
├── eslint.config.js        # Flat config (eslint-config-expo)
└── package.json
```

**Cài đặt & chạy:**

```bash
cd apps/mobile
yarn install
yarn start             # Expo dev server
yarn android           # build & run trên Android
yarn ios               # build & run trên iOS
yarn lint              # expo lint
```

**Build cho production** (qua Expo Application Services — EAS):

```bash
npx eas build --platform android
npx eas build --platform ios
```

> **Lưu ý:** Mobile app **không có CI/CD** trong monorepo (theo quyết định dự án). Build thủ công qua EAS account của bạn.

---

### 4.4. `services/robot` — ROS 2 + WebSocket bridge

**Mục đích:** Phần mềm chạy trên Pi 5 để:
1. Nhận dữ liệu LiDAR (`/scan`) qua `sllidar_ros2`.
2. Xây dựng bản đồ SLAM bằng `slam_toolbox` (online_async).
3. Quản lý state machine mapping (`map_manager_node.py`).
4. Phát dữ liệu real-time qua WebSocket thô cho web (`web_bridge.py`).

- **Cổng WebSocket:** `9091` (raw, không phải Socket.io).
- **Python 3** + **ROS 2 Humble** + `colcon` build system.
- **Quản lý tiến trình:** PM2 trên Pi 5.

**Cấu trúc package ROS 2:**

```
services/robot/
├── src/my_robot_controller/
│   ├── my_robot_controller/   # Python module
│   │   ├── __init__.py
│   │   ├── map_manager_node.py   # State machine mapping (5 trạng thái)
│   │   └── web_bridge.py         # WebSocket server
│   ├── launch/
│   │   ├── lidar_only_launch.py  # Chỉ chạy lidar
│   │   └── slam_only_launch.py   # Chỉ chạy SLAM
│   ├── config/
│   │   └── slam_params.yaml      # Cấu hình slam_toolbox
│   ├── resource/
│   ├── package.xml
│   ├── setup.cfg
│   └── setup.py
├── deploy.sh                    # Build + pm2 start all
├── install-pi.sh                # Cài đặt ban đầu trên Pi
└── CLAUDE.md                    # Tài liệu API WebSocket
```

**Hệ 5 trạng thái của `map_manager`:**

| Trạng thái         | Mô tả                                                                 |
|--------------------|-----------------------------------------------------------------------|
| `IDLE`             | Chưa mapping. slam_toolbox chạy nền nhưng không ghi bản đồ.           |
| `MAPPING_IDLE`     | Đã nhận `'start'`, slam_toolbox sẵn sàng, chờ robot di chuyển.       |
| `MAPPING_ACTIVE`   | Robot di chuyển → slam_toolbox ghi lại. Map được đẩy về frontend.     |
| `SCAN_OBSTACLE`    | Nhận `'stop'`. Tích lũy quét 360° sạch, dựng vùng nhận thức 2m.     |
| `LIVE`             | Hiển thị bản đồ SLAM + overlay chướng ngại vật 2m, cập nhật liên tục.|

**Luồng dữ liệu ROS 2:**

```
sllidar_ros2  →  /scan  ──┬──▶  slam_toolbox  →  TF (map→odom→base_footprint)
                            │                          /map
                            ├──▶  map_manager  →  /map_combined
                            │                       /obstacle_layer
                            └──▶  web_bridge  →  ws://0.0.0.0:9091
                                                       ↓
                                                  Web dashboard
```

**Các node quản lý qua PM2:**

| Process name             | Node ROS 2                              |
|--------------------------|------------------------------------------|
| `nexus-robot-lidar`      | `sllidar_ros2`                           |
| `nexus-robot-slam`       | `slam_toolbox` (online_async)            |
| `nexus-robot-map-manager`| `my_robot_controller/map_manager`        |
| `nexus-robot-web-bridge` | `my_robot_controller/web_bridge`         |

**API WebSocket (port 9091):**

| Message (server → client) | Tần suất     | Mô tả                                         |
|----------------------------|-------------|------------------------------------------------|
| `scan`                     | ≤ 5 Hz      | Point cloud LiDAR, robot-centric               |
| `map_layer`                | ≤ 5 Hz      | Bản đồ SLAM (gzip-compressed)                  |
| `obstacle_layer`           | one-shot    | Vùng chướng ngại vật 2m, sau khi `'stop'`      |
| `pose`                     | ~10 Hz      | Tọa độ robot từ TF (`x, y, theta`)             |
| `status`                   | on change   | Chuỗi trạng thái dễ đọc                        |
| `mode`                     | on change   | Tên trạng thái máy (`mapping_active`, ...)     |
| `info`                     | mỗi 5s     | Trạng thái các nguồn dữ liệu                   |
| `ping`                     | mỗi 5s     | Keepalive                                      |

**Lệnh client → server:**

```javascript
ws.send(JSON.stringify({ type: 'cmd', command: 'start' })); // Bắt đầu mapping
ws.send(JSON.stringify({ type: 'cmd', command: 'stop'  })); // Dừng + quét obstacle
ws.send(JSON.stringify({ type: 'cmd', command: 'idle'  })); // Về IDLE
ws.send(JSON.stringify({ type: 'cmd', command: 'reset' })); // Reset toàn bộ
```

Đọc thêm tại `services/robot/CLAUDE.md`.

---

### 4.5. `firmware` — ESP32-S3 (PlatformIO / Arduino)

**Mục đích:** Firmware thời gian thực cho ESP32-S3. Chạy vòng điều khiển động cơ ở tần số 50Hz, đọc encoder qua PCNT, chạy PID, xử lý cảm biến an toàn, giao tiếp với Pi qua UART.

- **Board:** WeAct ESP32-S3 N16R8 (16MB Flash, 8MB Octal PSRAM).
- **Framework:** Arduino (qua PlatformIO).
- **Cổng nạp:** USB-C native (xuất hiện thành `/dev/ttyACM0` trên Pi).
- **Cổng giao tiếp motor:** UART2 (GPIO 43 TX / GPIO 44 RX) ↔ Pi 5.

**Cấu trúc module** (`src/modules/`):

| Module              | Vai trò                                                  |
|---------------------|----------------------------------------------------------|
| `BTS7960Driver`     | Tạo PWM, enable/disable, brake/coast, E-stop             |
| `Encoder`           | PCNT hardware counter, tính RPM, x2 decoding              |
| `PIDController`     | Vòng điều khiển PID với anti-windup                       |
| `MecanumDrive`      | Inverse kinematics, chuẩn hóa, ramp tăng tốc              |
| `Watchdog`          | Theo dõi heartbeat, chuyển chế độ SAFE/MANUAL/NAV         |
| `ObstacleAvoidance` | Logic né vật cản từ sự kiện LiDAR (4 hướng)              |
| `WebServer`         | WiFi + WebSocket cho manual control dashboard            |
| `ModeManager`       | State machine trung tâm, route lệnh đến motor            |
| `CommandParser`     | Parse JSON + ASCII từ UART                                |

**Hệ 4 chế độ hoạt động:**

```
        ┌──────────────────────────┐
        │  MODE: NAV               │   ← Pi đang gửi heartbeat
        │  Pi5 → heartbeat + move  │      + ObstacleAvoidance bật
        └─────────────┬────────────┘
                      │ Pi mất tín hiệu (2s)
                      ▼
        ┌──────────────────────────┐
        │  MODE: MANUAL            │   ← Web UI đang điều khiển
        │  Web control, PID vẫn   │
        └─────────────┬────────────┘
                      │ Mất cả web
                      ▼
        ┌──────────────────────────┐
        │  MODE: SAFE              │   ← Tất cả motor BRAKE
        │  Chờ lệnh mới           │      PID tắt
        └─────────────┬────────────┘
                      │ E-stop (bất kỳ lúc nào)
                      ▼
        ┌──────────────────────────┐
        │  MODE: E-STOP            │   ← Tắt driver qua enable pin
        │  Chỉ "clear e-stop" mới  │
        │  khôi phục được          │
        └──────────────────────────┘
```

**Tham số mặc định** (`include/config.h`):

| Tham số                | Mặc định | Ý nghĩa                          |
|------------------------|----------|-----------------------------------|
| `HEARTBEAT_TIMEOUT_MS` | 2000     | Ngưỡng timeout Pi trước khi rời NAV |
| `OBSTACLE_THRESHOLD_CM`| 100      | Ngưỡng LiDAR để kích hoạt né      |
| `DODGE_STRAFE_SPEED`   | 100      | Tốc độ strafe khi né              |
| `DODGE_DURATION_MS`    | 800      | Thời gian giữ né trước khi đánh giá lại |
| `Kp/Ki/Kd`             | 2.0/0.8/0.1 | Hệ số PID mặc định           |
| Tần số PID             | 50 Hz    | Chu kỳ cập nhật                    |
| PWM                    | 20 kHz   | Tần số LEDC, 10-bit                |

**Build & flash:**

```bash
cd firmware
pio run                       # Build
pio run --target upload       # Flash qua USB-C
pio device monitor            # Xem serial log
```

Đọc thêm tại `firmware/CLAUDE.md` và `firmware/MODULES.md`.

---

## 5. Phần cứng robot

### 5.1. Bộ xử lý

| Module            | Thông số                                                |
|-------------------|---------------------------------------------------------|
| Raspberry Pi 5    | Broadcom BCM2712, 4× Cortex-A76 @ 2.4GHz, 8GB LPDDR4X  |
|                   | 512GB NVMe Gen4×4, Ubuntu 22.04 LTS, ROS 2 Humble       |
| ESP32-S3 N16R8    | Xtensa LX7 dual-core, 16MB Flash, 8MB Octal PSRAM       |
|                   | WiFi/BT, USB-C native CDC, 2× UART, I2C, SPI             |

### 5.2. Hệ thống di chuyển

| Linh kiện               | Số lượng | Thông số                                            |
|-------------------------|----------|------------------------------------------------------|
| BTS7960 Motor Driver    | 4        | 6–27VDC, 43A đỉnh, 20kHz PWM                        |
| JGB37-520 DC Geared     | 4        | 12VDC, 333RPM no-load, tỉ số truyền 30:1            |
| Encoder Hall-effect     | 4        | Quadrature, 11 PPR trên trục motor (x2 = 22 PPR)     |
| Mecanum Wheel           | 4        | 97mm, bố trí hình X                                  |

### 5.3. Cảm biến & cánh tay

| Linh kiện                | Vai trò                                                    |
|--------------------------|------------------------------------------------------------|
| RPLIDAR A1M8-R6          | 360°, tầm 0.15–12m, UART 115200 → cắm vào Pi 5 qua USB-UART |
| Webcam                   | Nhận dạng QR / quan sát                                    |
| 5DOF Robotic Arm         | 3× MG996R + 3× SG90 servos, tầm với ~40cm                 |
| IMU (BNO055 hoặc MPU6050)| I2C → ESP32, dùng để ổn định yaw cho SLAM (bù trượt bánh)  |
| 4× E18-D80NK IR sensor   | ~20cm, kết nối ESP32, **xử lý trực tiếp trên ESP32** cho an toàn tối đa |
| Logitech BRIO 100        | Camera FullHD                                              |

### 5.4. Nguồn điện

| Thành phần            | Thông số                                                 |
|-----------------------|----------------------------------------------------------|
| Nguồn ngoài (hiện tại)| 21VDC PSU                                                |
| Pin (dự kiến)         | 3S3P 18650 (11.1V nom / 12.6V full) với BMS 40A          |
| Buck converter        | 21V → 12V (motor), 21V → 5V (logic)                      |

**Nguyên tắc quan trọng:** tất cả các module (RPi 5, ESP32-S3, BTS7960, LiDAR, nguồn) **phải chung mass** (GND) — bắt buộc để UART hoạt động đúng.

### 5.5. Cơ chế an toàn

- **IR sensor** xử lý **trực tiếp trên ESP32** (không qua Pi) để đảm bảo độ trỉ tối thiểu khi có vật cản gần (< 20cm).
- **E-stop** (`D` lệnh hoặc nút nhấn vật lý) tắt driver qua chân enable, không cần qua state máy — chỉ `K` (clear e-stop) mới khôi phục được.

---

## 6. Cài đặt & Chạy local

### 6.1. Yêu cầu môi trường

- **Node.js** ≥ 20
- **Yarn** 1.22.22 (classic)
- **Python 3** + ROS 2 Humble (chỉ cần khi làm việc với `services/robot`)
- **PlatformIO** (chỉ cần khi flash firmware)
- **MongoDB** instance (chỉ cần khi chạy `apps/api`)

### 6.2. Cài đặt lần đầu

```bash
# 1. Cài dependencies cho toàn monorepo (hoist lên /node_modules)
yarn install

# 2. Postinstall script tự tạo symlink để fix lỗi eslint-config-next
#    (nếu lỗi, chạy tay: node scripts/postinstall-hoist-next.js)
```

### 6.3. Chạy từng app local

```bash
# Backend (port 5000)
cd apps/api
cp .env.example .env          # điền MONGO_URI, PORT
yarn start:dev                # nest start --watch

# Web dashboard (port 3000)
cd apps/web
yarn dev

# Mobile (Expo dev server)
cd apps/mobile
yarn start                    # sau đó mở Expo Go trên điện thoại

# Robot (chỉ chạy trên Pi 5)
cd services/robot
./deploy.sh                   # colcon build + pm2 start
```

### 6.4. Các lệnh thường dùng ở root

```bash
# Build / lint toàn bộ
yarn build
yarn lint

# Chỉ một app
yarn dev:api
yarn dev:web
yarn dev:mobile

# Turbo filter (chỉ chạy trên app bị ảnh hưởng bởi thay đổi)
yarn turbo run build --filter=@robot-for-nguyen/api
yarn turbo run lint  --filter=...[origin/master]

# Dọn dẹp
yarn clean
```

---

## 7. Triển khai (Deploy)

### 7.1. Triể khai tự động qua CI/CD

Hai workflow tại `.github/workflows/`:

**`ci.yml`** — kiểm tra lint + build:
- Trigger: push to `master`, PR, manual.
- Chạy trên `ubuntu-latest`.
- `yarn turbo run lint build --filter=@robot-for-nguyen/{api,web,mobile}`.
- Upload `api-dist` artifact (hiện đang là dư thừa, chưa dùng đến — xem TODO).

**`deploy.yml`** — path-filtered deploy lên Pi 5:
- Trigger: push to `master`, manual.
- Chạy trên self-hosted runner (chính là Pi 5).
- `dorny/paths-filter@v3` phát hiện app nào đổi → chỉ chạy job tương ứng.
- 3 job: `deploy-api`, `deploy-web`, `deploy-robot`. Mỗi job gọi `apps/<x>/deploy.sh`.
- **Mobile bị loại khỏi mọi filter** — không tự động deploy.

| Đường dẫn thay đổi              | Job chạy                              |
|--------------------------------|----------------------------------------|
| `apps/api/**`                  | `detect` + `deploy-api`                |
| `apps/web/**`                  | `detect` + `deploy-web`                |
| `services/robot/**`            | `detect` + `deploy-robot`              |
| `tools/deploy/**`              | `detect` + cả 3 deploy job             |
| `apps/mobile/**`               | `detect` only (không có deploy job)    |
| `firmware/**`                  | không thuộc filter nào                  |

### 7.2. Triển khai thủ công qua SSH

Nếu không muốn qua CI, dùng toolkit tại `tools/deploy/`:

```bash
# Từ máy dev
./tools/deploy/deploy-all.sh
./tools/deploy/stop-all.sh
./tools/deploy/install-pi.sh   # cài lần đầu trên Pi
```

### 7.3. Triển khai firmware

Firmware **không qua CI/CD** — flash trực tiếp qua USB:

```bash
cd firmware
pio run --target upload
pio device monitor
```

---

## 8. Giao thức Pi ↔ ESP32

Hai bên **phải thống nhất byte-for-byte**. Mọi thay đổi phải sửa cả `firmware/src/modules/CommandParser.cpp` lẫn handler Python ở `services/robot/`.

**Vật lý:**
- UART2 trên ESP32-S3: GPIO 43 (TX) / GPIO 44 (RX) ↔ Pi 5 UART.
- 115200 baud, 8N1, kết thúc bằng `\n`.

### 8.1. Lệnh JSON (Pi → ESP32)

| JSON                                              | Mục đích                                         |
|---------------------------------------------------|--------------------------------------------------|
| `{"cmd":"move","vx":100,"vy":0,"omega":0}`         | Vận tốc mecanum (vx, vy đơn vị PWM, omega scaled)|
| `{"cmd":"individual","speeds":[fl,fr,rl,rr]}`     | Tốc độ từng bánh (-255..255)                      |
| `{"cmd":"set_speed","motor_id":0,"speed":150}`    | Một motor                                         |
| `{"cmd":"set_all_speed","speeds":[100,...]}`      | Cả 4 motor                                        |
| `{"cmd":"stop"}` / `{"cmd":"e_stop"}`             | Phanh / tắt cứng                                 |
| `{"cmd":"get_encoder"}` / `{"cmd":"reset_encoder"}`| Đọc / reset encoder                              |
| `{"cmd":"set_pid","motor_id":0,"kp":1.0,...}`     | Đổi hệ số PID                                    |
| `{"cmd":"heartbeat"}`                             | Reset watchdog (Pi phải gửi trong HEARTBEAT_TIMEOUT_MS) |
| `{"cmd":"obstacle_left"\|"right"\|"front"\|"clear"}`| Sự kiện né vật cản (xem `ObstacleAvoidance`)     |

### 8.2. Phản hồi JSON (ESP32 → Pi)

| Type | Payload                                                                  |
|------|--------------------------------------------------------------------------|
| 128  | `{"type":128,"data":{...}}` — ACK                                       |
| 129  | `{"type":129,"data":{"error":"..."}}` — lỗi                              |
| 130  | `{"type":130,"data":{"motors":[{id,name,count,rpm},...]}}` — encoder     |
| 131  | `{"type":131,"data":{uptime_ms,mode,e_stop,pid,max_pct,motors:[...]}}` — status |

### 8.3. Lệnh ASCII (dự phòng, dùng khi debug hoặc qua web UI)

```
F 150   tiến              S        phanh
B 100   lùi               D / K    e-stop / clear e-stop
L 80    trái              M fl fr rl rr   manual motor
R 80    phải              Z        heartbeat
Q 60    xoay CCW          V        status JSON
E 60    xoay CW           P kp ki kd      set PID
T       test sequence     X 75     max speed %
?       trợ giúp
```

---

## 9. Quy ước phát triển

### 9.1. Quy ước chung (áp dụng toàn monorepo)

- **Package manager:** Yarn 1.22.22. Không dùng npm, không pnpm.
- **TypeScript:** strict mode. **Không dùng `any`**.
- **Ngôn ngữ UI:** mọi text người dùng thấy trên web/mobile **bằng tiếng Việt**.
- **Test:** hiện KHÔNG có framework test. Không tự ý thêm test trừ khi được yêu cầu.
- **Shared types:** `Package`, `Shelf`, `ShelfSlot`, `SelectedCell` hiện bị lặp giữa các app. Tương lai sẽ chuyển sang `packages/shared-types/`.

### 9.2. Quản lý state theo từng app

| App              | State management       |
|------------------|-------------------------|
| `apps/api`       | NestJS DI (server-side, không có state frontend) |
| `apps/web`       | Redux Toolkit + RTK Query |
| `apps/mobile`    | Zustand (KHÔNG dùng Redux) |
| `services/robot` | ROS 2 topics (pub/sub)  |
| `firmware`       | State machine C++ (`ModeManager`) |

### 9.3. Cấu trúc module NestJS (`apps/api`)

Mỗi module trong `src/modules/<tên>/`:

```
<module>/
├── dto/                              # Data Transfer Objects
│   ├── create-<module>.dto.ts
│   └── update-<module>.dto.ts
├── interfaces/                       # Hợp đồng (dùng string token)
│   ├── <module>-repository.interface.ts
│   └── <module>-service.interface.ts
├── schemas/                          # Mongoose schemas
│   └── <module>.schema.ts
├── <module>-controller.ts            # HTTP endpoints
├── <module>-service.ts               # Business logic
├── <module>-repository.ts            # Data access
└── <module>.module.ts                # NestJS module wiring
```

Controller → Service → Repository (3 lớp tách biệt, KHÔNG trộn lẫn).

### 9.4. Biến môi trường

| File                       | Biến                                        |
|----------------------------|---------------------------------------------|
| `apps/api/.env`            | `MONGO_URI`, `PORT`                         |
| `apps/web/.env.local`      | `NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_WS_URL` |
| `apps/mobile/.env`         | `EXPO_PUBLIC_API_BASE_URL`, `EXPO_PUBLIC_CAMERA_STREAM_URL` |
| `services/robot` env       | `LIDAR_MODEL` (vd: `a1`)                    |

File `.env` đã được gitignore. Mỗi app có file `.env.example` để tham khảo.

---

## 10. Các lệnh thường dùng (cheat sheet)

| Lệnh                                          | Mô tả                                          |
|-----------------------------------------------|-------------------------------------------------|
| `yarn install`                                | Cài đặt toàn monorepo                           |
| `yarn build`                                  | Build tất cả app (turbo)                       |
| `yarn lint`                                   | Lint tất cả app (turbo)                        |
| `yarn dev:api` / `dev:web` / `dev:mobile`     | Chạy dev từng app                               |
| `yarn turbo run build --filter=<name>`        | Build một app cụ thể                            |
| `cd firmware && pio run --target upload`      | Flash firmware lên ESP32-S3                    |
| `cd services/robot && ./deploy.sh`            | Build + start toàn bộ node ROS 2 trên Pi        |
| `pm2 status` (trên Pi)                        | Xem trạng thái 4 node ROS 2                    |
| `pm2 logs nexus-robot-web-bridge`             | Xem log WebSocket                              |
| `ros2 topic list` (trên Pi)                   | Liệt kê topic ROS 2                            |
| `ros2 run tf2_ros tf2_echo map base_footprint`| Kiểm tra TF tree                               |

---

## 11. Tài liệu tham khảo

| File                          | Nội dung                                          |
|-------------------------------|---------------------------------------------------|
| `CLAUDE.md` (root)            | Tổng quan monorepo + AIoT project context        |
| `docs/superpowers/specs/`     | Design specs cho mỗi thay đổi kiến trúc           |
| `apps/api/CLAUDE.md`          | API reference + patterns NestJS                   |
| `apps/web/CLAUDE.md`          | Next.js patterns + Redux                         |
| `apps/mobile/CLAUDE.md`       | Expo patterns                                    |
| `services/robot/CLAUDE.md`    | WebSocket API reference (port 9091)              |
| `firmware/CLAUDE.md`          | Pin mapping, protocol, lệnh ASCII/JSON           |
| `firmware/MODULES.md`         | Kiến trúc module firmware                        |
| `.github/workflows/ci.yml`    | Pipeline CI                                      |
| `.github/workflows/deploy.yml`| Pipeline deploy                                  |

---

## 12. Tình trạng phát triển

| Giai đoạn                             | Trạng thái |
|---------------------------------------|------------|
| 1. Điều khiển động cơ + encoder      | ✅         |
| 2. UART (Pi ↔ ESP32)                  | ✅         |
| 3. Mecanum + odometry                 | ✅         |
| 4. Tích hợp LiDAR + né vật cản       | ✅         |
| 5. SLAM mapping (slam_toolbox)        | ✅         |
| 6. Điều hướng tự động (Nav2)         | 🔄        |
| 7. Nhận QR cho kệ                     | 🔄        |
| 8. Tích hợp cánh tay robot            | 🔄        |
| 9. Demo kho tự động hoàn chỉnh        | 📅         |
| 10. Hệ thống pin                      | 📅         |

---

## 13. License

UNLICENSED — dự án tốt nghiệp, bảo lưu mọi quyền.
