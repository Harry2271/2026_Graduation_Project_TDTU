# =============================================================================
# apps/api/Dockerfile — Multi-stage build for NestJS API
# Context: monorepo root (docker build -f apps/api/Dockerfile .)
# =============================================================================

# --- Stage 1: Install dependencies + Build ---
FROM node:20-slim AS builder

RUN corepack enable && corepack prepare yarn@1.22.22 --activate
WORKDIR /app

# Copy workspace manifests so yarn 1 can resolve the full workspace graph.
# Yarn 1 needs root package.json + all workspace package.json files.
COPY package.json yarn.lock turbo.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/mobile/package.json apps/mobile/package.json
COPY packages/.gitkeep packages/.gitkeep
COPY packages/README.md packages/README.md
COPY scripts/postinstall-hoist-next.js scripts/postinstall-hoist-next.js

# Install all deps (devDeps needed for `nest build` via swc/tsc)
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

RUN corepack enable && corepack prepare yarn@1.22.22 --activate
WORKDIR /app

# Copy workspace manifests for yarn workspace resolution
# Yarn 1 needs ALL workspace package.json files even for --production install
COPY package.json yarn.lock ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/mobile/package.json apps/mobile/package.json
COPY packages/.gitkeep packages/.gitkeep
COPY packages/README.md packages/README.md

# Install production deps only (no devDeps), skip postinstall scripts
RUN yarn install --production --frozen-lockfile --ignore-engines --ignore-scripts

# Copy build output from builder
COPY --from=builder /app/apps/api/dist apps/api/dist

WORKDIR /app/apps/api

ENV NODE_ENV=production
EXPOSE 5000

CMD ["node", "dist/main.js"]
