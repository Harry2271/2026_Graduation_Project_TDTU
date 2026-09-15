# Pre-Flight Checklist — ESP32-S3 Standalone Test (No Pi 5)

## ✅ Checklist Trước Khi Flash Firmware

### 1. Hardware Connection
- [ ] **ESP32-S3 WeAct N16R8** kết nối USB Type-C với máy tính
- [ ] **COM Port** xuất hiện (kiểm tra Device Manager hoặc `pio device list`)
- [ ] **4× BTS7960** motor drivers đã được cấp nguồn 21V (hoặc 12V test)
- [ ] **Common Ground** giữa ESP32, tất cả BTS7960, và nguồn điện
- [ ] **4× JGB37-520 motors** đã kết nối với OUT+/OUT- của BTS7960

### 2. I2C Sensors (Optional cho standalone test)
- [ ] **BNO055 IMU** (I2C address 0x28) - GPIO10 SDA, GPIO11 SCL
- [ ] **INA226 Power Monitor** (I2C address 0x40) - GPIO10 SDA, GPIO11 SCL
- [ ] **VL53L0X rear ToF** (I2C address 0x30 runtime) - GPIO10 SDA, GPIO11 SCL
- [ ] **VL53L1X front ToF** (I2C address 0x31 runtime) - GPIO10 SDA, GPIO11 SCL
- [ ] **External 4.7kΩ pull-ups** trên SDA và SCL (bắt buộc cho 4-device I2C bus)

⚠️ **Nếu không có sensors**: Firmware vẫn chạy được, chỉ báo WARN khi boot.

### 3. IR Proximity Sensors (Optional)
- [ ] **E18-D80NK** rear-left (GPIO1), rear-right (GPIO37)
- [ ] **E18-D80NK** left (GPIO45), right (GPIO46)
- [ ] Các sensor này là INPUT_PULLUP, không có cũng chạy được

### 4. Cylinder Actuator (Optional)
- [ ] **L298N** IN1=GPIO2, IN2=GPIO35
- [ ] **Limit switch** GPIO44 cho retract detection

### 5. Encoder Connection
- [ ] **FL encoder**: CHA=GPIO40, CHB=GPIO41
- [ ] **FR encoder**: CHA=GPIO42, CHB=GPIO6
- [ ] **RL encoder**: CHA=GPIO4, CHB=GPIO5
- [ ] **RR encoder**: CHA=GPIO20, CHB=GPIO21
- [ ] Encoder VCC kết nối 3.3V hoặc 5V (tùy motor spec)
- [ ] Encoder GND chung với ESP32

---

## ⚙️ Configuration Check

### platformio.ini
```ini
[env:weact-esp32s3-n16r8]
upload_port = COM8  ← Đổi thành COM port của bạn
```

### config.h — Thông số quan trọng
```cpp
#define TEST_MOTOR_COUNT 4       // Test tất cả 4 motors
#define MOTOR_MAX_DUTY   511     // 21V → ~10.5V (an toàn cho motor 12V)
#define PWM_FREQUENCY    20000   // 20kHz PWM
#define DEFAULT_KP  2.5f         // PID gains
#define DEFAULT_KI  0.2f
#define DEFAULT_KD  0.05f
#define HEARTBEAT_TIMEOUT_MS 2000 // Chuyển sang MANUAL mode sau 2s không có Pi
```

⚠️ **Motor Direction**: Nếu motor quay ngược, đổi `.dir` trong `MOTOR_PINS[]`:
```cpp
// config.h dòng 46-55
{ .rpwm = 12, .lpwm = 13, .en = 3,  .dir = -1 },  // FL: -1 = reversed
{ .rpwm = 14, .lpwm = 15, .en = 7,  .dir =  1 },  // FR: +1 = normal
{ .rpwm = 16, .lpwm = 17, .en = 48, .dir = -1 },  // RL: -1 = reversed
{ .rpwm = 38, .lpwm = 39, .en = 47, .dir =  1 },  // RR: +1 = normal
```

---

## 🔧 Build & Flash

### 1. Compile Firmware
```bash
cd e:/robot-for-nguyen/firmware
pio run
```

**Kiểm tra output**:
- ✅ Thành công: `SUCCESS` và có file `.pio/build/weact-esp32s3-n16r8/firmware.bin`
- ❌ Lỗi: Đọc error message, thường là thiếu library hoặc syntax error

### 2. Flash to ESP32
```bash
pio run --target upload
```

**Hoặc chỉ định COM port**:
```bash
pio run --target upload --upload-port COM8
```

### 3. Monitor Serial Output
```bash
pio device monitor
```

**Hoặc dùng Serial Monitor của Arduino IDE / VSCode PlatformIO**.

