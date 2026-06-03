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

# With `output: 'standalone'`, Next.js does not copy `public/` or
# `.next/static` into the standalone output. The standalone server.js looks
# for them inside `.next/standalone/apps/web/...`. Without these copies the
# page renders but every static asset (and the favicon) returns 404, which
# cascades into a 500.
echo "[3b/4] 📦 Copying static assets and public/ into the standalone output..."
mkdir -p "$APP_DIR/.next/standalone/apps/web/.next/static"
cp -r "$APP_DIR/.next/static/." "$APP_DIR/.next/standalone/apps/web/.next/static/"
if [ -d "$APP_DIR/public" ]; then
    mkdir -p "$APP_DIR/.next/standalone/apps/web/public"
    cp -r "$APP_DIR/public/." "$APP_DIR/.next/standalone/apps/web/public/"
fi

# Sanity-check the build before launching PM2. A missing middleware-manifest
# means `next build` failed silently — better to abort the deploy than start
# a half-broken server.
if [ ! -f "$APP_DIR/.next/server/middleware-manifest.json" ]; then
    echo "❌ Build looks incomplete: $APP_DIR/.next/server/middleware-manifest.json is missing."
    exit 1
fi
if [ ! -f "$APP_DIR/.next/standalone/apps/web/server.js" ]; then
    echo "❌ Standalone build is missing: $APP_DIR/.next/standalone/apps/web/server.js"
    exit 1
fi

echo "[4/4] 🔄 Restarting PM2..."
mkdir -p /home/pi/.pm2/logs

pm2 delete "$SERVICE_NAME" 2>/dev/null || true

if [ -f "$APP_DIR/ecosystem.json" ]; then
    (cd "$APP_DIR" && pm2 start ecosystem.json)
else
    # Fallback: run the standalone server directly.
    PORT="${PORT:-3000}" pm2 start "$APP_DIR/.next/standalone/apps/web/server.js" --name "$SERVICE_NAME"
fi

pm2 save

echo "----------------------------------------------"
echo "✅ DEPLOY FINISHED TRỰC TIẾP TRÊN PI!"
pm2 status "$SERVICE_NAME"
