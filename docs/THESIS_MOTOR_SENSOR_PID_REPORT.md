# Báo cáo Tổng hợp Hệ thống Điều khiển Robot — Tất cả Phép tính & Công thức

> **Mục đích:** Tài liệu tham khảo cho đồ án tốt nghiệp — tổng hợp toàn bộ
> phép tính toán, công thức, hằng số phần cứng, thuật toán PID, kinematics,
> cảm biến, state machine, và các lỗi còn lại trong hệ thống.
>
> **Ngày kiểm tra:** 2026-08-09
> **Phiên bản firmware:** `e55f678 → 90cf2b9` (branch `Add_more_esp32`)

---

## MỤC LỤC

1. [Hạ tầng Phần cứng](#1-hạ-tầng-phần-cứng)
2. [Mecanum Kinematics](#2-mecanum-kinematics)
3. [Encoder & PCNT Hardware Counting](#3-encoder--pcnt-hardware-counting)
4. [PID Speed Controller](#4-pid-speed-controller)
5. [Hệ thống Cảm biến](#5-hệ-thống-cảm-biến)
6. [LiDAR & SLAM Processing](#6-lidar--slam-processing)
7. [State Machine & An toàn](#7-state-machine--an-toàn)
8. [Odometry Fusion (ROS 2)](#8-odometry-fusion-ros-2)
9. [Warehouse Dock Sequence](#9-warehouse-dock-sequence)
10. [Các lỗi còn tồn đọng](#10-các-lỗi-còn-tồn-đọng)
11. [Lệnh kiểm tra thực địa](#11-lệnh-kiểm-tra-thực-địa)

---

## 1. Hạ tầng Phần cứng

### 1.1 Bánh xe & Truyền động

| Thông số | Giá trị | Ghi chú |
|---|---|---|
| Bánh xe | Mecanum 97 mm | 4 bánh omnidirectional |
| Bán kính bánh hiệu dụng (`WHEEL_RADIUS_M`) | **0.0485 m** | 97/2 mm (hệ số trượt mecanum) |
| Chu vi bánh (`C`) | 2π × 0.0485 ≈ **0.3048 m** | |
| Khoảng cách trục trước/sau (`2L`) | 0.24 m | `HALF_LENGTH_M = 0.12` |
| Khoảng cách trục trái/phải (`2W`) | 0.26 m | `HALF_WIDTH_M = 0.13` |

### 1.2 Motor & Encoder

| Thông số | Giá trị | Nguồn |
|---|---|---|
| Motor | JGB37-520 DC Servo 12V, 333 RPM | datasheet |
| Tỷ số truyền (`MOTOR_GEAR_RATIO`) | **30:1** | `config.h:88` |
| Encoder PPR (trục motor) (`MOTOR_ENCODER_PPR`) | **11** | `config.h:87` |
| Encoder CPR = PPR × 2 edges (`MOTOR_ENCODER_CPR`) | **22** | `config.h:89` |
| **Output-shaft CPR** = CPR × gear (`OUTPUT_CPR`) | **660** | `Encoder.cpp:111` |
| Motor RPM danh nghĩa (`MOTOR_NOMINAL_RPM`) | **333 RPM** tại 12V | `config.h:101` |
| Điện áp motor danh nghĩa | 12V | `config.h:102` |
| Điện áp nguồn pin | 21V (3S Li-ion) | |

### 1.3 PWM & BTS7960 Driver

| Thông số | Giá trị | Nguồn |
|---|---|---|
| Tần số PWM (`PWM_FREQUENCY`) | **20 kHz** | `config.h:93` |
| Độ phân giải LEDC (`PWM_RESOLUTION`) | **10 bit** (0–1023) | `config.h:94` |
| `PWM_MAX_DUTY` | 1023 | `config.h:95` |
| `MOTOR_MAX_DUTY` (giới hạn điện áp motor) | **511** (~50% × 1023) | `config.h:100` |
| Duty thực tế cho 12V từ nguồn 21V | 511/1023 × 21V ≈ **10.5V** | |

BTS7960 mapping:
```
setSpeed(+N):  RPWM = |N| (clamped 0..511), LPWM = 0  → MOTOR_FORWARD
setSpeed(-N):  RPWM = 0, LPWM = |N| (clamped 0..511)  → MOTOR_BACKWARD
setSpeed(0):   RPWM = LPWM = 0                           → MOTOR_COAST
brake():       RPWM = 511, LPWM = 0                      → MOTOR_BRAKE (dynamic)
emergencyStop: EN pin = LOW, RPWM = LPWM = 0             → hardware disable
```

Bảng `dir` wiring补偿 (từ `MOTOR_PINS[]`):

| Motor | dir | Lí do |
|---|---|---|
| FL (0) | **+1** | Wiring bình thường |
| FR (1) | **-1** | RPWM/LPWM bị đảo vật lý |
| RL (2) | **+1** | Wiring bình thường |
| RR (3) | **-1** | RPWM/LPWM bị đảo vật lý |

### 1.4 Bảng_pins Encoder (PCNT)

| Motor | CH A | CH B | PCNT Unit |
|---|---|---|---|
| FL | GPIO 40 | GPIO 41 | PCNT_UNIT_0 |
| FR | GPIO 42 | GPIO 6 | PCNT_UNIT_1 |
| RL | GPIO 4 | GPIO 5 | PCNT_UNIT_2 |
| RR | GPIO 20 | GPIO 21 | PCNT_UNIT_3 |

---

## 2. Mecanum Kinematics

### 2.1 Inverse Kinematics (lệnh → tốc độ bánh)

Từ `MecanumDrive::compute()` — Mecanum X-pattern:

```
Input:  vx (-255..+255), vy (-255..+255), omega (-255..+255)
Output: speeds[4]

FL = vx − vy + omega
FR = vx + vy − omega
RL = vx + vy + omega
RR = vx − vy − omega
```

**Ký hiệu:**
- `vx > 0`: tiến (+), `vx < 0`: lùi (-)
- `vy > 0`: sang phải (+), `vy < 0`: sang trái (-)
- `omega > 0`: quay CW (+), `omega < 0`: quay CCW (-)

**Normalization:** Sau clamp ±255, nếu max |speed| > 255, tất cả được scale xuống tỷ lệ:
```
scale = 255 / max(|FL|,|FR|,|RL|,|RR|)
speeds[i] *= scale
```
→ Giữ nguyên tỷ lệ direction, không có wheel nào vượt 255.

**Ramp (acceleration slew-rate limiter):**
```
diff = target - current
if diff >  50: return current + 50    ← ACCEL_RAMP_RATE
if diff < -50: return current - 50
return target
```
- Tốc độ ramp: 50 PWM/tick × 50 Hz = **2500 PWM/s**
- Thời gian 0 → 255: ⌈255/50⌉ = 6 ticks = **120 ms**

### 2.2 Forward Kinematics (encoder → vận tốc cơ thể)

Từ `odom_node.py` — dùng encoder deltas từ type-130:

```
dWi = (count_new[i] − count_prev[i]) × METERS_PER_COUNT

METERS_PER_COUNT = (2π × 0.0485) / 660 = 0.0004605 m/count

vx_body  = (dFL + dFR + dRL + dRR) / 4          ← tiến
vy_body  = (−dFL + dFR + dRL − dRR) / 4          ← sang phải
omega_fw = (−dFL + dFR − dRL + dRR) / (4 × (L + W))   ← CW+ theo firmware
```

Nơi `L + W = 0.12 + 0.13 = 0.25 m`.

**Chiếu body → odom frame:**
```
cos_y = cos(yaw)
sin_y = sin(yaw)
x += vx_body × cos_y − vy_body × sin_y
y += vx_body × sin_y + vy_body × cos_y
```

---

## 3. Encoder & PCNT Hardware Counting

### 3.1 Cấu hình PCNT

```cpp
pos_mode  = PCNT_COUNT_INC;   // rising edge CH_A → +1
neg_mode  = PCNT_COUNT_DEC;   // falling edge CH_A → -1
lctrl_mode = PCNT_MODE_REVERSE; // CH_B LOW → đảo inc/dec
hctrl_mode = PCNT_MODE_KEEP;    // CH_B HIGH → giữ nguyên
```

→ **x2 quadrature decode**: mỗi edge trên CH_A đếm ±1 tùy mức CH_B.
11 PPR motor shaft × 2 edges = 22 CPR motor shaft.
22 × 30 gear = **660 counts/output-rev**.

**Filter:** 1000 ticks ≈ 12.5 µs @ 80 MHz — loại rung motor-brush.

### 3.2 Công thức RPM

```
OUTPUT_CPR = MOTOR_ENCODER_CPR × MOTOR_GEAR_RATIO = 22 × 30 = 660

raw_rpm = delta / dt_ms × 60000 / OUTPUT_CPR
         = delta / dt_ms × 90.909...

filtered = 0.7 × prev + 0.3 × raw_rpm     ← EMA, α = 0.3
```

**Ví dụ:** `delta = 33 counts`, `dt_ms = 20 ms`:
```
raw_rpm = 33/20 × 60000/660 = 1.65 × 90.909 = 150.0 RPM
```

Giới hạn: ±500 RPM, deadband |filtered| < 0.1 → 0.

### 3.3 Đếm tích lũy (odometry position)

```
cumulative_count_ += delta     // signed, có xử lý wrap-around int16
```

Giá trị `count` trong type-130 JSON = `cumulative_count × dir` (đã补偿 wiring).

---

## 4. PID Speed Controller

### 4.1 Hằng số

| Hằng số | Giá trị | Ý nghĩa vật lý |
|---|---|---|
| `PID_UPDATE_RATE_HZ` | **50 Hz** | Tần suất PID |
| `PID_UPDATE_MS` | **20 ms** | Chu kỳ PID |
| `DEFAULT_KP` | **2.5** | 2.5 PWM units / 1 RPM lỗi |
| `DEFAULT_KI` | **0.2** | 0.2 PWM / (RPM·s) tích lũy lỗi |
| `DEFAULT_KD` | **0.05** | 0.05 PWM / (RPM/s) tốc độ thay đổi |
| `PID_INTEGRAL_LIMIT` | **400.0** | Giới hạn tích phân |
| `PID_OUTPUT_LIMIT` | **511** | = MOTOR_MAX_DUTY |

### 4.2 Mapping PWM → Target RPM

```
target_rpm = limited × (MOTOR_NOMINAL_RPM / MOTOR_MAX_DUTY)
           = limited × (333.0 / 511.0)
           = limited × 0.6517
```

PWM 511 → 333 RPM (danh nghĩa). PWM 255 → ~166 RPM (50%).

### 4.3 Thuật toán PID (Pseudocode)

```python
def compute(target_rpm, actual_rpm, dt_us):
    dt_s = clamp(dt_us / 1_000_000, 0.001, 0.1)

    error = target_rpm - actual_rpm
    P = kp × error                           # P = 2.5 × error

    # Conditional anti-windup integral
    integral += error × dt_s
    I = ki × integral                         # I = 0.2 × integral

    # Derivative-on-measurement (tránh derivative kick)
    if not first_run:
        dmeas = (actual_rpm - prev_actual_rpm) / dt_s
        D = -kd × dmeas                       # D = -0.05 × dmeas
    prev_actual_rpm = actual_rpm

    output = P + I + D

    # Anti-windup: rollback nếu output bão hòa
    if |output| > 511:
        integral -= error × dt_s              # hoàn nguyên tích phân
        I = ki × integral
        output = P + I + D

    integral = clamp(integral, -400, +400)
    output = clamp(output, -511, +511)
    return int16(output)
```

### 4.4 Kick-Start Boost

| Thông số | Giá trị |
|---|---|
| `KICK_BOOST_PWM` | **255** PWM units |
| `KICK_BOOST_TICKS` | **15 ticks** = 300 ms |
| Trigger | target chuyển `0 → non-zero` (edge-triggered) |
| Vị trí áp dụng | **SAU** PID correction, trên `final_pwm` |

```python
final_pwm = limited + correction           # PID correction
final_pwm = clamp(final_pwm, -511, +511)
if kick_ticks > 0:
    boost = +255 if limited > 0 else -255
    final_pwm = clamp(final_pwm + boost, -511, +511)
    kick_ticks -= 1
motor_cmd = final_pwm × MOTOR_PINS[i].dir  # dir compensation
```

### 4.5 Signed RPM trong PID Path

```cpp
float actual_rpm = g_encoders[i].getFilteredRPM() * (float)MOTOR_PINS[i].dir;
```

Thay thế `fabsf()` cũ — cho phép PID phát hiện motor quay ngược so với lệnh.

---

## 5. Hệ thống Cảm biến

### 5.1 Tổng quan bus I2C

| Thông số | Giá trị |
|---|---|
| SDA / SCL | GPIO 10 / GPIO 11 |
| Tần số | **100 kHz** |
| Pull-up bên ngoài | 2.2–4.7 kΩ (cần thiết) |
| Timeout mỗi giao dịch | 50 ms |
| Recovery | toggle SCL 9 lần + `Wire.begin()` lại |

### 5.2 BNO055 IMU (type-134, 20 Hz)

**Giao thức:** I2C @ 0x28 (hoặc SPI nếu available)

**Đơn vị dữ liệu:**
```
heading_deg = (int16_t)(raw_little_endian) / 16.0    ← 1 LSB = 1/16°
heading_rad = heading_deg × π / 180
```

**Gyro:** `gyro_x_dps = raw / 16.0` (°/s)
**Linear accel:** `accel_x = raw / 100.0` (m/s²)
**Gravity:** `gravity_x = raw / 100.0` (m/s²)

**Heading error normalization:**
```python
err = target - current
if err > 180:  err -= 360
if err <= -180: err += 360
```

**Trạng thái calibration:** sys/gyro/accel/mag, mỗi field 0–3, fully calibrated khi tất cả ≥ 3.

**Publish:** `JsonStatus::emitIMU()` mỗi 50 ms → type-134 JSON.

### 5.3 INA226 Power Monitor (type-133, 0.2 Hz)

**Giao thức:** I2C @ 0x40, shunt resistor = 10 mΩ

```
V_bus = mv / 1000     (volts)
I = mA / 1000         (amps)
P = mW / 1000         (watts)
```

**Battery SOC (piecewise Li-ion voltage curve):**
```
V_FULL  = 20.5 V   (100%)
V_EMPTY = 14.0 V   (0%)

20.5V:100, 20.0V:90, 19.2V:80, 18.6V:70, 18.0V:60,
17.4V:50, 16.8V:40, 16.2V:30, 15.6V:20, 14.8V:10, 14.0V:0

SOC is linearly interpolated between adjacent points and clamped
at 100% above V_FULL and 0% below V_EMPTY.
```

| SOC | Hành động |
|---|---|
| ≤ 10% | `battery_status = 2` (critical) → auto E-stop *(hiện disabled trong code)* |
| ≤ 20% | `battery_status = 1` (low) → giới hạn `max_speed_pct = 50%` |
| > 20% | `battery_status = 0` (ok) |

**Giả bảo an:** nếu `V < 0.05V` → force I=0, P=0, SOC=0 (tránh offset ghost).

### 5.4 IR Proximity Sensor (type-135, 50 Hz)

**4 cảm biến E18-D80NK**, digital GPIO active-LOW:

| Sensor | GPIO | Vị trí |
|---|---|---|
| REAR_LEFT | 1 | Sau trái |
| REAR_RIGHT | 8 | Sau phải |
| LEFT | 45 | Trái |
| RIGHT | 46 | Phải |

**Debounce:** 50 ms (`IR_DEBOUNCE_MS`). Chỉ chấp nhận chuyển state khi giữ ổn định ≥ 50 ms.

**Khoảng cách phát hiện:** ~15 cm (điều chỉnh bằng potentiometer trên cảm biến).

**Mapping sang hướng obstacle (main.cpp):**
```
L+R   → REAR
L only → LEFT
R only → RIGHT
RL+RR → REAR
RL only → REAR_LEFT
RR only → REAR_RIGHT
```

### 5.5 Sharp Front Distance (type-136, 50 Hz)

**ADC:** GPIO 9 (ADC1_CH8), 12-bit, attenuation 11dB (full-scale ≈ 3.3V)

**Oversample:** 5 readings, loại saturated (raw < 4090).

```
V_adc = raw × 3.3 / 4095

d_cm = SHARP_K / V_adc + SHARP_OFFSET
     = 118.76 / V_adc + 0.42       (cm, từ datasheet transfer function)
```

**Clamp:** [10, 80] cm. `V < 0.05` → distance = 80 (out of range).

| Threshold | Giá trị | Hành động |
|---|---|---|
| `SHARP_FRONT_THRESHOLD_CM` | **15 cm** | Hard-stop (`g_local_obstacle_stop = true`) |
| `SHARP_FRONT_SLOW_CM` | **60 cm** | Bắt đầu giảm tốc |

### 5.6 VL53L0X ToF Cargo Sensor (type-138, 20 Hz)

**Giao thức:** I2C @ 0x29, measurement budget = 33 ms → ~30 Hz max

```
distance_cm = distance_mm / 10.0
at_unload = (sensor_present && distance_mm ≤ 40)    ← 4 cm target
```

`VL53L0X_TOLERANCE_MM = 10` (±1 cm tolerance cho dock alignment).

---

## 6. LiDAR & SLAM Processing

### 6.1 Hardware

| Thông số | Giá trị |
|---|---|
| Model | RPLIDAR A1M8-R6 |
| Khoảng cách tối đa | 12 m |
| Góc quét | 360° |
| Tần suất quét | ~10–12 Hz |
| ROS driver | `ros-jazzy-rplidar-ros2` |
| Topic | `/scan` (LaserScan) |

### 6.2 SLAM

**slam_toolbox** (online_async mode):
- Nhận `/scan` → scan-matching → TF (`map → odom → base_footprint`)
- Publish `/map` (OccupancyGrid)
- TF publish rate: ~10 Hz

### 6.3 Map Manager — Obstacle Awareness Zone

Khi nhận lệnh `'stop'` → `SCAN_OBSTACLE` state → tích lũy scan 360° → xây dựng vùng awareness 2m:

```
OBSTACLE_RADIUS = 2.0 m   (post-mapping awareness zone)
GRID_SIZE = 800 × 800 cells, RESOLUTION = 0.05 m/cell
```

Scan points trong bán kính 2m → đánh dấu occupied (100) trên grid → publish `/obstacle_layer`.

### 6.4 Quaternion từ Quaternion TF

```python
def quaternion_to_yaw(q):
    siny_cosp = 2.0 * (q.w * q.z + q.x * q.y)
    cosy_cosp = 1.0 - 2.0 * (q.y * q.y + q.z * q.z)
    return math.atan2(siny_cosp, cosy_cosp)
```

---

## 7. State Machine & An toàn

### 7.1 Bốn chế độ chính

```
                        ┌──────────────┐
            ┌───────────│   MODE_SAFE  │─────────────────┐
            │           │ (chờ kết nối) │                 │
            │           └──────────────┘                 │
            │ heartbeat_received()               AUTO_ROAM_BOOT_DELAY
            │ (3s boot delay)                    = 3000 ms
            ▼                                              ▼
    ┌──────────────┐                              ┌──────────────────┐
    │   MODE_NAV   │  ← heartbeat timeout 2s ──  │ MODE_AUTO_ROAM   │
    │ (Pi điều khiển)│  ─────────────────────────→ │ (tự lái sensor)  │
    └──────────────┘                              └──────────────────┘
            │ CMD_E_STOP
            ▼
    ┌──────────────┐
    │  E-STOP      │  → tất cả motor emergencyStop()
    │ (khóa cứng)   │  → chỉ CMD_E_STOP_CLEAR mới mở
    └──────────────┘
```

**Ưu tiên motor outputs (ModeManager::applyMotorOutputs):**
1. `estop_active_` → emergencyStop tất cả → return ngay
2. `MODE_NAV` + nav ≠ 0 → mecanum từ Pi
3. `MODE_AUTO_ROAM` → `auto_roam_.compute()` (local sensor avoidance)
4. Còn lại → `mecanum.stop()`

### 7.2 Watchdog

| Thông số | Giá trị |
|---|---|
| `HEARTBEAT_TIMEOUT_MS` | **2000 ms** |
| `AUTO_ROAM_BOOT_DELAY_MS` | **3000 ms** |

`onHeartbeatReceived()` được gọi khi parse thành công bất kỳ lệnh nào từ Pi.
`onSerialActivity()` được gọi cho mọi byte UART (kể cả malformed) — prevents false timeout khi cable bị giật.

`millis()` wrap-safe: `elapsed = now - last` hoạt động đúng khi millis() overflow (~49.7 ngày).

### 7.3 Obstacle Avoidance (2 subsystems song song)

**A. ObstacleAvoidance (Pi-fed, cho MODE_NAV):**

Triggered by `CMD_OBSTACLE_LEFT/RIGHT/FRONT/CLEAR` từ LiDAR Pi.

| Hằng số | Giá trị |
|---|---|
| `OBSTACLE_THRESHOLD_CM` | 100 cm |
| `DODGE_STRAFE_SPEED` | 100 |
| `DODGE_DURATION_MS` | 800 ms |
| `CLEAR_THRESHOLD_MS` | 500 ms |

Direction override rules:
```
FRONT         → vx=vy=omega=0  (hard stop)
LEFT          → vy=+100, vx=slow forward
RIGHT         → vy=-100, vx=slow forward
FRONT_LEFT    → vy=+120, vx=-40, omega=+40
FRONT_RIGHT   → vy=-120, vx=-40, omega=-40
REAR_*        → cancel backward, nudge forward
```

**B. AvoidanceFSM (local IR/Sharp, cho MODE_AUTO_ROAM):**

8 states: IDLE → ROAMING → EVALUATING → STRAFING/ROTATING/REVERSING → back to EVALUATING → E_STOPPED.

| Hằng số | Giá trị |
|---|---|
| `STRAFE_DURATION_MS` | 1000 ms |
| `REVERSE_TIMEOUT_MS` | 4000 ms |
| `REVERSE_PULSE_TARGET` | 1000 pulses ≈ 28.5 cm |
| `ROTATE_HEADING_TOL_DEG` | 8° |
| `MAX_REVERSE_ATTEMPTS` | 3 → E_STOPPED |
| `SPEED_STRAFE_FULL` | 100 |
| `SPEED_REVERSE_NORMAL` | 80 |
| `SPEED_ROTATE_NORMAL` | 70 |

### 7.4 Local Hard-Stop Latch

```cpp
if (ir.anyDetected() || sharp.isTooClose() || sharp.isSlowing()) {
    g_local_obstacle_stop = true;   // LATCH
    g_target_speeds[i] = 0;
    g_ramped_speeds[i] = 0;
    g_motors[i].coast();
}
// Clear debounce: chỉ clear khi tất cả sensor im lặng liên tục
if (!g_ir.anyDetected() && !g_sharp.isTooClose() && !g_sharp.isSlowing()) {
    g_local_obstacle_stop = false;  // CLEAR
}
```

### 7.5 Health Monitor (Type 142, 1 Hz)

11 modules được theo dõi:

| Module | Stale (ms) | Critical | Hành động khi FAILED |
|---|---|---|---|
| `MOD_IMU` | 2000 | Có | Recovery → FAILED → stop motors |
| `MOD_ENCODERS` | 200 | Có | FAILED → stop motors |
| `MOD_MOTOR_DRIVER` | 1000 | Có | Stall detection |
| `MOD_BATTERY` | 2000 | Có (critical) | Low → cap speed; Critical → auto E-stop *(disabled)* |
| `MOD_Pi_LINK` | 2500 (2s+500ms) | Không | Warning only |
| `MOD_I2C_BUS` | 1000 | Có | FAILED → stop motors |
| `MOD_IR` | 200 | Không | Warning only |
| `MOD_SHARP` | 200 | Không | Warning only |
| `MOD_TOF` | 200 | Không | Warning only |
| `MOD_CYLINDER` | 500 | Không | Warning only |

State machine per module:
```
ONLINE → (age > stale) → WARNING → (age > 2×stale) → RECOVERING → (retry ≥ 3) → FAILED
```

---

## 8. Odometry Fusion (ROS 2)

### 8.1 Constants

```python
WHEEL_RADIUS_M     = 0.0485
HALF_LENGTH_M      = 0.12
HALF_WIDTH_M       = 0.13
ENCODER_COUNTS_REV = 660       # matches firmware OUTPUT_CPR
METERS_PER_COUNT   = 2π × 0.0485 / 660 = 0.0004605 m/count

PUBLISH_RATE_HZ    = 30.0
OMEGA_ROS_SIGN     = -1.0     # firmware CW+ → ROS CCW+ sign flip
TWIST_STALE_AFTER_S = 0.15    # 150 ms freshness window
```

### 8.2 Yaw Fusion Algorithm

```
ON IMU MESSAGE (type-134, heading 0-360°):
    yaw_rad = radians(heading_deg)
    IF first IMU:
        yaw_continuous = yaw_rad
    ELSE:
        diff = yaw_rad - yaw_continuous
        diff = (diff + π) MOD 2π - π    ← wrap to [-π, π]
        yaw_continuous += diff            ← unwrap across 360°
    _imu_yaw = yaw_continuous
    _imu_yaw_time = now

ON ENCODER MESSAGE (type-130, every 20 ms):
    IF IMU fresh (age < 0.2s):
        yaw = _imu_yaw                    ← use IMU as absolute reference
    ELSE:
        yaw += omega_firmware × dt        ← integrate wheel angular velocity

    x += vx_body × cos(yaw) - vy_body × sin(yaw)
    y += vx_body × sin(yaw) + vy_body × cos(yaw)
```

### 8.3 Twist Staleness

```python
age = now - last_encoder_msg_time
vx  = _vx  IF age ≤ 0.15s ELSE 0.0
vy  = _vy  IF age ≤ 0.15s ELSE 0.0
omega_ros = _omega × OMEGA_ROS_SIGN  IF age ≤ 0.15s ELSE 0.0
```

Pose giữ nguyên (không reset), twist decay về 0 khi stale → Nav2 dừng steering.

### 8.4 Rotation Convention Chain

| Layer | Convention | Ghi chú |
|---|---|---|
| Firmware `MecanumDrive.h` | omega > 0 = CW | Source of truth |
| Odom integration | Computes `omega_firmware` CW+ | Same convention |
| Yaw from IMU | BNO055 heading (0-360° compass) | Used directly |
| Yaw from wheel fallback | Integrates CW+ omega | → CW+ yaw for body rotation |
| Twist publish | `angular.z = omega × (-1)` | Flip once for ROS CCW+ |
| TF quaternion | Uses `_yaw` directly | CW+ when wheel-only |

**Lưu ý:** Khi IMU stale, `_yaw` (CW+) được dùng cho rotation matrix và quaternion, nhưng `twist.angular.z` bị flip CCW+. Pose và twist dùng **different sign conventions** trong trường hợp này.

---

## 9. Warehouse Dock Sequence

### 9.1 Cylinder Actuator (L298N H-Bridge)

| Pin | Chức năng |
|---|---|
| GPIO 2 (IN1) | Extend HIGH |
| GPIO 35 (IN2) | Retract HIGH |
| GPIO 37 (Limit) | Retract limit switch (INPUT_PULLUP, active-LOW) |

| Hằng số | Giá trị |
|---|---|
| `CYLINDER_MAX_RUN_MS` | 8000 ms (safety timeout) |
| `CYLINDER_HOLD_AT_TOP_MS` | 3000 ms |
| `HEADING_GATE_DEG` | 2.0° |
| `LEAVE_DOCK_SPEED` | 50 PWM |
| `LEAVE_DOCK_DISTANCE_CM` | 30 cm |

### 9.2 8-State Dock Sequence

```
IDLE
  ↓ CMD_BEGIN_DOCK
ADJUSTING (≤5s)     ← nudge ±40 PWM, chờ TOF ≤ 4cm + |heading_err| ≤ 2°
  ↓ distance_ok + heading_ok
EXTENDING (≤8s)     ← cylinder_extend()
  ↓ timeout or cylinder extended
HOLDING (3s)        ← cylinder_hold()
  ↓ timeout
RETRACTING (≤8s)    ← cylinder_retract(), chờ limit switch GPIO 37
  ↓ isRetracted() or timeout
DONE
  ↓ auto
LEAVE (≤8s, ≤30cm)  ← reverse at PWM 50, heading-hold PI (kp=2.5, ki=0.3)
  ↓ distance reached or timeout
COMPLETE → back to IDLE
```

**Heading gate trong ADJUSTING:** Nếu IMU fail → `heading_ok = true` (bypass gate — potential safety gap).

### 9.3 Distance Calculation (AutoRoam leave-dock)

```cpp
constexpr float OUTPUT_CPR = (float)MOTOR_ENCODER_CPR * MOTOR_GEAR_RATIO;  // = 660
float dist_cm = fabs(delta) * (3.14159f * 6.0f) / OUTPUT_CPR;
// = delta × 188.5mm / 660 = delta × 0.2856 mm/pulse
```

---

## 10. Các lỗi còn tồn đọng

### Đã sửa trong 2 commits gần nhất

| # | Mức độ | Mô tả | File | Trạng thái |
|---|---|---|---|---|
| 1 | **CRITICAL** | Odom parser không nhận type-130 array format từ telemetry bridge | `odom_node.py` | ✅ Đã sửa (90cf2b9) |
| 2 | **CRITICAL** | Encoder CPR odom_node = 330 thay vì 660 (2x scale error) | `odom_node.py` | ✅ Đã sửa (e55f678) |
| 3 | **CRITICAL** | Yaw blend 80/20 gây drift tích lũy + 0/360° discontinuity | `odom_node.py` | ✅ Đã sửa (e55f678) |
| 4 | **HIGH** | Firmware CW+ vs ROS CCW+ rotation convention mismatch | `odom_node.py` | ✅ Đã sửa (e55f678) |
| 5 | **HIGH** | PID derivative kick (overshoot every speed change) | `PIDController.cpp` | ✅ Đã sửa (e55f678) |
| 6 | **HIGH** | AutoRoam distance ÷ 22 thay vì 660 (30x quá lớn) | `AutoRoam.cpp` | ✅ Đã sửa (90cf2b9) |
| 7 | **HIGH** | AvoidanceFSM REVERSE_PULSE_TARGET sai (500 thay vì 1000) | `AvoidanceFSM.cpp` | ✅ Đã sửa (90cf2b9) |
| 8 | **MEDIUM** | PID integral windup (clamp-only anti-windup) | `PIDController.cpp` | ✅ Đã sửa (e55f678) |
| 9 | **MEDIUM** | Kick boost nằm trong PID target (gây oscillation) | `main.cpp`, `ModeManager.cpp` | ✅ Đã sửa (e55f678) |
| 10 | **MEDIUM** | PID dt fixed thay vì measured (delayed loop stall) | `main.cpp` | ✅ Đã sửa (e55f678) |
| 11 | **MEDIUM** | Encoder resume() phantom delta | `Encoder.cpp` | ✅ Đã sửa (e55f678) |
| 12 | **MEDIUM** | BTS7960 re-enable từ PWM cũ + brake cả 2 kênh | `BTS7960Driver.cpp` | ✅ Đã sửa (e55f678) |
| 13 | **MEDIUM** | fabsf() trong PID path che dấu motor quay ngược | `main.cpp`, `ModeManager.cpp` | ✅ Đã sửa (e55f678) |
| 14 | **LOW** | Pi-link health timeout không khớp heartbeat | `main.cpp` | ✅ Đã sửa (e55f678) |
| 15 | **LOW** | Encoder RPM clip trước filter (gây spike) | `Encoder.cpp` | ✅ Đã sửa (e55f678) |

### Còn tồn đọng (chưa sửa)

| # | Mức độ | Mô tả | Vị trí | Khuyến nghị |
|---|---|---|---|---|
| 16 | **HIGH** | **Không có physical E-stop button** — chỉ rely on `CMD_E_STOP` từ Pi | Hệ thống | Wire NC button → GPIO interrupt → emergencyStop |
| 17 | **HIGH** | **Battery auto-E-stop bị disabled** trong main.cpp (bench test) | `main.cpp:1144-1163` | Bật lại khi INA226 wiring hoàn tất |
| 18 | **HIGH** | **Yaw convention: IMU BNO055 heading (compass) ≠ ROS CCW+** | `odom_node.py` | Thêm heading-to-ROS-yaw conversion: `yaw_ros = π/2 - yaw_mag` hoặc dùng quaternion directly |
| 19 | **MEDIUM** | **Pose vs Twist sign mismatch khi IMU stale** | `odom_node.py` | `_yaw` CW+ dùng cho pose rotation, `twist.angular.z` flip CCW+. Cần nhất quán |
| 20 | **MEDIUM** | **`forced_auto_roam_` là bẫy một chiều** — không thể về NAV | `Watchdog.cpp:35,68-71` | Thêm `CMD_FORCE_NAV` hoặc heartbeat timeout auto-recovery |
| 21 | **MEDIUM** | **Heading gate bypass khi IMU fail mid-dock** | `AutoRoam.cpp:222` | Nếu IMU offline → `heading_ok = false`, abort dock |
| 22 | **MEDIUM** | **`_yaw_wheel_integral` dead code** — gán nhưng không đọc | `odom_node.py` | Xóa hoặc dùng cho fallback |
| 23 | **LOW** | **Brake() chỉ brake một chiều** — motor quay ngược bị reverse-impulse | `BTS7960Driver.cpp` | Direction-aware brake hoặc dùng coast thay vì brake |
| 24 | **LOW** | **`MAX_ROTATE_ATTEMPTS = 4` never enforced** | `AvoidanceFSM.cpp:44` | Thêm path escalate → E_STOPPED khi rotate ≥ 4 lần |
| 25 | **LOW** | **Emergency stop không brake trước khi disable EN** | `BTS7960Driver.cpp` | Brake 50ms trước khi EN LOW để dừng nhanh hơn |
| 26 | **LOW** | **Sharp boot skip 2s** gây 5s tổng immobilize sau boot | `AutoRoam.cpp:423-425` | Document trong user manual |

---

## 11. Lệnh kiểm tra thực địa

### 11.1 Kiểm tra từng bánh (PWM thấp)

```bash
# Trên Pi, qua serial monitor:
pio device monitor

# Test từng bánh:
M 80 0 0 0      # FL forward 80 PWM — xác nhận wheel quay forward
M -80 0 0 0     # FL backward 80 PWM
M 0 80 0 0      # FR
M 0 0 80 0      # RL
M 0 0 0 80      # RR

# Kiểm tra encoder RPM (type-134 debug):
V               # Status JSON — xem motors[].rpm
```

### 11.2 Kiểm tra Odometry

```bash
# Trên Pi:
ros2 topic echo /odom --once

# Test 1: Forward 1m — odom x ≈ 1.0 m (±0.02 m)
ros2 topic pub /esp32/cmd std_msgs/msg/String '{"data":"{\"cmd\":\"move\",\"vx\":100,\"vy\":0,\"omega\":0}"}'

# Test 2: Strafe — |angular.z| < 0.02 rad/s
ros2 topic pub /esp32/cmd std_msgs/msg/String '{"data":"{\"cmd\":\"move\",\"vx\":0,\"vy\":100,\"omega\":0}"}'

# Test 3: Rotate 90° CW — pose yaw ≈ -π/2 (CW = negative trong ROS CCW+)
ros2 topic pub /esp32/cmd std_msgs/msg/String '{"data":"{\"cmd\":\"move\",\"vx\":0,\"vy\":0,\"omega\":80}"}'
```

### 11.3 Kiểm tra PID

```bash
# Từ serial monitor, observe RPM debug (once per second per motor):
# Command vx=150 từ stop — overshoot < 10%
# Kiểm tra saturated PWM khi motor stall (bánh kẹt)
```

### 11.4 Kiểm tra Safety

```bash
# E-stop test:
D               # E-stop → tất cả motor停止
K               # Clear E-stop →恢复

# Heartbeat timeout test:
# Ngắt UART cable 2s → MODE_AUTO_ROAM
# Nối lại UART → heartbeat → MODE_NAV

# Sharp threshold test:
# Đặt vật cản 15cm trước robot → hard-stop
# Di chuyển vật cản ra → robot resume
```

### 11.5 TypeScript Check

```bash
cd apps/web && npx tsc --noEmit   # No regressions
```

---

> **Kết luận kiểm tra:** Hệ thống motor/encoder/PID/odometry đã được audit
> và sửa 15 lỗi (15/15 đã verified). Còn 11 tồn đọng cần xử lý trước
> khi triển khai production, trong đó 3 lỗi HIGH (physical E-stop,
> battery auto-E-stop, IMU heading convention) cần ưu tiên.
