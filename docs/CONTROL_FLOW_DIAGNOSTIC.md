# Chẩn Đoán: Xe Không Chạy Khi Điều Khiển Từ Web UI

**Ngày:** 2026-09-18  
**Vấn đề:** Bấm nút điều khiển trên web (WASD / Arrow keys) nhưng xe không chạy  
**Trạng thái:** 🔴 CẦN KIỂM TRA

---

## 🔍 Phân Tích Luồng Điều Khiển

### Luồng Đầy Đủ: Web UI → ESP32

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. WEB UI (apps/web)                                            │
│    FloatingControlDock.tsx                                       │
│    ├─ User nhấn nút W/A/S/D hoặc Arrow keys                     │
│    ├─ onStartManualMotion() / onStopManualMotion()              │
│    └─ Gửi qua WebSocket → ws://robot-ip:9091                    │
└────────────────────┬────────────────────────────────────────────┘
                     │ WebSocket message
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│ 2. WEB_BRIDGE (services/robot/web_bridge.py)                   │
│    ├─ Nhận WebSocket command từ browser                        │
│    ├─ Parse JSON: {"type": "teleop", "vx": N, "vy": N, ...}   │
│    ├─ Đưa vào teleop_q (queue.Queue)                           │
│    └─ _poll_teleop() chạy mỗi 50ms (20 Hz)                     │
└────────────────────┬────────────────────────────────────────────┘
                     │ ROS 2 Topic
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│ 3. PUBLISH /cmd_vel (geometry_msgs/Twist)                      │
│    web_bridge.teleop_pub.publish(Twist)                        │
│    ├─ linear.x = vx (m/s)                                      │
│    ├─ linear.y = vy (m/s)                                      │
│    └─ angular.z = omega (rad/s)                                │
└────────────────────┬────────────────────────────────────────────┘
                     │ ROS 2 Topic
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│ 4. TELEOP_NODE (services/robot/teleop_node.py)                 │
│    ├─ Subscribe /cmd_vel                                        │
│    ├─ Kiểm tra controlMode: MANUAL hoặc AUTO                   │
│    ├─ Scale: m/s → PWM units (-255..255)                       │
│    │   vx_pwm = int(msg.linear.x * max_vx)  # max_vx=200      │
│    ├─ Clamp [-255, 255]                                        │
│    └─ await bridge.move(vx, vy, omega)                         │
└────────────────────┬────────────────────────────────────────────┘
                     │ MirrorBridge
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│ 5. MIRROR BRIDGE → /esp32/cmd (ROS Topic)                      │
│    teleop_node._bridge = MirrorBridge(self)                    │
│    ├─ await _send({"cmd":"move","vx":N,"vy":N,"omega":N})     │
│    └─ Publish JSON string on /esp32/cmd                        │
└────────────────────┬────────────────────────────────────────────┘
                     │ ROS 2 Topic
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│ 6. ESP32_TELEMETRY_NODE (services/robot/                       │
│       esp32_telemetry_node.py)                                  │
│    ├─ Subscribe /esp32/cmd                                      │
│    ├─ Validate command trong ALLOWED_COMMANDS                  │
│    ├─ Enqueue vào _cmd_q (deque, maxlen=32)                    │
│    ├─ _poll_commands() mỗi 50ms (20 Hz)                        │
│    ├─ Drain queue → forward to bridge                          │
│    └─ await bridge.send_command(cmd)                           │
└────────────────────┬────────────────────────────────────────────┘
                     │ USB CDC Serial
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│ 7. REAL ESP32 BRIDGE → Serial /dev/robot-esp32                 │
│    RealEsp32Bridge._send_line(cmd)                             │
│    ├─ JSON encode: {"cmd":"move","vx":100,"vy":0,"omega":0}   │
│    ├─ Append '\n'                                              │
│    └─ writer.write(line) → USB CDC @ 115200 baud              │
└────────────────────┬────────────────────────────────────────────┘
                     │ USB Cable
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│ 8. ESP32-S3 FIRMWARE (firmware/src/main.cpp)                   │
│    ├─ PiSerial.available() → đọc JSON line                    │
│    ├─ CommandParser::parseCommand(line)                        │
│    ├─ Dispatch: CMD_MOVE                                       │
│    ├─ MecanumDrive::compute(vx, vy, omega)                    │
│    │   → wheel speeds [FL, FR, RL, RR]                        │
│    ├─ PIDController::setTarget(speed) cho 4 motors            │
│    └─ BTS7960Driver::setSpeed() → PWM output                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## ❌ Các Điểm Có Thể Bị Lỗi

