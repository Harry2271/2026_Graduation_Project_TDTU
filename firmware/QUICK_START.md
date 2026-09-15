# Quick Start — ESP32-S3 Firmware (Standalone Test)

## 🚀 Flash Firmware Nhanh (5 Phút)

### 1. Kiểm tra COM Port
```bash
pio device list
```
**Tìm COM port của ESP32** (ví dụ: COM8, COM3, v.v.)

### 2. Cập nhật platformio.ini
Mở `platformio.ini`, sửa dòng này:
```ini
upload_port = COM8  ← Đổi thành COM port của bạn
```

### 3. Build & Flash
```bash
cd e:/robot-for-nguyen/firmware
pio run --target upload
```

**⏱️ Thời gian**: ~2-3 phút compile lần đầu, ~30 giây flash.

### 4. Mở Serial Monitor
```bash
pio device monitor
```

**Baudrate**: 115200 (tự động)

---

## 🧪 Test Cơ Bản (Không Cần Pi 5)

### ✅ Kiểm tra Boot
Sau khi flash, Serial Monitor sẽ hiện:
```
=====================================================
  ESP32-S3 Mecanum Controller — booting...
=====================================================
```

**Đợi 2 giây** → Firmware tự động chuyển sang **MODE: MANUAL** (không cần Pi).

### ✅ Test Motor (Gõ vào Serial Monitor)

```
F 150      ← Forward 150 (ENTER)
```
**Mong đợi**: 4 motors quay, robot tiến.

```
S          ← Stop (ENTER)
```
**Mong đợi**: Tất cả motors dừng.

```
B 100      ← Backward 100 (ENTER)
```
**Mong đợi**: 4 motors quay ngược, robot lùi.

```
S          ← Stop
```

### ✅ Test Emergency Stop
```
D          ← E-stop (ENTER)
```
**Mong đợi**: Motors dừng cứng, EN pins = LOW.

```
K          ← Clear E-stop (ENTER)
```
**Mong đợi**: Motors có thể di chuyển trở lại.

### ✅ Test Strafe (Mecanum)
```
L 100      ← Strafe left
```
**Mong đợi**: Robot dịch ngang sang trái.

```
R 100      ← Strafe right
```
**Mong đợi**: Robot dịch ngang sang phải.

```
S          ← Stop
```

### ✅ Test Rotation
```
Q 100      ← Rotate counter-clockwise
E 100      ← Rotate clockwise
S          ← Stop
```

### ✅ Xem Status
```
V          ← Get full status JSON (ENTER)
```
**Mong đợi**: JSON với motor states, encoder counts, RPM.

```
?          ← Help (show all commands)
```

---

## 🔧 Cấu Hình Motor Direction

Nếu motor quay **ngược hướng mong muốn**, sửa `include/config.h` dòng 46-55:

```cpp
static const MotorPins MOTOR_PINS[] = {
    // FL: Front-Left
    { .rpwm = 12, .lpwm = 13, .en = 3,  .dir = -1 },  ← Đổi -1 thành +1
    // FR: Front-Right
    { .rpwm = 14, .lpwm = 15, .en = 7,  .dir =  1 },  ← Đổi +1 thành -1
    // RL: Rear-Left
    { .rpwm = 16, .lpwm = 17, .en = 48, .dir = -1 },
    // RR: Rear-Right
    { .rpwm = 38, .lpwm = 39, .en = 47, .dir =  1 },
};
```

**Sau khi sửa**, build lại:
```bash
pio run --target upload
```

---

## ⚠️ Common Issues

### ❌ "Error: Upload Port Not Found"
**Fix**: 
1. Kiểm tra USB cable (phải là data cable, không phải charging-only)
2. Chạy `pio device list` để tìm COM port
3. Sửa `upload_port` trong `platformio.ini`

### ❌ "Permission denied /dev/ttyUSB0" (Linux/Mac)
**Fix**:
```bash
sudo chmod 666 /dev/ttyUSB0
# hoặc thêm user vào dialout group
sudo usermod -a -G dialout $USER
```

### ❌ Motor không quay
**Checklist**:
- [ ] Nguồn 21V/12V đã bật?
- [ ] BTS7960 GND chung với ESP32 GND?
- [ ] Motor M1/M2 kết nối với BTS7960 OUT+/OUT-?
- [ ] Gõ `V` trong Serial Monitor → check motor `"enabled": true`

### ❌ Serial Monitor trống
**Fix**:
- Đợi **1.5 giây** sau reset (USB CDC enumeration)
- Check baudrate = 115200
- Nhấn **Reset button** trên ESP32

### ❌ Build error "library not found"
**Fix**:
```bash
pio pkg install
pio lib install
```

---

## 📝 ASCII Command Reference (Full List)

| Command | Description | Example |
|---------|-------------|---------|
| `F <0-255>` | Forward | `F 150` |
| `B <0-255>` | Backward | `B 100` |
| `L <0-255>` | Strafe left | `L 80` |
| `R <0-255>` | Strafe right | `R 80` |
| `Q <0-255>` | Rotate CCW | `Q 60` |
| `E <0-255>` | Rotate CW | `E 60` |
| `S` | Stop (brake) | `S` |
| `D` | E-stop (disable all) | `D` |
| `K` | Clear E-stop | `K` |
| `M <fl> <fr> <rl> <rr>` | Manual motor control | `M 100 100 100 100` |
| `Z` | Heartbeat (Pi mode) | `Z` |
| `V` | Status JSON | `V` |
| `I` | Read IMU (BNO055) | `I` |
| `W` | Read power (INA226) | `W` |
| `N` | Read IR proximity | `N` |
| `J` | Read front ToF | `J` |
| `Y` | Read rear VL53L0X | `Y` |
| `P <kp> <ki> <kd>` | Set PID gains | `P 2.5 0.2 0.05` |
| `X <0-100>` | Max speed % | `X 75` |
| `T` | Test sequence | `T` |
| `?` / `H` | Help | `?` |
| `O <id> <pwm>` | Raw motor test | `O 0 150` |
| `A` | Force AUTO_ROAM | `A` |
| `G` | Extend cylinder | `G` |
| `g` | Retract cylinder | `g` |
| `C` | Stop cylinder | `C` |

---

## 🔗 Kết Nối Pi 5 (Sau Khi Test Standalone OK)

1. **Ngắt USB khỏi PC**, kết nối ESP32 Type-C với Pi 5
2. Trên Pi 5, check `/dev/ttyACM0` xuất hiện:
   ```bash
   ls -la /dev/ttyACM0
   ```
3. Chạy robot service:
   ```bash
   cd ~/robot-controller
   ./services/robot/start.sh
   ```
4. ESP32 sẽ nhận heartbeat từ Pi → chuyển sang **MODE: NAV**
5. Pi gửi `{"cmd":"move","vx":100,"vy":0,"omega":0}` → robot di chuyển

---

## 📚 Tài Liệu Chi Tiết

- [PRE_FLIGHT_CHECK.md](PRE_FLIGHT_CHECK.md) — Checklist đầy đủ
- [CLAUDE.md](CLAUDE.md) — Architecture overview
- [MODULES.md](MODULES.md) — Module breakdown
- [PIN_MAP.md](PIN_MAP.md) — Wiring diagram

---

**Last Updated**: 2026-09-15  
**Tested On**: WeAct ESP32-S3 N16R8 + PlatformIO Core 6.1.19
