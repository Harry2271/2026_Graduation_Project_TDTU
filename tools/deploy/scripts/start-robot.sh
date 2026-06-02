#!/bin/bash
# =============================================================================
# start-robot.sh — Start all ROS 2 robot nodes on the Pi
#                   Called by deploy-robot.sh or systemd
# =============================================================================

set -e

source /opt/ros/jazzy/setup.bash
source /opt/ros/sllidar_ros2/install/setup.bash 2>/dev/null || true

# Source our workspace
ROS_WS="/opt/ros/robot_ws"
if [ -f "$ROS_WS/install/setup.bash" ]; then
    source "$ROS_WS/install/setup.bash"
fi

DEPLOY_ROOT="${DEPLOY_ROOT:-/home/pi/robot-for-nguyen}"
LIDAR_MODEL="${LIDAR_MODEL:-a1}"
LOG_DIR="/var/log/robot"
mkdir -p "$LOG_DIR"

echo "=== Robot Nodes Starting ==="
echo "  Lidar model: $LIDAR_MODEL"

# Auto-detect lidar USB port
find_lidar_port() {
    for link in /dev/serial/by-id/*; do
        [ -e "$link" ] || continue
        target=$(readlink -f "$link" 2>/dev/null)
        if echo "$link" | grep -qi 'slamtec\|sllidar\|lidar'; then
            echo "$target" && return 0
        fi
    done
    for dev in /dev/ttyACM* /dev/ttyUSB*; do
        [ -e "$dev" ] && echo "$dev" && return 0
    done
    echo "/dev/ttyUSB0"
}

LIDAR_PORT=$(find_lidar_port | tr -d '[:space:]')
echo "  Lidar port: $LIDAR_PORT"

# --- 1. Lidar driver ----------------------------------------------------------
echo "[1/4] Starting lidar driver..."
ros2 launch my_robot_controller lidar_only_launch.py \
    lidar_model:="$LIDAR_MODEL" serial_port:="$LIDAR_PORT" \
    > "$LOG_DIR/lidar.log" 2>&1 &
LIDAR_PID=$!

echo "  Lidar PID: $LIDAR_PID"

# Wait for /scan topic
echo "  Waiting for /scan topic..."
for i in $(seq 1 30); do
    if ros2 topic list 2>/dev/null | grep -q '^/scan$'; then
        echo "  /scan ready after ${i}s"
        break
    fi
    [ $i -eq 30 ] && echo "  WARNING: /scan not detected after 30s"
    sleep 1
done

# --- 2. Static TF publishers --------------------------------------------------
echo "[2/4] Starting TF publishers..."
ros2 run tf2_ros static_transform_publisher \
    --x 0 --y 0 --z 0 --yaw 0 --pitch 0 --roll 0 \
    --frame-id base_footprint --child-frame-id base_link \
    > "$LOG_DIR/tf.log" 2>&1 &

ros2 run tf2_ros static_transform_publisher \
    --x 0 --y 0 --z 0 --yaw 0 --pitch 0 --roll 0 \
    --frame-id base_link --child-frame-id laser \
    >> "$LOG_DIR/tf.log" 2>&1 &

sleep 1

# --- 3. Python nodes (map_manager + brain_node) --------------------------------
# New structure: my_robot_controller/ is flat (no duplicate nesting)
ROBOT_PKG="/opt/ros/robot_ws/src/my_robot_controller/my_robot_controller"

echo "[3/4] Starting brain_node..."
"$ROBOT_PKG/brain_node.py" \
    > "$LOG_DIR/brain.log" 2>&1 &

echo "[4/4] Starting map_manager..."
"$ROBOT_PKG/map_manager_node.py" \
    > "$LOG_DIR/map_manager.log" 2>&1 &

# --- 4. WebSocket bridge (with auto-restart) ----------------------------------
echo "[5/5] Starting web_bridge (port 9091)..."
start_web_bridge() {
    local attempt=1
    while true; do
        echo "[WS] web_bridge attempt $attempt at $(date)" >> "$LOG_DIR/web_bridge.log"
        "$ROBOT_PKG/web_bridge.py" >> "$LOG_DIR/web_bridge.log" 2>&1
        local ec=$?
        echo "[WS] exit code=$ec at $(date)" >> "$LOG_DIR/web_bridge.log"
        [ $ec -eq 0 ] && break
        echo "[WS] Restarting in 3s..." >> "$LOG_DIR/web_bridge.log"
        sleep 3
        attempt=$((attempt + 1))
    done
}
start_web_bridge &

echo "=== All Robot Nodes Started ==="
echo "  Logs: $LOG_DIR/"

# Keep process alive
wait
