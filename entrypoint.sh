#!/bin/bash
set -e

LIDAR_MODEL=${LIDAR_MODEL:-a1}
CAMERA_DEVICE=${CAMERA_DEVICE:-0}
MAPPING_MODE=${MAPPING_MODE:-live}

# Auto-detect lidar port — Slamtec lidars identify themselves via USB hardware ID
find_lidar_port() {
    # Scan by hardware ID (Slamtec vendor/product IDs)
    for link in /dev/serial/by-id/*; do
        if [ -e "$link" ]; then
            target=$(readlink -f "$link" 2>/dev/null)
            # Slamtec S1/S2/A1/A2/A3 identification
            if echo "$link" | grep -qi 'slamtec\|sllidar\|lidar'; then
                echo "  [AUTO] Found Slamtec lidar: $link -> $target"
                echo "$target"
                return 0
            fi
        fi
    done
    # Fallback: check all serial ports for Slamtec USB device (VID:PID 0483:5740)
    for dev in /dev/ttyUSB* /dev/ttyACM*; do
        if [ -e "$dev" ]; then
            vendor=$(udevadm info -q property -n "$dev" 2>/dev/null | grep 'ID_VENDOR_ID=' | cut -d= -f2)
            model=$(udevadm info -q property -n "$dev" 2>/dev/null | grep 'ID_MODEL=' | cut -d= -f2)
            if echo "$vendor $model" | grep -qi 'slamtec\|sllidar\|lidar\|0483.*5740'; then
                echo "  [AUTO] Found Slamtec lidar: $dev (VID=$vendor)"
                echo "$dev"
                return 0
            fi
        fi
    done
    # Last resort: first available ttyUSB/ttyACM (assuming it's the lidar)
    for dev in /dev/ttyUSB* /dev/ttyACM*; do
        if [ -e "$dev" ]; then
            echo "  [AUTO] Using first available serial port: $dev"
            echo "$dev"
            return 0
        fi
    done
    return 1
}

LIDAR_PORT=$(find_lidar_port)

LOG_DIR="/app/logs"
mkdir -p "$LOG_DIR"

echo "--- Starting robot-core ---"
echo "  Lidar model  : $LIDAR_MODEL"
echo "  Lidar port   : $LIDAR_PORT"
echo "  Camera device: /dev/video$CAMERA_DEVICE"
echo "  Mapping mode : $MAPPING_MODE"
echo "  Log dir      : $LOG_DIR"
echo "  NOTE: ESP32 motor control removed for testing"

# Source ROS 2 and our workspace
source /opt/ros/jazzy/setup.bash
source /app/install/setup.bash

# Verify dependencies
python3 -c "import rclpy; print('rclpy OK')"
python3 -c "import websockets; print('websockets OK')"

# Paths to Python source scripts (entry-point scripts broken after rebuild, run directly)
PYTHON="/usr/bin/python3"
BRAIN_SCRIPT="/app/src/my_robot_controller/my_robot_controller/brain_node.py"
QR_SCRIPT="/app/src/my_robot_controller/my_robot_controller/qr_detector.py"
WEB_BRIDGE_SCRIPT="/app/src/my_robot_controller/my_robot_controller/web_bridge.py"
MAP_MANAGER_SCRIPT="/app/src/my_robot_controller/my_robot_controller/map_manager_node.py"

echo "--- Script paths ---"
ls -la "$BRAIN_SCRIPT"       2>&1 | tee "$LOG_DIR/startup.log"
ls -la "$QR_SCRIPT"           2>&1 | tee -a "$LOG_DIR/startup.log"
ls -la "$WEB_BRIDGE_SCRIPT"   2>&1 | tee -a "$LOG_DIR/startup.log"
ls -la "$MAP_MANAGER_SCRIPT"  2>&1 | tee -a "$LOG_DIR/startup.log"

# --- Wait for Lidar to be detected ---
echo ""
echo "========================================"
echo "  WAITING FOR LIDAR..."
echo "========================================"

LIDAR_READY=false

while [ "$LIDAR_READY" = false ]; do
    if [ -e "$LIDAR_PORT" ]; then
        chmod 666 "$LIDAR_PORT" 2>/dev/null
        echo "[STARTUP] Lidar detected at $LIDAR_PORT"
        LIDAR_READY=true
    else
        echo "[STARTUP] Waiting for lidar at $LIDAR_PORT..."
        sleep 3
    fi
done

echo "[STARTUP] Lidar detected!"
echo ""

# --- Lidar driver startup (synchronous — wait for /scan to publish) ---
echo "[STARTUP] Starting lidar driver..."
ros2 launch my_robot_controller lidar_only_launch.py \
    lidar_model:="$LIDAR_MODEL" \
    serial_port:="$LIDAR_PORT" \
    2>&1 | tee "$LOG_DIR/lidar.log" &
LIDAR_PID=$!

# Wait for /scan topic to appear and publish at least once
echo "[STARTUP] Waiting for /scan topic to become active..."
SCAN_READY=false
for i in $(seq 1 30); do
    if ros2 topic list 2>/dev/null | grep -q "^/scan$"; then
        # Verify it's actually publishing
        RATE=$(ros2 topic hz /scan 2>/dev/null | grep 'average rate' | awk '{print $3}')
        if [ -n "$RATE" ] && [ "$RATE" != "N/A" ]; then
            echo "[STARTUP] /scan is publishing at ${RATE} Hz"
            SCAN_READY=true
            break
        fi
    fi
    echo "[STARTUP] Waiting for /scan... (${i}/30)"
    sleep 1
done

if [ "$SCAN_READY" = false ]; then
    echo "[STARTUP] ERROR: Lidar driver failed to publish /scan after 30s!"
    echo "[STARTUP] Lidar log:"
    tail -20 "$LOG_DIR/lidar.log"
    exit 1
fi

echo "[STARTUP] Lidar driver ready."
echo ""

# --- Start all other nodes ---
echo "--- Launching SLAM + Map Manager + Brain + QR + WebBridge ---"

# SLAM Toolbox
echo "[entrypoint] Starting slam_only_launch.py..." | tee -a "$LOG_DIR/slam.log"
ros2 launch my_robot_controller slam_only_launch.py \
    2>&1 | tee -a "$LOG_DIR/slam.log" &
SLAM_PID=$!

# Wait for slam_toolbox to initialize
sleep 3

# Static TFs
ros2 run tf2_ros static_transform_publisher \
    --x 0 --y 0 --z 0 --yaw 0 --pitch 0 --roll 0 \
    --frame-id base_link --child-frame-id laser \
    2>&1 | tee -a "$LOG_DIR/tf.log" &
ros2 run tf2_ros static_transform_publisher \
    --x 0 --y 0 --z 0 --yaw 0 --pitch 0 --roll 0 \
    --frame-id base_footprint --child-frame-id base_link \
    2>&1 | tee -a "$LOG_DIR/tf.log" &

# Verify topics
echo "[entrypoint] Checking ROS topics..." | tee -a "$LOG_DIR/startup.log"
sleep 2
ros2 topic list 2>&1 | tee -a "$LOG_DIR/startup.log" || echo "[entrypoint] ros2 topic list failed" | tee -a "$LOG_DIR/startup.log"

# Map Manager
echo "[entrypoint] Starting map_manager (mode=$MAPPING_MODE)..." | tee -a "$LOG_DIR/map_manager.log"
"$PYTHON" "$MAP_MANAGER_SCRIPT" --ros-args -r __node:=map_manager \
    2>&1 | tee -a "$LOG_DIR/map_manager.log" &

# If MAPPING_MODE=mapping, send start command after a short delay
if [ "$MAPPING_MODE" = "mapping" ]; then
    echo "[entrypoint] Auto-starting MAPPING mode..." | tee -a "$LOG_DIR/startup.log"
    sleep 3
    ros2 topic pub --once /mapping/control std_msgs/String "data: 'start'" \
        2>&1 | tee -a "$LOG_DIR/startup.log" || echo "[entrypoint] Failed to send start command" | tee -a "$LOG_DIR/startup.log"
fi

# Brain Node
echo "[entrypoint] Starting brain_node (ESP32 removed)..." | tee -a "$LOG_DIR/brain.log"
"$PYTHON" "$BRAIN_SCRIPT" --ros-args -r __node:=brain_node \
    2>&1 | tee -a "$LOG_DIR/brain.log" &

# QR Detector
echo "[entrypoint] Starting qr_detector..." | tee -a "$LOG_DIR/qr.log"
export CAMERA_DEVICE="$CAMERA_DEVICE"
"$PYTHON" "$QR_SCRIPT" --ros-args -r __node:=qr_detector_node \
    2>&1 | tee -a "$LOG_DIR/qr.log" &

# Web Bridge — with crash restart wrapper
echo "[entrypoint] Starting web_bridge..." | tee -a "$LOG_DIR/web_bridge.log"

start_web_bridge() {
    local attempt=1
    while true; do
        echo "[web_bridge-wrapper] Starting web_bridge (attempt $attempt)..." >> "$LOG_DIR/web_bridge.log"
        "$PYTHON" "$WEB_BRIDGE_SCRIPT" --ros-args -r __node:=web_bridge \
            >> "$LOG_DIR/web_bridge.log" 2>&1
        local exit_code=$?
        echo "[web_bridge-wrapper] web_bridge exited with code $exit_code at $(date)" >> "$LOG_DIR/web_bridge.log"
        if [ $exit_code -eq 0 ]; then
            echo "[web_bridge-wrapper] web_bridge exited cleanly — not restarting" >> "$LOG_DIR/web_bridge.log"
            break
        fi
        echo "[web_bridge-wrapper] Restarting in 3 seconds..." >> "$LOG_DIR/web_bridge.log"
        sleep 3
        attempt=$((attempt + 1))
    done
}

start_web_bridge &
WEB_BRIDGE_PID=$!

# --- Lidar hot-plug monitor (for reconnection after startup) ---
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

# Start lidar hot-plug monitor in background (for reconnection)
start_lidar_monitor &

# --- Wait for all background jobs ---
wait
