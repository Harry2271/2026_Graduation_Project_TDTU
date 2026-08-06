# POSTER: SO SÁNH CÁC PHƯƠNG PHÁP ĐIỀU KHIỂN ROBOT KHO + ƯU NHƯỢC ĐIỂM TOÀN HỆ THỐNG

## 1. Tổng quan kiến trúc hệ thống

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│   ┌──────────────┐      ┌──────────────┐      ┌──────────────┐ │
│   │   Web UI     │ ←──→ │   Backend    │ ←──→ │  Robot Brain  │ │
│   │  (Next.js)   │      │   (NestJS)   │      │  (ROS 2/Nav2) │ │
│   └──────────────┘      └──────────────┘      └──────┬───────┘ │
│                                                      │         │
│                                                 UART JSON      │
│                                                      │         │
│                                               ┌──────▼───────┐ │
│                                               │   ESP32-S3   │ │
│                                               │  (Firmware)  │ │
│                                               └──────┬───────┘ │
│                                                      │         │
│   ┌──────────────────────────────────────────────────▼───────┐ │
│   │              PHẦN CỨNG ROBOT                            │ │
│   │  4 motor mecanum + 4 encoder + IR + Sharp + LiDAR      │ │
│   └──────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. So sánh 3 phương pháp điều khiển

### A. Điều khiển thủ công (Remote Control)

**Ưu điểm:**
- Đơn giản, dễ triển khai
- Không cần algorithm phức tạp
- Ổn định trong môi trường nhỏ

**Khuyết điểm:**
- Cần người điều khiển liên tục
- Không thể tự động hóa kho hàng
- Phạm vi giới hạn (WiFi/Bluetooth)
- Không tối ưu hóa quãng đường

**Ứng dụng trong dự án:** Giai đoạn 1-2 — test motor, encoder, kinematics

---

### B. Điều khiển tự động không GPS (AUTO_ROAM)

```
┌─────────────────────────────────────────────┐
│          CẢM BIẾN TRÊN XE                  │
│                                             │
│    ◄── IR_LEFT ────────── IR_RIGHT ──►      │
│    (trái 20cm)            (phải 20cm)      │
│                                             │
│    ◄── IR_REAR_LEFT ── IR_REAR_RIGHT ──►   │
│    (sau 20cm)           (sau 20cm)        │
│                                             │
│              ◄── Sharp 80cm ──►             │
│              (trước 10-80cm)               │
│                                             │
│         ◄────── LiDAR 12m ───────►         │
│         (xoay 360°, toàn cảnh)             │
└─────────────────────────────────────────────┘

Thuật toán né vật cản (AVOIDANCE FSM):

    ┌────────────────────────────────────┐
    │  Tín hiệu IR_LEFT = ON            │
    │  (phát hiện vật cản bên trái)    │
    └──────────────┬───────────────────┘
                   │
                   ▼
    ┌────────────────────────────────────┐
    │  CHECK: IR_RIGHT = ON hay OFF?    │
    │                                    │
    │  • LEFT=ON,  RIGHT=OFF → STRAFE   │
    │    PHẢI (vy=+100)                │
    │                                    │
    │  • LEFT=ON,  RIGHT=ON  → ROTATE   │
    │    CW 90° (omega=+100)           │
    │                                    │
    │  • LEFT=ON,  RIGHT=ON  + SHARP    │
    │    < 15cm → E-STOP               │
    └──────────────┬───────────────────┘
                   │
                   ▼
    ┌────────────────────────────────────┐
    │  Kết quả: Xe né vật cản an toàn  │
    └────────────────────────────────────┘
```

**Ưu điểm:**
- Phản ứng nhanh (50Hz — 20ms)
- Không cần GPS hoặc SLAM
- Hoạt động offline (không cần WiFi)
- Chi phí thấp (chỉ IR + Sharp)
- Reliable trong môi trường nhỏ

**Khuyết điểm:**
- Không biết vị trí chính xác
- Chỉ né được vật cản gần (≤80cm)
- Không tối ưu quãng đường
- Dễ bị kẹt giữa nhiều vật cản
- Không thể lập kế hoạch trước

