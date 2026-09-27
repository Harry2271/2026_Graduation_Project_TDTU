# AI Enhancements Roadmap — Robot for Nguyen

Tài liệu này mô tả các tính năng AI/thông minh đã được thêm vào `services/robot`
để chạy **offline trên Raspberry Pi 5** (không cần cloud). Tất cả đều *degrade
gracefully*: nếu thiếu thư viện, node chỉ log 1 cảnh báo rồi idle — robot vẫn
chạy bình thường (SLAM, Nav2, teleop không bị ảnh hưởng).

## Tổng quan 3 tính năng

| Tính năng | Node ROS 2 | Topic ra | Deps | Bật/tắt |
|---|---|---|---|---|
| Nhận diện vật thể YOLOv8n | `vision_node` | `/detected_objects` | ultralytics, opencv | `ENABLE_YOLO` (mặc định 1) |
| Giám sát sức khỏe động cơ | `motor_health_node` | `/motor_health_alerts` | (rule-based: không cần) + TFLite optional | `ENABLE_MOTOR_HEALTH` (mặc định 1) |
| Điều khiển bằng giọng nói (Tiếng Việt) | `voice_control_node` | `/voice_commands`, `/cmd_vel` | whisper.cpp, alsa-utils | `ENABLE_VOICE` (mặc định 0) |

## Kiến trúc tích hợp

```
camera_stream (MJPEG :9092) ──/snapshot──▶ vision_node ──▶ /detected_objects
                            └────────────▶ april_tag_node (đã có)

esp32_telemetry_node ──/esp32/encoder──▶ motor_health_node ──▶ /motor_health_alerts
                     └─/esp32/power────▶

micro (arecord) ──▶ whisper.cpp ──▶ voice_control_node ──▶ /voice_commands
                                                        └─▶ /cmd_vel ──▶ teleop_node ──▶ ESP32
```

- `vision_node` đọc **cùng một snapshot** với `april_tag_node`, nên không tranh
  chấp `/dev/video0`.
- `motor_health_node` chỉ *nghe* telemetry, không gửi lệnh — an toàn tuyệt đối.
- `voice_control_node` phát `/cmd_vel` (giống Nav2/teleop) nên đi qua đúng
  đường arbitration MANUAL/AUTO của `teleop_node`; mỗi lệnh chỉ chạy trong
  `motion_duration` giây rồi tự dừng.

## Cài đặt (chạy trên Pi, mỗi cái độc lập)

```bash
cd services/robot
./install-ai-deps.sh        # YOLOv8n
./install-motor-health.sh   # TFLite runtime cho autoencoder (tùy chọn)
./install-voice-control.sh  # whisper.cpp + model + alsa-utils
```

Sau đó redeploy để PM2 khởi động các node:

```bash
cd services/robot && ./deploy.sh          # hoặc ./start.sh khi chạy tay
```

## Kiểm tra nhanh

```bash
./scripts/health-check.sh                 # báo cáo tổng thể

ros2 topic echo /detected_objects         # YOLO
ros2 topic echo /motor_health_alerts      # cảnh báo động cơ
ros2 topic echo /voice_commands           # lệnh giọng nói
```

## Trạng thái & bước tiếp theo

- [x] `vision_node` (YOLOv8n) + install script + hướng dẫn train
- [x] `motor_health_node` (rule-based + TFLite autoencoder) + hướng dẫn thu thập/train
- [x] `voice_control_node` (whisper.cpp Tiếng Việt)
- [x] Wire-up: `setup.py` entry points, `deploy.sh` PM2 services, `scripts/health-check.sh`
- [ ] (Tương lai) Cho `brain_node` tiêu thụ `/detected_objects` để tránh vật cản
      theo ngữ nghĩa và `/voice_commands` (`go_home`) để nhận job bằng giọng nói.
- [ ] (Tương lai) Train YOLO tập dữ liệu warehouse riêng (pallet, kệ, người).
- [ ] (Tương lai) Thu thập baseline động cơ khỏe → train autoencoder → deploy `.tflite`.

## Hiệu năng trên Pi 5 (ước lượng)

- YOLOv8n CPU @ 640px: ~80–150 ms/frame → chạy 5 Hz thoải mái, để dành CPU cho SLAM/Nav2.
- Muốn nhẹ hơn: giảm `inference_hz`, hoặc export YOLO sang NCNN/ONNX (xem hướng dẫn train).
- whisper.cpp `small` @ 3 s audio: ~2–4 s xử lý trên Pi 5 CPU; dùng `base` nếu cần nhanh hơn.

Xem chi tiết: [YOLOV8_QUICK_START.md](YOLOV8_QUICK_START.md),
[YOLOV8_CUSTOM_TRAINING.md](YOLOV8_CUSTOM_TRAINING.md),
[MOTOR_HEALTH_TRAINING.md](MOTOR_HEALTH_TRAINING.md),
[VOICE_CONTROL_QUICK_START.md](VOICE_CONTROL_QUICK_START.md).
