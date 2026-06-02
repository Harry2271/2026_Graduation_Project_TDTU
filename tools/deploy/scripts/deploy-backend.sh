#!/bin/bash
# =============================================================================
# deploy-backend.sh — Deploy NestJS backend to the Pi
#
# Automated (via GitHub Actions self-hosted runner):
#   GitHub builds → downloads artifact to /home/pi/robot-for-nguyen/nguyen-tdtu
#   Then runs: yarn install --production --frozen-lockfile && pm2 restart/start
#
# Manual on the Pi:
#   Pull latest code + build + deploy (no artifact download needed)
# =============================================================================

set -e

DEPLOY_ROOT="${DEPLOY_ROOT:-/home/pi/robot-for-nguyen}"
PROJECT_DIR="$DEPLOY_ROOT/nguyen-tdtu"
SERVICE_NAME="nguyen-backend"
ENV_FILE="$PROJECT_DIR/.env"

# --- Mode: auto (artifact already downloaded) vs manual (build on Pi) ---
MODE="${1:-auto}"

echo "=== Deploying Backend ($MODE mode) ==="

if [ ! -d "$PROJECT_DIR" ]; then
    echo "[ERROR] Backend source not found at $PROJECT_DIR"
    exit 1
fi

cd "$PROJECT_DIR"

if [ "$MODE" = "manual" ]; then
    # Manual: pull code and build on Pi
    echo "[1/4] Pulling latest code..."
    git pull origin master
    echo "[2/4] Installing dependencies..."
    yarn install --frozen-lockfile
    echo "[3/4] Building..."
    yarn build
else
    # Auto: artifact is already downloaded
    echo "[1/3] Artifact downloaded — skipping build"
fi

# Write .env from env vars (secrets/vars from GitHub Actions)
# MONGO_URI must come from secrets.MONGO_URI, PORT comes from vars
if [ -z "$MONGO_URI" ]; then
    echo "[ERROR] MONGO_URI is not set — check GitHub Secrets"
    exit 1
fi
echo "[INFO] Writing .env..."
cat > "$ENV_FILE" << ENVEOF
PORT=${PORT:-5000}
MONGO_URI=${MONGO_URI}
ENVEOF

echo "[2/3] Installing production dependencies..."
yarn install --production --frozen-lockfile

echo "[3/3] Restarting with PM2..."
pm2 stop    "$SERVICE_NAME" 2>/dev/null || true
pm2 delete  "$SERVICE_NAME" 2>/dev/null || true
pm2 start   "$DEPLOY_ROOT/deploy/ecosystem-backend.json" --env production
pm2 save

echo "=== Backend deployed ==="
pm2 status "$SERVICE_NAME"
