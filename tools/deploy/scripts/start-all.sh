#!/bin/bash
# =============================================================================
# start-all.sh — Manually start all production services on the Pi
#
# Use this after a Pi reboot when PM2 did not restore the services automatically.
# Backend and frontend use their existing production builds. The robot deployment
# rebuilds the ROS workspace before starting its PM2-managed nodes.
#
# Usage:
#   ./tools/deploy/scripts/start-all.sh
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MONOREPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
API_DIR="$MONOREPO_ROOT/apps/api"
WEB_DIR="$MONOREPO_ROOT/apps/web"
ROBOT_DIR="$MONOREPO_ROOT/services/robot"

BACKEND_NAME="nguyen-backend"
FRONTEND_NAME="nguyen-frontend"
ROBOT_NAMES=(
    "nexus-robot-lidar"
    "nexus-robot-slam"
    "nexus-robot-map-manager"
    "nexus-robot-web-bridge"
    "nexus-robot-brain"
    "nexus-robot-vision"
    "nexus-robot-camera"
    "nexus-robot-nav2"
)

fail_preflight() {
    echo "❌ Preflight failed. No service was started."
    exit 1
}

check_file() {
    local path="$1"
    local description="$2"

    if [ -f "$path" ]; then
        echo "  ✓ $description"
    else
        echo "  ❌ $description: $path"
        PREFLIGHT_FAILED=1
    fi
}

check_directory() {
    local path="$1"
    local description="$2"

    if [ -d "$path" ]; then
        echo "  ✓ $description"
    else
        echo "  ❌ $description: $path"
        PREFLIGHT_FAILED=1
    fi
}

start_pm2_app() {
    local name="$1"
    local app_dir="$2"
    local ecosystem_file="$3"

    if pm2 describe "$name" >/dev/null 2>&1; then
        echo "  ↻ Restarting $name..."
        pm2 restart "$name"
    else
        echo "  ▶ Starting $name..."
        (cd "$app_dir" && pm2 start "$ecosystem_file" --env production)
    fi
}

echo "=== NEXUS MANUAL START ==="
echo "  Monorepo: $MONOREPO_ROOT"
echo "  Host:     $(hostname 2>/dev/null || printf 'unknown')"
echo

echo "[1/5] Checking required commands and files..."
PREFLIGHT_FAILED=0

if command -v pm2 >/dev/null 2>&1; then
    echo "  ✓ pm2: $(command -v pm2)"
else
    echo "  ❌ pm2 is not installed or not on PATH"
    PREFLIGHT_FAILED=1
fi

check_file "$API_DIR/dist/main.js" "Backend build"
check_file "$API_DIR/.env" "Backend environment file"
check_file "$API_DIR/ecosystem.json" "Backend PM2 config"
check_file "$WEB_DIR/.next/standalone/apps/web/server.js" "Frontend standalone build"
check_file "$WEB_DIR/.env" "Frontend environment file"
check_file "$WEB_DIR/ecosystem.json" "Frontend PM2 config"
check_file "/opt/ros/jazzy/setup.bash" "ROS 2 Jazzy environment"
check_file "$ROBOT_DIR/deploy.sh" "Robot deploy script"
check_directory "$ROBOT_DIR/src/my_robot_controller" "Robot source package"
check_directory "$HOME/robot_ws/install" "Robot colcon workspace build"

if [ "$PREFLIGHT_FAILED" -ne 0 ]; then
    echo
    echo "Backend/frontend build or environment missing? Run the affected deploy script first:"
    echo "  cd $API_DIR && MONGO_URI=\"...\" ./deploy.sh"
    echo "  cd $WEB_DIR && ./deploy.sh"
    echo
    echo "The robot workspace is rebuilt by the robot deploy step below."
    fail_preflight
fi

echo

echo "[2/5] Restoring saved PM2 processes (if available)..."
pm2 resurrect >/dev/null 2>&1 || true

echo "  ✓ PM2 restore attempted"

echo

echo "[3/5] Starting backend..."
start_pm2_app "$BACKEND_NAME" "$API_DIR" "ecosystem.json"

echo

echo "[4/5] Starting frontend..."
start_pm2_app "$FRONTEND_NAME" "$WEB_DIR" "ecosystem.json"

echo

echo "[5/5] Rebuilding and starting robot..."
(cd "$ROBOT_DIR" && ./deploy.sh)

echo

echo "Saving PM2 process list..."
pm2 save

sleep 3

echo
echo "=== PM2 STATUS ==="
pm2 status

echo

PI_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
PI_IP="${PI_IP:-localhost}"
echo "Access URLs:"
echo "  Web: http://$PI_IP:3000"
echo "  API: http://$PI_IP:5000"
echo "  WS:  ws://$PI_IP:9091"
echo "  Cam: http://$PI_IP:9092"
echo
echo "Quick logs if a service is not online:"
echo "  pm2 logs $BACKEND_NAME --lines 30 --nostream"
echo "  pm2 logs $FRONTEND_NAME --lines 30 --nostream"
echo "  pm2 logs nexus-robot-web-bridge --lines 30 --nostream"
