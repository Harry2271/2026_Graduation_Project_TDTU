#!/bin/bash
# =============================================================================
# deploy.sh — Build and restart ROS 2 robot controller on the Pi
#
# CI/CD flow: actions/checkout lands here → colcon build → restart nodes
# Manual flow: git pull + build + restart
# =============================================================================

set -e

WORKSPACE="${GITHUB_WORKSPACE:-$(pwd)}"
ROS_WS="$HOME/robot_ws"
LIDAR_MODEL="${LIDAR_MODEL:-a1}"
MODE="${1:-}"

echo "=== Deploying Robot Controller ==="
echo "  Lidar model: $LIDAR_MODEL"
echo "  Workspace:   $WORKSPACE"

# Source ROS 2 — try multiple known installation paths
ROS_SETUP=""
for path in /opt/ros/jazzy/setup.bash /opt/ros/humble/setup.bash /opt/ros/galactic/setup.bash; do
    if [ -f "$path" ]; then
        ROS_SETUP="$path"
        break
    fi
done

if [ -z "$ROS_SETUP" ]; then
    echo "[ERROR] ROS 2 not found. Run install-pi.sh first."
    echo "  Expected one of:"
    echo "    /opt/ros/jazzy/setup.bash"
    echo "    /opt/ros/humble/setup.bash"
    echo "    /opt/ros/galactic/setup.bash"
    exit 1
fi
source "$ROS_SETUP"
echo "[INFO] Sourced ROS 2 from $ROS_SETUP"

# Detect available RMW implementation
for rmw in rmw_connextdds rmw_fastrtps_cpp rmw_cyclonedds_cpp; do
    if find /opt/ros/jazzy/lib -name "lib${rmw}.so" 2>/dev/null | grep -q .; then
        export RMW_IMPLEMENTATION="$rmw"
        echo "[INFO] Using RMW: $rmw"
        break
    fi
done

# Source SLLidar driver
source /opt/ros/sllidar_ros2/install/setup.bash 2>/dev/null || \
source /opt/ros/sllidar_ros2/setup.bash 2>/dev/null || true

cd "$WORKSPACE"

# Manual mode: pull latest code first
if [ "$MODE" = "manual" ]; then
    echo "[1/4] Pulling latest code..."
    git pull origin master
else
    echo "[1/4] CI/CD mode — code already checked out"
fi

# Link src into ROS workspace
mkdir -p "$ROS_WS/src"
if [ ! -L "$ROS_WS/src/my_robot_controller" ]; then
    ln -s "$WORKSPACE/src" "$ROS_WS/src/my_robot_controller"
fi

# Build
echo "[2/4] Building with colcon..."
cd "$ROS_WS"
source "$ROS_WS/install/setup.bash"
colcon build --merge-install --executor sequential

# Restart robot nodes
echo "[3/4] Restarting robot nodes..."

pkill -f "brain_node"       2>/dev/null || true
pkill -f "map_manager"      2>/dev/null || true
pkill -f "web_bridge"       2>/dev/null || true
pkill -f "lidar_only"       2>/dev/null || true
pkill -f "static_transform"  2>/dev/null || true
sleep 2

# Re-source workspace setup (loads RMW + local packages) and ensure scripts are executable
ROBOT_PKG="$ROS_WS/src/my_robot_controller/my_robot_controller"
source "$ROS_WS/install/setup.bash"
chmod +x "$ROBOT_PKG/brain_node.py" \
         "$ROBOT_PKG/map_manager_node.py" \
         "$ROBOT_PKG/web_bridge.py"

LOG_DIR="$HOME/robot_logs"
mkdir -p "$LOG_DIR"

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

ros2 launch my_robot_controller lidar_only_launch.py \
    lidar_model:="$LIDAR_MODEL" serial_port:="$LIDAR_PORT" \
    > "$LOG_DIR/lidar.log" 2>&1 &

echo "  Waiting for /scan topic..."
for i in $(seq 1 30); do
    ros2 topic list 2>/dev/null | grep -q '^/scan$' && break
    [ $i -eq 30 ] && echo "  WARNING: /scan not detected"
    sleep 1
done

ros2 run tf2_ros static_transform_publisher \
    --x 0 --y 0 --z 0 --yaw 0 --pitch 0 --roll 0 \
    --frame-id base_footprint --child-frame-id base_link \
    > "$LOG_DIR/tf.log" 2>&1 &
ros2 run tf2_ros static_transform_publisher \
    --x 0 --y 0 --z 0 --yaw 0 --pitch 0 --roll 0 \
    --frame-id base_link --child-frame-id laser \
    >> "$LOG_DIR/tf.log" 2>&1 &
sleep 1

python3 "$ROBOT_PKG/brain_node.py"       > "$LOG_DIR/brain.log"       2>&1 &
python3 "$ROBOT_PKG/map_manager_node.py" > "$LOG_DIR/map_manager.log" 2>&1 &

start_web_bridge() {
    while true; do
        echo "[WS] restart at $(date)" >> "$LOG_DIR/web_bridge.log"
        python3 "$ROBOT_PKG/web_bridge.py" >> "$LOG_DIR/web_bridge.log" 2>&1
        [ $? -eq 0 ] && break
        sleep 3
    done
}
start_web_bridge &

echo "=== Robot Controller deployed ==="
echo "  Logs: $LOG_DIR/"