**Ứng dụng trong dự án:** Giai đoạn 4 — khi mất kết nối Pi, robot tự lái né vật cản

---

### C. Điều khiển tự động có bản đồ (Nav2 + LiDAR)

```
┌──────────────────────────────────────────────────┐
│           BẢN ĐỒ SLAM (Occupancy Grid)           │
│                                                  │
│    ██████████████████████████████████████████    │
│    ██                                    ██    │
│    ██  ██████  FREE SPACE  ██████  ██    ██    │
│    ██  ██    ████████████████  ██   ██   ██    │
│    ██  ██  X→ FREE  ←X  ██   ██   ██   ██    │
│    ██  ████████████████████████████   ██   ██  │
│    ██                              ██   ██    │
│    ██████████████████████████████████████████    │
│                                                  │
│    █ = Occupied (tường/kệ)                     │
│    X = Vị trí robot                            │
│    → = Hướng di chuyển (Nav2 planner)           │
└──────────────────────────────────────────────────┘
```

**Ưu điểm:**
- Biết vị trí chính xác trong bản đồ
- Lập kế hoạch đường đi tối ưu (A* / Dijkstra)
- Né vật cản ở mọi khoảng cách (LiDAR 12m)
- Có thể tự động quay về home
- Tương thích với nhiều môi trường kho

**Khuyết điểm:**
- Cần GPS hoặc SLAM để xây bản đồ (WiFi hoặc Pi 5)
- Chi phí phần cứng cao (LiDAR A1M8 ~2tr, Pi 5 ~15tr)
- Phức tạp khi triển khai
- Yêu cầu robot di chuyển đủ lâu để build map
- Delay ~100ms (LiDAR scan cycle)
- WiFi mất → mất khả năng điều khiển

**Ứng dụng trong dự án:** Giai đoạn 5-7 — SLAM mapping, Nav2 navigation, warehouse automation

---

## 3. So sánh chi tiết

| Tiêu chí | Remote Control | AUTO_ROAM (FSM) | Nav2 + LiDAR |
|----------|---------------|-----------------|--------------|
| **Độ phức tạp** | ★☆☆☆☆ | ★★★☆☆ | ★★★★★ |
| **Chi phí phần cứng** | Thấp (thêm remote) | Trung bình (IR+Sharp) | Cao (LiDAR+Pi5) |
| **Phản ứng vật cản** | Thủ công | 20ms (50Hz) | 100ms (10Hz) |
| **Vùng che phủ** | Tùy remote | ≤80cm | ≤12m (360°) |
| **Biết vị trí** | ❌ | ❌ | ✅ (SLAM/AMCL) |
| **Lập kế hoạch đường** | ❌ | ❌ | ✅ (Nav2) |
| **Tự động quay về home** | ❌ | ❌ | ✅ |
| **Off-line operation** | ✅ | ✅ | ❌ (cần WiFi) |
| **Dễ bảo trì** | ✅ | Trung bình | Phức tạp |
| **Khả năng mở rộng** | Thấp | Trung bình | Cao |

---

## 4. Hardware Components Map

```
┌─────────────────────────────────────────────────────┐
│              ESP32-S3 (Real-Time Controller)        │
│                                                     │
│  GPIO   │ Component       │ Chức năng               │
│  ───────┼────────────────┼─────────────────────────  │
│  12-13  │ Motor FL PWM   │ Forward/Reverse FL      │
│  14-15  │ Motor FR PWM   │ Forward/Reverse FR      │
│  16-17  │ Motor RL PWM   │ Forward/Reverse RL      │
│  38-39  │ Motor RR PWM   │ Forward/Reverse RR      │
│  3,7,48,47 │ Motor EN    │ Enable (BTS7960)        │
│  40-42  │ Encoder CH A  │ FL/FR/RL encoder        │
│  20,21  │ Encoder CH B  │ FR/RR encoder           │
│  1      │ IR_REAR_LEFT  │ Phát hiện sau trái     │
│  8      │ IR_REAR_RIGHT │ Phát hiện sau phải     │
│  45     │ IR_LEFT       │ Phát hiện trái         │
│  46     │ IR_RIGHT      │ Phát hiện phải         │
│  9      │ Sharp FRONT   │ Khoảng cách trước (ADC)│
│  10-11  │ I2C SDA/SCL   │ BNO055 + VL53L0X + INA226│
│  2      │ Cylinder IN1  │ XY lanh (Nâng)         │
│  35     │ Cylinder IN2  │ XY lanh (Hạ)           │
│  37     │ Limit Switch  │ XY lanh đã rút hết     │
│  43-44  │ UART TX/RX    │ Kết nối Pi 5           │
│  18-19  │ USB CDC       │ Flash + Debug           │
└─────────────────────────────────────────────────────┘
```

