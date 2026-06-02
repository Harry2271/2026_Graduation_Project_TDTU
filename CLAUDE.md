# CLAUDE.md — Robot for Nguyen (Monorepo)

This is a **Turborepo + yarn-workspaces** monorepo containing the full-stack Park Smart warehouse + robot control system. Four projects that used to be separate git repos now live in one repo with path-filtered CI/CD.

**Read the per-app `CLAUDE.md` before working in that app** — they carry the project-specific rules. This file covers the monorepo-level conventions and cross-cutting concerns.

---

## Projects Overview

| Directory | Role | Framework | Port | CI/CD |
|---|---|---|---|---|
| `apps/api/` | Backend API | NestJS 11 | `5000` | ✅ path-filtered |
| `apps/web/` | Web Frontend | Next.js 16 | `3000` | ✅ path-filtered |
| `apps/mobile/` | Mobile App | Expo 55 (Router) | — | ❌ none (per project decision) |
| `services/robot/` | Robot Bridge | Python / ROS 2 | `9091` (WS) | ✅ path-filtered |
| `tools/deploy/` | Manual SSH deploy toolkit | bash | — | — |
| `packages/` | Shared libraries (future) | — | — | — |

Per-app `CLAUDE.md` files: `apps/api/CLAUDE.md`, `apps/web/CLAUDE.md`, `apps/mobile/CLAUDE.md`, `services/robot/CLAUDE.md`.

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Robot Hardware (Raspberry Pi 5 + Slamtec A1M8 Lidar)      │
│  ROS 2 + web_bridge.py                                     │
└────────────────┬────────────────────────────────────────────┘
                 │ WebSocket (ws://robot-ip:9091)
                 ▼
┌─────────────────────────────────────────────────────────────┐
│  apps/api (NestJS)          apps/web (Next.js)              │
│  Port 5000                  Port 3000                       │
│  • REST API (packages, shelves)  • Warehouse dashboard      │
│  • Socket.io (real-time)         • SLAM map viewer          │
│  • MongoDB                       • Real-time sync           │
└────────────────┬────────────────────────────────────────────┘
                 │ REST API
                 ▼
┌─────────────────────────────────────────────────────────────┐
│  apps/mobile (Expo React Native)                            │
│  • On-the-go warehouse ops, QR scanning, camera stream     │
└─────────────────────────────────────────────────────────────┘
```

---

## Monorepo Commands

All commands run from the repo root.

```bash
# Install (hoists to root /node_modules)
yarn install

# Build / lint all affected apps
yarn build
yarn lint

# Run a specific app's dev server
yarn dev:api       # NestJS on :5000
yarn dev:web       # Next.js on :3000
yarn dev:mobile    # Expo dev server

# Turborepo (advanced)
yarn turbo run build --filter=@robot-for-nguyen/api
yarn turbo run lint --filter=...[origin/master]   # only affected
```

The per-app dev workflow hasn't changed — `yarn start:dev` in `apps/api/`, `yarn dev` in `apps/web/`, `yarn start` in `apps/mobile/`. Yarn workspaces resolves dependencies from the hoisted `node_modules/` at the root.

---

## CI/CD

**Two workflows, both at `.github/workflows/`:**

### `ci.yml` — Affected build
- Triggers: push to `master`, PR.
- Runs on `ubuntu-latest`.
- Uses `yarn turbo run lint build --filter=...` to build only changed apps.
- Uploads `api-dist` artifact for use by `deploy.yml`.

### `deploy.yml` — Path-filtered deploy
- Triggers: push to `master`, manual dispatch.
- Uses `dorny/paths-filter@v3` to detect which app(s) changed.
- Three jobs: `deploy-api`, `deploy-web`, `deploy-robot`. Each is gated on its own filter and runs on `self-hosted` (the Pi).
- Path filters:
  - `api` → `apps/api/**` (also `tools/deploy/**`)
  - `web` → `apps/web/**` (also `tools/deploy/**`)
  - `robot` → `services/robot/**` (also `tools/deploy/**`)
- **Mobile is intentionally not in any filter** — there is no CI/CD for it. Build via `eas build` (cloud) or `expo start` (local) using your EAS account.

**Path change examples:**

| Changed path | Jobs that run |
|---|---|
| `apps/api/src/...` | `detect` + `deploy-api` |
| `apps/web/src/...` | `detect` + `deploy-web` |
| `services/robot/src/...` | `detect` + `deploy-robot` |
| `tools/deploy/...` | `detect` + all 3 deploy jobs |
| `apps/mobile/...` | `detect` only (no deploy job gated on it) |
| `apps/web/.env` | `detect` only (env files are gitignored, this is illustrative) |

---

## Deploy Scripts

Each app has a `deploy.sh` in its own folder. The Pi's self-hosted runner is checked out at the monorepo root, then `cd`s into the app folder and runs `./deploy.sh`. The script resolves its own path with `BASH_SOURCE[0]` so it works from any invocation context.

| App | Script | What it does |
|---|---|---|
| `apps/api` | `apps/api/deploy.sh` | `yarn install --production`, write `.env` from secrets, `pm2 start ecosystem.json` |
| `apps/web` | `apps/web/deploy.sh` | `yarn install`, `yarn build` (in app), `pm2 start ecosystem.json` |
| `services/robot` | `services/robot/deploy.sh` | colcon build, PM2-managed ROS 2 nodes |

The legacy `tools/deploy/` folder keeps the manual SSH toolkit (`deploy-all.sh`, `stop-all.sh`, `install-pi.sh`, etc.) for deploys from a dev machine. These still reference the new monorepo paths.

---

## Cross-Project Conventions

These apply everywhere in the monorepo. Per-app `CLAUDE.md` files add project-specific rules on top.

- **Package manager:** Yarn (classic, 1.22.22). No npm, no pnpm.
- **Language:** TypeScript with strict mode in all Node projects. No `any`.
- **UI language:** All user-facing text is **Vietnamese** (apps/web and apps/mobile).
- **Testing:** No testing framework installed. Do not add tests unless explicitly requested.
- **Cross-project types:** `Package`, `Shelf`, `ShelfSlot`, `SelectedCell` are duplicated across apps today. A future `packages/shared-types/` is reserved for these.
- **State management:**
  - `apps/api` — NestJS DI (no frontend state)
  - `apps/web` — Redux Toolkit + RTK Query
  - `apps/mobile` — Zustand (NOT Redux)
- **Backend circular dependency:** `PackageModule` and `ShelfModule` use `forwardRef` — keep this pattern.

---

## Environment Variables

| Where | Variable | Notes |
|---|---|---|
| `apps/api/.env` | `MONGO_URI`, `PORT` | written by deploy from GitHub secrets |
| `apps/web/.env.local` | `NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_WS_URL` | set at build time, baked into the bundle |
| `apps/mobile/.env` | `EXPO_PUBLIC_API_BASE_URL`, `EXPO_PUBLIC_CAMERA_STREAM_URL` | set at build time, baked into the bundle |
| `services/robot` env | `LIDAR_MODEL` (e.g. `a1`) | set in `deploy.sh` |

`.env` files are gitignored. Per-app `.env.example` files are checked in (when present) and copied to `.env` by the deploy script.

---

## Migrating from the old polyrepo

The four old repos (`nguyen-tdtu`, `nguyen-web-app`, `nguyen-mobile-app`, `robot-controller`) were merged into this monorepo via `git subtree add`. The original git histories are preserved in the merge commits. The old repos can be archived once the team is comfortable with the monorepo.

If you need to pull new commits from an old repo into the monorepo later, use `git subtree pull --prefix=apps/api <old-repo-url-or-path> master`.

---

## File Index (monorepo-level)

| File | Purpose |
|---|---|
| `package.json` | Root — yarn workspaces, turbo scripts |
| `turbo.json` | Turborepo task graph |
| `.gitignore` | Monorepo-level ignore patterns (per-app `.gitignore` files remain) |
| `CLAUDE.md` | This file |
| `docs/superpowers/specs/2026-06-02-monorepo-restructure-design.md` | The design doc that drove this restructure |
| `.github/workflows/ci.yml` | Affected build + lint |
| `.github/workflows/deploy.yml` | Path-filtered deploy |
| `tools/deploy/` | Manual SSH toolkit (deploy-all.sh, install-pi.sh, etc.) |
