#!/bin/bash
# =============================================================================
# services/robot/start.sh — Manual start script for the ROS 2 robot service
#
# Idempotent — safe to run multiple times. Stops existing PM2 processes first,
# rebuilds the colcon workspace, then starts everything via PM2.
#
# Use this when CI/CD is unavailable (e.g. Pi is offline but has fresh code):
#   services/robot/start.sh
#
# Environment variables (all optional, defaults shown):
#   LIDAR_MODEL=a1                  # a1 | a2m8 | ...
#   ESP32_PORT=/dev/robot-esp32   # ESP32 serial port (stable udev symlink)
#   CAMERA_DEVICE=/dev/video0       # USB camera device
#   API_SOCKET_URL=https://api.nguyen-robot.io.vn
#   ROBOT_BRAIN_TOKEN=...           # shared secret for brain<->API auth
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR"
ROS_WS="$HOME/robot_ws"
LIDAR_MODEL="${LIDAR_MODEL:-a1}"
SERVICE_NAME_PREFIX="nexus-robot"

echo "=== 🤖 ROBOT MANUAL START ==="
echo "  Script dir:    $APP_DIR"
echo "  ROS workspace: $ROS_WS"
echo "  Lidar model:   $LIDAR_MODEL"

# --- [1] Source ROS 2 + ensure pyserial-asyncio ---
source "/opt/ros/jazzy/setup.bash"

if ! python3 -c 'import serial_asyncio' 2>/dev/null; then
    echo "📦 Installing python3-serial-asyncio..."
    sudo apt-get update
    sudo apt-get install -y python3-serial-asyncio
fi

# Do not pick the first ttyUSB/ttyACM device: enumeration order can swap the
# LiDAR and ESP32 after a reboot. Install config/udev/99-robot-ports.rules
# first, then use the stable device identities below.
LIDAR_PORT="${LIDAR_PORT:-/dev/robot-lidar}"
ESP32_PORT="${ESP32_PORT:-/dev/robot-esp32}"

require_serial_device() {
    local label=$1
    local device=$2
    if [ ! -e "$device" ]; then
        echo "❌ $label device not found: $device"
        echo "   Connect the device and install services/robot/tools/install_udev_rules.sh."
        exit 1
    fi
    if [ ! -c "$device" ]; then
        echo "❌ $label path is not a character device: $device"
        exit 1
    fi
}

require_serial_device "LiDAR" "$LIDAR_PORT"
require_serial_device "ESP32" "$ESP32_PORT"
echo "📍 Lidar Port: $LIDAR_PORT"
echo "📍 ESP32 Port: $ESP32_PORT"

# --- [2] Stop existing PM2 processes (idempotent) ---
echo "🔄 Stopping existing robot nodes..."
NODES=(
    "${SERVICE_NAME_PREFIX}-lidar"
    "${SERVICE_NAME_PREFIX}-slam"
    "${SERVICE_NAME_PREFIX}-map-manager"
    "${SERVICE_NAME_PREFIX}-web-bridge"
    "${SERVICE_NAME_PREFIX}-esp32-telemetry"
    "${SERVICE_NAME_PREFIX}-odom"
    "${SERVICE_NAME_PREFIX}-teleop"
    "${SERVICE_NAME_PREFIX}-brain"
    "${SERVICE_NAME_PREFIX}-vision"
    "${SERVICE_NAME_PREFIX}-camera"
    "${SERVICE_NAME_PREFIX}-nav2"
)
for name in "${NODES[@]}"; do
    pm2 stop "$name" 2>/dev/null || true
    pm2 delete "$name" 2>/dev/null || true
done

# Kill any stray ROS processes not under PM2
pkill -f "map_manager" 2>/dev/null || true
pkill -f "brain_node" 2>/dev/null || true
pkill -f "web_bridge" 2>/dev/null || true
pkill -f "lidar_only" 2>/dev/null || true
pkill -f "april_tag_node" 2>/dev/null || true
pkill -f "camera_stream" 2>/dev/null || true
pkill -f "slam_toolbox" 2>/dev/null || true
sleep 2

# --- [3] Build colcon workspace ---
echo "📂 Reorganizing files for colcon build..."
mkdir -p "$ROS_WS/src"
rm -rf "$ROS_WS/src/my_robot_controller"
cp -r "$APP_DIR/src/my_robot_controller" "$ROS_WS/src/"

RPLIDAR_SRC="$ROS_WS/src/rplidar_ros"
if [ -d "$RPLIDAR_SRC/.git" ]; then
    echo "🔄 Updating rplidar_ros in $RPLIDAR_SRC ..."
    git -C "$RPLIDAR_SRC" pull --ff-only || echo "⚠️  rplidar_ros pull failed — using existing source"