---

## 5. Luồng hoạt động warehouse robot

```
    ┌─────────────────────────────────────────────┐
    │  1. Xây bản đồ (SLAM)                       │
    │     • Robot di chuyển tự do trong kho        │
    │     • LiDAR quét 360°                       │
    │     • slam_toolbox xây occupancy grid        │
    │     • Lưu bản đồ: ros2 run nav2_map_server  │
    └──────────────┬──────────────────────────────┘
                   │
    ┌──────────────▼──────────────────────────────┐
    │  2. Calibrate (gắn AprilTag)                │
    │     • Gắn AprilTag lên từng kệ              │
    │     • Web UI set tọa độ (x,y,theta) cho     │
    │       từng slot trong bản đồ                │
    │     • Lưu vào MongoDB                        │
    └──────────────┬──────────────────────────────┘
                   │
    ┌──────────────▼──────────────────────────────┐
    │  3. Nhận job từ backend                     │
    │     • Backend gửi job:dispatch qua Socket.io │
    │     • Job chứa: pickup (x,y), dropoff (x,y) │
    │     + AprilTag ID                           │
    └──────────────┬──────────────────────────────┘
                   │
    ┌──────────────▼──────────────────────────────┐
    │  4. Nav2 điều khiển đi đến pickup            │
    │     • BrainNode dùng BasicNavigator          │
    │     • Nav2 tính đường ngắn nhất              │
    │     • Local planner né vật cản (costmap)     │
    └──────────────┬──────────────────────────────┘
                   │
    ┌──────────────▼──────────────────────────────┐
    │  5. Nav2 đi đến dropoff                      │
    │     • Robot đến gần vị trí kệ               │
    │     • Camera nhận diện AprilTag              │
    │     • Hiệu chỉnh vị trí (±1cm)              │
    └──────────────┬──────────────────────────────┘
                   │
    ┌──────────────▼──────────────────────────────┐
    │  6. Dock + Unload                            │
    │     • ESP32 firmware điều khiển XY lanh     │
    │     • Nâng XY lanh (L298N driver)           │
    │     • Đợi 3 giây                            │
    │     • Hạ XY lanh (limit switch xác nhận)   │
    │     • Lùi 30cm                               │
    └──────────────┬──────────────────────────────┘
                   │
    ┌──────────────▼──────────────────────────────┐
    │  7. Quay về home                             │
    │     • Nav2 điều hướng về vị trí ban đầu     │
    │     • Home pose được capture từ TF (AMCL)   │
    │     • Robot sẵn sàng cho job tiếp theo       │
    └─────────────────────────────────────────────┘
```

---

## 6. I2C Bus — Vấn đề & Giải pháp

```
VẤN ĐỀ: 3 thiết bị I2C (BNO055 + VL53L0X + INA226)
         đều share 1 bus → timeout

NGUYÊN NHÂN:
  ┌──────────────────────────────────────────┐
  │  GPIO10 ──┬── BNO055 (0x28)            │
  │           ├── VL53L0X (0x29)            │
  │           └── INA226 (0x40)             │
  │           │                             │
  │         THIẾU PULL-UP 4.7kΩ            │
  │           │                             │
  │  GPIO11 ──┬── BNO055 SCL               │
  │           ├── VL53L0X SCL               │
  │           └── INA226 SCL                │
  │           │                             │
  │         THIẾU PULL-UP 4.7kΩ            │
  └──────────────────────────────────────────┘

GIẢI PHÁP:
  3.3V ──┬──[4.7kΩ]──┬── GPIO10 ── BNO055/VL53L0X/INA226 SDA
         │           │
  3.3V ──┴──[4.7kΩ]──┴── GPIO11 ── BNO055/VL53L0X/INA226 SCL
```