---

## 🧪 Test Sequence (Standalone — No Pi)

### Boot Output (mong đợi)
```
=====================================================
  ESP32-S3 Mecanum Controller — booting...
=====================================================
  [OK]   PiSerial = native USB CDC @ 115200 logical baud
  [INIT] I2C bus SDA=GPIO10 SCL=GPIO11 @ 100 kHz...
  [DIAG] SDA=1 SCL=1 (no internal pullup — test your external 4.7kΩ)
  [OK]   I2C bus initialized
  [INIT] BNO055 IMU...
  [OK  ] BNO055
  [INIT] VL53L0X rear docking sensor...
  [OK  ] VL53L0X rear
  [INIT] VL53L1X front TOF400C sensor...
  [OK  ] VL53L1X front
  [INIT] INA226 power monitor...
  [OK  ] INA226
  [OK]   IR proximity sensors
  [OK  ] Front TOF400C distance sensor
  [OK]   Cylinder actuator
=====================================================
  ESP32-S3 Mecanum Controller
=====================================================
  Motors: 4 | Encoders: PCNT 0-3
  PID: 2.50 / 0.20 / 0.05 @ 50 Hz
  I2C: SDA=10 SCL=11 @ 100 kHz
  IMU:  BNO055 (heading + accel + gyro)
  PWR:  INA226 (V + I + P)
  IR:   4 proximity sensors
  FRONT TOF: VL53L1X @ 0x31 (< 45cm)
  Heartbeat timeout: 2000 ms
=====================================================
```

⚠️ **Nếu không có I2C sensors**: Sẽ báo `[WARN] BNO055`, `[WARN] VL53L0X`, etc. — đây là bình thường, firmware vẫn chạy motor được.

### Mode Manager Behavior
- **Sau boot**: Đợi 2 giây không có Pi heartbeat → chuyển sang **MODE: MANUAL**
- **MODE: MANUAL**: Chấp nhận ASCII commands qua Serial Monitor
- **MODE: NAV**: Cần Pi gửi `{"cmd":"heartbeat"}` mỗi 2 giây

### ASCII Commands để Test (gõ trong Serial Monitor)

#### 1. Test Forward/Backward
```
F 100      # Forward speed 100 (ra 255)
```
**Mong đợi**: Cả 4 motors quay về phía trước, robot tiến.

```
B 100      # Backward speed 100
```
**Mong đợi**: Cả 4 motors quay ngược, robot lùi.

```
S          # Stop
```

#### 2. Test Strafe (Mecanum)
```
L 100      # Strafe left
```
**Mong đợi**: FL+RR quay forward, FR+RL quay backward → robot dịch sang trái.

```
R 100      # Strafe right
```
**Mong đợi**: FL+RR quay backward, FR+RL quay forward → robot dịch sang phải.

```
S          # Stop
```

#### 3. Test Rotation
```
Q 100      # Rotate counter-clockwise (trái)
```
**Mong đợi**: FL+RL quay backward, FR+RR quay forward → robot xoay trái.

```
E 100      # Rotate clockwise (phải)
```
**Mong đợi**: FL+RL quay forward, FR+RR quay backward → robot xoay phải.

```
S          # Stop
```

#### 4. Test Individual Motor (Raw PWM)
```
O 0 150    # Motor FL (id=0) at PWM 150
```
**Mong đợi**: Chỉ FL motor quay, các motor khác dừng.

```
O 1 150    # Motor FR (id=1)
O 2 150    # Motor RL (id=2)
O 3 150    # Motor RR (id=3)
O 0 0      # Thoát raw test mode
```

#### 5. Test PID + Encoder
```
V          # Get full status JSON
```
**Mong đợi**: JSON với encoder counts, RPM, motor states, v.v.

```
F 150      # Forward
```
**Đợi 3 giây, sau đó gõ**:
```
V          # Check encoder RPM
```
**Mong đợi**: `"rpm": 200-300` cho mỗi motor (tùy load).

#### 6. Test Emergency Stop
```
D          # E-stop
```
**Mong đợi**: Tất cả motors dừng ngay lập tức, EN pin = LOW.

```
K          # Clear E-stop
```
**Mong đợi**: Motors có thể di chuyển trở lại.

#### 7. Test Sequence (Auto)
```
T          # Run test sequence (50→100→150→200→150→100→50→0)
```
**Mong đợi**: Robot tự động tăng giảm tốc độ trong 8 giây.

#### 8. Query Sensors (nếu có I2C sensors)
```
I          # Read IMU (BNO055) → type 134 JSON
W          # Read power (INA226) → type 133 JSON
N          # Read IR proximity → type 135 JSON
J          # Read front ToF distance → type 136 JSON
Y          # Read rear VL53L0X → type 138 JSON
```

