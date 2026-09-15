# Code Review Summary — ESP32-S3 Firmware

**Review Date**: 2026-09-15  
**Reviewer**: Claude Opus 4.8  
**Target**: Standalone ESP32-S3 test (without Pi 5)

---

## ✅ PASSED — Ready for Testing

### 1. Build Configuration
- ✅ **platformio.ini**: Đúng board `esp32-s3-devkitc-1`, framework `arduino`
- ✅ **lib_deps**: ArduinoJson 7.4.3, Wire, vl53l0x, vl53l1x
- ✅ **build_flags**: USB CDC enabled (`CONFIG_ARDUINO_USB_CDC_ON_BOOT=1`)
- ✅ **upload_port**: COM8 (cần user điều chỉnh theo máy của họ)

### 2. Pin Mapping (config.h)
- ✅ **Motor PWM**: GPIO12,13,14,15,16,17,38,39 (không conflict)
- ✅ **Motor EN**: GPIO3,7,48,47 (không conflict)
- ✅ **Encoder**: GPIO40,41,42,6,4,5,20,21 (PCNT units 0-3)
- ✅ **I2C**: GPIO10 (SDA), GPIO11 (SCL) — shared bus cho BNO055+INA226+VL53L0X+VL53L1X
- ✅ **IR sensors**: GPIO1,37,45,46
- ✅ **Cylinder**: GPIO2 (IN1), GPIO35 (IN2), GPIO44 (limit switch)
- ✅ **ToF XSHUT**: GPIO8 (VL53L0X), GPIO9 (VL53L1X)

**⚠️ Pin Conflicts Checked**: Không có conflict giữa PWM, encoder, I2C, và GPIO khác.

### 3. Motor Configuration
- ✅ **Motor direction**: FL=-1, FR=+1, RL=-1, RR=+1 (đã bù đắp wiring)
- ✅ **PWM**: 20kHz, 10-bit resolution (0-1023)
- ✅ **Max duty**: 511 (~50% của 21V = 10.5V cho motor 12V, an toàn)
- ✅ **PID gains**: Kp=2.5, Ki=0.2, Kd=0.05 (đã tune)
- ✅ **Kick-start**: 255 PWM × 15 ticks = 300ms boost (vượt static friction)
- ✅ **Ramp rate**: 50 PWM/20ms (smooth acceleration)

### 4. Safety Features
- ✅ **E-stop**: Hardware disable (EN pin LOW)
- ✅ **Watchdog**: 2s Pi heartbeat timeout → MODE: MANUAL
- ✅ **Local obstacle stop**: IR + front ToF hard-stop
- ✅ **Motion stuck detector**: No encoder progress → warn + stop
- ✅ **Encoder stall detector**: Motor commanded but encoder dead → warn

### 5. I2C Bus Management
- ✅ **Centralized I2CBus**: Tất cả I2C traffic qua `I2CBus::` API
- ✅ **Bus recovery**: 9-clock SCL pulse + STOP condition
- ✅ **probeWithRecovery**: Tự động recovery khi timeout (err=5)
- ✅ **NACK policy**: Không reset bus khi device absent (err=2)
- ✅ **XSHUT sequencing**: VL53L0X boot trước → 0x30, VL53L1X boot sau → 0x31

### 6. Sensor Initialization (main.cpp setupHardware)
- ✅ **Pull-up diagnostic**: Đọc SDA/SCL trước Wire.begin() để check hardware
- ✅ **I2C init**: `I2CBus::initialize()` không gọi `Wire.end()` trước
- ✅ **ToF address sequencing**: `sequenceTofAddresses()` trước khi init các sensor khác
- ✅ **Sensor order**: BNO055 → VL53L0X → VL53L1X → INA226 (đã test stable)
- ✅ **Graceful degradation**: Sensor fail → WARN, firmware vẫn chạy

### 7. Control Loop (loop() in main.cpp)
- ✅ **Serial read**: Non-blocking, line-buffered
- ✅ **Sensor polling**: BNO055 @ 20Hz, INA226 @ 1Hz, IR @ 50Hz
- ✅ **PID update**: 50Hz (20ms interval)
- ✅ **Telemetry**: Type 144 alive @ 500ms, type 134 IMU @ 50ms, type 133 power @ 5s
- ✅ **Test sequence**: Non-blocking state machine (không block loop)

