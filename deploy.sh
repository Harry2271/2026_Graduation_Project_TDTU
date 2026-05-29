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
mkdir -p "$ROS_WS/src/my_robot_controller/launch"
mkdir -p "$ROS_WS/src/my_robot_controller/my_robot_controller"

# FIX: Đưa file vào đúng chỗ mà setup.py của ROS 2 yêu cầu
echo "📂 Reorganizing files for colcon build..."
cp "$WORKSPACE/slam_only_launch.py" "$ROS_WS/src/my_robot_controller/launch/" 2>/dev/null || true
cp "$WORKSPACE/lidar_only_launch.py" "$ROS_WS/src/my_robot_controller/launch/" 2>/dev/null || true
cp "$WORKSPACE/brain_node.py" "$ROS_WS/src/my_robot_controller/my_robot_controller/" 2>/dev/null || true
cp "$WORKSPACE/map_manager_node.py" "$ROS_WS/src/my_robot_controller/my_robot_controller/" 2>/dev/null || true
cp "$WORKSPACE/web_bridge.py" "$ROS_WS/src/my_robot_controller/my_robot_controller/" 2>/dev/null || true
cp "$WORKSPACE/package.xml" "$ROS_WS/src/my_robot_controller/" 2>/dev/null || true
cp "$WORKSPACE/setup.py" "$ROS_WS/src/my_robot_controller/" 2>/dev/null || true
cp "$WORKSPACE/setup.cfg" "$ROS_WS/src/my_robot_controller/" 2>/dev/null || true

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

# 2. Logic Nodes
PKG_BIN="$ROS_WS/install/lib/my_robot_controller"
start_ros_node "${SERVICE_NAME_PREFIX}-brain" "python3 $ROS_WS/src/my_robot_controller/my_robot_controller/brain_node.py"
start_ros_node "${SERVICE_NAME_PREFIX}-map-manager" "python3 $ROS_WS/src/my_robot_controller/my_robot_controller/map_manager_node.py"
start_ros_node "${SERVICE_NAME_PREFIX}-web-bridge" "python3 $ROS_WS/src/my_robot_controller/my_robot_controller/web_bridge.py"

pm2 save
echo "✅ DEPLOY THÀNH CÔNG!"