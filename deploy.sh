#!/bin/bash
# =============================================================================
# deploy.sh — ROS 2 Robot Controller (Optimized with PM2)
# =============================================================================

set -e

WORKSPACE="${GITHUB_WORKSPACE:-$(pwd)}"
ROS_WS="$HOME/robot_ws"
LIDAR_MODEL="${LIDAR_MODEL:-a1}"
SERVICE_NAME_PREFIX="nexus-robot"

echo "=== 🤖 STARTING DEPLOYMENT: ROBOT CONTROLLER ==="

# --- [BƯỚC 1] Setup Môi trường ---
ROS_SETUP="/opt/ros/jazzy/setup.bash"
if [ ! -f "$ROS_SETUP" ]; then
    echo "❌ [ERROR] Không tìm thấy ROS 2 Jazzy. Hãy cài đặt trước!"
    exit 1
fi
source "$ROS_SETUP"

# Tự động tìm và cấp quyền cổng Lidar
find_lidar_port() {
    for dev in /dev/ttyUSB* /dev/ttyACM*; do
        [ -e "$dev" ] && echo "$dev" && return 0
    done
    echo "/dev/ttyUSB0"
}
LIDAR_PORT=$(find_lidar_port)
echo "📍 Lidar Port detected: $LIDAR_PORT"
sudo chmod 666 "$LIDAR_PORT" || true

# --- [BƯỚC 2] Đồng bộ và Build ---
mkdir -p "$ROS_WS/src"
if [ ! -L "$ROS_WS/src/my_robot_controller" ]; then
    ln -s "$WORKSPACE/src/my_robot_controller" "$ROS_WS/src/my_robot_controller"
fi

# Also symlink config directory
if [ ! -d "$WORKSPACE/src/config" ]; then
    echo "⚠️ Config directory not found at $WORKSPACE/src/config"
fi

cd "$ROS_WS"
# Đảm bảo có bộ biên dịch cho sllidar_ros2
if ! command -v g++ &>/dev/null; then 
    echo "📦 Installing build-essential..."
    sudo apt update && sudo apt install -y build-essential
fi

echo "🏗️ Building workspace with colcon..."
colcon build --merge-install --executor sequential
source "$ROS_WS/install/setup.bash"

# Fallback: copy config files if setup.py glob missed them
if [ ! -f "$ROS_WS/install/share/my_robot_controller/config/slam_params.yaml" ]; then
    echo "📋 Config files missing — copying manually..."
    mkdir -p "$ROS_WS/install/share/my_robot_controller/config"
    cp "$WORKSPACE/src/config/slam_params.yaml" \
       "$ROS_WS/install/share/my_robot_controller/config/" 2>/dev/null || true
fi

# --- [BƯỚC 3] Vận hành bằng PM2 ---
echo "🔄 Restarting ROS 2 Nodes via PM2..."

# Hàm khởi động node bọc trong môi trường ROS 2
start_ros_node() {
    local name=$1
    local command=$2
    pm2 delete "$name" 2>/dev/null || true
    # Chạy qua bash -c để nạp source môi trường mỗi khi node restart
    pm2 start "bash" --name "$name" -- -c "source $ROS_SETUP && source $ROS_WS/install/setup.bash && $command"
}

# 1. Khởi chạy Lidar (Sửa timeout bằng cách cấp quyền và dùng đúng driver)
start_ros_node "${SERVICE_NAME_PREFIX}-lidar" \
"ros2 launch sllidar_ros2 sllidar_a1_launch.py serial_port:=$LIDAR_PORT"

# 1b. Khởi chạy SLAM Toolbox (tạo frame 'map' cần cho pose tracking)
start_ros_node "${SERVICE_NAME_PREFIX}-slam" \
"ros2 launch my_robot_controller slam_only_launch.py"

# 2. Khởi chạy Brain Node
# Symlink: $ROS_WS/src/my_robot_controller -> $WORKSPACE/src/
# Files are at $WORKSPACE/src/my_robot_controller/
ROBOT_PKG="$WORKSPACE/src/my_robot_controller"
chmod +x "$ROBOT_PKG/brain_node.py" "$ROBOT_PKG/map_manager_node.py" "$ROBOT_PKG/web_bridge.py"

start_ros_node "${SERVICE_NAME_PREFIX}-brain" \
"python3 $ROBOT_PKG/brain_node.py"

# 3. Khởi chạy Map Manager Node
start_ros_node "${SERVICE_NAME_PREFIX}-map-manager" \
"python3 $ROBOT_PKG/map_manager_node.py"

# 4. Khởi chạy Web Bridge
start_ros_node "${SERVICE_NAME_PREFIX}-web-bridge" \
"python3 $ROBOT_PKG/web_bridge.py"

pm2 save
echo "----------------------------------------------"
echo "✅ DEPLOY ROBOT THÀNH CÔNG!"
pm2 status | grep "$SERVICE_NAME_PREFIX"