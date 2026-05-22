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

# Source ROS 2 and our workspace — this sets PYTHONPATH and ROS environment
source /opt/ros/jazzy/setup.bash
source /app/install/setup.bash

# Verify dependencies
python3 -c "import rclpy; print('rclpy OK')"
python3 -c "import websockets; print('websockets OK')"

# Paths to installed scripts (created by colcon build)
# Entry point names match setup.py: 'brain', 'qr_detector', 'web_bridge'
BRAIN_BIN="/app/install/my_robot_controller/lib/my_robot_controller/brain"
QR_BIN="/app/install/my_robot_controller/lib/my_robot_controller/qr_detector"
WEB_BRIDGE_BIN="/app/install/my_robot_controller/lib/my_robot_controller/web_bridge"

echo "--- Binary paths ---"
echo "  brain:      $BRAIN_BIN"
echo "  qr_detector: $QR_BIN"
echo "  web_bridge: $WEB_BRIDGE_BIN"

# --- Hot-plug monitoring for Lidar ---
start_lidar_monitor() {
    while true; do
        if [ -e "$LIDAR_PORT" ]; then
            chmod 666 "$LIDAR_PORT" 2>/dev/null
            echo "[lidar-monitor] Lidar detected at $LIDAR_PORT"
            (
                sleep 0.5
                ros2 launch my_robot_controller lidar_only_launch.py \
                    lidar_model:="$LIDAR_MODEL" \
                    serial_port:="$LIDAR_PORT" \
                    2>&1
                echo "[lidar-monitor] Lidar driver stopped — waiting for reconnect"
            ) &
            LIDAR_PID=$!
            while kill -0 $LIDAR_PID 2>/dev/null; do
                sleep 1
                if [ ! -e "$LIDAR_PORT" ]; then
                    echo "[lidar-monitor] Lidar disconnected — stopping driver"
                    kill $LIDAR_PID 2>/dev/null
                    break
                fi
            done
            wait $LIDAR_PID 2>/dev/null
            echo "[lidar-monitor] Waiting for lidar to reconnect..."
            sleep 2
        else
            echo "[lidar-monitor] Lidar not found at $LIDAR_PORT — waiting..."
            sleep 3
        fi
    done
}

# --- Set permissions on ESP32 if present ---
if [ -e "$ESP32_PORT" ]; then
    chmod 666 "$ESP32_PORT"
    echo "[esp32-monitor] ESP32 detected at $ESP32_PORT"
else
    echo "[esp32-monitor] ESP32 not detected at $ESP32_PORT — will retry on startup"
fi

# --- Start non-device-dependent nodes ---
echo "--- Launching SLAM + Brain + QR + WebBridge (lidar starts when detected) ---"

# SLAM Toolbox
ros2 launch my_robot_controller slam_only_launch.py &

# Static TFs
ros2 run tf2_ros static_transform_publisher \
    0 0 0 0 0 0 base_link laser &>/dev/null &
ros2 run tf2_ros static_transform_publisher \
    0 0 0 0 0 0 base_footprint base_link &>/dev/null &
ros2 run tf2_ros static_transform_publisher \
    0 0 0 0 0 0 odom base_footprint &>/dev/null &

# Brain Node
export ESP32_PORT="$ESP32_PORT"
"$BRAIN_BIN" --ros-args -r __node:=brain_node &

# QR Detector
export CAMERA_DEVICE="$CAMERA_DEVICE"
"$QR_BIN" --ros-args -r __node:=qr_detector_node &

# Web Bridge
"$WEB_BRIDGE_BIN" --ros-args -r __node:=web_bridge &

# --- Start lidar hot-plug monitor in background ---
start_lidar_monitor &

# --- Wait for all background jobs ---
wait
