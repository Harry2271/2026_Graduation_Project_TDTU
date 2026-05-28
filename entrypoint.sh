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
# Entry point names match setup.py: 'brain', 'qr_detector', 'web_bridge', 'map_manager'
BRAIN_BIN="/app/install/my_robot_controller/lib/my_robot_controller/brain"
QR_BIN="/app/install/my_robot_controller/lib/my_robot_controller/qr_detector"
WEB_BRIDGE_BIN="/app/install/my_robot_controller/lib/my_robot_controller/web_bridge"
MAP_MANAGER_BIN="/app/install/my_robot_controller/lib/my_robot_controller/map_manager"

echo "--- Binary paths ---"
echo "  brain:       $BRAIN_BIN"
echo "  qr_detector: $QR_BIN"
echo "  web_bridge: $WEB_BRIDGE_BIN"
echo "  map_manager: $MAP_MANAGER_BIN"

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
echo "--- Launching SLAM + Map Manager + Brain + QR + WebBridge (lidar starts when detected) ---"

# SLAM Toolbox (for TF: map->odom->base_footprint)
ros2 launch my_robot_controller slam_only_launch.py &

# Static TFs for lidar and base frames
ros2 run tf2_ros static_transform_publisher \
    0 0 0 0 0 0 base_link laser &>/dev/null &
ros2 run tf2_ros static_transform_publisher \
    0 0 0 0 0 0 base_footprint base_link &>/dev/null &

# Map Manager (custom two-map system, reads /scan + TF from slam)
export MAPPING_MODE="${MAPPING_MODE:-live}"  # 'mapping' or 'live'
"$MAP_MANAGER_BIN" --ros-args -r __node:=map_manager &

# If MAPPING_MODE=mapping, send start command to map_manager after a short delay
if [ "$MAPPING_MODE" = "mapping" ]; then
    echo "[map_manager] Auto-starting MAPPING mode..."
    sleep 3
    ros2 topic pub --once /mapping/control std_msgs/String "data: 'start'" &>/dev/null
fi

# Brain Node
export ESP32_PORT="$ESP32_PORT"
"$BRAIN_BIN" --ros-args -r __node:=brain_node &

# QR Detector
export CAMERA_DEVICE="$CAMERA_DEVICE"
"$QR_BIN" --ros-args -r __node:=qr_detector_node &

# Web Bridge — source workspace first so ROS env is available
source /app/install/setup.bash
"$WEB_BRIDGE_BIN" --ros-args -r __node:=web_bridge &

# --- Start lidar hot-plug monitor in background ---
start_lidar_monitor &

# --- Wait for all background jobs ---
wait
