#!/bin/bash
set -e

LIDAR_MODEL=${LIDAR_MODEL:-a1}
LIDAR_PORT=${LIDAR_PORT:-/dev/ttyUSB0}
ESP32_PORT=${ESP32_PORT:-/dev/ttyUSB1}
CAMERA_DEVICE=${CAMERA_DEVICE:-0}
MAPPING_MODE=${MAPPING_MODE:-live}

LOG_DIR="/app/logs"
mkdir -p "$LOG_DIR"

echo "--- Starting robot-core ---"
echo "  Lidar model  : $LIDAR_MODEL"
echo "  Lidar port   : $LIDAR_PORT"
echo "  ESP32 port   : $ESP32_PORT"
echo "  Camera device: /dev/video$CAMERA_DEVICE"
echo "  Mapping mode : $MAPPING_MODE"
echo "  Log dir      : $LOG_DIR"

# Source ROS 2 and our workspace — this sets PYTHONPATH and ROS environment
source /opt/ros/jazzy/setup.bash
source /app/install/setup.bash

# Verify dependencies
python3 -c "import rclpy; print('rclpy OK')"
python3 -c "import websockets; print('websockets OK')"

# Paths to installed scripts (created by colcon build)
BRAIN_BIN="/app/install/my_robot_controller/lib/my_robot_controller/brain"
QR_BIN="/app/install/my_robot_controller/lib/my_robot_controller/qr_detector"
WEB_BRIDGE_BIN="/app/install/my_robot_controller/lib/my_robot_controller/web_bridge"
MAP_MANAGER_BIN="/app/install/my_robot_controller/lib/my_robot_controller/map_manager"

echo "--- Binary paths ---"
ls -la "$BRAIN_BIN"    2>&1 | tee "$LOG_DIR/startup.log"
ls -la "$QR_BIN"        2>&1 | tee -a "$LOG_DIR/startup.log"
ls -la "$WEB_BRIDGE_BIN" 2>&1 | tee -a "$LOG_DIR/startup.log"
ls -la "$MAP_MANAGER_BIN" 2>&1 | tee -a "$LOG_DIR/startup.log"

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
                    2>&1 | tee "$LOG_DIR/lidar.log"
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
echo "[entrypoint] Starting slam_only_launch.py..." | tee -a "$LOG_DIR/slam.log"
ros2 launch my_robot_controller slam_only_launch.py \
    2>&1 | tee -a "$LOG_DIR/slam.log" &
SLAM_PID=$!

# Wait for slam_toolbox to initialize
sleep 3

# Static TFs for lidar and base frames (use --frame-id style for clarity)
ros2 run tf2_ros static_transform_publisher \
    --x 0 --y 0 --z 0 --yaw 0 --pitch 0 --roll 0 \
    --frame-id base_link --child-frame-id laser \
    2>&1 | tee -a "$LOG_DIR/tf.log" &
ros2 run tf2_ros static_transform_publisher \
    --x 0 --y 0 --z 0 --yaw 0 --pitch 0 --roll 0 \
    --frame-id base_footprint --child-frame-id base_link \
    2>&1 | tee -a "$LOG_DIR/tf.log" &

# Verify topics are available
echo "[entrypoint] Checking ROS topics after 2s..." | tee -a "$LOG_DIR/startup.log"
sleep 2
ros2 topic list 2>&1 | tee -a "$LOG_DIR/startup.log" || echo "[entrypoint] ros2 topic list failed" | tee -a "$LOG_DIR/startup.log"

# Map Manager (custom two-map system, reads /scan + TF from slam)
echo "[entrypoint] Starting map_manager (mode=$MAPPING_MODE)..." | tee -a "$LOG_DIR/map_manager.log"
"$MAP_MANAGER_BIN" --ros-args -r __node:=map_manager \
    2>&1 | tee -a "$LOG_DIR/map_manager.log" &

# If MAPPING_MODE=mapping, send start command to map_manager after a short delay
if [ "$MAPPING_MODE" = "mapping" ]; then
    echo "[entrypoint] Auto-starting MAPPING mode..." | tee -a "$LOG_DIR/startup.log"
    sleep 3
    ros2 topic pub --once /mapping/control std_msgs/String "data: 'start'" \
        2>&1 | tee -a "$LOG_DIR/startup.log" || echo "[entrypoint] Failed to send start command" | tee -a "$LOG_DIR/startup.log"
fi

# Brain Node
echo "[entrypoint] Starting brain_node..." | tee -a "$LOG_DIR/brain.log"
export ESP32_PORT="$ESP32_PORT"
"$BRAIN_BIN" --ros-args -r __node:=brain_node \
    2>&1 | tee -a "$LOG_DIR/brain.log" &

# QR Detector
echo "[entrypoint] Starting qr_detector..." | tee -a "$LOG_DIR/qr.log"
export CAMERA_DEVICE="$CAMERA_DEVICE"
"$QR_BIN" --ros-args -r __node:=qr_detector_node \
    2>&1 | tee -a "$LOG_DIR/qr.log" &

# Web Bridge — source workspace first so ROS env is available
echo "[entrypoint] Starting web_bridge..." | tee -a "$LOG_DIR/web_bridge.log"
source /app/install/setup.bash
"$WEB_BRIDGE_BIN" --ros-args -r __node:=web_bridge \
    2>&1 | tee -a "$LOG_DIR/web_bridge.log" &

# --- Start lidar hot-plug monitor in background ---
start_lidar_monitor &

# --- Periodic topic health check every 30s ---
(
    while true; do
        sleep 30
        echo "--- Topic health check ($(date) ---" >> "$LOG_DIR/startup.log"
        ros2 topic list 2>&1 >> "$LOG_DIR/startup.log" || echo "topic list failed" >> "$LOG_DIR/startup.log"
        for topic in /scan /map_combined /pose /mapping_status /robot_status; do
            rate=$(ros2 topic hz "$topic" 2>&1 | grep 'average rate' | awk '{print $3}' || echo "N/A")
            echo "  $topic: $rate Hz" >> "$LOG_DIR/startup.log"
        done
    done
) &

# --- Wait for all background jobs ---
wait
