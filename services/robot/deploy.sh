#!/bin/bash
# =============================================================================
# deploy.sh — ROS 2 Robot Controller (services/robot)
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR"
MONOREPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"

ROS_WS="$HOME/robot_ws"
MAPS_DIR="${MAPS_DIR:-$HOME/robot_ws/maps}"
LIDAR_MODEL="${LIDAR_MODEL:-a1}"
SERVICE_NAME_PREFIX="nexus-robot"

echo "=== 🤖 STARTING DEPLOYMENT: ROBOT CONTROLLER ==="
echo "  App dir:  $APP_DIR"
echo "  Monorepo: $MONOREPO_ROOT"

# --- [BƯỚC 1] Setup Môi trường & Quyền Serial ---
source "/opt/ros/jazzy/setup.bash"

# RealEsp32Bridge uses pyserial-asyncio for the USB CDC/UART read loop.
# Install it here as well as in install-pi.sh so existing Pis are repaired
# by the next deploy without requiring a full one-time setup rerun.
if ! python3 -c 'import serial_asyncio' 2>/dev/null; then
    echo "📦 Installing python3-serial-asyncio..."
    sudo apt-get update
    sudo apt-get install -y python3-serial-asyncio
fi

# AprilTag vision dependencies. Keep this repair step in deploy so an existing
# Pi is fixed even when install-pi.sh was run before vision was added.
if ! python3 -c 'from dt_apriltags import Detector; import cv2; import numpy' 2>/dev/null; then
    echo "📦 Installing AprilTag vision dependencies..."
    sudo apt-get update
    sudo apt-get install -y ffmpeg libopencv-dev python3-opencv python3-pip
    python3 -m pip install --break-system-packages \
        numpy opencv-python-headless dt-apriltags
fi
python3 - <<'PY'
from dt_apriltags import Detector
import cv2
import numpy
print(f"AprilTag ready: dt-apriltags, OpenCV {cv2.__version__}, NumPy {numpy.__version__}")
Detector(families="tag25h9", nthreads=2)
PY

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

# --- AprilTag vision dependencies. Keep this repair step in deploy so an existing
# Pi is fixed even when install-pi.sh was run before vision was added.
if ! python3 -c 'from dt_apriltags import Detector; import cv2; import numpy' 2>/dev/null; then
    echo "📦 Installing AprilTag vision dependencies..."
    sudo apt-get update
    sudo apt-get install -y ffmpeg libopencv-dev python3-opencv python3-pip
    python3 -m pip install --break-system-packages \
        numpy opencv-python-headless dt-apriltags
fi
python3 - <<'PY'
from dt_apriltags import Detector
import cv2
import numpy
print(f"AprilTag ready: dt-apriltags, OpenCV {cv2.__version__}, NumPy {numpy.__version__}")
Detector(families="tag25h9", nthreads=2)
PY

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

# --- Environment variables for brain<->API connection ---
# These are passed inline to the brain's bash command because PM2 daemon
# may not inherit shell exports from this script.
BRAIN_ENV="API_SOCKET_URL=${API_SOCKET_URL:-https://api.nguyen-robot.io.vn} ROBOT_BRAIN_TOKEN=${ROBOT_BRAIN_TOKEN:-}"

# 2. Logic Nodes (brain_node added in Phase 0 of robot-controller-brain plan)
start_ros_node "${SERVICE_NAME_PREFIX}-map-manager" "ros2 run my_robot_controller map_manager"

# ESP32 telemetry bridge — opens /dev/robot-esp32 and forwards type-130/131 frames
# to /esp32/encoder and /esp32/status, which web_bridge relays to the browser.
# Must start before web_bridge so subscriptions are live by the time clients
# connect. Overridable via ESP32_PORT for non-default hardware.
ESP32_PORT="${ESP32_PORT:-/dev/robot-esp32}"

# Fallback for ESP32 if udev symlink doesn't exist
if [ ! -e "$ESP32_PORT" ]; then
    echo "⚠️  $ESP32_PORT not found — checking for fallback devices..."
    for candidate in /dev/ttyACM0 /dev/ttyACM1 /dev/ttyUSB1 /dev/ttyUSB2; do
        if [ -c "$candidate" ] && [ "$candidate" != "$LIDAR_PORT" ]; then
            ESP32_PORT="$candidate"
            echo "   Found fallback: $ESP32_PORT"
            break
        fi
    done