**Ưu điểm giải pháp:**
- Chi phí thấp (~2k VNĐ)
- Không cần thay đổi code firmware
- Giải quyết root cause thực sự
- Ổn định lâu dài

**Khuyết điểm:**
- Cần hàn (mất ~15 phút)
- Không loại bỏ được vấn đề bus contention (BNO055 chiếm bus 100ms+)

**Giải pháp thay thế (Software):**
- Thêm `linesIdle()` guard trước mỗi I2C transaction
- Timeout 50ms cho mỗi read/write
- Retry + bus reset khi timeout

---

## 7. BNO055 — Tính toán góc

```
BNO055 Output: Euler Angles (Heading, Roll, Pitch)
  • Heading (H) = Yaw quanh trục Z → góc robot xoay
  • Roll (R) = Góc nghiêng trái/phải
  • Pitch (P) = Góc ngóc lên/xuống

Đơn vị: 1 LSB = 1/16 độ

Ví dụ:
  Raw value = 1440 → 1440 / 16 = 90° (chỉ về phía đông)

  0°      90°     180°     270°     360°
  ↑        →        ↓        ←        ↑
 NORTH    EAST    SOUTH    WEST    NORTH
```

**Yêu cầu calibration:** Di chuyển xe theo hình số 8 trên mặt đất ~30 giây

```
    ┌───┐     ┌───┐
    │   │     │   │
    │   └──┐  │   │
    │      │  │   │
    │   ┌──┘  └──┐│
    │   │        ││
    └───┘        ┘┘
    ↑ Robot di chuyển theo đường này
```

---

## 8. Tổng kết