#### 9. Help
```
?          # Show all commands
```

---

## 🐛 Troubleshooting

### ❌ Motor không quay
1. **Kiểm tra nguồn 21V/12V**: Đo điện áp tại BTS7960 B+ terminal
2. **Kiểm tra common ground**: ESP32 GND, BTS7960 GND, nguồn GND phải chung
3. **Kiểm tra EN pin**: Đo GPIO EN khi motor command → phải HIGH (3.3V)
4. **Kiểm tra PWM output**: Dùng LED test hoặc oscilloscope trên RPWM/LPWM
5. **Motor direction sai**: Đổi `.dir` trong `MOTOR_PINS[]` config.h

### ❌ Encoder không đếm
1. **Kiểm tra encoder VCC/GND**: Phải có 3.3V hoặc 5V
2. **Kiểm tra CHA/CHB wiring**: Đo tín hiệu khi motor quay (phải toggle 0V↔3.3V)
3. **Encoder bị đảo**: RPM âm khi motor quay thuận → không sao, PID tự điều chỉnh
4. **PCNT không khởi tạo**: Xem Serial boot log có `[MOTOR x FL]` messages

### ❌ I2C sensors không detect
1. **Kiểm tra pull-up 4.7kΩ**: Đo SDA/SCL khi idle → phải ~3.3V
2. **Kiểm tra SDA/SCL wiring**: GPIO10 = SDA, GPIO11 = SCL
3. **Address conflict**: Chạy I2C scanner để xác nhận address
4. **XSHUT pins**: VL53L0X XSHUT=GPIO8, VL53L1X XSHUT=GPIO9 phải HIGH khi boot

### ❌ Serial Monitor không hiện gì
1. **Đợi 1.5 giây sau reset**: USB CDC cần thời gian enumeration
2. **Baudrate sai**: Phải 115200 (virtual, CDC không quan trọng baud nhưng pio monitor cần)
3. **COM port sai**: Kiểm tra `pio device list`, đổi upload_port trong platformio.ini
4. **Driver chưa cài**: Cài CH343 driver nếu dùng UART0 (không cần cho USB CDC)

### ❌ Build lỗi
1. **Missing library**: Chạy `pio pkg install` hoặc check `lib_deps` trong platformio.ini
2. **Wrong board**: Phải `board = esp32-s3-devkitc-1`
3. **PIO Core outdated**: Cập nhật PlatformIO Core

---

## 📊 Expected Telemetry (MODE: MANUAL)

Sau khi boot và không có Pi heartbeat (2 giây), firmware sẽ:

1. **Type 144 (alive)** mỗi 500ms:
```json
{"type":144,"data":{"uptime_ms":5432,"alive":10,"e_stop":false,"mode":"MANUAL"}}
```

2. **Type 134 (IMU)** mỗi 50ms (nếu có BNO055):
```json
{"type":134,"data":{"yaw":123.4,"pitch":0.5,"roll":-0.2,"temp":28,"cal":{"sys":3,"gyro":3,"accel":3,"mag":3}}}
```

3. **Type 133 (power)** mỗi 5000ms (nếu có INA226):
```json
{"type":133,"data":{"bus_v":20.8,"current_a":1.2,"power_w":24.9,"soc_pct":85}}
```

Không cần Pi, firmware tự publish các type này qua USB CDC Serial.

---

## ✅ Kết Luận

Nếu tất cả các test trên pass:
- ✅ **Hardware wiring đúng**
- ✅ **Firmware compile và flash thành công**
- ✅ **Motors, encoders, sensors hoạt động**
- ✅ **PID control ổn định**
- ✅ **Emergency stop fail-safe hoạt động**

➡️ **Sẵn sàng kết nối với Pi 5** để test full stack (ROS2 + SLAM + Nav2).

---

## 🔗 Next Steps (with Pi 5)

1. Kết nối ESP32 USB Type-C với Pi 5 → xuất hiện `/dev/ttyACM0`
2. Chạy `services/robot/start.sh` trên Pi 5
3. Pi gửi `{"cmd":"heartbeat"}` mỗi 50ms → ESP32 chuyển sang **MODE: NAV**
4. Pi gửi `{"cmd":"move","vx":100,"vy":0,"omega":0}` → robot di chuyển theo lệnh ROS2

---

**Date**: 2026-09-15  
**Firmware Version**: ESP32-S3 Mecanum Controller (Arduino framework via PlatformIO)  
**Hardware**: WeAct ESP32-S3 N16R8 + 4× BTS7960 + 4× JGB37-520 + I2C sensors