fi

# ESP32 is optional for SLAM-only operation
if [ -c "$ESP32_PORT" ]; then
    sudo chmod 666 "$ESP32_PORT" 2>/dev/null || echo "⚠️ Warning: Could not chmod $ESP32_PORT"
    start_ros_node "${SERVICE_NAME_PREFIX}-esp32-telemetry" "ESP32_PORT=$ESP32_PORT ros2 run my_robot_controller esp32_telemetry_node"
    # Required for Nav2: publishes /odom and odom→base_footprint from encoders/IMU.
    start_ros_node "${SERVICE_NAME_PREFIX}-odom" "ros2 run my_robot_controller odom"
    # Required motor command consumer for both MANUAL and AUTO/Nav2 /cmd_vel.
    start_ros_node "${SERVICE_NAME_PREFIX}-teleop" "ros2 run my_robot_controller teleop_node"
    echo "✅ ESP32 telemetry started on $ESP32_PORT"
else
    echo "⚠️  ESP32 device not found: $ESP32_PORT"
    echo "   Robot will start in SLAM-only mode (no motor control)."
    echo "   To enable motor control:"
    echo "     1. Connect ESP32 via USB"
    echo "     2. Find repo path: find ~ -name 'robot-for-nguyen' -type d 2>/dev/null"
    echo "     3. Run: cd <repo-path>/services/robot && sudo ./tools/install_udev_rules.sh"
    echo "     4. Restart: pm2 restart nexus-robot-esp32-telemetry nexus-robot-odom nexus-robot-teleop"
fi

# web_bridge now subscribes to /esp32/status, /esp32/encoder AND /esp32/power
# so it must start after esp32-telemetry to have topic subscribers ready.
start_ros_node "${SERVICE_NAME_PREFIX}-web-bridge" "ros2 run my_robot_controller web_bridge"

# Ensure maps directory exists for map_saver_cli and MapsController
mkdir -p "$MAPS_DIR"

# Brain node gets extra PM2 settings: exponential backoff on restart so a
# temporarily-unreachable API doesn't cause a 1500-restart crash loop.
pm2 delete "${SERVICE_NAME_PREFIX}-brain" 2>/dev/null || true
pm2 start "bash" \
    --name "${SERVICE_NAME_PREFIX}-brain" \
    --exp-backoff-restart-delay=1000 \
    --max-restarts 50 \
    -- -c "source /opt/ros/jazzy/setup.bash && source $ROS_WS/install/setup.bash && $BRAIN_ENV ros2 run my_robot_controller brain"

start_ros_node "${SERVICE_NAME_PREFIX}-vision" "ros2 run my_robot_controller april_tag_node"

# Camera stream (MJPEG over HTTP on port 9092)
CAMERA_ENV="CAMERA_DEVICE=/dev/video0 CAMERA_WIDTH=1280 CAMERA_HEIGHT=720 CAMERA_FPS=30 CAMERA_QUALITY=2 CAMERA_PORT=9092"
pm2 delete "${SERVICE_NAME_PREFIX}-camera" 2>/dev/null || true
pm2 start "bash" \
    --name "${SERVICE_NAME_PREFIX}-camera" \
    --max-restarts 10 \
    -- -c "source /opt/ros/jazzy/setup.bash && source $ROS_WS/install/setup.bash && $CAMERA_ENV ros2 run my_robot_controller camera_stream"

# 3. Nav2 (Phase 3 — real bringup)
# Do not register a mapless launch under PM2: nav2_launch.py exits cleanly
# when latest.yaml is absent, which would otherwise cause a restart loop.
MAP_YAML="$ROS_WS/maps/latest.yaml"
if [ -f "$MAP_YAML" ]; then
    start_ros_node "${SERVICE_NAME_PREFIX}-nav2" "ros2 launch my_robot_controller nav2_launch.py map_yaml:=$MAP_YAML"
else
    echo "⚠️ Skipping Nav2: $MAP_YAML not found. Save a map, then start nexus-robot-nav2."
fi

pm2 save
echo "✅ DEPLOY THÀNH CÔNG!"
