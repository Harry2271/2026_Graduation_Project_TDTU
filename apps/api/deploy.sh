#!/bin/bash
# =============================================================================
# deploy.sh — Deploy NestJS API (apps/api) to the Pi
#
# Usage:
#   ./deploy.sh          # auto: artifact already downloaded, just restart
#   ./deploy.sh manual   # manual: pull code + build on Pi
# =============================================================================

set -e

# Resolve the app folder regardless of where the script was invoked from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR"
MONOREPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"

SERVICE_NAME="nguyen-backend"
ENV_FILE="$APP_DIR/.env"
MODE="${1:-auto}"

echo "=== Deploying Backend ($MODE mode) ==="
echo "  App dir:    $APP_DIR"
echo "  Monorepo:   $MONOREPO_ROOT"

cd "$APP_DIR"

if [ "$MODE" = "manual" ]; then
    echo "[1/5] Pulling latest code..."
    git -C "$MONOREPO_ROOT" pull origin master
    echo "[2/5] Installing dependencies..."
    (cd "$MONOREPO_ROOT" && yarn install --frozen-lockfile)
    echo "[3/5] Building API..."
    (cd "$APP_DIR" && yarn build)
    echo "[4/5] Installing production deps..."
    (cd "$MONOREPO_ROOT" && yarn install --production --frozen-lockfile)
else
    echo "[1/3] Artifact downloaded — installing production deps..."
    (cd "$MONOREPO_ROOT" && yarn install --production --frozen-lockfile)
fi

# Write .env from env vars (secrets/vars from GitHub Actions)
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
mkdir -p /home/pi/.pm2/logs
pm2 stop    "$SERVICE_NAME" 2>/dev/null || true
pm2 delete  "$SERVICE_NAME" 2>/dev/null || true
pm2 start   ecosystem.json --env production
pm2 save

echo "=== Backend deployed ==="
pm2 status "$SERVICE_NAME"
