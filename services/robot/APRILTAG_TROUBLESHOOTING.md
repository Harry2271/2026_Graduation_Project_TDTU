# AprilTag Troubleshooting Guide — Raspberry Pi 5

> **Vấn đề:** Raspberry Pi 5 không quét được mã AprilTag nào.
> **Hệ thống:** ROS 2 Jazzy + dt-apriltags + OpenCV + ffmpeg camera stream

---

## Kiến trúc hệ thống AprilTag

```
[Logitech BRIO 100] → /dev/video0
          ↓
[camera_stream.py] → ffmpeg MJPEG → HTTP :9092
          ↓
    GET /snapshot
          ↓
[april_tag_node.py] → dt-apriltags detector → /detected_tags
```

**Luồng dữ liệu:**
1. Camera phát hình qua ffmpeg (MJPEG native)
2. `camera_stream.py` mở HTTP server trên port 9092
3. `april_tag_node.py` lấy snapshot từ `http://127.0.0.1:9092/snapshot` mỗi 100ms (10 Hz)
4. Detector xử lý grayscale → tìm AprilTag → publish `/detected_tags`

---

## Checklist kiểm tra (thực hiện theo thứ tự)

### ✅ BƯỚC 1: Kiểm tra Camera Hardware

```bash
# 1.1. Kiểm tra camera có được nhận diện không
ls -la /dev/video*
```

**Kết quả mong đợi:**
```
crw-rw---- 1 root video 81, 0 Dec 15 10:30 /dev/video0
crw-rw---- 1 root video 81, 1 Dec 15 10:30 /dev/video1
```

**❌ Nếu không thấy /dev/video0:**
- Camera chưa cắm USB
- Camera bị hỏng
- Driver không load (chạy `dmesg | tail -50` xem log)

```bash
# 1.2. Kiểm tra camera có thể capture không (test 5 giây)
ffmpeg -f v4l2 -i /dev/video0 -frames 1 test_frame.jpg
```

**Kết quả mong đợi:** Tạo file `test_frame.jpg` thành công

**❌ Nếu lỗi:**
- `Device or resource busy` → Camera đang bị process khác chiếm dụng
- `Cannot open video device` → Permission issue hoặc camera không hỗ trợ V4L2

```bash
# 1.3. Kiểm tra process nào đang dùng camera
sudo lsof /dev/video0
```

---

### ✅ BƯỚC 2: Kiểm tra PM2 Services

```bash
# 2.1. Kiểm tra status của camera và vision nodes
pm2 list | grep -E "camera|vision"
```

**Kết quả mong đợi:**
```
nexus-robot-camera     online    1m    0    /dev/video0
nexus-robot-vision     online    1m    0    april_tag_node
```

**❌ Nếu status = `errored` hoặc `stopped`:**

```bash
# 2.2. Xem logs chi tiết
pm2 logs nexus-robot-camera --lines 50 --nostream
pm2 logs nexus-robot-vision --lines 50 --nostream
```

**Lỗi thường gặp trong camera logs:**
- `ffmpeg: Cannot open video device` → Camera không tồn tại hoặc bị chiếm
- `Permission denied` → Chạy `sudo chmod 666 /dev/video0`
- `Input/output error` → Camera bị lỗi hardware

**Lỗi thường gặp trong vision logs:**
- `No module named 'dt_apriltags'` → Thư viện chưa cài
- `Camera snapshot unavailable` → Camera stream node chưa chạy hoặc port sai
- `cannot import name 'Detector'` → Cài nhầm version

```bash
# 2.3. Restart cả 2 nodes (thứ tự quan trọng: camera trước, vision sau)
pm2 restart nexus-robot-camera
sleep 3
pm2 restart nexus-robot-vision
```

---

### ✅ BƯỚC 3: Kiểm tra Camera HTTP Stream

```bash
# 3.1. Health check
curl http://127.0.0.1:9092/ | python3 -m json.tool
```

**Kết quả mong đợi:**
```json
{
  "status": "ok",
  "camera": true,
  "device": "/dev/video0",
  "resolution": "1280x720",
  "fps": 30,
  "has_frame": true,
  "frame_size": 25340
}
```

