# =============================================================================
# apps/api/Dockerfile — Multi-stage build for NestJS API (optimized for API-only)
# Context: monorepo root (docker build -f apps/api/Dockerfile .)
# =============================================================================

# --- Stage 1: Install dependencies + Build ---
FROM node:20-slim AS builder

RUN corepack enable && corepack prepare yarn@1.22.22 --activate
WORKDIR /app

# Copy workspace manifests — prune to API only to avoid installing mobile/web deps
COPY package.json yarn.lock turbo.json ./
COPY apps/api/package.json apps/api/package.json

# Rewrite root package.json to only reference the API workspace and remove postinstall
# This prevents yarn from installing mobile/web dependencies (saves ~4 minutes)
RUN node -e "const pkg=require('./package.json'); pkg.workspaces=['apps/api']; delete pkg.scripts.postinstall; require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2));"

# Install only API deps (devDeps needed for `nest build`)
RUN yarn install --frozen-lockfile --ignore-engines

# Copy API source
COPY apps/api/ apps/api/

# Build
WORKDIR /app/apps/api
RUN yarn build

# Verify build output exists
RUN test -f dist/main.js || (echo "BUILD FAILED: dist/main.js missing" && exit 1)

# --- Stage 2: Production runtime ---
FROM node:20-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user (nodejs user exists in node:slim but is locked)
RUN groupadd -g 1001 nodejs && useradd -u 1001 -g nodejs -s /bin/sh -m nodejs

RUN corepack enable && corepack prepare yarn@1.22.22 --activate
WORKDIR /app

# Copy workspace manifests — prune to API only
COPY package.json yarn.lock ./
COPY apps/api/package.json apps/api/package.json

# Rewrite root package.json to only reference the API workspace and remove postinstall
RUN node -e "const pkg=require('./package.json'); pkg.workspaces=['apps/api']; delete pkg.scripts.postinstall; require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2));"

# Install production deps only (no devDeps), skip postinstall scripts
RUN yarn install --production --frozen-lockfile --ignore-engines --ignore-scripts

# Copy build output from builder
COPY --from=builder /app/apps/api/dist apps/api/dist

# Fix ownership so the non-root user can read the app
RUN chown -R nodejs:nodejs /app

WORKDIR /app/apps/api

ENV NODE_ENV=production
EXPOSE 5000

# Run as non-root
USER nodejs

CMD ["node", "dist/main.js"]
