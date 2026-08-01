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

echo "[1/7] 📥 Cleaning local working tree (matches web/deploy.sh)..."
git reset --hard HEAD
git clean -fd

echo "[2/7] 🧹 Removing partial node_modules (defense against torn installs)..."
# A previous interrupted `yarn install` can leave a node_modules/ where some
# nested files are missing — e.g. iconv-lite/encodings/, mongoose/lib/document.js.
# That breaks runtime lazy requires with cryptic 400/500 errors at request time.
# Force a full re-install on every deploy so the state on disk is always
# deterministic. This is the same pattern the root `yarn clean` script uses.
rm -rf node_modules apps/*/node_modules services/*/node_modules packages/*/node_modules

echo "[3/7] 📦 Installing all dependencies (devDeps needed for `nest build`)..."
yarn install --frozen-lockfile

echo "[4/7] 🏗️ Building NestJS..."
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

# Sanity-check the runtime node_modules. These are files known to vanish when
# yarn install is interrupted mid-flight; if any are missing, the next POST/PUT
# (body-parser → iconv-lite) or any Mongoose schema operation (mongoose/lib/
# document) will throw MODULE_NOT_FOUND at request time. Fail loudly here
# instead of leaving a 500-serving PM2.
echo "[4b/7] 🔎 Verifying runtime node_modules is complete..."
RUNTIME_REQUIRED=(
    "node_modules/iconv-lite/encodings/index.js"
    "node_modules/iconv-lite/package.json"
    "node_modules/mongoose/lib/document.js"
    "node_modules/mongoose/package.json"
    "node_modules/body-parser/index.js"
    "node_modules/raw-body/index.js"
)
MISSING=0
for f in "${RUNTIME_REQUIRED[@]}"; do
    if [ ! -f "$MONOREPO_ROOT/$f" ]; then
        echo "  ❌ missing: $f"
        MISSING=$((MISSING+1))
    fi
done
if [ "$MISSING" -gt 0 ]; then
    echo "❌ $MISSING runtime file(s) missing — node_modules install was torn. Aborting before PM2 restart."
    exit 1
fi
echo "  ✓ all ${#RUNTIME_REQUIRED[@]} runtime files present"

echo "[5/7] 📥 Pruning to production dependencies..."
# dist/ is already on disk; switching to --production drops devDeps (nest, swc,
# ts-jest, etc.) so node_modules is closer to runtime size.
yarn install --production --frozen-lockfile

# Re-verify after prune — yarn shouldn't drop our runtime files (they're
# production deps), but check anyway in case the lockfile is wrong.
for f in "${RUNTIME_REQUIRED[@]}"; do
    if [ ! -f "$MONOREPO_ROOT/$f" ]; then
        echo "❌ Runtime file disappeared after --production prune: $f"
        echo "    Likely cause: lockfile marks the parent package as devDependency."
        exit 1
    fi
done

echo "[6/7] ✍️  Writing .env..."
cat > "$ENV_FILE" << ENVEOF
PORT=${PORT:-5000}
MONGO_URI=${MONGO_URI}
ENVEOF

echo "[7/7] 🔄 Restarting with PM2..."
mkdir -p /home/pi/.pm2/logs

pm2 stop    "$SERVICE_NAME" 2>/dev/null || true
pm2 delete  "$SERVICE_NAME" 2>/dev/null || true
pm2 start   ecosystem.json --env production --cwd "$APP_DIR"
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
