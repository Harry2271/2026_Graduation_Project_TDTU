#!/bin/bash
# =============================================================================
# deploy.sh — Deploy Next.js frontend to the Pi
#
# Usage:
#   ./deploy.sh          # auto: artifact already downloaded, just restart
#   ./deploy.sh manual   # manual: pull code + build on Pi
# =============================================================================

set -e

WORKSPACE="${GITHUB_WORKSPACE:-$(pwd)}"
SERVICE_NAME="nguyen-frontend"
ENV_FILE="$WORKSPACE/.env.local"
MODE="${1:-auto}"

echo "=== Deploying Frontend ($MODE mode) ==="
echo "  Workspace: $WORKSPACE"

cd "$WORKSPACE"

if [ "$MODE" = "manual" ]; then
    echo "[1/5] Pulling latest code..."
    git pull origin master
    echo "[2/5] Installing dependencies..."
    yarn install --frozen-lockfile
    echo "[3/5] Building..."
    NEXT_TELEMETRY_DISABLED=1 yarn build
    echo "[4/5] Installing production deps..."
    yarn install --production --frozen-lockfile
else
    echo "[1/3] Artifact downloaded — installing production deps..."
    yarn install --production --frozen-lockfile
fi

# Protect .env.local
if [ ! -f "$ENV_FILE" ]; then
    echo "[WARN] .env.local not found — creating default"
    cat > "$ENV_FILE" << 'ENVEOF'
NEXT_PUBLIC_API_BASE_URL=http://localhost:5000
NEXT_PUBLIC_WS_URL=ws://localhost:9091
ENVEOF
fi

echo "[5/5] Restarting with PM2..."
pm2 stop    "$SERVICE_NAME" 2>/dev/null || true
pm2 delete  "$SERVICE_NAME" 2>/dev/null || true
pm2 start   ecosystem.json --env production 2>/dev/null || \
pm2 start   "node_modules/next/dist/bin/next" --name "$SERVICE_NAME" -- start -p 3000
pm2 save

echo "=== Frontend deployed ==="
pm2 status "$SERVICE_NAME"
