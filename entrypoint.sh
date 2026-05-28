#!/bin/bash
set -e

LIDAR_MODEL=${LIDAR_MODEL:-a1}
MAPPING_MODE=${MAPPING_MODE:-live}
LOG_DIR="/app/logs"
mkdir -p "$LOG_DIR"

echo "=== Robot Core Starting ==="
echo "  Lidar model : $LIDAR_MODEL"
echo "  Mode        : $MAPPING_MODE"

source /opt/ros/jazzy/setup.bash
source /app/install/setup.bash 2>/dev/null || true

PYTHON="/usr/bin/python3"
BRAIN="/app/src/my_robot_controller/my_robot_controller/brain_node.py"
WEB_BRIDGE="/app/src/my_robot_controller/my_robot_controller/web_bridge.py"
MAP_MANAGER="/app/src/my_robot_controller/my_robot_controller/map_manager_node.py"

# Auto-detect lidar port
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
echo "[LIDAR] Port: $LIDAR_PORT"

# Start lidar driver
echo "[LIDAR] Starting..."
ros2 launch my_robot_controller lidar_only_launch.py \
    lidar_model:="$LIDAR_MODEL" serial_port:="$LIDAR_PORT" \
    > "$LOG_DIR/lidar.log" 2>&1 &
LIDAR_PID=$!

# Wait for /scan topic
echo "[LIDAR] Waiting for /scan..."
for i in $(seq 1 30); do
    if ros2 topic list 2>/dev/null | grep -q '^/scan$'; then
        echo "[LIDAR] /scan ready after ${i}s"
        break
    fi
    echo "  waiting... ($i/30)"
    sleep 1
done

# Static TFs
ros2 run tf2_ros static_transform_publisher \
    --x 0 --y 0 --z 0 --yaw 0 --pitch 0 --roll 0 \
    --frame-id base_footprint --child-frame-id base_link \
    > "$LOG_DIR/tf.log" 2>&1 &
ros2 run tf2_ros static_transform_publisher \
    --x 0 --y 0 --z 0 --yaw 0 --pitch 0 --roll 0 \
    --frame-id base_link --child-frame-id laser \
    >> "$LOG_DIR/tf.log" 2>&1 &

sleep 1

# Send initial mode command
INITIAL_CMD="stop"
if [ "$MAPPING_MODE" = "mapping" ]; then
    INITIAL_CMD="start"
fi
echo "[MODE] Sending initial command: $INITIAL_CMD"
ros2 topic pub --once /mapping/control std_msgs/String "data: '$INITIAL_CMD'" 2>/dev/null || true

# Start nodes
echo "[NODE] map_manager"
"$PYTHON" "$MAP_MANAGER" --ros-args -r __node:=map_manager \
    > "$LOG_DIR/map_manager.log" 2>&1 &
echo "[NODE] brain_node"
"$PYTHON" "$BRAIN" --ros-args -r __node:=brain_node \
    > "$LOG_DIR/brain.log" 2>&1 &

# Web bridge with restart wrapper
echo "[NODE] web_bridge"
start_web_bridge() {
    local attempt=1
    while true; do
        echo "[WS] web_bridge attempt $attempt" | tee -a "$LOG_DIR/web_bridge.log"
        "$PYTHON" "$WEB_BRIDGE" >> "$LOG_DIR/web_bridge.log" 2>&1
        local ec=$?
        echo "[WS] exit code=$ec at $(date)" >> "$LOG_DIR/web_bridge.log"
        [ $ec -eq 0 ] && break
        echo "[WS] Restarting in 3s..." >> "$LOG_DIR/web_bridge.log"
        sleep 3
        attempt=$((attempt + 1))
    done
}
start_web_bridge &

echo "=== All nodes started ==="
wait
