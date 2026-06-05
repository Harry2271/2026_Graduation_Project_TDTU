#!/bin/bash
# =============================================================================
# deploy.sh — Deploy NestJS API (apps/api) to the Pi
#
# Builds on the Pi (matches the web app pattern in apps/web/deploy.sh) so the
# build output and runtime deps are guaranteed to be in sync. The previous
# version built in deploy.yml and then re-ran `yarn install --production` from
# deploy.sh — if those two steps disagreed, PM2 ended up pointing at a missing
# dist/main.js and crash-looped.
#
# Usage:
#   ./deploy.sh
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR"
MONOREPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"

SERVICE_NAME="nguyen-backend"
ENV_FILE="$APP_DIR/.env"

echo "=== 🚀 NEXUS BACKEND: LOCAL BUILD & DEPLOY ==="
echo "  App dir:    $APP_DIR"
echo "  Monorepo:   $MONOREPO_ROOT"

cd "$APP_DIR"

# Secrets are passed in by the GitHub Actions job — abort loudly if missing.
if [ -z "$MONGO_URI" ]; then
    echo "[ERROR] MONGO_URI is not set — check GitHub Secrets"
    exit 1
fi

echo "[1/5] 📥 Cleaning local working tree (matches web/deploy.sh)..."
git reset --hard HEAD
git clean -fd

echo "[2/5] 📦 Installing all dependencies (devDeps needed for `nest build`)..."
yarn install --frozen-lockfile

echo "[3/5] 🏗️ Building NestJS..."
yarn build

# Sanity-check the build before touching PM2. A missing dist/main.js means the
# build failed silently — better to abort than to start a half-broken process
# and crash-loop with "Cannot find module".
if [ ! -f "$APP_DIR/dist/main.js" ]; then
    echo "❌ Build looks incomplete: $APP_DIR/dist/main.js is missing."
    echo "--- dist/ contents ---"
    ls -la "$APP_DIR/dist/" 2>/dev/null || echo "(no dist directory)"
    exit 1
fi

echo "[4/5] 📥 Pruning to production dependencies..."
# dist/ is already on disk; switching to --production drops devDeps (nest, swc,
# ts-jest, etc.) so node_modules is closer to runtime size.
yarn install --production --frozen-lockfile

echo "[5/5] ✍️  Writing .env..."
cat > "$ENV_FILE" << ENVEOF
PORT=${PORT:-5000}
MONGO_URI=${MONGO_URI}
ENVEOF

echo "[6/6] 🔄 Restarting with PM2..."
mkdir -p /home/pi/.pm2/logs

pm2 stop    "$SERVICE_NAME" 2>/dev/null || true
pm2 delete  "$SERVICE_NAME" 2>/dev/null || true
pm2 start   ecosystem.json --env production
pm2 save

# Give NestJS a moment to bind the port, then check the process is alive.
# A crash-loop here means dist/main.js is broken or env vars are wrong — fail
# the deploy loudly so CI surfaces it instead of leaving a 502-serving PM2.
sleep 3
if pm2 list 2>/dev/null | grep -q "$SERVICE_NAME.*errored\| $SERVICE_NAME .*stopped"; then
    echo "❌ $SERVICE_NAME is in a failed state after deploy — dumping logs:"
    pm2 logs "$SERVICE_NAME" --lines 30 --nostream || true
    exit 1
fi

echo "=== Backend deployed ==="
pm2 status "$SERVICE_NAME"
