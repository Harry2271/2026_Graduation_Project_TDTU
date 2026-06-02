# Monorepo Restructure + Path-Based CI/CD — Design

**Date:** 2026-06-02
**Status:** Approved (verbal approval, 2026-06-02)
**Scope:** Convert 4-project polyrepo into a single Turborepo monorepo, with GitHub Actions workflows that only run on relevant path changes.

---

## Background

The workspace `D:\taiLieuHoc\robot-for-nguyen` currently contains 4 sibling projects, each its own git repo with its own `.github/workflows/deploy.yml`, `deploy.sh`, and `node_modules/`:

| Folder | Stack | Deploy target |
|---|---|---|
| `nguyen-tdtu/` | NestJS API (port 5000) | Pi via PM2 + self-hosted runner |
| `nguyen-web-app/` | Next.js 16 (port 3000) | Pi via PM2 + self-hosted runner |
| `nguyen-mobile-app/` | Expo React Native | EAS cloud build (no Pi deploy) |
| `robot-controller/` | Python / ROS 2 | Pi via PM2 + colcon build |

Pain points:
- Cross-project type drift (Package, Shelf, ShelfSlot duplicated in 3 frontends).
- 4 separate git remotes, 4 lockfiles, 4 deploy pipelines.
- No way to atomically bump a shared dependency.
- CI runs even when an unrelated project changes.

---

## Goals

1. **One git repo** with all 4 projects under it, preserving commit history.
2. **Turborepo + yarn workspaces** for build orchestration and affected-aware CI.
3. **Path-filtered GitHub Actions** so a push that touches only `apps/api/` runs only the API pipeline.
4. **Mobile app has no CI/CD** (per request) — workflow file removed; team uses EAS dashboard or local builds.
5. **One consolidated CLAUDE.md** at the root that links to per-app rules where useful.

## Non-Goals

- No code changes to runtime behavior — this is a structural move.
- No extracting of shared types into `packages/shared-types/` yet (placeholder only).
- No test framework additions (none currently exist; not requested).

---

## Target Layout

```
robot-for-nguyen/                          ← single git repo
├── .github/
│   └── workflows/
│       ├── ci.yml                         ← lint + build affected apps (PR/push)
│       └── deploy.yml                     ← path-filtered deploy to Pi
├── apps/
│   ├── api/                               ← was nguyen-tdtu/  (NestJS, port 5000)
│   │   ├── src/
│   │   ├── test/
│   │   ├── package.json                   ← name: "@robot-for-nguyen/api"
│   │   ├── tsconfig.json, tsconfig.build.json, nest-cli.json
│   │   ├── ecosystem.json                 ← PM2 config
│   │   ├── deploy.sh                      ← GitHub Actions calls this
│   │   ├── .env.example
│   │   └── eslint.config.mjs
│   ├── web/                               ← was nguyen-web-app/  (Next.js, port 3000)
│   │   ├── src/, public/
│   │   ├── package.json                   ← name: "@robot-for-nguyen/web"
│   │   ├── next.config.ts, postcss.config.mjs
│   │   ├── ecosystem.json
│   │   ├── deploy.sh
│   │   └── .env.local.example
│   └── mobile/                            ← was nguyen-mobile-app/  (Expo, no CI/CD)
│       ├── app/, src/, assets/, scripts/
│       ├── package.json                   ← name: "@robot-for-nguyen/mobile"
│       ├── app.json, eas.json
│       └── tsconfig.json
├── services/
│   └── robot/                             ← was robot-controller/  (Python/ROS 2)
│       ├── src/                           ← map_manager_node.py, web_bridge.py
│       ├── install-pi.sh
│       ├── deploy.sh
│       └── ros2_launch/
├── tools/
│   └── deploy/                            ← was root deploy/  (manual SSH toolkit)
│       ├── README.md
│       ├── ecosystem-backend.json
│       ├── ecosystem-frontend.json
│       ├── install-pi.sh
│       ├── start-robot.sh
│       └── stop-all.sh
├── packages/                              ← empty for now; .gitkeep
│   └── .gitkeep
├── _test_ssh.bat                          ← kept at root
├── .gitignore                             ← consolidated
├── package.json                           ← root, yarn workspaces + turbo scripts
├── turbo.json                             ← Turborepo task graph
├── yarn.lock                              ← single combined lockfile
└── CLAUDE.md                              ← consolidated
```

---

## Git Migration

Each of the 4 existing repos is a separate git history. We preserve all of them via `git subtree add` from local paths:

