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

echo "[1/7] 📥 Cleaning source tree (tracked + untracked, NOT ignored)..."
git reset --hard HEAD
git clean -fd

# .next/ is gitignored, so `git clean -fd` above does NOT remove it. A previous
# interrupted or torn `yarn build` can leave a partial .next/ — and the next
# `yarn build` runs incrementally on top of it, potentially keeping stale
# manifests and missing freshly-added routes. Symptom on the Pi was:
#   Invariant: The client reference manifest for route "/products/[id]" does not exist
#   Failed to load static file for page: /500
# i.e. exactly the kind of dangling references an incremental build leaves
# behind. Force a clean build every time.
echo "[2/7] 🧹 Removing partial .next/ and node_modules/ for a deterministic build..."
rm -rf node_modules apps/*/node_modules services/*/node_modules packages/*/node_modules
rm -rf "$APP_DIR/.next"

echo "[3/7] 📦 Installing all dependencies..."
yarn install --frozen-lockfile

echo "[4/7] 🏗️ Building Next.js (Pi 5 is fast, please wait)..."
export NEXT_PUBLIC_API_BASE_URL="${NEXT_PUBLIC_API_BASE_URL}"
export NEXT_PUBLIC_WS_URL="${NEXT_PUBLIC_WS_URL}"
export NEXT_PUBLIC_CAMERA_STREAM_URL="${NEXT_PUBLIC_CAMERA_STREAM_URL}"
export NEXT_TELEMETRY_DISABLED=1

(cd "$APP_DIR" && yarn build)

# With `output: 'standalone'`, Next.js does not copy `public/`, `.next/static`,
# or `.next/server` into the standalone output. The standalone server.js looks
# for them inside `.next/standalone/apps/web/...`. Without these copies the
# page renders but every static asset (and the favicon) returns 404, and the
# server crashes with MODULE_NOT_FOUND for middleware-manifest.json / app
# manifests, which cascades into a 500.
echo "[4b/7] 📦 Copying static assets, server manifests, and public/ into the standalone output..."
mkdir -p "$APP_DIR/.next/standalone/apps/web/.next/static"
cp -r "$APP_DIR/.next/static/." "$APP_DIR/.next/standalone/apps/web/.next/static/"
# .next/server contains middleware-manifest.json + App Router / Pages Router
# manifests the server reads at runtime. Standalone output excludes it by
# default — must be copied or the server returns 500 on every request.
mkdir -p "$APP_DIR/.next/standalone/apps/web/.next/server"
cp -r "$APP_DIR/.next/server/." "$APP_DIR/.next/standalone/apps/web/.next/server/"
if [ -d "$APP_DIR/public" ]; then
    mkdir -p "$APP_DIR/.next/standalone/apps/web/public"
    cp -r "$APP_DIR/public/." "$APP_DIR/.next/standalone/apps/web/public/"
fi

# Sanity-check the build before launching PM2. These are the files Next.js
# fails to load at runtime with the cryptic "Invariant: client reference
# manifest does not exist" / "Failed to load static file for page: /500"
# errors — a missing manifest means the build was incomplete or the copy
# step didn't include a route. Abort the deploy so CI surfaces the problem
# instead of leaving a 500-serving PM2.
echo "[4c/7] 🔎 Verifying runtime build artifacts are present in the standalone output..."
RUNTIME_REQUIRED=(
    ".next/standalone/apps/web/.next/server/middleware-manifest.json"
    ".next/standalone/apps/web/.next/server/pages/500.html"
    ".next/standalone/apps/web/.next/server/pages/404.html"
    ".next/standalone/apps/web/.next/server/app/_not-found/page_client-reference-manifest.js"
    ".next/standalone/apps/web/.next/server/app/products/[id]/page_client-reference-manifest.js"
    ".next/standalone/apps/web/.next/server/app/page_client-reference-manifest.js"
)
MISSING=0
for f in "${RUNTIME_REQUIRED[@]}"; do
    if [ ! -f "$APP_DIR/$f" ]; then
        echo "  ❌ missing: $f"
        MISSING=$((MISSING+1))
    fi
done
if [ "$MISSING" -gt 0 ]; then
    echo "❌ $MISSING runtime artifact(s) missing — build or copy step was torn. Aborting before PM2 restart."
    exit 1
fi
echo "  ✓ all ${#RUNTIME_REQUIRED[@]} runtime artifacts present"

# Sanity-check the standalone server itself.
if [ ! -f "$APP_DIR/.next/standalone/apps/web/server.js" ]; then
    echo "❌ Standalone build is missing: $APP_DIR/.next/standalone/apps/web/server.js"
    exit 1
fi

echo "[5/7] 🔄 Restarting PM2..."
mkdir -p /home/pi/.pm2/logs

pm2 delete "$SERVICE_NAME" 2>/dev/null || true

if [ -f "$APP_DIR/ecosystem.json" ]; then
    (cd "$APP_DIR" && pm2 start ecosystem.json)
else
    # Fallback: run the standalone server directly.
    PORT="${PORT:-3000}" pm2 start "$APP_DIR/.next/standalone/apps/web/server.js" --name "$SERVICE_NAME"
fi
pm2 save

# Give Next.js a moment to bind the port, then hit the health endpoint. A
# crash here usually means the standalone server can't find a manifest — fail
# loudly so CI surfaces it instead of leaving a 500-serving PM2.
echo "[6/7] 🩺 Health check..."
HEALTH_URL="http://localhost:${PORT:-3000}/"
for i in 1 2 3 4 5 6 7 8 9 10; do
    if curl -sf -o /dev/null "$HEALTH_URL"; then
        echo "  ✓ HTTP 200 on $HEALTH_URL"
        break
    fi
    if [ "$i" -eq 10 ]; then
        echo "❌ Health check failed after 10 attempts — dumping logs:"
        pm2 logs "$SERVICE_NAME" --lines 30 --nostream || true
        exit 1
    fi
    sleep 1
done

echo "[7/7] ✅ DEPLOY FINISHED!"
pm2 status "$SERVICE_NAME"
