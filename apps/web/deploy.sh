#!/bin/bash
set -e

SERVICE_NAME="nguyen-frontend"

echo "=== 🚀 NEXUS FRONTEND: LOCAL BUILD & DEPLOY ==="

# 1. Cập nhật code mới nhất (nếu bước checkout chưa làm sạch)
echo "[1/4] 📥 Cleaning up workspace..."
git reset --hard HEAD
git clean -fd

# 2. Cài đặt toàn bộ dependencies
echo "[2/4] 📦 Installing all dependencies..."
yarn install --frozen-lockfile

# 3. Build Next.js ngay trên Pi
echo "[3/4] 🏗️ Building Next.js (Pi 5 is fast, please wait)..."
# Truyền biến môi trường vào lúc build
export NEXT_PUBLIC_API_BASE_URL="${NEXT_PUBLIC_API_BASE_URL}"
export NEXT_PUBLIC_WS_URL="${NEXT_PUBLIC_WS_URL}"
export NEXT_TELEMETRY_DISABLED=1

yarn build

# 4. Vận hành PM2
echo "[4/4] 🔄 Restarting PM2..."
mkdir -p /home/pi/.pm2/logs

# Xóa và chạy mới để cập nhật cấu hình
pm2 delete "$SERVICE_NAME" 2>/dev/null || true

if [ -f "ecosystem.json" ]; then
    pm2 start ecosystem.json
else
    pm2 start yarn --name "$SERVICE_NAME" --interpreter bash -- start -p ${PORT:-3000}
fi

pm2 save

echo "----------------------------------------------"
echo "✅ DEPLOY FINISHED TRỰC TIẾP TRÊN PI!"
pm2 status "$SERVICE_NAME"