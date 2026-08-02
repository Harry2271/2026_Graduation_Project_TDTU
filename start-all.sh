#!/bin/bash
# =============================================================================
# start-all.sh — Start ALL services on the Pi (recovery command)
#
# Single command to bring everything back up after a Pi reboot or network
# outage. Pulls latest code (best-effort), then:
#   1. Builds + starts Docker containers for API + Web
#   2. Starts the robot service via services/robot/start.sh
#
# Usage:
#   ./start-all.sh              # pull code + start everything
#   ./start-all.sh --skip-git   # offline mode (skip git pull)
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

SKIP_GIT=false
if [ "${1:-}" = "--skip-git" ]; then
    SKIP_GIT=true
fi

echo "=============================================="
echo "  NEXUS ALL-IN-ONE START"
echo "  Host: $(hostname 2>/dev/null || echo 'unknown')"
echo "  Time: $(date)"
echo "=============================================="
echo ""

# --- [1] Git pull (best-effort, never fails) ---
if [ "$SKIP_GIT" = false ]; then
    echo "[1/4] Pulling latest code..."
    if git pull --ff-only 2>/dev/null; then
        echo "  ✓ Code is up to date."
    else
        echo "  ⚠️  WARNING: git pull failed (network may be down). Using existing code."
    fi
else
    echo "[1/4] Skipping git pull (--skip-git flag)"
fi
echo ""

# --- [2] Check API .env ---
echo "[2/4] Checking environment files..."
if [ ! -f apps/api/.env ]; then
    echo "  ⚠️  WARNING: apps/api/.env does not exist."
    if [ -f apps/api/.env.example ]; then
        cp apps/api/.env.example apps/api/.env
        echo "  apps/api/.env created from .env.example"
        echo "  ❗ EDIT IT with real secrets before relying on this deployment!"
    else
        echo "  ❌ ERROR: apps/api/.env.example not found. Cannot bootstrap."
    fi
else
    echo "  ✓ apps/api/.env exists"
fi
echo ""

# --- [3] Docker containers for API + Web ---
echo "[3/4] Starting Docker containers..."
if ! command -v docker >/dev/null 2>&1; then
    echo "  ❌ ERROR: Docker is not installed!"
    echo "  Install Docker: curl -fsSL https://get.docker.com | sh"
    echo "  Then add user to docker group: sudo usermod -aG docker \$USER"
    exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
    echo "  ❌ ERROR: docker compose plugin not available!"
    exit 1
fi

docker compose up -d --build
echo "  ✓ Docker containers started."
echo ""

# --- [4] Robot service ---
echo "[4/4] Starting robot service..."
if [ -f services/robot/start.sh ]; then
    bash services/robot/start.sh
else
    echo "  ⚠️  WARNING: services/robot/start.sh not found, skipping robot start."
fi
echo ""

# --- Status summary ---
echo "=============================================="
echo "  ALL SERVICES STARTED"
echo "=============================================="
echo ""

echo "📦 Docker containers:"
docker compose ps 2>/dev/null || docker ps --filter "name=nguyen" --format "table {{.Names}}\t{{.Status}}" 2>/dev/null || true
echo ""

echo "🤖 Robot PM2 processes:"
if command -v pm2 >/dev/null 2>&1; then
    pm2 list 2>/dev/null | grep "nexus-robot" || echo "  (no robot processes found)"
else
    echo "  (pm2 not installed)"
fi
echo ""

PI_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
PI_IP="${PI_IP:-localhost}"
echo "🌐 Access URLs:"
echo "  API:     http://$PI_IP:5000"
echo "  Web:     http://$PI_IP:3000"
echo "  WS:      ws://$PI_IP:9091"
echo "  Camera:  http://$PI_IP:9092"
echo ""
echo "📋 Quick logs:"
echo "  docker compose logs -f api"
echo "  docker compose logs -f web"
echo "  pm2 logs nexus-robot-web-bridge --lines 20 --nostream"