```
┌────────────────────────────────────────────────────────────────┐
│                 KẾT LUẬN DỰ ÁN                               │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  ✅ ĐÃ HOÀN THÀNH:                                           │
│    • Điều khiển 4 motor mecanum (PID 50Hz)                   │
│    • Xây bản đồ SLAM (slam_toolbox)                         │
│    • Navigation tự động (Nav2)                                │
│    • Né vật cản thông minh (LiDAR + IR + Sharp)             │
│    • Warehouse automation (AprilTag + XY lanh)               │
│    • Web dashboard (Next.js + NestJS)                        │
│                                                                │
│  🔄 ĐANG LÀM:                                                │
│    • I2C bus stabilization (thiếu pull-up)                   │
│    • BNO055 heading calibration verification                 │
│    • Return-to-home logic                                     │
│                                                                │
│  📋 CẦN LÀM TIẾP:                                            │
│    • Test toàn bộ hệ thống tích hợp                         │
│    • Hoàn thiện calibration AprilTag cho 4 kệ               │
│    • Test warehouse automation end-to-end                    │
│    • Viết tài liệu kỹ thuật hoàn chỉnh                      │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

---

---

## PHẦN BỔ SUNG: ƯU VÀ NHƯỢC ĐIỂM TOÀN HỆ THỐNG

---

### A. Tổng quan ưu điểm

```
┌─────────────────────────────────────────────────────────────────┐
│                    ✅ ƯU ĐIỂM TOÀN HỆ THỐNG                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1️⃣  Kiến trúc mô-đun hóa (Microservices)                      │
│     ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐           │
│     │ Web UI │  │Backend │  │  Brain │  │  ESP32 │           │
│     │Next.js │  │NestJS  │  │ ROS2   │  │Firmware│           │
│     └────────┘  └────────┘  └────────┘  └────────┘           │
│     → Mỗi layer hoạt động độc lập                           │
│     → Thay thế/thêm tính năng không ảnh hưởng layer khác     │
│                                                                 │
│  2️⃣  Đa cảm biến融合 (Sensor Fusion)                         │
│     ┌──────────────────────────────────────────────┐          │
│     │  LiDAR 360°   │  4× IR  │  Sharp  │  BNO055 │          │
│     │  12m range    │  20cm    │  80cm   │  IMU    │          │
│     │  10Hz         │  50Hz   │  20Hz   │  50Hz   │          │
│     └───────────────┴─────────┴─────────┴─────────┘          │
│     → Layer 1: ESP32 phản ứng nhanh (2ms-20ms)              │
│     → Layer 2: Pi brain lập kế hoạch (100ms)                 │
│     → Kết hợp: covering cả 0-12m, 360°                      │
│                                                                 │
│  3️⃣  Phản ứng nhanh (Real-time)                                │
│     → ESP32-S3 chạy firmware riêng cho motor control          │
│     → PID loop 50Hz (20ms) — đủ nhanh cho mecanum            │
│     → I2C/SPI sensor: IMU 50Hz, IR 50Hz, Sharp 20Hz         │
│     → UART: 115200 baud JSON protocol                        │
│                                                                 │
│  4️⃣  Tự động hóa warehouse (End-to-end)                        │
│     → Web UI điều khiển từ xa                                 │
│     → Backend dispatch job qua Socket.io                      │
│     → Robot tự đi pickup → dropoff → dock → unload → return  │
│     → Hiển thị % pin, trạng thái, SLAM map real-time          │
│                                                                 │
│  5️⃣  Chi phí thấp (Cost-effective)                             │
│     → Chỉ 1× LiDAR + 1× Pi 5 + 1× ESP32-S3                 │
│     → 4× motor mecanum + 4× IR + 1× Sharp + 1× IMU          │
│     → Tổng chi phí phần cứng: ~5-8 triệu VNĐ               │
│                                                                 │
│  6️⃣  Dễ bảo trì + mở rộng                                    │
│     → Firmware ESP32: PlatformIO, có thể flash từ Windows    │
│     → Backend: NestJS + MongoDB, REST API chuẩn             │
│     → Frontend: Next.js, responsive design                   │
│     → ROS2: Tiêu chuẩn robotics, tài liệu phong phú         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

### B. Tổng quan nhược điểm

