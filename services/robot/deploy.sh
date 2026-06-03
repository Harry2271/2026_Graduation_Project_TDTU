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

# The sllidar_ros2 driver is built into its own workspace by install-pi.sh at
# /opt/ros/sllidar_ros2/install. It is NOT part of the robot_ws colcon build.
# Without sourcing that setup, `ros2 launch sllidar_ros2 ...` fails with
# `Package 'sllidar_ros2' not found` and PM2 spins the launch wrapper in a
# crash loop while reporting the process as 'online' (because the launch
# wrapper itself stays alive long enough to be registered).
SLLIDAR_SETUP="/opt/ros/sllidar_ros2/install/setup.bash"
if [ ! -f "$SLLIDAR_SETUP" ]; then
    echo "❌ sllidar_ros2 workspace is missing at $SLLIDAR_SETUP."
    echo "   Run install-pi.sh first, or manually install the Slamtec driver."
    exit 1
fi

start_ros_node() {
    local name=$1
    local command=$2
    # Optional 4th arg: extra setup file to source (used for sllidar_ros2).
    local extra_setup=${3:-}
    pm2 delete "$name" 2>/dev/null || true
    if [ -n "$extra_setup" ]; then
        pm2 start "bash" --name "$name" -- -c "source /opt/ros/jazzy/setup.bash && source $extra_setup && source $ROS_WS/install/setup.bash && $command"
    else
        pm2 start "bash" --name "$name" -- -c "source /opt/ros/jazzy/setup.bash && source $ROS_WS/install/setup.bash && $command"
    fi
}

# 1. Lidar & SLAM
start_ros_node "${SERVICE_NAME_PREFIX}-lidar" "ros2 launch sllidar_ros2 sllidar_a1_launch.py serial_port:=$LIDAR_PORT" "$SLLIDAR_SETUP"
start_ros_node "${SERVICE_NAME_PREFIX}-slam" "ros2 launch my_robot_controller slam_only_launch.py"

# 2. Logic Nodes (brain_node removed — slam_toolbox handles odometry)
start_ros_node "${SERVICE_NAME_PREFIX}-map-manager" "ros2 run my_robot_controller map_manager"
start_ros_node "${SERVICE_NAME_PREFIX}-web-bridge" "ros2 run my_robot_controller web_bridge"

pm2 save
echo "✅ DEPLOY THÀNH CÔNG!"