### 🔴 1. **Web UI Không Gửi Command**

**Kiểm tra:**
```bash
# Mở browser DevTools → Console
# Nhấn phím W/A/S/D → xem có message gửi đi không
```

**Dấu hiệu:**
- Không thấy WebSocket message trong Console
- Không thấy `onStartManualMotion()` được gọi

**Nguyên nhân có thể:**
- WebSocket không kết nối (`ws://robot-ip:9091` down)
- Event listener không hoạt động
- `controlMode !== 'MANUAL'` (đang ở chế độ AUTO)

---

### 🔴 2. **web_bridge.py Không Nhận hoặc Không Publish**

**Kiểm tra:**
```bash
# SSH vào Pi 5
pm2 logs nexus-robot-web-bridge

# Hoặc kiểm tra ROS topic
ros2 topic echo /cmd_vel
```

**Dấu hiệu:**
- `pm2 logs` không thấy "teleop command received"
- `ros2 topic echo /cmd_vel` không có message nào

**Nguyên nhân có thể:**
- WebSocket server không chạy (port 9091 không mở)
- `teleop_q` không được poll đúng cách
- `_poll_teleop()` timer không hoạt động
- Lỗi exception trong `_poll_teleop()` → silent fail

**Code cần kiểm tra:**
```python
# web_bridge.py line 131-132
self.create_timer(0.05, self._poll_teleop)  # 20 Hz

# Line 104
self.teleop_pub = self.create_publisher(Twist, '/cmd_vel', 10)
```

---

### 🔴 3. **teleop_node.py Không Subscribe hoặc Không Forward**

**Kiểm tra:**
```bash
# Kiểm tra teleop_node có chạy không
ros2 node list | grep teleop

# Kiểm tra /esp32/cmd topic
ros2 topic echo /esp32/cmd
```

**Dấu hiệu:**
- `ros2 node list` không thấy `teleop` node
- `/cmd_vel` có message nhưng `/esp32/cmd` không có

**Nguyên nhân có thể:**
- **ĐÂY LÀ NGUYÊN NHÂN QUAN TRỌNG NHẤT:**
  - `teleop_node.py` kiểm tra `self._mode` (line 122-124)
  - Nếu `self._mode == 'AUTO'` thì KHÔNG forward lệnh từ keyboard!
  
```python
# teleop_node.py:119-124
def _on_cmd_vel(self, msg: Twist) -> None:
    """Convert MANUAL or Nav2 /cmd_vel to ESP32 move commands."""
    # /cmd_vel is operator input in MANUAL and Nav2 output in AUTO.
    # The mode switch changes publisher authority, not this safety bridge.
    if self._bridge is None or not self._connected:
        return  # ← KIỂM TRA NÀY!
```

- `MirrorBridge` không kết nối (`self._connected = False`)
- `esp32_telemetry_node` chưa chạy → `/esp32/cmd` không có subscriber

---

### 🔴 4. **esp32_telemetry_node Không Forward**

**Kiểm tra:**
```bash
# Kiểm tra node có chạy không
ros2 node list | grep esp32_telemetry

# Kiểm tra command queue status
ros2 topic echo /esp32/cmd_status
```

**Dấu hiệu:**
- `/esp32/cmd` có message nhưng không ra serial
- `/esp32/cmd_status` báo "rejected" hoặc "queue full"

**Nguyên nhân có thể:**
- Command bị reject do không nằm trong `ALLOWED_COMMANDS` (line 50-61)
- Priority queue hoặc normal queue đầy
- `_poll_commands()` không chạy (line 538)
- Serial port `/dev/robot-esp32` không mở được

**Code cần kiểm tra:**
```python
# esp32_telemetry_node.py:50-61
ALLOWED_COMMANDS = frozenset({
    'move', 'stop', 'e_stop', 'e_stop_clear', 'heartbeat',
    ...
})

# Line 505-507
port = os.environ.get('ESP32_PORT', '/dev/robot-esp32')
baud = int(os.environ.get('ESP32_BAUD', '115200'))
```

