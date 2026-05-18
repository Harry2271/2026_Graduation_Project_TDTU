#!/bin/bash
set -e

# Sử dụng biến môi trường LIDAR_MODEL, mặc định là a1 nếu không truyền vào
LIDAR_MODEL=${LIDAR_MODEL:-a1}
LIDAR_PORT=${LIDAR_PORT:-/dev/ttyUSB0}

echo "--- Khởi động hệ thống với model Lidar: $LIDAR_MODEL ---"

# Nạp môi trường ROS 2 và Workspace
source /opt/ros/jazzy/setup.bash
source /app/install/setup.bash

echo "--- Đang đợi Lidar xuất hiện tại $LIDAR_PORT ---"

# Vòng lặp đợi thiết bị để tránh container bị restart liên tục
while [ ! -e "$LIDAR_PORT" ]; do
    sleep 2
done

echo "Lidar đã kết nối! Đang khởi động hệ thống mapping..."

# Cấp quyền serial
chmod 666 "$LIDAR_PORT"

# Chạy file launch tổng (Lidar + SLAM Toolbox + Brain Node)
ros2 launch my_robot_controller mapping_launch.py \
    lidar_model:="$LIDAR_MODEL" \
    serial_port:="$LIDAR_PORT"