# Báo cáo khắc phục LiDAR - phạm vi source ROS

**Hệ thống:** AIoT Autonomous Logistics Robot  
**Phạm vi thực hiện:** Chỉ `services/robot/src/`  
**Trạng thái:** Đã cập nhật mã nguồn ROS; cần kiểm chứng cuối cùng trên Raspberry Pi với LiDAR thật.

---

## 1. Yêu cầu phạm vi

Đợt sửa này chỉ xử lý chuỗi dữ liệu LiDAR trong mã nguồn ROS của robot.

Các khu vực **không bị sửa đổi**:

- Web frontend
- API backend
- Mobile app
- Docker / Docker Compose
- GitHub Actions workflow
- Script deploy, start, install hoặc udev
- Cấu hình triển khai

Các file thay đổi đều nằm trong `services/robot/src/`.

---

## 2. Nguyên nhân kỹ thuật chính

LiDAR RPLIDAR A1M8 xuất scan với frame `laser`. SLAM, AMCL và Nav2 cần transform được từ frame `laser` đến frame robot `base_footprint`.

Chuỗi transform cần có là:

```text
map -> odom -> base_footprint -> base_link -> laser
```

Trước khi sửa, odometry đã publish:

```text
odom -> base_footprint
```

URDF đã có:

```text
base_link -> laser
```

Nhưng thiếu liên kết:

```text
base_footprint -> base_link
```

Do đó cây TF bị đứt. `slam_toolbox`, AMCL và costmap không thể quy đổi dữ liệu `/scan` từ `laser` về `base_footprint`, dẫn đến map/định vị có thể không hoạt động dù LiDAR vẫn chạy tốt khi cắm vào PC.

Ngoài ra, obstacle overlay trong ROS bị cố định ở kích thước `800 x 800`. Kích thước map từ `slam_toolbox` là động, nên khi geometry map thay đổi có thể gây lỗi index hoặc map layer không khớp dữ liệu LiDAR.

---

## 3. Thay đổi đã thực hiện

### 3.1. Hoàn chỉnh TF cho LiDAR

**File:** `my_robot_controller/urdf/agv.urdf.xacro`

Đã bổ sung:

```xml
<link name="base_footprint"/>
<joint name="base_footprint_to_base_link" type="fixed">
  <parent link="base_footprint"/>
  <child link="base_link"/>
  <origin xyz="0 0 0" rpy="0 0 0"/>
</joint>
```

Giữ nguyên vị trí gắn LiDAR đã có:

```text
base_link -> laser
xyz: 0.05 0 0.18
rpy: 0 0 0
```

Kết quả: scan frame `laser` đã có đường TF đầy đủ đến `base_footprint`.

### 3.2. Khai báo dependency ROS đúng với launch pipeline

**File:** `my_robot_controller/package.xml`

Bổ sung dependency runtime/launch liên quan trực tiếp đến LiDAR và SLAM:

- `launch`
- `launch_ros`
- `robot_state_publisher`
- `rplidar_ros`
- `slam_toolbox`

Mục tiêu là mô tả đúng package requirements của source ROS. Không thêm cơ chế cài driver hoặc thay đổi deploy.

### 3.3. Sửa overlay map theo geometry động từ SLAM

**File:** `my_robot_controller/my_robot_controller/map_manager_node.py`

Đã loại bỏ giả định cố định:

```text
800 x 800 cells
0.05 m/cell
origin -20.0, -20.0
```

Map manager hiện lấy trực tiếp từ mỗi `/map`:

- `width`
- `height`
- `resolution`
- `origin.x`, `origin.y`
- Kiểm tra điều kiện `len(data) == width * height`

Grid obstacle tạm được tự động cấp phát lại khi geometry map thay đổi. `/map_combined` và `/obstacle_layer` dùng cùng geometry với map SLAM, tránh lỗi khi map mở rộng, dịch origin hoặc đổi kích thước.

---

## 4. Chuỗi dữ liệu sau khi sửa

```text
RPLIDAR A1M8
  -> rplidar_ros
  -> /scan (frame: laser)
  -> TF: laser -> base_link -> base_footprint
  -> slam_toolbox
  -> /map
  -> map_manager
  -> /map_combined và /obstacle_layer
```

TF đầy đủ trong mapping mode:

```text
map -> odom -> base_footprint -> base_link -> laser
```

Ownership của transform:

| Transform | Thành phần publish |
|---|---|
| `map -> odom` | `slam_toolbox` |
| `odom -> base_footprint` | `odom_node.py` |
| `base_footprint -> base_link` | `robot_state_publisher` từ URDF |
| `base_link -> laser` | `robot_state_publisher` từ URDF |

---

## 5. Kiểm tra bắt buộc trên Raspberry Pi

Thực hiện khi robot đứng yên và chưa cho phép robot tự di chuyển:

```bash
ros2 topic echo /scan --once
ros2 run tf2_ros tf2_echo base_footprint laser
ros2 run tf2_ros tf2_echo odom laser
ros2 topic echo /map --once
ros2 topic echo /map_combined --once
```

Kết quả đạt yêu cầu:

1. `/scan` trả về message `sensor_msgs/msg/LaserScan` có `header.frame_id: laser`.
2. `tf2_echo base_footprint laser` trả transform hợp lệ, không báo lookup/connectivity error.
3. `tf2_echo odom laser` trả transform hợp lệ sau khi odometry hoạt động.
4. `/map` và `/map_combined` trả `nav_msgs/msg/OccupancyGrid`.
5. Với mỗi map: `data.length` phải bằng `info.width x info.height`.

Nếu `/scan` chưa có dữ liệu, cần kiểm tra driver/process LiDAR và cổng serial trên Pi. Việc đó thuộc vận hành Pi, không được thay đổi trong source-only repair này.

---

## 6. Kiểm chứng mã nguồn

Đã thực hiện tại workspace:

```bash
python -m py_compile services/robot/src/my_robot_controller/my_robot_controller/map_manager_node.py
git diff --check -- services/robot/src
```

Kiểm tra phần cứng thật không thể thực hiện từ môi trường Windows hiện tại; cần thực hiện theo Mục 5 trên Raspberry Pi.

---

## 7. Kết luận

Đợt sửa này xử lý trực tiếp hai nguyên nhân phía source ROS ảnh hưởng đến LiDAR:

1. Cây TF thiếu kết nối từ `base_footprint` đến `base_link` và `laser`.
2. Obstacle overlay không tương thích với kích thước động của map SLAM.

Không có thay đổi nào được thực hiện đối với Web, API, Mobile hoặc deploy. Sau khi build source robot theo quy trình vận hành hiện có và kiểm tra thành công `/scan`, TF, `/map`, `/map_combined` trên Pi, pipeline LiDAR đủ điều kiện để tiếp tục kiểm thử map có giám sát.
