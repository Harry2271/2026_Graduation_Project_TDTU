#!/bin/bash
# =============================================================================
# install-pi.sh — One-time setup: install all dependencies on Raspberry Pi 5
#                  running Ubuntu 24.04 LTS
#
# Run ONCE as root: sudo ./install-pi.sh
#
# Installs shared tools, then sets up each project independently.
# Each project is cloned to: /home/pi/<project-name>
# =============================================================================

set -e

echo "=== PI Setup: Installing all dependencies ==="

# ---- System update -----------------------------------------------------------
echo "[STEP 1/7] Updating system..."
apt-get update
apt-get upgrade -y

# ---- Node.js 24 (latest) ----------------------------------------------------
echo "[STEP 2/7] Installing Node.js 24..."
if ! command -v node &>/dev/null || [[ "$(node -v)" != v24* ]]; then
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
    apt-get install -y nodejs
else
    echo "  Node.js $(node -v) already installed — skipping"
fi
node -v

# ---- Yarn --------------------------------------------------------------------
echo "[STEP 3/7] Installing Yarn..."
npm install -g yarn
yarn -v

# ---- PM2 --------------------------------------------------------------------
echo "[STEP 4/7] Installing PM2..."
npm install -g pm2
pm2 --version

# ---- serve (for mobile app web) --------------------------------------------
echo "[STEP 5/7] Installing serve (static file server)..."
npm install -g serve

# ---- Git --------------------------------------------------------------------
echo "[STEP 6/7] Ensuring git is installed..."
apt-get install -y git

# ---- ROS 2 Jazzy -----------------------------------------------------------
echo "[STEP 7/7] Installing ROS 2 Jazzy..."
ROS_SETUP="/opt/ros/jazzy/setup.bash"
if [ -f "$ROS_SETUP" ]; then
    echo "  ROS 2 Jazzy already installed — skipping"
else
    apt-get install -y \
        curl gnupg2 lsb-release wget \
        software-properties-common

    install -d /etc/apt/keyrings
    curl -sSL https://raw.githubusercontent.com/ros/rosdistro/master/ros.asc | \
        gpg --dearmor -o /etc/apt/keyrings/ros.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/ros.gpg] \
http://packages.ros.org/ros2/ubuntu $(. /etc/os-release && echo $UBUNTU_CODENAME) main" | \
        tee /etc/apt/sources.list.d/ros2.list > /dev/null

    apt-get update
    apt-get install -y \
        ros-jazzy-ros-base \
        ros-jazzy-tf2-ros \
        ros-jazzy-sensor-msgs \
        ros-jazzy-nav-msgs \
        ros-jazzy-geometry2 \
        python3-colcon-common-extensions \
        python3-pip \
        python3-venv

    if ! grep -q "jazzy/setup.bash" /root/.bashrc; then
        echo "source /opt/ros/jazzy/setup.bash" >> /root/.bashrc
    fi
    echo "  ROS 2 Jazzy installed"
fi

# Source ROS 2 for this session
source /opt/ros/jazzy/setup.bash

# ---- SLLidar ROS 2 driver --------------------------------------------------
echo "[EXTRA] Installing SLLidar ROS 2 driver..."
SLLIDAR_WS="/opt/ros/sllidar_ros2"
if [ -d "$SLLIDAR_WS/src/sllidar_ros2" ]; then
    echo "  SLLidar driver already cloned — skipping"
else
    mkdir -p "$SLLIDAR_WS/src"
    git clone https://github.com/Slamtec/sllidar_ros2.git "$SLLIDAR_WS/src/sllidar_ros2"
    cd "$SLLIDAR_WS"
    source /opt/ros/jazzy/setup.bash
    colcon build --merge-install --executor sequential
    if ! grep -q "sllidar_ros2/setup.bash" /root/.bashrc; then
        echo "source $SLLIDAR_WS/install/setup.bash" >> /root/.bashrc
    fi
fi

# ---- Python deps ------------------------------------------------------------
echo "[EXTRA] Installing Python packages..."
pip3 install --break-system-packages websockets numpy

# ---- Create project directories ---------------------------------------------
echo "[EXTRA] Creating project directories..."
mkdir -p /home/pi/nguyen-tdtu
mkdir -p /home/pi/nguyen-web-app
mkdir -p /home/pi/nguyen-mobile-app
mkdir -p /home/pi/robot-controller
chown -R pi:pi /home/pi 2>/dev/null || true

# ---- Clone each project (optional — comment out if already cloned) -----------
echo ""
echo "=== Setup Complete! ==="
echo ""
echo "Next steps — clone each project:"
echo "  git clone <backend-repo-url>     /home/pi/nguyen-tdtu"
echo "  git clone <frontend-repo-url>   /home/pi/nguyen-web-app"
echo "  git clone <mobile-repo-url>      /home/pi/nguyen-mobile-app"
echo "  git clone <robot-repo-url>       /home/pi/robot-controller"
echo ""
echo "Then per project:"
echo "  cd /home/pi/nguyen-tdtu         && ./deploy.sh manual"
echo "  cd /home/pi/nguyen-web-app      && ./deploy.sh manual"
echo "  cd /home/pi/nguyen-mobile-app   && ./deploy.sh manual"
echo "  cd /home/pi/robot-controller    && ./deploy.sh"
echo ""
echo "Auto-start on boot:"
echo "  pm2 startup   # copy-paste the printed command with sudo"
echo "  pm2 save"
