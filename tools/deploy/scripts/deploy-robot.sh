#!/bin/bash
# =============================================================================
# deploy-robot.sh — Build and restart ROS 2 robot controller on the Pi
# =============================================================================

set -e

DEPLOY_ROOT="${DEPLOY_ROOT:-/home/pi/robot-for-nguyen}"
WORKSPACE="${GITHUB_WORKSPACE:-$(pwd)}"
PROJECT_DIR="$WORKSPACE"
ROS_WS="/opt/ros/robot_ws"
LIDAR_MODEL="${LIDAR_MODEL:-a1}"
MODE="${1:-}"

echo "=== Deploying Robot Controller ==="
echo "  Lidar model: $LIDAR_MODEL"
echo "  Workspace:   $WORKSPACE"

if [ ! -d "$PROJECT_DIR/src" ]; then
    echo "[ERROR] Robot source not found at $PROJECT_DIR"
    exit 1
fi

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

# Source SLLidar driver
source /opt/ros/sllidar_ros2/install/setup.bash 2>/dev/null || \
source /opt/ros/sllidar_ros2/setup.bash 2>/dev/null || true

# Build ROS workspace
mkdir -p "$ROS_WS/src"
# Symlink: $ROS_WS/src/my_robot_controller -> $PROJECT_DIR/src
# After symlink: $ROS_WS/src/my_robot_controller/package.xml exists (colcon finds the package)
if [ ! -L "$ROS_WS/src/my_robot_controller" ]; then
    ln -sf "$PROJECT_DIR/src" "$ROS_WS/src/my_robot_controller"
fi

cd "$ROS_WS"

if [ "$MODE" = "manual" ]; then
    echo "[1/3] Pulling latest code..."
    git -C "$PROJECT_DIR" pull origin master || git -C "$PROJECT_DIR" fetch origin && git -C "$PROJECT_DIR" reset --hard origin/master
else
    echo "[1/3] CI/CD mode — code already checked out"
fi

echo "[2/3] Building with colcon..."
# Set Python path so colcon can find the my_robot_controller package
export PYTHONPATH="$ROS_WS/src/my_robot_controller:$PYTHONPATH"
colcon build --merge-install --executor sequential

echo "[3/3] Restarting robot launch..."
# Stop existing ROS nodes (kill all our nodes, be careful)
pkill -f "map_manager"  2>/dev/null || true
pkill -f "brain_node"   2>/dev/null || true
pkill -f "web_bridge"   2>/dev/null || true
pkill -f "lidar_only"   2>/dev/null || true
sleep 2

# Source workspace and launch
source "$ROS_WS/install/setup.bash"

nohup "$DEPLOY_ROOT/deploy/scripts/start-robot.sh" > /var/log/robot-controller.log 2>&1 &
echo "  Robot controller started (PID: $!), logs: /var/log/robot-controller.log"

echo "=== Robot Controller deployed ==="
