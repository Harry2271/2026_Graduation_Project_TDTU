# YOLOv8n Quick Start — vision_node

Nhận diện vật thể thời gian thực trên Pi 5, đọc snapshot camera có sẵn
(`http://127.0.0.1:9092/snapshot`) và phát kết quả JSON lên `/detected_objects`.

## 1. Cài đặt (trên Pi)

```bash
cd services/robot
./install-ai-deps.sh
```

Script cài `ultralytics` (YOLOv8 + torch CPU), `opencv-python-headless`, `numpy`
và tải sẵn `yolov8n.pt` vào `~/robot_ws/models/`.

## 2. Chạy

Qua PM2 (khuyến nghị — deploy.sh đã cấu hình sẵn):

```bash
cd services/robot
ENABLE_YOLO=1 YOLO_MODEL=~/robot_ws/models/yolov8n.pt ./deploy.sh
pm2 logs nexus-robot-yolo
```

Chạy tay để thử:

```bash
ros2 run my_robot_controller vision_node --ros-args \
  -p camera_snapshot_url:=http://127.0.0.1:9092/snapshot \
  -p inference_hz:=5.0 \
  -p confidence_threshold:=0.5 \
  -p model_path:=~/robot_ws/models/yolov8n.pt
```

## 3. Kiểm tra

```bash
ros2 topic echo /detected_objects
```

Ví dụ payload:

```json
{"stamp":1727452800.12,"count":1,"frame":[640,480],
 "objects":[{"label":"person","cls":0,"conf":0.91,
             "box":[210.5,120.0,410.2,470.9],"cx":310.4,"cy":295.5}],
 "model":"yolov8n.pt","infer_ms":92.3}
```

## 4. Tham số (ROS params)

| Param | Mặc định | Ý nghĩa |
|---|---|---|
| `camera_snapshot_url` | `http://127.0.0.1:9092/snapshot` | Nguồn ảnh (dùng chung với AprilTag) |
| `model_path` | `yolov8n.pt` | Đường dẫn weights (`.pt`, `.onnx`, `.ncnn`) |
| `inference_hz` | `5.0` | Tần số suy luận |
| `confidence_threshold` | `0.5` | Ngưỡng tin cậy |
| `device` | `cpu` | `cpu` hoặc `0` (CUDA — không áp dụng cho Pi) |
| `classes` | `[]` | Lọc theo class id COCO (rỗng = tất cả) |

Chỉ quan tâm người + một vài lớp? Lọc bằng class id COCO (person=0):

```bash
ros2 run my_robot_controller vision_node --ros-args -p classes:="[0]"
```

## 5. Tối ưu hiệu năng Pi 5

- Giảm `inference_hz` xuống 2–3 nếu CPU căng khi chạy cùng SLAM/Nav2.
- Export sang **NCNN** (nhanh nhất trên ARM CPU):
  ```bash
  yolo export model=yolov8n.pt format=ncnn
  # → yolov8n_ncnn_model/ ; trỏ model_path vào thư mục này
  ```
- Hoặc **ONNX**: `yolo export model=yolov8n.pt format=onnx` rồi `model_path=yolov8n.onnx`.

## 6. Xử lý sự cố

| Triệu chứng | Nguyên nhân / cách xử lý |
|---|---|
| Log "Vision deps unavailable" | Chưa chạy `install-ai-deps.sh` |
| Log "Snapshot fetch failed" | `nexus-robot-camera` chưa chạy → `pm2 restart nexus-robot-camera` |
| `/detected_objects` không có dữ liệu | Kiểm tra `pm2 logs nexus-robot-yolo`; thử giảm `confidence_threshold` |
| Suy luận chậm/giật | Giảm `inference_hz` hoặc export NCNN/ONNX |

Muốn nhận diện đúng vật thể trong kho (pallet, kệ, thùng hàng)? Xem
[YOLOV8_CUSTOM_TRAINING.md](YOLOV8_CUSTOM_TRAINING.md).
