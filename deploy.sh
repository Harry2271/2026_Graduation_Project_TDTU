#!/bin/bash
# =============================================================================
# deploy.sh — Bản nâng cấp cho Next.js trên Pi (Native)
# =============================================================================

set -e

# Đảm bảo xử lý đúng đường dẫn
WORKSPACE="${GITHUB_WORKSPACE:-$(pwd)}"
SERVICE_NAME="nguyen-frontend"
MODE="${1:-auto}"

echo "=== 🚀 Deploying Frontend ($MODE mode) ==="
echo "📍 Workspace: $WORKSPACE"

cd "$WORKSPACE"

# --- [BƯỚC 1] Xử lý Code & Build ---
if [ "$MODE" = "manual" ]; then
    echo "[1/4] 📥 Manual mode: Fetching and Resetting code..."
    git fetch origin master
    git reset --hard origin/master
    
    echo "[2/4] 📦 Installing dependencies..."
    yarn install --frozen-lockfile
    
    echo "[3/4] 🏗️ Building Next.js (This might take a while on Pi)..."
    NEXT_TELEMETRY_DISABLED=1 yarn build
else
    echo "[1/2] ⬇️ Auto mode: Checking Artifact..."
    # Kiểm tra xem folder .next có tồn tại không
    if [ ! -d ".next" ]; then
        echo "❌ [ERROR] Thư mục .next không tồn tại! Kiểm tra lại bước Download Artifact trong GitHub Actions."
        exit 1
    fi
    echo "✅ Thư mục .next đã sẵn sàng."
fi

# --- [BƯỚC 2] Cấu hình Môi trường ---
# Lưu ý: .env.local ở đây chủ yếu phục vụ Server-side (SSR) hoặc Runtime
echo "[2/3] ⚙️ Writing .env.local for runtime..."
cat > .env.local << ENVEOF
PORT=${PORT:-3000}
NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL}
NEXT_PUBLIC_WS_URL=${NEXT_PUBLIC_WS_URL}
ENVEOF

# --- [BƯỚC 3] Vận hành PM2 ---
echo "[3/3] 🔄 Restarting with PM2..."

# Tạo folder log nếu chưa có
mkdir -p /home/pi/.pm2/logs

# Kiểm tra file ecosystem.json
if [ -f "ecosystem.json" ]; then
    echo "📄 Using ecosystem.json for startup..."
    pm2 delete "$SERVICE_NAME" 2>/dev/null || true
    pm2 start ecosystem.json --env production
else
    echo "⚠️ No ecosystem.json found, using direct yarn start..."
    pm2 delete "$SERVICE_NAME" 2>/dev/null || true
    # Ép PM2 chạy lệnh 'yarn start' với port đã định nghĩa
    pm2 start yarn --name "$SERVICE_NAME" --interpreter bash -- start -p ${PORT:-3000}
fi

# Lưu trạng thái để tự khởi động khi reboot Pi
pm2 save

echo "----------------------------------------------"
echo "✅ Frontend deployed successfully!"
pm2 status "$SERVICE_NAME"