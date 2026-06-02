#!/bin/bash
# =============================================================================
# deploy.sh — Deploy Next.js web app (apps/web) to the Pi
#
# Builds on the Pi (Pi 5 is fast enough), then restarts PM2.
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR"
MONOREPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"

SERVICE_NAME="nguyen-frontend"

echo "=== 🚀 NEXUS FRONTEND: LOCAL BUILD & DEPLOY ==="
echo "  App dir:  $APP_DIR"
echo "  Monorepo: $MONOREPO_ROOT"

cd "$MONOREPO_ROOT"

echo "[1/4] 📥 Cleaning up workspace..."
git reset --hard HEAD
git clean -fd

echo "[2/4] 📦 Installing all dependencies..."
yarn install --frozen-lockfile

echo "[3/4] 🏗️ Building Next.js (Pi 5 is fast, please wait)..."
export NEXT_PUBLIC_API_BASE_URL="${NEXT_PUBLIC_API_BASE_URL}"
export NEXT_PUBLIC_WS_URL="${NEXT_PUBLIC_WS_URL}"
export NEXT_TELEMETRY_DISABLED=1

(cd "$APP_DIR" && yarn build)

echo "[4/4] 🔄 Restarting PM2..."
mkdir -p /home/pi/.pm2/logs

pm2 delete "$SERVICE_NAME" 2>/dev/null || true

if [ -f "$APP_DIR/ecosystem.json" ]; then
    (cd "$APP_DIR" && pm2 start ecosystem.json)
else
    pm2 start yarn --name "$SERVICE_NAME" --interpreter bash -- start -p ${PORT:-3000}
fi

pm2 save

echo "----------------------------------------------"
echo "✅ DEPLOY FINISHED TRỰC TIẾP TRÊN PI!"
pm2 status "$SERVICE_NAME"