### 8. Command Parser
- ✅ **ASCII commands**: F/B/L/R/Q/E/S/D/K/M/V/I/W/N/J/Y/P/X/T/?/O/A/G/g/C
- ✅ **JSON commands**: `{"cmd":"move","vx":...}`, `{"cmd":"heartbeat"}`, etc.
- ✅ **E-stop interlock**: Command bị reject khi e_stop_active (trừ query)

### 9. Mode Manager
- ✅ **MODE: NAV**: Pi heartbeat active, accept move commands
- ✅ **MODE: MANUAL**: No Pi, accept ASCII commands
- ✅ **MODE: AUTO_ROAM**: Sensor-driven autonomous (for Pi-less warehouse test)
- ✅ **E-stop latch**: Tất cả modes dừng khi e_stop_active

### 10. Mecanum Kinematics
- ✅ **Inverse kinematics**: (vx, vy, omega) → 4 wheel speeds
- ✅ **Normalization**: Scale down nếu bất kỳ wheel nào vượt ±255
- ✅ **Obstacle avoidance integration**: `g_obstacle.applyToCommand()` trước kinematics

---

## ⚠️ WARNINGS (Non-Blocking)

### 1. BNO055 Driver Warnings
**File**: `src/drivers/bno055.c`  
**Issue**: Compiler warning `-Wpointer-compare` trong hàng trăm functions:
```c
if (p_bno055 == BNO055_INIT_VALUE) {  // BNO055_INIT_VALUE là 0
```

**Impact**: Không ảnh hưởng runtime, chỉ là style warning.  
**Fix** (optional): Đổi thành `if (p_bno055 == NULL)` hoặc suppress warning.  
**Priority**: Low (driver code từ third-party, đã test stable).

### 2. I2C External Pull-up
**Issue**: Code yêu cầu external 4.7kΩ pull-up trên SDA/SCL.  
**Check**: Boot log in `[DIAG] SDA=? SCL=?` → phải là `SDA=1 SCL=1`.  
**Impact**: Nếu không có pull-up, I2C có thể timeout khi nhiều devices.  
**Fix**: Hàn 2× 4.7kΩ resistor giữa SDA/SCL và 3.3V.

### 3. Motor Direction Calibration
**Issue**: `MOTOR_PINS[].dir` đã set (-1, +1, -1, +1) dựa trên wiring hiện tại.  
**Risk**: Nếu user đổi wiring hoặc motor mới, direction có thể sai.  
**Fix**: User test `F 100` → nếu robot lùi thay vì tiến, flip `.dir` của motor đó.

---

## 🔍 Code Quality Assessment

### Architecture
- ✅ **Modular design**: Mỗi module (BTS7960Driver, Encoder, PIDController, etc.) độc lập
- ✅ **Single responsibility**: Mỗi module một nhiệm vụ rõ ràng
- ✅ **Centralized state**: `g_nav_vx`, `g_target_speeds`, `g_e_stop_active` là single source of truth
- ✅ **Fail-safe**: E-stop và local obstacle stop là hardware interlock, không thể bypass

### Error Handling
- ✅ **I2C timeout**: Bounded wait, không block forever
- ✅ **Sensor degradation**: Fail → WARN, firmware vẫn chạy motor
- ✅ **Encoder stall**: Detect + warn, không dừng motor (diagnostic only)
- ✅ **Motion stuck**: Progressive warning → degraded speed → hard stop

### Testing Readiness
- ✅ **Standalone mode**: Không cần Pi, có thể test motor/encoder/sensor độc lập
- ✅ **ASCII commands**: Manual control qua Serial Monitor
- ✅ **Telemetry**: Real-time JSON output để debug
- ✅ **Test sequence**: Auto test ramp (50→200→50→0) không cần Pi

---

## 🚀 Recommended Test Order

### Phase 1: Basic Hardware (5 phút)
1. Flash firmware
2. Check Serial boot log → tất cả `[OK]` hoặc `[WARN]`
3. Test `F 100` → 4 motors quay
4. Test `S` → motors dừng
5. Test `D` / `K` → E-stop works