---

### 🔴 5. **RealEsp32Bridge Serial Không Gửi**

**Kiểm tra:**
```bash
# Kiểm tra USB CDC device
ls -l /dev/robot-esp32
ls -l /dev/ttyACM*

# Monitor serial raw data
sudo cat /dev/robot-esp32
```

**Dấu hiệu:**
- `/dev/robot-esp32` không tồn tại
- `ls /dev/ttyACM*` không có device nào
- `sudo cat` không thấy data

**Nguyên nhân có thể:**
- **ESP32 không kết nối USB** → kiểm tra dây cáp Type-C
- Udev rule không hoạt động (`/dev/robot-esp32` symlink không tạo)
- Permission denied (user không trong `dialout` group)
- ESP32 đã crash / không boot

**Kiểm tra udev:**
```bash
# services/robot/config/udev/99-robot-ports.rules phải được cài
cat /etc/udev/rules.d/99-robot-ports.rules
```

---

### 🔴 6. **ESP32 Firmware Không Parse Command**

**Kiểm tra:**
```bash
# Mở serial monitor để xem firmware logs
pio device monitor -p /dev/ttyACM0 -b 115200
```

**Dấu hiệu trong serial monitor:**
- Thấy JSON line đến nhưng không có response `{"type":128,...}` (ACK)
- Thấy `{"type":129,"data":{"error":"..."}}` (ERROR)
- Firmware print "Unknown command" hoặc "Parse error"

**Nguyên nhân có thể:**
- `CommandParser.cpp` không parse đúng JSON
- JSON malformed (thiếu dấu `}` hoặc sai format)
- Buffer overflow (line quá dài, >256 bytes)

**Code firmware cần kiểm tra:**
```cpp
// firmware/src/modules/CommandParser.cpp
void CommandParser::parseCommand(const String& line) {
    DeserializationError error = deserializeJson(doc, line);
    if (error) {
        // JSON parse error
        return;
    }
    // ...
}
```

---

### 🔴 7. **Motor/PID/BTS7960 Không Hoạt Động**

**Dấu hiệu:**
- Firmware nhận command và ACK đúng
- Nhưng motor vẫn không quay

**Nguyên nhân có thể:**
- **E-STOP đang active** → kiểm tra `esp32_status.estop === true`
- Mode không đúng (MODE_MANUAL_SAFE thay vì MODE_NAV)
- BTS7960 EN pin không HIGH
- PWM không output (LEDC channel lỗi)
- Motor bị disconnect (dây nguồn / dây tín hiệu lỏng)
- PID loop không chạy (timer bị stop)

**Kiểm tra trong serial monitor:**
```json
// Type 131 status
{"type":131,"data":{
  "uptime_ms":123456,
  "mode":"NAV",         ← Phải là NAV, không phải SAFE
  "e_stop":false,       ← Phải là false
  "motors":[
    {"id":0,"speed":100,"rpm":50,...}  ← rpm > 0 khi chạy
  ]
}}
```

---

## ✅ Checklist Chẩn Đoán Từng Bước

### Bước 1: Kiểm tra Web UI

- [ ] Mở DevTools → Console, nhấn W → thấy WebSocket message
- [ ] Kiểm tra `controlMode` = `'MANUAL'` (không phải AUTO)
- [ ] WebSocket kết nối thành công (`ws://robot-ip:9091`)

### Bước 2: Kiểm tra web_bridge.py

```bash
pm2 logs nexus-robot-web-bridge --lines 50
# Nhấn W trên web → phải thấy log "teleop command received"
```

- [ ] web_bridge chạy (PM2 status = online)
- [ ] WebSocket server listening trên port 9091
- [ ] `/cmd_vel` topic có message

```bash
ros2 topic echo /cmd_vel
# Nhấn W → phải thấy linear.x != 0
```

### Bước 3: Kiểm tra teleop_node.py

```bash
ros2 node list | grep teleop
# Phải thấy: /teleop
```

```bash
ros2 topic echo /esp32/cmd
# Nhấn W → phải thấy {"cmd":"move","vx":...}
```

- [ ] `teleop_node` đang chạy
- [ ] `self._connected = True` (MirrorBridge connected)
- [ ] Mode = MANUAL (kiểm tra `/control/mode` topic)

