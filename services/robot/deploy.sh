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

# rplidar_ros (Slamtec's official driver) is NOT available as an apt package
# on the Pi's Ubuntu 24.04 / Jazzy repos. Build it from source into the same
# colcon workspace so it shares the overlay with my_robot_controller.
# Upstream repo: github.com/Slamtec/rplidar_ros, branch: ros2, package name: rplidar_ros
RPLIDAR_SRC="$ROS_WS/src/rplidar_ros"
if [ -d "$RPLIDAR_SRC/.git" ]; then
    echo "🔄 Updating rplidar_ros in $RPLIDAR_SRC ..."
    git -C "$RPLIDAR_SRC" pull --ff-only || echo "⚠️  rplidar_ros pull failed — using existing source"
else
    echo "📥 Cloning rplidar_ros (ros2 branch) from github.com/Slamtec/rplidar_ros ..."
    git clone --depth 1 --branch ros2 https://github.com/Slamtec/rplidar_ros.git "$RPLIDAR_SRC"
fi

cd "$ROS_WS"
echo "🏗️ Building workspace..."
colcon build --merge-install --executor sequential
source "$ROS_WS/install/setup.bash"

# --- [BƯỚC 3] Vận hành bằng PM2 ---
echo "🔄 Restarting ROS 2 Nodes via PM2..."

# rplidar_ros2 is now built from source into $ROS_WS/install — no apt package
# required, no separate sllidar_ros2 workspace.

start_ros_node() {
    local name=$1
    local command=$2
    pm2 delete "$name" 2>/dev/null || true
    pm2 start "bash" --name "$name" -- -c "source /opt/ros/jazzy/setup.bash && source $ROS_WS/install/setup.bash && $command"
}

# 1. Lidar & SLAM
start_ros_node "${SERVICE_NAME_PREFIX}-lidar" "ros2 launch my_robot_controller lidar_only_launch.py serial_port:=$LIDAR_PORT"
start_ros_node "${SERVICE_NAME_PREFIX}-slam" "ros2 launch my_robot_controller slam_only_launch.py"

# 2. Logic Nodes (brain_node added in Phase 0 of robot-controller-brain plan)
start_ros_node "${SERVICE_NAME_PREFIX}-map-manager" "ros2 run my_robot_controller map_manager"
start_ros_node "${SERVICE_NAME_PREFIX}-web-bridge" "ros2 run my_robot_controller web_bridge"
start_ros_node "${SERVICE_NAME_PREFIX}-brain" "ros2 run my_robot_controller brain"
start_ros_node "${SERVICE_NAME_PREFIX}-vision" "ros2 run my_robot_controller april_tag_node"

# --- Environment variables for brain<->API connection ---
export API_SOCKET_URL="${API_SOCKET_URL:-https://api.nguyen-robot.io.vn}"
export ROBOT_BRAIN_TOKEN="${ROBOT_BRAIN_TOKEN:-}"

# 3. Nav2 (Phase 3 — real bringup)
start_ros_node "${SERVICE_NAME_PREFIX}-nav2" "ros2 launch my_robot_controller nav2_launch.py"

pm2 save
echo "✅ DEPLOY THÀNH CÔNG!"