1. `git init` at monorepo root.
2. `git subtree add --prefix=apps/api ../nguyen-tdtu master` (or branch name).
3. Same for `apps/web`, `apps/mobile`, `services/robot`.
4. After all 4 are merged, delete the original 4 `.git/` folders and the original project folders (they're now inside the monorepo).

If `git subtree add` fails because the upstream branches don't exist, fall back to `git subtree add --prefix=<dir> <repo-path> HEAD` or import via `git fast-import` from a bundle.

**Limitation acknowledged:** `git subtree add` from a local path requires either the branch exists in the source repo, or we use `HEAD`. We'll detect and adapt at implementation time.

---

## CI/CD Design

### `ci.yml` — affected build

- Triggers: `push` to `master`, `pull_request`.
- Runs on `ubuntu-latest` (no Pi needed for build/lint).
- Steps: checkout, setup node 24, `yarn install --frozen-lockfile`, `yarn turbo run lint build --filter=...[origin/master]`.
- Result: only changed apps (per Turborepo's affected detection) get linted and built.

### `deploy.yml` — path-filtered deploy

- Triggers: `push` to `master`, `workflow_dispatch`.
- Job `detect` uses `dorny/paths-filter@v3` to produce boolean outputs for `api`, `web`, `robot`.
- Three separate jobs `deploy-api`, `deploy-web`, `deploy-robot` each gated on the corresponding filter output, run on `self-hosted` (the Pi), and execute the per-app `deploy.sh`.
- Path filters:
  - `api`: `apps/api/**`
  - `web`: `apps/web/**`
  - `robot`: `services/robot/**`
- `apps/mobile/**` triggers nothing — no CI/CD per request.
- `tools/deploy/**` is treated as a shared-scripts change. Filter: any of the three services should re-deploy if a shared script changes (we'll re-run all three when `tools/deploy/**` changes, or include it in each service's filter as a "deploy trigger").

### Removed

- The 4 existing `.github/workflows/deploy.yml` files inside each subproject.
- The mobile CI workflow (lint + EAS build) — removed per request.

### Path-change strategy

- **Builds:** Turborepo's `--filter=...[origin/master]` handles affected detection.
- **Deploys:** `dorny/paths-filter` handles "which service changed" — simpler and more explicit than affected-graph for deploys.

---

## Per-app `deploy.sh`

Each app keeps its own `deploy.sh` (moved from the existing per-project `deploy.sh`). Differences from the current state:

- They now live in the app folder, not the project root.
- They receive a `DEPLOY_ROOT` env var pointing to the monorepo root on the Pi (e.g., `/home/pi/robot-for-nguyen`).
- They `cd` into their own folder (e.g., `apps/api`) and operate from there.
- They use the local `ecosystem.json` (also moved into the app folder).
- They write `.env` from GitHub Actions secrets/vars as before.

`tools/deploy/` keeps the manual SSH-deploy toolkit (for `deploy-all.sh`, `stop-all.sh`, `start-robot.sh`, etc.) — the scripts there still reference the new monorepo paths.

---

## Turborepo configuration

### `turbo.json`

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**", ".next/**", "!.next/cache/**"] },
    "lint": {},
    "dev":   { "cache": false, "persistent": true },
    "deploy":{ "cache": false }
  }
}
```

### Root `package.json`

```json
{
  "name": "robot-for-nguyen",
  "private": true,
  "workspaces": ["apps/*", "services/*", "packages/*"],
  "scripts": {
    "build":    "turbo run build",
    "lint":     "turbo run lint",
    "dev":      "turbo run dev",
    "dev:api":  "turbo run dev --filter=@robot-for-nguyen/api",
    "dev:web":  "turbo run dev --filter=@robot-for-nguyen/web",
    "dev:mobile": "turbo run dev --filter=@robot-for-nguyen/mobile"
  },
  "devDependencies": { "turbo": "latest" },
  "packageManager": "yarn@1.22.22"
}
```

Note: `services/robot` is in workspaces for `git subtree` consistency, but Turborepo will skip it (no `package.json` with a `build` script).

### App `package.json` renames

| Old | New |
|---|---|
| `nguyen-tdtu` | `@robot-for-nguyen/api` |
| `nguyen-web-app` | `@robot-for-nguyen/web` |
| `nguyen-mobile-app` | `@robot-for-nguyen/mobile` |
| (no `package.json`) | `services/robot` is not renamed (Python) |

### Per-app `dev` script

Each app needs a `dev` script in its `package.json` so `turbo run dev --filter=<name>` works:

- `api`: `"dev": "nest start --watch"`
- `web`: `"dev": "next dev -p 3000"`
- `mobile`: `"dev": "expo start"`

---

## CLAUDE.md consolidation

Replace the 4 project-level `CLAUDE.md` files with one root `CLAUDE.md` that:

- Describes the monorepo layout (apps, services, packages, tools).
- Links to per-app rules: `apps/api/CLAUDE.md`, `apps/web/CLAUDE.md`, `apps/mobile/CLAUDE.md`, `services/robot/CLAUDE.md`.
- Documents yarn workspace commands and the path-based CI/CD.
- Carries forward the cross-project conventions: yarn only, no `any`, strict TS, Vietnamese UI, no test frameworks unless requested, circular-dep note for `package`/`shelf` modules.

The per-app `CLAUDE.md` files keep their project-specific rules (NestJS module layout, Redux patterns, Expo patterns, ROS architecture).

---

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| `git subtree add` from local paths may fail if source branches are not named `master` | Detect actual default branch and use it. Fallback to `HEAD`. |
| Renaming `package.json` `name` fields breaks cross-project imports | There are no cross-project imports today (each app is self-contained). All `name` fields are local. |
| `next.config.ts` or `nest-cli.json` reference absolute paths | Audit before moving; fix any project-relative references. |
| Mobile loses EAS CI; team may forget how to build | Update CLAUDE.md + add a README note in `apps/mobile/`. |
| Turborepo's affected filter requires `git log` to be available | The CI workflow checks out with full history (`fetch-depth: 0`). |

---

## Open decisions (resolved during brainstorming)

- ✅ Monorepo tool: **Turborepo**
- ✅ Folder structure: **Turborepo convention** (`apps/`, `services/`, `packages/`)
- ✅ Git migration: **git subtree add** (preserve history)
- ✅ Deploy strategy: **Per-app `deploy.sh` + Turborepo**
- ✅ Existing files: **Move `deploy/` → `tools/deploy/`, move `deploy.sh` into each app, consolidate CLAUDE.md**
- ✅ Mobile CI/CD: **Removed**
