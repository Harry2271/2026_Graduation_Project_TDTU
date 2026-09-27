# Voice Control Quick Start — voice_control_node

Điều khiển robot bằng **giọng nói Tiếng Việt, hoàn toàn offline** trên Pi 5,
dùng `whisper.cpp` (không cần Internet, không gửi audio lên cloud).

## 1. Cài đặt (trên Pi)

```bash
cd services/robot
./install-voice-control.sh            # model 'small' (cân bằng tốt cho VI)
# hoặc nhẹ/nhanh hơn:
WHISPER_MODEL_SIZE=base ./install-voice-control.sh
```

Script sẽ: build whisper.cpp → cài `/usr/local/bin/whisper-cli` → tải model
`ggml-small.bin` → cài `alsa-utils` (cho `arecord`).

Kiểm tra micro:
```bash
arecord -l                            # liệt kê thiết bị thu
arecord -d 3 -f S16_LE -r 16000 test.wav && aplay test.wav   # thử ghi/phát
```

## 2. Chạy

```bash
# Qua PM2 (mặc định TẮT vì cần micro — bật bằng ENABLE_VOICE=1)
ENABLE_VOICE=1 WHISPER_MODEL=~/whisper.cpp/models/ggml-small.bin ./deploy.sh
pm2 logs nexus-robot-voice

# Chạy tay
ros2 run my_robot_controller voice_control_node --ros-args \
  -p model_path:=~/whisper.cpp/models/ggml-small.bin \
  -p language:=vi -p mic_device:=default
```

## 3. Bộ lệnh Tiếng Việt

Node so khớp **không phân biệt dấu**, nên nói tự nhiên là được:

| Nói | Ý định (intent) | Hành động |
|---|---|---|
| "tiến", "đi thẳng", "đi tới" | `forward` | Phát `/cmd_vel` tiến trong `motion_duration` s |
| "lùi", "lùi lại" | `backward` | Đi lùi |
| "rẽ trái", "quay trái", "sang trái" | `left` | Xoay trái |
| "rẽ phải", "quay phải", "sang phải" | `right` | Xoay phải |
| "dừng", "dừng lại", "đứng lại" | `stop` | Dừng ngay (Twist = 0) |
| "tăng tốc", "nhanh" | `speed_up` | Tăng hệ số tốc độ (+0.25, tối đa 2.0) |
| "giảm tốc", "chậm" | `slow_down` | Giảm hệ số tốc độ (−0.25, tối thiểu 0.25) |
| "về home", "về trạm", "về nhà" | `go_home` | Chỉ phát intent lên `/voice_commands` (để `brain_node` xử lý — chưa nối) |

## 4. Tham số

| Param | Mặc định | Ý nghĩa |
|---|---|---|
| `whisper_bin` | `whisper-cli` | Tên binary whisper.cpp (tự fallback `main`) |
| `model_path` | `~/whisper.cpp/models/ggml-small.bin` | Model ggml |
| `language` | `vi` | Ngôn ngữ nhận dạng |
| `mic_device` | `default` | Giá trị `arecord -D` (vd `plughw:1,0`) |
| `record_seconds` | `3.0` | Độ dài mỗi lần thu |
| `sample_rate` | `16000` | Bắt buộc 16 kHz cho whisper |
| `publish_cmd_vel` | `true` | Cho phép lái trực tiếp qua `/cmd_vel` |
| `linear_speed` | `0.25` | m/s cho tiến/lùi |
| `angular_speed` | `0.8` | rad/s cho xoay |
| `motion_duration` | `1.5` | Số giây giữ mỗi lệnh chuyển động |

## 5. An toàn & lưu ý

- Lệnh chuyển động **tự dừng** sau `motion_duration` giây (node phát Twist 0),
  và `teleop_node` cũng tự dừng nếu không nhận `/cmd_vel` trong 1 s → không có
  runaway.
- `/cmd_vel` chỉ có tác dụng khi robot ở chế độ **MANUAL** (theo arbitration của
  `teleop_node`); ở AUTO, Nav2 giữ quyền điều khiển.
- Nói ngắn gọn, rõ; tránh ồn nền. Dùng model lớn hơn (`medium`) nếu cần chính
  xác hơn và Pi còn dư CPU.

## 6. Theo dõi

```bash
ros2 topic echo /voice_commands
# {"stamp":..., "text":"đi thẳng", "intent":"forward", "speed_scale":1.0}
```

## 7. Xử lý sự cố

| Triệu chứng | Cách xử lý |
|---|---|
| Log "arecord not found" | `sudo apt-get install -y alsa-utils` |
| Log "whisper binary not found" | Chạy lại `./install-voice-control.sh` |
| Log "model ... missing" | Kiểm tra `model_path`, tải lại model |
| Nhận sai từ | Đổi `mic_device` đúng thiết bị (`arecord -l`), giảm ồn, dùng model lớn hơn |
| Phản hồi chậm | Dùng model `base`, hoặc giảm `record_seconds` |
