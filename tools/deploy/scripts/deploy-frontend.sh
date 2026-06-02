#!/bin/bash
# =============================================================================
# deploy-frontend.sh — Deploy Next.js frontend to the Pi
#
# Automated (via GitHub Actions self-hosted runner):
#   GitHub builds → downloads artifact to /home/pi/robot-for-nguyen/nguyen-web-app
#   Then runs: yarn install --production --frozen-lockfile && pm2 restart/start
#
# Manual on the Pi:
#   Pull latest code + build + deploy (no artifact download needed)
# =============================================================================

set -e

DEPLOY_ROOT="${DEPLOY_ROOT:-/home/pi/robot-for-nguyen}"
PROJECT_DIR="$DEPLOY_ROOT/nguyen-web-app"
SERVICE_NAME="nguyen-frontend"
ENV_FILE="$PROJECT_DIR/.env.local"

MODE="${1:-auto}"

echo "=== Deploying Frontend ($MODE mode) ==="

if [ ! -d "$PROJECT_DIR" ]; then
    echo "[ERROR] Frontend source not found at $PROJECT_DIR"
    exit 1
fi

cd "$PROJECT_DIR"

if [ "$MODE" = "manual" ]; then
    echo "[1/4] Pulling latest code..."
    git pull origin master
    echo "[2/4] Installing dependencies..."
    yarn install --frozen-lockfile
    echo "[3/4] Building..."
    NEXT_TELEMETRY_DISABLED=1 yarn build
else
    echo "[1/3] Artifact downloaded — skipping build"
fi

# Write .env.local from env vars (all vars from GitHub Actions)
echo "[INFO] Writing .env.local..."
cat > "$ENV_FILE" << ENVEOF
NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL:-http://localhost:5000}
NEXT_PUBLIC_WS_URL=${NEXT_PUBLIC_WS_URL:-ws://localhost:9091}
ENVEOF

echo "[2/3] Installing production dependencies..."
yarn install --production --frozen-lockfile

echo "[3/3] Restarting with PM2..."
pm2 stop    "$SERVICE_NAME" 2>/dev/null || true
pm2 delete  "$SERVICE_NAME" 2>/dev/null || true
pm2 start   "$DEPLOY_ROOT/deploy/ecosystem-frontend.json" --env production
pm2 save

echo "=== Frontend deployed ==="
pm2 status "$SERVICE_NAME"
