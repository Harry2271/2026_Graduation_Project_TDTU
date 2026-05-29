#!/bin/bash
# =============================================================================
# deploy.sh — Deploy NestJS backend to the Pi
#
# Usage:
#   ./deploy.sh          # auto: artifact already downloaded, just restart
#   ./deploy.sh manual   # manual: pull code + build on Pi
# =============================================================================

set -e

# Runner's workspace directory (actions/checkout lands here)
WORKSPACE="${GITHUB_WORKSPACE:-$(pwd)}"
SERVICE_NAME="nguyen-backend"
ENV_FILE="$WORKSPACE/.env"
MODE="${1:-auto}"

echo "=== Deploying Backend ($MODE mode) ==="
echo "  Workspace: $WORKSPACE"

cd "$WORKSPACE"

if [ "$MODE" = "manual" ]; then
    echo "[1/5] Pulling latest code..."
    git pull origin master
    echo "[2/5] Installing dependencies..."
    yarn install --frozen-lockfile
    echo "[3/5] Building..."
    yarn build
    echo "[4/5] Installing production deps..."
    yarn install --production --frozen-lockfile
else
    echo "[1/3] Artifact downloaded — installing production deps..."
    yarn install --production --frozen-lockfile
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

echo "[5/5] Restarting with PM2..."
pm2 stop    "$SERVICE_NAME" 2>/dev/null || true
pm2 delete  "$SERVICE_NAME" 2>/dev/null || true
pm2 start   ecosystem.json --env production 2>/dev/null || \
pm2 start   dist/main.js --name "$SERVICE_NAME"
pm2 save

echo "=== Backend deployed ==="
pm2 status "$SERVICE_NAME"