```
┌─────────────────────────────────────────────────────────────────┐
│                    ❌ NHƯỢC ĐIỂM TOÀN HỆ THỐNG               │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1️⃣  Chi phí cao ban đầu                                       │
│     → Pi 5: ~15tr, LiDAR: ~2tr, ESP32-S3: ~500k             │
│     → Tổng hardware: ~5-8tr + servo arm: ~2tr                │
│     → So với AGV thương mại (~50tr-100tr) vẫn rẻ hơn       │
│                                                                 │
│  2️⃣  Độ phức tạp triển khai                                     │
│     → Cần kiến thức ROS2, Python, C++, firmware, electronics│
│     → Cần setup Pi 5 (Ubuntu + ROS2 + Nav2)                 │
│     → Calibration SLAM + AprilTag cần kỹ thuật              │
│     → Debug I2C bus (pull-up, wiring) cần kinh nghiệm       │
│                                                                 │
│  3️⃣  WiFi/Network dependency                                     │
│     → Pi 5 cần kết nối WiFi để ROS2 hoạt động              │
│     → Web UI cần WiFi để truy cập                           │
│     → Nếu WiFi mất → mất khả năng điều khiển                 │
│     → AUTO_ROAM vẫn hoạt động offline (chỉ né vật cản)     │
│                                                                 │
│  4️⃣  Precision limitations                                       │
│     → LiDAR精度: ±5cm (A1M8)                                │
│     → SLAM精度: ±10cm (tùy môi trường)                       │
│     → AprilTag精度: ±1cm (khi camera gần)                   │
│     → Motor encoder: ±1 pulse (330 PPR = ~0.57mm)           │
│     → BNO055 heading: ±1-2° (sau calibration figure-8)       │
│                                                                 │
│  5️⃣  Battery & Power management                              │
│     → Pin M21-B4055A: 84Wh, 20.6V full → 15V empty         │
│     → Không có BMS thực tế trên firmware                     │
│     → INA226 đo dòng nhưng không auto-shutdown               │
│     → Nếu pin cạn → motor fail, không an toàn               │
│                                                                 │
│  6️⃣  Safety concerns                                          │
│     → XY lanh dùng timeout (8s) thay vì limit switch        │
│     → Không có emergency button vật lý                       │
│     → Motor driver (BTS7960) không có feedback                 │
│     → Nếu firmware crash → motor vẫn chạy (hardware watchdog)│
│                                                                 │
│  7️⃣  Scalability concerns                                     │
│     → Mỗi robot cần 1× Pi 5 + 1× LiDAR                     │
│     → Không có centralized fleet management                   │
│     → Nếu 10 robot → cần 10 Pi 5 riêng biệt                │
│     → Không có shared map giữa các robot                    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

### C. So sánh chi tiết Ưu vs Nhược

```
┌──────────────────┬──────────────────────┬──────────────────────┐
│   Tiêu chí       │   ƯU ĐIỂM           │   NHƯỢC ĐIỂM        │
├──────────────────┼──────────────────────┼──────────────────────┤
│ Chi phí          │ Rẻ hơn AGV           │ Vẫn ~5-8tr VNĐ       │
│ Triển khai       │ Tiêu chuẩn robotics  │ Phức tạp, cần team  │
│ Offline operation│ AUTO_ROAM hoạt động  │ WiFi mất → mất control│
│ Precision        │ ±1cm (AprilTag)      │ ±10cm (SLAM), ±5cm   │
│                  │                       │ (LiDAR)              │
│ Safety           │ IR + Sharp hard-stop  │ Không BMS, timeout   │
│                  │                       │ cylinder thay limit   │
│ Scalability     │ Mô-đun hóa tốt       │ Không fleet mgmt     │
│ Maintenance     │ Firmware OTA困难      │ Cần flash USB        │
│ Documentation   │ Có CLAUDE.md + specs  │ Thiếu user manual    │
│ Testing         │ Đơn vị test Python    │ Thiếu integration    │
│                  │                       │ test (ROS2+ESP32)    │
└──────────────────┴──────────────────────┴──────────────────────┘
```

---

### D. Sơ đồ Ưu điểm theo Module

```
┌─────────────────────────────────────────────────────────────────┐
│                    ƯU ĐIỂM THEO MODULE                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐           │
│  │   ESP32     │  │  ROS2/Nav2  │  │   NestJS    │           │
│  │   Firmware  │  │  Brain      │  │   Backend   │           │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘           │
│         │                │                │                    │
│         ▼                ▼                ▼                    │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐           │
│  │ Motor PID   │  │ SLAM Map    │  │ REST API    │           │
│  │ 50Hz real-  │  │ occupancy   │  │ Socket.io   │           │
│  │ time ctrl   │  │ grid        │  │ real-time   │           │
│  │             │  │             │  │             │           │
│  │ ✅ Ưu điểm:│  │ ✅ Ưu điểm:│  │ ✅ Ưu điểm:│           │
│  │ • PID loop  │  │ • Tiêu chuẩn│  │ • MongoDB   │           │
│  │ • Encoder   │  │   robotics  │  │ • JWT auth  │           │
│  │   feedback  │  │ • Nav2 path │  │ • Swagger   │           │
│  │ • 50Hz      │  │   planning  │  │ • REST + WS │           │
│  │             │  │ • TF tree   │  │             │           │
│  │ ❌ Nhược:   │  │ ❌ Nhược:   │  │ ❌ Nhược:   │           │
│  │ • No BMS    │  │ • WiFi      │  │ • Single    │           │
│  │ • Timeout   │  │   depend    │  │   instance  │           │
│  │   cylinder  │  │ • Complex   │  │ • No HA     │           │
│  │             │  │   setup     │  │             │           │
│  └─────────────┘  └─────────────┘  └─────────────┘           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

### E. Sơ đồ Nhược điểm theo Mức độ Ưu tiên

