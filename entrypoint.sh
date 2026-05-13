#!/bin/bash
set -e

# Sử dụng biến môi trường LIDAR_MODEL, mặc định là a1 nếu không truyền vào
LIDAR_MODEL=${LIDAR_MODEL:-a1}
LIDAR_PORT=${LIDAR_PORT:-/dev/ttyUSB0}

echo "--- Khởi động hệ thống với model Lidar: $LIDAR_MODEL ---"

# Kiểm tra Lidar có cắm vào không
if [ -e "$LIDAR_PORT" ]; then
    echo "Lidar đã sẵn sàng tại $LIDAR_PORT"
    
    # Nạp môi trường ROS 2 và Workspace
    source /opt/ros/humble/setup.bash
    source /app/install/setup.bash

    # Chạy file launch tương ứng với model
    # File sẽ có dạng: sllidar_a1_launch.py hoặc sllidar_a2m8_launch.py...
    ros2 launch sllidar_ros2 sllidar_${LIDAR_MODEL}_launch.py serial_port:=$LIDAR_PORT &
    
    # Chạy node Python điều khiển của ông
    python3 /app/src/my_robot_controller/brain_node.py
else
    echo "Lỗi: Không tìm thấy Lidar tại $LIDAR_PORT. Vui lòng cắm thiết bị!"
    exit 1
fi