else
    echo "📥 Cloning rplidar_ros (ros2 branch) from github.com/Slamtec/rplidar_ros ..."
    git clone --depth 1 --branch ros2 https://github.com/Slamtec/rplidar_ros.git "$RPLIDAR_SRC"
fi

cd "$ROS_WS"
echo "🏗️  Building workspace..."
colcon build --merge-install --executor sequential
source "$ROS_WS/install/setup.bash"

# --- [3b] Camera deps ---
echo "📦 Checking camera dependencies..."
if ! command -v ffmpeg &>/dev/null; then
    sudo apt-get install -y ffmpeg
fi

# --- [4] Start PM2 processes ---
echo "🚀 Starting ROS 2 Nodes via PM2..."

start_ros_node() {
    local name=$1
    local command=$2
    pm2 start "bash" --name "$name" -- -c "source /opt/ros/jazzy/setup.bash && source $ROS_WS/install/setup.bash && $command"
}

# 1. Lidar & SLAM
start_ros_node "${SERVICE_NAME_PREFIX}-lidar" "ros2 launch my_robot_controller lidar_only_launch.py serial_port:=$LIDAR_PORT"
start_ros_node "${SERVICE_NAME_PREFIX}-slam" "ros2 launch my_robot_controller slam_only_launch.py"

# 2. Logic Nodes
start_ros_node "${SERVICE_NAME_PREFIX}-map-manager" "ros2 run my_robot_controller map_manager"
start_ros_node "${SERVICE_NAME_PREFIX}-web-bridge" "ros2 run my_robot_controller web_bridge"
start_ros_node "${SERVICE_NAME_PREFIX}-esp32-telemetry" "ESP32_PORT=$ESP32_PORT ros2 run my_robot_controller esp32_telemetry_node"
# Encoder + IMU odometry must run in production so Nav2 has odom→base_footprint.
start_ros_node "${SERVICE_NAME_PREFIX}-odom" "ros2 run my_robot_controller odom"
# Sole ROS velocity-to-ESP32 command consumer.  It forwards both MANUAL and
# AUTO/Nav2 /cmd_vel; teleop_node enforces its one-second command timeout.
start_ros_node "${SERVICE_NAME_PREFIX}-teleop" "ros2 run my_robot_controller teleop_node"

# Brain (exp backoff + max restarts)
BRAIN_ENV="API_SOCKET_URL=${API_SOCKET_URL:-https://api.nguyen-robot.io.vn} ROBOT_BRAIN_TOKEN=${ROBOT_BRAIN_TOKEN:-}"
pm2 start "bash" \
    --name "${SERVICE_NAME_PREFIX}-brain" \
    --exp-backoff-restart-delay=1000 \
    --max-restarts 50 \
    -- -c "source /opt/ros/jazzy/setup.bash && source $ROS_WS/install/setup.bash && $BRAIN_ENV ros2 run my_robot_controller brain"

# Vision
start_ros_node "${SERVICE_NAME_PREFIX}-vision" "ros2 run my_robot_controller april_tag_node"

# Camera (max 10 restarts)
CAMERA_ENV="CAMERA_DEVICE=${CAMERA_DEVICE:-/dev/video0} CAMERA_WIDTH=1280 CAMERA_HEIGHT=720 CAMERA_FPS=30 CAMERA_QUALITY=2 CAMERA_PORT=9092"
pm2 start "bash" \
    --name "${SERVICE_NAME_PREFIX}-camera" \
    --max-restarts 10 \
    -- -c "source /opt/ros/jazzy/setup.bash && source $ROS_WS/install/setup.bash && $CAMERA_ENV ros2 run my_robot_controller camera_stream"

# 3. Nav2 — only start when a saved map is available. The launch file exits
# cleanly without a map, which would otherwise make PM2 restart it forever.
MAP_YAML="$ROS_WS/maps/latest.yaml"
if [ -f "$MAP_YAML" ]; then
    start_ros_node "${SERVICE_NAME_PREFIX}-nav2" "ros2 launch my_robot_controller nav2_launch.py map_yaml:=$MAP_YAML"
else
    echo "⚠️  Skipping Nav2: $MAP_YAML not found. Save a map, then run:"
    echo "   pm2 start nexus-robot-nav2"
fi

pm2 save

echo ""
echo "✅ ROBOT STARTED!"
echo "  Lidar: $LIDAR_PORT  ESP32: $ESP32_PORT"
echo ""
pm2 list | grep "$SERVICE_NAME_PREFIX" || true
echo ""
echo "📋 Quick commands:"
echo "  pm2 logs nexus-robot-web-bridge --lines 20 --nostream"
echo "  pm2 logs nexus-robot-brain"
echo "  ros2 topic list"