**❌ Nếu:**
- `Connection refused` → Camera stream node chưa chạy
- `"camera": false` → ffmpeg không capture được từ /dev/video0
- `"has_frame": false` → Camera không phát frame
- `"frame_size": 0` → Camera capture nhưng không có dữ liệu

```bash
# 3.2. Lấy 1 snapshot để test
curl -o snapshot_test.jpg http://127.0.0.1:9092/snapshot
```

**Kiểm tra file:**
```bash
file snapshot_test.jpg
# Mong đợi: JPEG image data, JFIF standard...

# Xem kích thước
ls -lh snapshot_test.jpg
# Mong đợi: >10KB (nếu <5KB → có vấn đề)
```

**❌ Nếu lỗi:**
- HTTP 503 `No frame available` → Camera stream đang khởi động hoặc bị lỗi
- File không phải JPEG → ffmpeg encoding bị lỗi

---

### ✅ BƯỚC 4: Kiểm tra AprilTag Dependencies

```bash
# 4.1. Kiểm tra dt-apriltags
python3 -c "from dt_apriltags import Detector; print('dt-apriltags OK')"

# 4.2. Kiểm tra OpenCV
python3 -c "import cv2; print(f'OpenCV {cv2.__version__}')"

# 4.3. Kiểm tra NumPy
python3 -c "import numpy; print(f'NumPy {numpy.__version__}')"
```

**❌ Nếu lỗi `ModuleNotFoundError`:**

```bash
# Cài đặt lại dependencies
sudo apt-get update
sudo apt-get install -y ffmpeg libopencv-dev python3-opencv python3-pip
python3 -m pip install --break-system-packages numpy opencv-python-headless dt-apriltags
```

**⚠️ LƯU Ý QUAN TRỌNG:**
- **PHẢI dùng `dt-apriltags`** (KHÔNG phải `pupil-apriltags`)
- `pupil-apriltags` không build được trên Pi 5 Python 3.12
- Nếu đã cài `pupil-apriltags`, gỡ đi: `pip uninstall pupil-apriltags`

```bash
# 4.4. Test detector có hoạt động không
python3 <<'PY'
from dt_apriltags import Detector
import cv2
import numpy as np

# Tạo detector
detector = Detector(families="tag36h11", nthreads=2)
print("✅ Detector created successfully")

# Test với ảnh trống (không có tag)
blank = np.zeros((480, 640), dtype=np.uint8)
detections = detector.detect(blank, estimate_tag_pose=False)
print(f"✅ Detection on blank image: {len(detections)} tags (expected: 0)")
PY
```

---

### ✅ BƯỚC 5: Kiểm tra ROS 2 Topics

```bash
# 5.1. Kiểm tra topic /detected_tags có tồn tại không
ros2 topic list | grep detected
```

**Mong đợi:** `/detected_tags`

```bash
# 5.2. Lắng nghe topic (để chạy 30 giây)
timeout 30 ros2 topic echo /detected_tags
```

**❌ Nếu không có message nào:**
- AprilTag node đang chạy nhưng không detect được tag
- Kiểm tra logs: `pm2 logs nexus-robot-vision --lines 100`

**❌ Nếu thấy message:**
```
data: '{"ts": 1234567890.123, "tags": []}'
```
→ Node chạy OK nhưng không có tag nào trong camera

---

### ✅ BƯỚC 6: Test AprilTag Detection Thủ Công

**6.1. Tạo AprilTag test image:**

Truy cập: https://chev.me/arucogen/

Hoặc dùng Python:
```python
# Tạo file tag_test.py
import cv2
import numpy as np
from dt_apriltags import Detector

# Load ảnh snapshot từ camera
img = cv2.imread('snapshot_test.jpg', cv2.IMREAD_GRAYSCALE)
if img is None:
    print("❌ Cannot read snapshot_test.jpg")
    exit(1)

print(f"✅ Image loaded: {img.shape}")

# Tạo detector
detector = Detector(
    families="tag36h11",
    nthreads=2,
    quad_decimate=2.0,
    quad_sigma=0.0,
    refine_edges=True,
    decode_sharpening=0.25
)

# Detect
detections = detector.detect(img, estimate_tag_pose=False)
print(f"✅ Detected {len(detections)} tags")

for det in detections:
    print(f"  Tag ID: {det.tag_id}, margin: {det.decision_margin:.2f}, hamming: {det.hamming}")
```

