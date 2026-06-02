#!/bin/bash
# =============================================================================
# deploy.sh — ROS 2 Robot Controller (Fix: Sudo & Path issues)
# =============================================================================

set -e

WORKSPACE="${GITHUB_WORKSPACE:-$(pwd)}"
ROS_WS="$HOME/robot_ws"
LIDAR_MODEL="${LIDAR_MODEL:-a1}"
SERVICE_NAME_PREFIX="nexus-robot"

echo "=== 🤖 STARTING DEPLOYMENT: ROBOT CONTROLLER ==="

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

# FIX: Cấp quyền không cần pass (đã dặn ông chạy visudo ở dưới)
sudo chmod 666 "$LIDAR_PORT" 2>/dev/null || echo "⚠️ Warning: Could not chmod $LIDAR_PORT"

# --- [BƯỚC 2] Sửa cấu trúc Folder & Build ---
mkdir -p "$ROS_WS/src"

# FIX: Copy the entire package directory from Workspace to ROS Workspace
echo "📂 Reorganizing files for colcon build..."
rm -rf "$ROS_WS/src/my_robot_controller"
cp -r "$WORKSPACE/src/my_robot_controller" "$ROS_WS/src/"

cd "$ROS_WS"
echo "🏗️ Building workspace..."
colcon build --merge-install --executor sequential
source "$ROS_WS/install/setup.bash"

# --- [BƯỚC 3] Vận hành bằng PM2 ---
echo "🔄 Restarting ROS 2 Nodes via PM2..."

start_ros_node() {
    local name=$1
    local command=$2
    pm2 delete "$name" 2>/dev/null || true
    pm2 start "bash" --name "$name" -- -c "source /opt/ros/jazzy/setup.bash && source $ROS_WS/install/setup.bash && $command"
}

# 1. Lidar & SLAM
start_ros_node "${SERVICE_NAME_PREFIX}-lidar" "ros2 launch sllidar_ros2 sllidar_a1_launch.py serial_port:=$LIDAR_PORT"
start_ros_node "${SERVICE_NAME_PREFIX}-slam" "ros2 launch my_robot_controller slam_only_launch.py"

# 2. Logic Nodes (brain_node removed — slam_toolbox handles odometry)
start_ros_node "${SERVICE_NAME_PREFIX}-map-manager" "ros2 run my_robot_controller map_manager"
start_ros_node "${SERVICE_NAME_PREFIX}-web-bridge" "ros2 run my_robot_controller web_bridge"

pm2 save
echo "✅ DEPLOY THÀNH CÔNG!"