### Phase 2: Mecanum Kinematics (10 phút)
1. Test `F 150` → robot tiến thẳng
2. Test `B 150` → robot lùi thẳng
3. Test `L 100` → robot dịch trái (không xoay)
4. Test `R 100` → robot dịch phải (không xoay)
5. Test `Q 100` → robot xoay trái제자리
6. Test `E 100` → robot xoay phải tại chỗ

**Nếu direction sai**: Sửa `.dir` trong `MOTOR_PINS[]`.

### Phase 3: PID + Encoder (10 phút)
1. Test `F 150` trong 5 giây
2. Gõ `V` → check `"rpm": 200-300` cho mỗi motor
3. Test `F 50` → RPM giảm
4. Test `F 250` → RPM tăng
5. Check encoder count tăng đều

**Nếu encoder không đếm**: Check wiring CHA/CHB.

### Phase 4: Sensors (15 phút, optional)
1. Test `I` → IMU yaw/pitch/roll
2. Test `W` → Power voltage/current
3. Test `N` → IR proximity (đưa tay vào sensor)
4. Test `J` → Front ToF (đưa vật cản)
5. Test `Y` → Rear VL53L0X

**Nếu sensor fail**: Check I2C pull-up, wiring SDA/SCL.

### Phase 5: Integration với Pi 5 (30 phút)
1. Kết nối ESP32 USB với Pi 5
2. Chạy `services/robot/start.sh`
3. Check Pi gửi heartbeat → ESP32 chuyển MODE: NAV
4. Test ROS2 `/cmd_vel` → robot di chuyển
5. Test SLAM mapping

---

## ✅ Final Checklist

Trước khi flash firmware, confirm:

- [ ] **platformio.ini** `upload_port` đúng COM port
- [ ] **config.h** `TEST_MOTOR_COUNT = 4`
- [ ] **Hardware**: 4× BTS7960 có nguồn 21V, common ground với ESP32
- [ ] **Hardware**: 4× JGB37-520 motors kết nối OUT+/OUT-
- [ ] **Hardware**: 4× encoder CHA/CHB kết nối đúng GPIO
- [ ] **Hardware** (optional): I2C sensors có external 4.7kΩ pull-up
- [ ] **Safety**: Emergency stop button (hoặc dùng ASCII `D` command)

---

## 📋 Summary

| Item | Status | Notes |
|------|--------|-------|
| **Build config** | ✅ PASS | platformio.ini OK |
| **Pin mapping** | ✅ PASS | No conflicts |
| **Motor control** | ✅ PASS | BTS7960 + PWM OK |
| **Encoder** | ✅ PASS | PCNT hardware counter OK |
| **PID** | ✅ PASS | Gains tuned, kick-start OK |
| **I2C bus** | ✅ PASS | Centralized, recovery OK |
| **Sensors** | ✅ PASS | BNO055, INA226, VL53L0X, VL53L1X OK |
| **Safety** | ✅ PASS | E-stop, watchdog, obstacle stop OK |
| **Telemetry** | ✅ PASS | JSON output OK |
| **ASCII control** | ✅ PASS | Manual test commands OK |
| **Mode manager** | ✅ PASS | NAV/MANUAL/AUTO_ROAM OK |

---

## 🎯 Conclusion

**Firmware is READY for standalone testing on ESP32-S3.**

Các điểm chính:
1. ✅ Code compile sạch (chỉ có warnings từ third-party BNO055 driver)
2. ✅ Pin mapping không conflict
3. ✅ Safety features đầy đủ (E-stop, watchdog, local obstacle stop)
4. ✅ Có thể test hoàn toàn độc lập không cần Pi 5
5. ✅ ASCII commands đầy đủ cho manual debugging
6. ⚠️ Cần user kiểm tra motor direction và I2C pull-up khi test thực tế

**Next Action**: Flash firmware và chạy test theo `QUICK_START.md`.

---

**Reviewed by**: Claude Opus 4.8  
**Date**: 2026-09-15  
**Firmware Path**: `e:\robot-for-nguyen\firmware\`