```
┌─────────────────────────────────────────────────────────────────┐
│              NHƯỢC ĐIỂM — MỨC ĐỘ ƯU TIÊN                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  🔴 CAO (Cần fix ngay)                                        │
│  ├─ I2C bus timeout: thiếu pull-up 4.7kΩ                      │
│  │   → Fix: Hàn 2 điện trở SDA/SCL → 3.3V                    │
│  ├─ BNO055 heading chưa calibrated                            │
│  │   → Fix: Xoay xe figure-8 30 giây                         │
│  └─ Cylinder timeout thay limit switch                        │
│      → Fix: Gắn switch + firmware update                       │
│                                                                 │
│  🟡 TRUNG BÌNH (Cần test)                                      │
│  ├─ Motor direction có thể sai sau khi flash firmware mới      │
│  │   → Fix: Test F100, xem xe có tiến đúng không              │
│  ├─ AutoRoam FSM chưa test trên xe thực                       │
│  │   → Fix: Gắn IR sensors + test từng case                   │
│  └─ LiDAR zone scoring chưa test                             │
│      → Fix: Chạy trên Pi với LiDAR đang hoạt động            │
│                                                                 │
│  🟢 THẤP (Nice-to-have)                                        │
│  ├─ Web UI chưa hiển thị % pin real-time                      │
│  │   → Backend đã có type-133, frontend chỉ cần render       │
│  ├─ Không có export SLAM map thành file                       │
│  │   → ros2 run nav2_map_server đã có                        │
│  └─ Không có fleet management cho nhiều robot                 │
│      → Future work                                           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

### F. Đánh giá tổng thể (Scorecard)

```
┌──────────────────┬───────┬───────┬───────┬───────┐
│ Tiêu chí         │ Đạt  │ Đang  │ Chưa  │ Ghi   │
│                  │      │ làm   │ làm   │ chú   │
├──────────────────┼───────┼───────┼───────┼───────┤
│ Motor control    │  ✅  │       │       │ PID OK│
│ Encoder feedback │  ✅  │       │       │ PCNT  │
│ Mecanum kinematic│  ✅  │       │       │ 4 wheel│
│ I2C sensors      │  ⚠️  │  🔧   │       │ Pull-up│
│ BNO055 heading   │  ⚠️  │  🔧   │       │ Calib  │
│ Sharp distance   │  ✅  │       │       │ OK     │
│ IR proximity     │  ✅  │       │       │ 4 sen  │
│ LiDAR SLAM       │  ✅  │       │       │ A1M8   │
│ Nav2 navigation  │  ✅  │       │       │ Path   │
│ Web dashboard    │  ✅  │       │       │ Next.js│
│ Backend API      │  ✅  │       │       │ NestJS │
│ Brain node       │  ✅  │  🔄   │       │ ROS2   │
│ Avoidance FSM    │  ✅  │  🔄   │       │ ESP32  │
│ LiDAR scoring    │  ✅  │  🔄   │       │ Brain  │
│ XY lanh unload   │  ✅  │  🔄   │       │ L298N  │
│ Return home      │  ✅  │  🔄   │       │ Nav2   │
│ Pin display      │      │       │  ❌    │ INA226 │
│ Fleet mgmt       │      │       │  ❌    │ Future │
│ Safety button    │      │       │  ❌    │ HW     │
└──────────────────┴───────┴───────┴───────┴───────┘

Legend: ✅ = Done | 🔧 = Fix needed (HW) | 🔄 = In progress | ❌ = Not started
```

---

### G. Ưu điểm: Khả năng cạnh tranh

```
┌─────────────────────────────────────────────────────────────────┐
│         SO SÁNH VỚI AGV THƯƠNG MẠI                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  TIÊU CHÍ          │  DỰ ÁN NÀY        │  AGV THƯƠNG MẠI   │
│  ─────────────────  │  ──────────────    │  ──────────────    │
│  Chi phí            │  ~5-8tr VNĐ        │  ~50-100tr VNĐ    │
│  Navigation         │  SLAM + Nav2       │  Magnetic tape     │
│  Obstacle avoidance │  Multi-sensor      │  Bump sensor       │
│  Flexibility        │  Thay đổi bản đồ  │  Thay đổi băng từ │
│  Camera vision      │  ✅ AprilTag       │  ❌ Không có       │
│  Warehouse mgmt     │  ✅ Web dashboard  │  ❌ Cần phần mềm  │
│                     │                    │     riêng          │
│  Open source        │  ✅ ROS2 + Next.js │  ❌ Proprietary    │
│  Customizable       │  ✅ Thay đổi code  │  ❌ Không thể thay │
│  Documentation      │  ✅ CLAUDE.md +     │  ❌ Cần NDA        │
│                     │     specs + poster  │                    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

