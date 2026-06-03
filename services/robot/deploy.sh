#!/bin/bash
# =============================================================================
# deploy.sh — ROS 2 Robot Controller (services/robot)
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR"
MONOREPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"

ROS_WS="$HOME/robot_ws"
LIDAR_MODEL="${LIDAR_MODEL:-a1}"
SERVICE_NAME_PREFIX="nexus-robot"

echo "=== 🤖 STARTING DEPLOYMENT: ROBOT CONTROLLER ==="
echo "  App dir:  $APP_DIR"
echo "  Monorepo: $MONOREPO_ROOT"

# --- [BƯỚC 1] Setup Môi trường & Quyền Serial ---
source "/opt/ros/jazzy/setup.bash"

find_lidar_port() {
    for dev in /dev/ttyUSB* /dev/ttyACM*; do
        [ -e "$dev" ] && echo "$dev" && return 0
    done
    echo "/dev/ttyUSB0"
}
LIDAR_PORT=$(find_lidar_port)
echo "📍 Lidar Port: $LIDAR_PORT"

sudo chmod 666 "$LIDAR_PORT" 2>/dev/null || echo "⚠️ Warning: Could not chmod $LIDAR_PORT"

# --- [BƯỚC 2] Sửa cấu trúc Folder & Build ---
mkdir -p "$ROS_WS/src"

echo "📂 Reorganizing files for colcon build..."
rm -rf "$ROS_WS/src/my_robot_controller"
cp -r "$APP_DIR/src/my_robot_controller" "$ROS_WS/src/"

cd "$ROS_WS"
echo "🏗️ Building workspace..."
colcon build --merge-install --executor sequential
source "$ROS_WS/install/setup.bash"

# --- [BƯỚC 3] Vận hành bằng PM2 ---
echo "🔄 Restarting ROS 2 Nodes via PM2..."

# The RPLidar driver is now installed via apt (ros-jazzy-rplidar-ros2) in the
# system ROS 2 prefix, so a single `source /opt/ros/jazzy/setup.bash` is
# enough — no separate sllidar_ros2 workspace needed.
if ! dpkg -s ros-jazzy-rplidar-ros2 >/dev/null 2>&1; then
    echo "❌ ros-jazzy-rplidar-ros2 is not installed."
    echo "   Re-run install-pi.sh, or: sudo apt-get install -y ros-jazzy-rplidar-ros2"
    exit 1
fi

start_ros_node() {
    local name=$1
    local command=$2
    pm2 delete "$name" 2>/dev/null || true
    pm2 start "bash" --name "$name" -- -c "source /opt/ros/jazzy/setup.bash && source $ROS_WS/install/setup.bash && $command"
}

# 1. Lidar & SLAM
start_ros_node "${SERVICE_NAME_PREFIX}-lidar" "ros2 launch my_robot_controller lidar_only_launch.py serial_port:=$LIDAR_PORT"
start_ros_node "${SERVICE_NAME_PREFIX}-slam" "ros2 launch my_robot_controller slam_only_launch.py"

# 2. Logic Nodes (brain_node removed — slam_toolbox handles odometry)
start_ros_node "${SERVICE_NAME_PREFIX}-map-manager" "ros2 run my_robot_controller map_manager"
start_ros_node "${SERVICE_NAME_PREFIX}-web-bridge" "ros2 run my_robot_controller web_bridge"

pm2 save
echo "✅ DEPLOY THÀNH CÔNG!"
