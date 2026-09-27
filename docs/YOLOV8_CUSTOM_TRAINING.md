# Train YOLOv8n cho kho hàng — Custom Training Guide

Mục tiêu: dạy YOLOv8n nhận diện **đúng vật thể trong kho của bạn** (pallet, kệ,
thùng hàng, người, xe nâng, mã QR/AprilTag...) thay vì chỉ 80 lớp COCO mặc định.
Kết quả là model chính xác hơn nhiều cho môi trường thực tế.

> ⚠️ **Train ở đâu?** KHÔNG train trên Pi 5 (quá chậm). Train trên PC có GPU
> hoặc **Google Colab (GPU miễn phí)**, rồi export và copy model về Pi để chạy
> suy luận.

## Toàn cảnh pipeline

```
[1] Thu thập ảnh  →  [2] Gán nhãn  →  [3] Tạo dataset.yaml  →
[4] Train (Colab/PC-GPU)  →  [5] Đánh giá (mAP)  →
[6] Export cho Pi (NCNN/ONNX)  →  [7] Deploy  →  (lặp lại để "thông minh hơn")
```

Càng lặp `[7] → [1]` với ảnh robot chụp sai/khó, model càng "thông minh ra".

## Bước 1 — Thu thập ảnh từ chính camera robot

Ảnh train nên đến từ **đúng camera + đúng góc nhìn** robot sẽ gặp khi chạy.
Dùng công cụ có sẵn:

```bash
# Trên Pi (khi camera_stream đang chạy)
python3 services/robot/tools/auto_capture_training_data.py \
  --out ~/dataset/raw --interval 1 --min-diff 8
```

- `--min-diff 8`: chỉ lưu khi khung hình thay đổi đáng kể → tránh ảnh trùng.
- Mục tiêu: **200–500 ảnh/lớp**, đa dạng ánh sáng, góc, khoảng cách, che khuất.
- Cho robot chạy quanh kho ở nhiều thời điểm để lấy đủ điều kiện thực tế.

Copy `~/dataset/raw` về máy train (scp/USB).

## Bước 2 — Gán nhãn (labeling)

Chọn 1 trong 2 hướng:

**A. Roboflow (dễ nhất, khuyến nghị)** — https://roboflow.com
1. Tạo project "Object Detection", upload ảnh.
2. Vẽ bounding box + đặt tên lớp (vd: `pallet`, `shelf`, `box`, `person`, `forklift`).
3. Generate version: bật auto-augmentation, split train/val/test (vd 70/20/10).
4. Export định dạng **YOLOv8** → nhận sẵn `data.yaml` + thư mục ảnh/nhãn.

**B. LabelImg / labelme (offline, miễn phí)**
```bash
pip install labelImg && labelImg
# Chọn format "YOLO"; mỗi ảnh sinh 1 file .txt: <class> <cx> <cy> <w> <h> (đã chuẩn hóa 0..1)
```

Cấu trúc thư mục chuẩn YOLO:
```
dataset/
  images/{train,val}/*.jpg
  labels/{train,val}/*.txt
  data.yaml
```

## Bước 3 — data.yaml

```yaml
path: /content/dataset      # gốc dataset
train: images/train
val: images/val
names:
  0: pallet
  1: shelf
  2: box
  3: person
  4: forklift
```

## Bước 4 — Train (Google Colab GPU miễn phí)

Colab → Runtime → Change runtime type → **GPU (T4)**.

```python
!pip install ultralytics
from ultralytics import YOLO

# transfer learning từ checkpoint nano (nhanh, ít dữ liệu vẫn tốt)
model = YOLO("yolov8n.pt")
model.train(
    data="/content/dataset/data.yaml",
    epochs=100,
    imgsz=640,
    batch=16,
    patience=20,          # early stop nếu 20 epoch không cải thiện
    augment=True,         # mosaic/flip/hsv... tăng đa dạng
    project="warehouse", name="yolov8n_v1",
)
```

Kết quả: `warehouse/yolov8n_v1/weights/best.pt`.

## Bước 5 — Đánh giá

```python
metrics = model.val()
print(metrics.box.map)      # mAP@0.5:0.95 — càng cao càng tốt
print(metrics.box.map50)    # mAP@0.5
```

Xem `warehouse/yolov8n_v1/`: `confusion_matrix.png`, `results.png`, ảnh dự đoán.
- **mAP thấp / hay nhầm lớp** → cần thêm ảnh cho lớp đó, hoặc nhãn chưa nhất quán.
- **Tốt trên val nhưng kém thực tế** → ảnh train chưa giống điều kiện chạy thật
  (ánh sáng, góc) → quay lại Bước 1 lấy thêm.

## Bước 6 — Export cho Pi 5 (ARM CPU)

`best.pt` chạy được ngay, nhưng để nhanh hơn trên CPU ARM, export:

```python
model = YOLO("warehouse/yolov8n_v1/weights/best.pt")
model.export(format="ncnn")   # nhanh nhất trên Pi CPU → thư mục best_ncnn_model/
# hoặc: model.export(format="onnx")
```

## Bước 7 — Deploy về Pi

```bash
# Copy model về Pi
scp -r best_ncnn_model pi@robot:~/robot_ws/models/warehouse_ncnn

# Trỏ vision_node vào model mới
ros2 run my_robot_controller vision_node --ros-args \
  -p model_path:=~/robot_ws/models/warehouse_ncnn
# hoặc qua PM2:
ENABLE_YOLO=1 YOLO_MODEL=~/robot_ws/models/warehouse_ncnn ./deploy.sh
```

## Làm cho AI "thông minh hơn" theo thời gian (active learning)

Đây là vòng lặp quan trọng nhất:

1. Cho robot chạy với model hiện tại.
2. Lưu lại các khung hình model **đoán sai / tin cậy thấp** (dùng
   `auto_capture_training_data.py` khi vận hành).
3. Gán nhãn đúng cho đúng những ca khó đó.
4. Gộp vào dataset, train lại (`yolov8n_v2`).
5. So sánh mAP, deploy nếu tốt hơn. Lặp lại.

Mẹo tăng độ chính xác:
- **Cân bằng lớp**: mỗi lớp nên có số ảnh tương đương; lớp hiếm cần bổ sung.
- **Đa dạng bối cảnh**: nhiều nền, ánh sáng, vật che khuất một phần.
- **Nhãn nhất quán**: cùng quy ước bounding box cho mọi ảnh.
- **Dùng `yolov8s` nếu cần chính xác hơn** và Pi còn dư CPU (chậm hơn nano).
- **Freeze layers** khi ít dữ liệu: `model.train(..., freeze=10)` để giữ backbone.

## Tham khảo
- Ultralytics docs: https://docs.ultralytics.com
- Roboflow: https://roboflow.com
- Định dạng nhãn YOLO: `<class_id> <x_center> <y_center> <width> <height>` (chuẩn hóa 0–1).