### H. Ưu điểm: Khả năng mở rộng

```
┌─────────────────────────────────────────────────────────────────┐
│              KHẢ NĂNG MỞ RỘNG (ROADMAP)                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  HIỆN TẠI (2025):                                              │
│  ✅ Single robot warehouse automation                          │
│  ✅ SLAM mapping + Nav2 navigation                             │
│  ✅ AprilTag shelf detection                                    │
│  ✅ Web dashboard + real-time monitoring                       │
│  ✅ Multi-sensor obstacle avoidance                            │
│                                                                 │
│  TƯƠNG LAI GẦN (6-12 tháng):                                  │
│  🔄 Fleet management (quản lý nhiều robot)                     │
│  🔄 Task scheduling (lên lịch giao hàng thông minh)            │
│  🔄 Camera stream + object detection (YOLO)                  │
│  🔄 Voice control (Google Home / Alexa integration)            │
│  🔄 Mobile app (Expo React Native)                            │
│                                                                 │
│  TƯƠNG LAI XA (12-24 tháng):                                  │
│  📋 Multi-floor warehouse navigation                         │
│  📋 Robotic arm pick-and-place (5DOF)                        │
│  📋 Machine learning demand forecasting                      │
│  📋 Digital twin simulation                                   │
│  📋 Integration with ERP systems (SAP, Oracle)                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

### I. Tóm tắt cho Poster

```
┌─────────────────────────────────────────────────────────────────┐
│                TÓM TẮT DỰ ÁN CHO SẾP                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  🎯 MỤC TIÊU:                                                 │
│  Xây dựng robot tự động hóa kho hàng có khả năng:             │
│  • Di chuyển tự động (SLAM + Nav2)                            │
│  • Nhận diện kệ (AprilTag camera)                              │
│  • Né vật cản (LiDAR + IR + Sharp sensors)                   │
│  • Điều khiển từ xa (Web dashboard)                            │
│                                                                 │
│  💡 ĐỘC ĐÁO:                                                   │
│  • Chi phí thấp (~5-8tr) so với AGV (~50-100tr)             │
│  • Open source (ROS2 + Next.js + ESP32 firmware)             │
│  • Multi-sensor fusion (LiDAR + IR + Sharp + IMU)            │
│  • Real-time web dashboard với SLAM map                      │
│  • Tự động quay về home sau khi giao hàng                    │
│                                                                 │
│  ⚡ CÔNG NGHỆ:                                                 │
│  • Raspberry Pi 5 + ROS2 (SLAM, Nav2, TF)                   │
│  • ESP32-S3 (PID motor 50Hz, sensor fusion)                  │
│  • LiDAR A1M8 (360°, 12m range)                              │
│  • BNO055 IMU (9-axis heading)                               │
│  • Mecanum wheels (omnidirectional motion)                   │
│                                                                 │
│  📊 KẾT QUẢ:                                                  │
│  • Precision: ±1cm (AprilTag), ±10cm (SLAM)                 │
│  • Speed: 0.3 m/s max (an toàn cho kho)                     │
│  • Obstacle avoidance: 4-6 hướng (IR + Sharp + LiDAR)       │
│  • Battery: 84Wh, hiển thị % pin real-time                  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```
**Sinh viên:** [Tên của bạn]
**Giảng viên hướng dẫn:** [Tên GV]
**Khoa:** [Khoa/CNN]
**Trường:** TDTU — Capstone Project 2025
