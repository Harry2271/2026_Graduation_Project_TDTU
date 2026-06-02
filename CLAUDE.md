# CLAUDE.md — Robot for Nguyen (Multi-Project Workspace)

This workspace contains 4 projects that work together as a full-stack warehouse management + robot control system. Read the appropriate sub-project `CLAUDE.md` before working in any project directory.

---

## Projects Overview

| Directory | Role | Framework | Key Responsibility |
|---|---|---|---|
| `nguyen-tdtu/` | **Backend API** | NestJS | REST + WebSocket server. Manages packages, shelves, slots. |
| `nguyen-web-app/` | **Web Frontend** | Next.js (App Router) | Warehouse dashboard, SLAM map viewer, real-time UI. |
| `nguyen-mobile-app/` | **Mobile App** | Expo React Native | On-the-go warehouse operations, QR scanning, camera stream. |
| `robot-controller/` | **Robot Bridge** | Python / ROS 2 | WebSocket bridge for SLAM map, lidar, and pose data from the robot. |

---

## How This Workspace Is Organized

```
D:\taiLieuHoc\robot-for-nguyen\
├── CLAUDE.md                    ← You are here (multi-project index)
├── nguyen-tdtu/
│   ├── CLAUDE.md                ← NestJS backend details
│   ├── src/
│   │   ├── main.ts
│   │   ├── app.module.ts
│   │   ├── config/
│   │   ├── gateway/             ← Socket.io real-time events
│   │   └── modules/
│   │       ├── package/         ← Package CRUD
│   │       └── shelf/          ← Shelf/slot management
│   └── ...
├── nguyen-web-app/
│   ├── CLAUDE.md                ← Next.js frontend details
│   ├── src/
│   │   ├── app/                ← App Router pages
│   │   │   ├── inventory/      ← Shelf grid + package management
│   │   │   ├── map/            ← SLAM map viewer (WebSocket)
│   │   │   └── camera/         ← Robot camera feed
│   │   ├── components/
│   │   └── store/              ← Redux Toolkit + RTK Query
│   └── ...
├── nguyen-mobile-app/
│   ├── CLAUDE.md                ← Expo React Native details
│   ├── app/                    ← Expo Router pages
│   └── src/
│       ├── api/                ← Axios API client
│       ├── store/              ← Zustand state management
│       └── components/
├── robot-controller/
│   ├── CLAUDE.md                ← WebSocket robot bridge details
│   ├── docker-compose.yml
│   └── src/
│       ├── map_manager_node.py  ← ROS 2 map builder
│       └── web_bridge.py        ← WebSocket server (port 9091)
└── .github/workflows/
    └── deploy.yml              ← CI/CD pipeline
```

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Robot Hardware (Raspberry Pi 5 + Slamtec A1M8 Lidar)      │
│  ROS 2: map_manager_node.py + web_bridge.py               │
└────────────────┬────────────────────────────────────────────┘
                 │ WebSocket (ws://robot-ip:9091)
                 │ Map data, lidar points, pose, status
                 ▼
┌─────────────────────────────────────────────────────────────┐
│  nguyen-tdtu (NestJS)          nguyen-web-app (Next.js)    │
│  Port 5000                     Port 3000                    │
│  • REST API (packages, shelves)  • Warehouse dashboard      │
│  • Socket.io (real-time)         • SLAM map viewer          │
│  • MongoDB                       • Real-time sync via       │
│                                   Socket.io events          │
└────────────────┬────────────────────────────────────────────┘
                 │ REST API calls
                 ▼
┌─────────────────────────────────────────────────────────────┐
│  nguyen-mobile-app (Expo React Native)                      │
│  • Warehouse operations on the go                          │
│  • QR code scanning for packages                           │
│  • Camera stream from robot                                │
└─────────────────────────────────────────────────────────────┘
```

---

## Cross-Project Dependencies

### Shared Types Between Backend and Frontends

Package, Shelf, ShelfSlot, and SelectedCell types must be kept in sync across:
- `nguyen-tdtu/src/modules/` (backend — source of truth)
- `nguyen-web-app/src/types/` (web app)
- `nguyen-mobile-app/src/types/` (mobile app)

### Shared API Endpoints

All frontends consume the same REST API from `nguyen-tdtu`:

| Endpoint Group | Base URL |
|---|---|
| Packages CRUD | `http://localhost:5000/packages` |
| Shelves & Slots | `http://localhost:5000/shelves` |
| WebSocket Events | `http://localhost:5000` (Socket.io) |

### Real-Time Sync

`nguyen-tdtu` emits Socket.io events that both frontends subscribe to:

| Event | Effect |
|---|---|
| `package:created` | UI adds new package |
| `package:updated` | UI updates package |
| `package:deleted` | UI removes package |
| `shelf:updated` | UI updates slot status |

---

## Working Across Projects

When asked to work on a specific project, Claude Code will automatically:
1. Detect which subdirectory you're in
2. Read that project's `CLAUDE.md` for project-specific rules
3. Apply those rules while working

**If you're not sure which project to work on**, use the following guide:

| Task | Project |
|---|---|
| Add/fix REST API endpoint | `nguyen-tdtu/` |
| Add/fix web UI page or component | `nguyen-web-app/` |
| Add/fix mobile screen or feature | `nguyen-mobile-app/` |
| Fix robot map/lidar/pose WebSocket | `robot-controller/` |
| Add a feature spanning backend + frontend | Both — start with the backend first |

---

## Environment Variables Reference

### nguyen-tdtu (Backend)
```
MONGO_URI=mongodb://...        # Required — MongoDB connection
PORT=5000                      # Optional — default 5000
```

### nguyen-web-app (Frontend)
```
NEXT_PUBLIC_API_BASE_URL=http://localhost:5000   # Backend API
NEXT_PUBLIC_WS_URL=ws://robot-ip:9091           # Robot WebSocket
```

### nguyen-mobile-app (Mobile)
```
EXPO_PUBLIC_API_BASE_URL=http://localhost:5000  # Backend API
EXPO_PUBLIC_CAMERA_STREAM_URL=http://raspberry-pi:8000/stream  # Robot camera
```

### robot-controller
Configured via `docker-compose.yml` and environment variables inside the container.

---

## Common Commands

### nguyen-tdtu
```bash
cd nguyen-tdtu
yarn install
yarn start:dev     # Development
yarn build         # Production build
yarn lint
yarn test
```

### nguyen-web-app
```bash
cd nguyen-web-app
yarn install
yarn dev           # Development on port 3000
yarn build
yarn lint
```

### nguyen-mobile-app
```bash
cd nguyen-mobile-app
yarn install
yarn start         # Expo dev server
yarn android       # Android emulator
yarn ios           # iOS simulator
```

### robot-controller
```bash
cd robot-controller
docker compose up --build   # Start ROS 2 + WebSocket bridge
```

---

## Key Decisions to Know

- **Package manager:** All projects use **Yarn**. Do NOT use npm or pnpm.
- **Language:** All TypeScript projects use **strict mode**. No `any`.
- **State management:** `nguyen-tdtu` uses NestJS DI; `nguyen-web-app` uses Redux Toolkit + RTK Query; `nguyen-mobile-app` uses Zustand.
- **UI language:** All user-facing text is in **Vietnamese**.
- **Database:** Only `nguyen-tdtu` has a database (MongoDB via Mongoose). Web and mobile apps are clients only.
- **Testing:** No testing frameworks are installed in any project. Do not add tests unless explicitly requested.
- **Circular dependency:** `PackageModule` and `ShelfModule` in `nguyen-tdtu` have a circular dependency, resolved with `forwardRef`.