```bash
ros2 topic pub /control/mode std_msgs/String "data: 'MANUAL'"
```

### Bước 4: Kiểm tra esp32_telemetry_node.py

```bash
ros2 node list | grep esp32_telemetry
# Phải thấy: /esp32_telemetry
```

```bash
ros2 topic echo /esp32/cmd_status
# Nhấn W → phải thấy status: "accepted"
```

- [ ] `esp32_telemetry_node` đang chạy
- [ ] Serial port `/dev/robot-esp32` tồn tại
- [ ] Command không bị rejected

### Bước 5: Kiểm tra USB CDC / Serial

```bash
ls -l /dev/robot-esp32
# Phải là symlink → /dev/ttyACM0

ls -l /dev/ttyACM*
# Phải có ít nhất 1 device

groups $USER
# Phải có "dialout" trong danh sách
```

- [ ] `/dev/robot-esp32` hoặc `/dev/ttyACM0` tồn tại
- [ ] User trong group `dialout`
- [ ] Dây USB Type-C cắm chắc chắn

### Bước 6: Kiểm tra ESP32 Firmware

```bash
pio device monitor -p /dev/ttyACM0 -b 115200
# Nhấn W → phải thấy JSON line đến và ACK response
```

- [ ] Thấy JSON command đến firmware
- [ ] Thấy `{"type":128,...}` ACK hoặc `{"type":132,...}` move ACK
- [ ] KHÔNG thấy `{"type":129,...}` error
- [ ] `e_stop: false` trong status

### Bước 7: Kiểm tra Motor Hardware

```bash
# Trong serial monitor, thử gửi lệnh trực tiếp:
{"cmd":"move","vx":100,"vy":0,"omega":0}

# Hoặc ASCII command:
F 50
```

- [ ] Motor quay khi gửi lệnh trực tiếp
- [ ] BTS7960 EN pin = HIGH (đo bằng multimeter)
- [ ] PWM pin có tín hiệu (đo bằng oscilloscope hoặc LED test)
- [ ] Encoder count tăng khi motor quay

---

## 🛠️ Các Lệnh Chẩn Đoán Nhanh

### Test Toàn Bộ Pipeline

```bash
# Terminal 1: Monitor tất cả topics
ros2 topic echo /cmd_vel &
ros2 topic echo /esp32/cmd &
ros2 topic echo /esp32/cmd_status &
ros2 topic echo /esp32/status

# Terminal 2: Publish test command
ros2 topic pub /cmd_vel geometry_msgs/Twist \
  "{linear: {x: 0.5, y: 0.0, z: 0.0}, angular: {x: 0.0, y: 0.0, z: 0.0}}"

# Nếu xe chạy → vấn đề ở Web UI hoặc web_bridge
# Nếu xe KHÔNG chạy → vấn đề ở teleop_node hoặc ESP32
```

### Test Trực Tiếp ESP32

```bash
# Gửi JSON trực tiếp qua serial
echo '{"cmd":"move","vx":100,"vy":0,"omega":0}' > /dev/robot-esp32

# Hoặc dùng Python
python3 << EOF
import serial
ser = serial.Serial('/dev/robot-esp32', 115200, timeout=1)
ser.write(b'{"cmd":"move","vx":100,"vy":0,"omega":0}\n')
ser.flush()
print(ser.readline())  # Đọc ACK
ser.close()
EOF
```

### Check Control Mode

```bash
# Xem mode hiện tại
ros2 topic echo /control/mode_status --once

# Chuyển sang MANUAL
ros2 topic pub --once /control/mode std_msgs/String "data: 'MANUAL'"
```

---

## 🎯 Các Lỗi Thường Gặp Nhất

### Lỗi #1: Mode Không Đúng ⚠️ **QUAN TRỌNG NHẤT**

**Triệu chứng:** Bấm WASD không có gì xảy ra, không có log lỗi

**Nguyên nhân:**
```typescript
// Web UI cho phép bấm nút trong cả AUTO và MANUAL mode
// Nhưng teleop_node.py CHỈ forward khi mode = MANUAL!
```

**Giải pháp:**
```bash
# Kiểm tra mode
ros2 topic echo /control/mode_status --once

# Nếu là AUTO, chuyển về MANUAL
ros2 topic pub --once /control/mode std_msgs/String "data: 'MANUAL'"

# Hoặc click nút "MANUAL" trên Web UI
```