**Chạy test:**
```bash
python3 tag_test.py
```

**Kết quả mong đợi (nếu có AprilTag trong ảnh):**
```
✅ Image loaded: (720, 1280)
✅ Detected 1 tags
  Tag ID: 42, margin: 45.23, hamming: 0
```

**❌ Nếu `Detected 0 tags`:**
- **Không có AprilTag nào trong tầm nhìn camera** (nguyên nhân #1)
- AprilTag quá nhỏ (cần >50 pixels cạnh)
- AprilTag bị mờ / blur
- Ánh sáng quá tối hoặc quá chói
- AprilTag family không đúng (đang dùng `tag36h11`)

---

### ✅ BƯỚC 7: Kiểm tra AprilTag Physical Setup

**7.1. In AprilTag chuẩn:**
- Family: **tag36h11** (mặc định)
- Kích thước: **tối thiểu 16.6cm × 16.6cm** (default `APRILTAG_SIZE_M=0.166`)
- In trên giấy trắng, mực đen đậm
- Không bị nhăn, gấp, hoặc bóng

**Download AprilTag:**
```bash
# Tag ID 0-586 cho tag36h11
wget https://github.com/AprilRobotics/apriltag-imgs/raw/master/tag36h11/tag36_11_00000.png
```

**7.2. Vị trí camera:**
- Khoảng cách: **0.5m - 3m**
- Góc nhìn: **vuông góc với tag** (không quá nghiêng)
- Ánh sáng: **đều, không chói, không tối**

**7.3. Test với tag khác nhau:**
- Thử nhiều tag ID khác nhau (0, 1, 2, ...)
- Có thể tag bạn đang dùng bị damaged

---

## Diagnostic Script (Chạy tất cả kiểm tra cùng lúc)

```bash
#!/bin/bash
# File: check_apriltag.sh

echo "=== APRILTAG DIAGNOSTIC SCRIPT ==="
echo ""

echo "1️⃣  Checking camera device..."
if [ -c /dev/video0 ]; then
    echo "✅ /dev/video0 exists"
    ls -la /dev/video0
else
    echo "❌ /dev/video0 NOT FOUND"
    echo "   Available devices:"
    ls -la /dev/video* 2>/dev/null || echo "   No video devices found"
fi
echo ""

echo "2️⃣  Checking PM2 services..."
pm2 list | grep -E "camera|vision" || echo "❌ No camera/vision services running"
echo ""

echo "3️⃣  Checking camera HTTP stream..."
curl -s http://127.0.0.1:9092/ | python3 -m json.tool 2>/dev/null || echo "❌ Camera stream not responding"
echo ""

echo "4️⃣  Checking Python dependencies..."
python3 -c "from dt_apriltags import Detector; print('✅ dt-apriltags OK')" 2>/dev/null || echo "❌ dt-apriltags NOT installed"
python3 -c "import cv2; print(f'✅ OpenCV {cv2.__version__}')" 2>/dev/null || echo "❌ OpenCV NOT installed"
python3 -c "import numpy; print(f'✅ NumPy {numpy.__version__}')" 2>/dev/null || echo "❌ NumPy NOT installed"
echo ""

echo "5️⃣  Checking ROS 2 topics..."
ros2 topic list | grep detected_tags && echo "✅ /detected_tags topic exists" || echo "❌ /detected_tags topic NOT found"
echo ""

echo "6️⃣  Testing snapshot capture..."
curl -s -o /tmp/test_snapshot.jpg http://127.0.0.1:9092/snapshot
if [ -f /tmp/test_snapshot.jpg ]; then
    SIZE=$(stat -c%s /tmp/test_snapshot.jpg)
    if [ $SIZE -gt 5000 ]; then
        echo "✅ Snapshot captured: ${SIZE} bytes"
    else
        echo "⚠️  Snapshot too small: ${SIZE} bytes (possible error)"
    fi
else
    echo "❌ Failed to capture snapshot"
fi
echo ""

echo "7️⃣  Listening to /detected_tags for 10 seconds..."
timeout 10 ros2 topic echo /detected_tags --once || echo "⚠️  No messages received in 10s"
echo ""

echo "=== DIAGNOSTIC COMPLETE ==="
```

**Chạy script:**
```bash
chmod +x check_apriltag.sh
./check_apriltag.sh
```

---

## Common Issues & Solutions

| Triệu chứng | Nguyên nhân | Giải pháp |
|---|---|---|
| `Connection refused :9092` | Camera stream node chưa chạy | `pm2 restart nexus-robot-camera` |
| `No module named 'dt_apriltags'` | Thư viện chưa cài | `pip install --break-system-packages dt-apriltags` |
| `Device or resource busy` | Camera bị process khác chiếm | `sudo lsof /dev/video0` → kill process |
| `"has_frame": false` | ffmpeg không capture được | Check `pm2 logs nexus-robot-camera` |
| `/detected_tags` không có data | Không có tag trong camera | In AprilTag theo hướng dẫn BƯỚC 7 |
| `Detected 0 tags` trong manual test | Tag quá nhỏ / mờ / sai family | Dùng tag36h11, kích thước >16cm |
| `Camera snapshot unavailable` | URL sai hoặc port bị đổi | Check `CAMERA_SNAPSHOT_URL` env var |
| `Input/output error` khi ffmpeg chạy | Camera hardware lỗi | Thử camera khác hoặc reboot Pi |

---

## Environment Variables Reference

| Variable | Default | Description |
|---|---|---|
| `CAMERA_DEVICE` | `/dev/video0` | V4L2 camera path |
| `CAMERA_WIDTH` | `1280` | Capture width |
| `CAMERA_HEIGHT` | `720` | Capture height |
| `CAMERA_FPS` | `30` | Target FPS |
| `CAMERA_QUALITY` | `2` | JPEG quality (1-31, lower = better) |
| `CAMERA_PORT` | `9092` | HTTP server port |
| `APRILTAG_FAMILY` | `tag36h11` | Tag family name |
| `APRILTAG_SIZE_M` | `0.166` | Tag physical size (meters) |
| `APRILTAG_HZ` | `10` | Detection rate |
| `APRILTAG_MAX_HAMMING` | `1` | Max bit errors allowed |
| `APRILTAG_DEBUG` | `0` | Enable debug logging (`1`) |
| `CAMERA_SNAPSHOT_URL` | `http://127.0.0.1:9092/snapshot` | Snapshot endpoint |
| `CAMERA_MATRIX` | (pinhole default) | 9-tuple: `fx,0,cx,0,fy,cy,0,0,1` |
| `DIST_COEFFS` | `0,0,0,0,0` | 5-tuple: `k1,k2,p1,p2,k3` |

---

## Quick Fix Commands

```bash
# Fix 1: Restart camera + vision nodes
pm2 restart nexus-robot-camera && sleep 3 && pm2 restart nexus-robot-vision

# Fix 2: Reinstall dependencies
sudo apt-get install -y ffmpeg libopencv-dev python3-opencv python3-pip
python3 -m pip install --break-system-packages --force-reinstall dt-apriltags numpy opencv-python-headless

# Fix 3: Fix camera permissions
sudo chmod 666 /dev/video0

# Fix 4: Kill stray processes using camera
sudo lsof /dev/video0 | awk 'NR>1 {print $2}' | xargs -r sudo kill -9

# Fix 5: Full restart (nuclear option)
cd ~/robot-for-nguyen/services/robot && ./start.sh
```

---

## Next Steps After Detection Works

Sau khi AprilTag detection hoạt động (có message trong `/detected_tags`):

1. **Calibrate camera intrinsics** để có pose estimation chính xác:
   ```bash
   # Dùng ROS 2 camera_calibration package
   ros2 run camera_calibration cameracalibrator --size 8x6 --square 0.025
   ```

2. **Integrate với brain_node** để sử dụng trong autonomous navigation

3. **Test pose estimation accuracy** bằng cách đo khoảng cách thực tế so với output `(x, y, z)`

---

**Last Updated:** 2026-09-15  
**Tested On:** Raspberry Pi 5 + Ubuntu 24.04 + ROS 2 Jazzy + Logitech BRIO 100
