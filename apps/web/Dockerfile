# =============================================================================
# apps/web/Dockerfile — Multi-stage build for Next.js standalone
# Context: monorepo root (docker build -f apps/web/Dockerfile .)
#
# NEXT_PUBLIC_* vars are build-time ARGs (baked into JS bundles).
# =============================================================================

# --- Stage 1: Install dependencies + Build ---
FROM node:20-slim AS builder

RUN corepack enable && corepack prepare yarn@1.22.22 --activate
WORKDIR /app

# Copy workspace manifests for yarn 1 workspace resolution
COPY package.json yarn.lock turbo.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/mobile/package.json apps/mobile/package.json
COPY packages/.gitkeep packages/.gitkeep
COPY packages/README.md packages/README.md
COPY scripts/postinstall-hoist-next.js scripts/postinstall-hoist-next.js

# Install all deps
RUN yarn install --frozen-lockfile --ignore-engines

# Copy web app source
COPY apps/web/ apps/web/

# Build with NEXT_PUBLIC_* vars baked into client JS bundles
ARG NEXT_PUBLIC_API_BASE_URL
ARG NEXT_PUBLIC_WS_URL
ARG NEXT_PUBLIC_CAMERA_STREAM_URL

ENV NEXT_TELEMETRY_DISABLED=1

WORKDIR /app/apps/web
RUN NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL \
    NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL \
    NEXT_PUBLIC_CAMERA_STREAM_URL=$NEXT_PUBLIC_CAMERA_STREAM_URL \
    yarn build

# Post-build: copy static assets, server manifests, and public/ into standalone
# (replicates apps/web/deploy.sh lines 56-66)
RUN cp -r .next/static/. .next/standalone/apps/web/.next/static/ \
    && cp -r .next/server/. .next/standalone/apps/web/.next/server/ \
    && if [ -d public ]; then \
         cp -r public/. .next/standalone/apps/web/public/; \
       fi

# Verify standalone output
RUN test -f .next/standalone/apps/web/server.js || \
    (echo "BUILD FAILED: standalone server.js missing" && exit 1)

# --- Stage 2: Production runtime ---
FROM node:20-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd -g 1001 nodejs && useradd -u 1001 -g nodejs -s /bin/sh -m nodejs

WORKDIR /app

# Copy the standalone output (the only thing needed at runtime)
COPY --from=builder /app/apps/web/.next/standalone/ ./

# Fix ownership so non-root user can read app
RUN chown -R nodejs:nodejs /app

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV NEXT_TELEMETRY_DISABLED=1

EXPOSE 3000

# Run as non-root
USER nodejs

CMD ["node", "apps/web/server.js"]