### Lỗi #2: ESP32 Telemetry Node Không Chạy

**Triệu chứng:** `/esp32/cmd` không có subscriber

**Giải pháp:**
```bash
pm2 restart nexus-robot-esp32-telemetry
pm2 logs nexus-robot-esp32-telemetry
```

### Lỗi #3: USB CDC Không Kết Nối

**Triệu chứng:** `/dev/robot-esp32` không tồn tại

**Giải pháp:**
```bash
# Cắm lại dây USB
# Kiểm tra kernel log
dmesg | tail -20

# Reload udev rules
sudo udevadm control --reload-rules
sudo udevadm trigger

# Thêm user vào dialout group
sudo usermod -a -G dialout $USER
# Logout/login lại
```

### Lỗi #4: E-Stop Đang Active

**Triệu chứng:** Motor không chạy, `esp32_status.estop = true`

**Giải pháp:**
```bash
# Clear E-stop qua ROS
ros2 topic pub --once /esp32/cmd std_msgs/String \
  'data: "{\"cmd\":\"e_stop_clear\"}"'

# Hoặc click nút "Clear E-Stop" trên Web UI
```

---

## 📝 Kết Luận & Khuyến Nghị

### Khả Năng Cao Nhất (90%)

**Vấn đề:** `controlMode` đang ở AUTO thay vì MANUAL

**Giải pháp:**
1. Click nút **"MANUAL"** trên Web UI (FloatingControlDock)
2. Hoặc: `ros2 topic pub --once /control/mode std_msgs/String "data: 'MANUAL'"`

### Khả Năng Trung Bình (60%)

**Vấn đề:** `esp32_telemetry_node` hoặc `teleop_node` không chạy

**Giải pháp:**
```bash
pm2 restart nexus-robot-esp32-telemetry
pm2 restart nexus-robot-teleop
pm2 logs --lines 100
```

### Khả Năng Thấp (30%)

**Vấn đề:** Phần cứng (USB cable, motor, BTS7960)

**Giải pháp:** Kiểm tra từng bước theo checklist ở trên

---

## 🚀 Script Tự Động Chẩn Đoán

```bash
#!/bin/bash
# diagnose_control.sh

echo "=== ROBOT CONTROL DIAGNOSTIC ==="
echo ""

echo "1. Kiểm tra ROS nodes..."
ros2 node list | grep -E "teleop|esp32_telemetry|web_bridge"

echo ""
echo "2. Kiểm tra control mode..."
timeout 1 ros2 topic echo /control/mode_status --once

echo ""
echo "3. Kiểm tra USB CDC device..."
ls -l /dev/robot-esp32 /dev/ttyACM* 2>/dev/null

echo ""
echo "4. Kiểm tra PM2 processes..."
pm2 list | grep -E "teleop|esp32|web-bridge"

echo ""
echo "5. Test publish /cmd_vel..."
ros2 topic pub --once /cmd_vel geometry_msgs/Twist \
  "{linear: {x: 0.1, y: 0.0, z: 0.0}, angular: {x: 0.0, y: 0.0, z: 0.0}}"
sleep 1

echo ""
echo "6. Kiểm tra /esp32/cmd..."
timeout 2 ros2 topic echo /esp32/cmd

echo ""
echo "=== END DIAGNOSTIC ==="
```

Lưu script này vào `services/robot/diagnose_control.sh` và chạy:
```bash
chmod +x services/robot/diagnose_control.sh
./services/robot/diagnose_control.sh
```

---

**Tác giả:** Claude Opus 4.8  
**Ngày tạo:** 2026-09-18  
**File liên quan:**
- [web_bridge.py](../services/robot/src/my_robot_controller/my_robot_controller/web_bridge.py)
- [teleop_node.py](../services/robot/src/my_robot_controller/my_robot_controller/teleop_node.py)
- [esp32_telemetry_node.py](../services/robot/src/my_robot_controller/my_robot_controller/esp32_telemetry_node.py)
- [esp32_bridge.py](../services/robot/src/my_robot_controller/my_robot_controller/esp32_bridge.py)
- [FloatingControlDock.tsx](../apps/web/src/components/FloatingControlDock.tsx)
