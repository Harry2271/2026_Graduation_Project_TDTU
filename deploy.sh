#!/bin/bash
# =============================================================================
# deploy.sh — Optimized for Next.js Native Deployment on Pi 5
# =============================================================================

set -e

WORKSPACE="${GITHUB_WORKSPACE:-$(pwd)}"
SERVICE_NAME="nguyen-frontend"
MODE="${1:-auto}"

echo "=== 🚀 Deploying Frontend ($MODE mode) ==="
cd "$WORKSPACE"

# --- [BƯỚC 1] Xử lý Code & Dependencies ---
if [ "$MODE" = "manual" ]; then
    echo "[1/3] 📥 Manual mode: Pulling and Building..."
    git fetch origin master
    git reset --hard origin/master
    yarn install
    NEXT_TELEMETRY_DISABLED=1 yarn build
else
    echo "[1/3] ⬇️ Auto mode: Verifying Artifact..."
    if [ ! -d ".next" ]; then
        echo "❌ [ERROR] Folder .next NOT FOUND. Artifact transfer failed."
        exit 1
    fi
    # Cài production deps để PM2 có thể gọi 'next'
    yarn install --production --frozen-lockfile
fi

# --- [BƯỚC 2] Cấu hình Môi trường ---
echo "[2/3] ⚙️ Configuring runtime env..."
cat > .env.local << ENVEOF
PORT=${PORT:-3000}
NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL}
NEXT_PUBLIC_WS_URL=${NEXT_PUBLIC_WS_URL}
ENVEOF

# --- [BƯỚC 3] Vận hành PM2 ---
echo "[3/3] 🔄 Refreshing PM2 process..."
mkdir -p /home/pi/.pm2/logs

# Xóa cũ để đảm bảo nhận cấu hình mới từ ecosystem.json
pm2 delete "$SERVICE_NAME" 2>/dev/null || true

if [ -f "ecosystem.json" ]; then
    echo "📄 Starting with ecosystem.json..."
    pm2 start ecosystem.json
else
    echo "⚠️ No ecosystem.json, starting directly..."
    pm2 start node_modules/next/dist/bin/next --name "$SERVICE_NAME" -- start -p ${PORT:-3000}
fi

pm2 save
echo "----------------------------------------------"
echo "✅ DEPLOYMENT FINISHED!"
pm2 status "$SERVICE_NAME"