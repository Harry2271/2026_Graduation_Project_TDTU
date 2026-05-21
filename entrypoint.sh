#!/bin/bash
set -e

LIDAR_MODEL=${LIDAR_MODEL:-a1}
LIDAR_PORT=${LIDAR_PORT:-/dev/ttyUSB0}
ESP32_PORT=${ESP32_PORT:-/dev/ttyUSB1}
CAMERA_DEVICE=${CAMERA_DEVICE:-0}

echo "--- Starting robot-core ---"
echo "  Lidar model  : $LIDAR_MODEL"
echo "  Lidar port   : $LIDAR_PORT"
echo "  ESP32 port   : $ESP32_PORT"
echo "  Camera device: /dev/video$CAMERA_DEVICE"

source /opt/ros/jazzy/setup.bash
source /app/install/setup.bash

# Wait for Lidar serial device
echo "--- Waiting for Lidar at $LIDAR_PORT ---"
while [ ! -e "$LIDAR_PORT" ]; do
    sleep 2
done
chmod 666 "$LIDAR_PORT"

# Optionally wait for ESP32
if [ -e "$ESP32_PORT" ]; then
    chmod 666 "$ESP32_PORT"
    echo "ESP32 detected at $ESP32_PORT"
else
    echo "Warning: ESP32 not detected at $ESP32_PORT — brain node will retry on startup"
fi

# Run the full launch: Lidar + SLAM + Brain + QR Detector
ros2 launch my_robot_controller mapping_launch.py \
    lidar_model:="$LIDAR_MODEL" \
    serial_port:="$LIDAR_PORT" \
    esp32_port:="$ESP32_PORT" \
    camera_device:="$CAMERA_DEVICE"
