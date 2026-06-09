# Auth + Job Dispatch + Brain Wiring Design

**Date:** 2026-06-09
**Status:** Draft
**Companion to:** `docs/superpowers/plans/2026-06-07-robot-controller-brain-future-phases-notes.md` (Phases 4-5 sections)

---

## 1. Overview

Three interconnected additions to the system:

1. **Auth layer** — JWT-based API protection with user registration/approval
2. **Job dispatch (Phase 4)** — Job entity + Socket.io robot namespace + 202 response on shelf move
3. **Brain wiring (Phase 5)** — Python Socket.io client that receives jobs and walks the state machine (faked movement)

All three are designed and implemented together because they share types, Socket.io contracts, and env vars.

---

## 2. Auth Layer

### 2.1. User schema

New MongoDB collection `users`:

| Field | Type | Notes |
|---|---|---|
| `email` | string, unique, required | User's email |
| `password` | string, required | bcrypt hash |
| `approved` | boolean, default: `false` | Admin sets to `true` in DB |

No timestamps needed — admin handles users manually.

### 2.2. Endpoints

| Method | Path | Body | Response | Guard |
|---|---|---|---|---|
| POST | `/auth/register` | `{ email, password }` | 201 `{ id, email, approved }` | None |
| POST | `/auth/login` | `{ email, password }` | 200 `{ token }` | None |

- **Register:** Validate email format, check duplicate, hash password with bcrypt, create user with `approved: false`, return user info (NOT the password hash).
- **Login:** Find user by email, compare password with bcrypt hash, check `approved === true`, sign JWT with `JWT_SIGN_SECRET` from `.env`, return token.
- **JWT payload:** `{ sub: userId, email }`. No expiry (permanent token per user's request).
- **Error on login if not approved:** 403 `{ message: "Tài khoản chưa được duyệt" }` (not 401 — account exists but waiting for approval).

### 2.3. Guard

`JwtAuthGuard` (extends `@nestjs/passport` `AuthGuard('jwt')`) applied globally via `APP_GUARD` — every endpoint requires a valid JWT by default.

**Public endpoints** (no JWT required):
- `POST /auth/register`
- `POST /auth/login`
- `GET /api` (existing healthcheck)
- `GET /health` (NestJS Terminus)

Implemented via `@Public()` decorator that sets metadata, and the guard checks it.

### 2.4. New env vars

```
JWT_SIGN_SECRET=<openssl rand -hex 32>
```

Added to both:
- `apps/api/.env` (gitignored)
- GitHub Actions secrets (for deploy.yml)

---

## 3. Phase 4 — Job Entity + Robot Namespace

### 3.1. Job schema

New MongoDB collection `jobs`:

| Field | Type | Notes |
|---|---|---|
| `packageId` | ObjectId, ref Package | Package being moved |
| `fromSlotCode` | string | Source slot code |
| `toSlotCode` | string | Destination slot code |
| `status` | enum | DISPATCHED → IN_PROGRESS → COMPLETED / FAILED |
| `createdAt` | Date | auto |
| `updatedAt` | Date | auto |

```typescript
enum JobStatus {
  DISPATCHED = 'DISPATCHED',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}
```

### 3.2. Job endpoints

| Method | Path | Response | Notes |
|---|---|---|---|
| GET | `/jobs` | `{ data: Job[] }` | All jobs, newest first |
| GET | `/jobs/:id` | `{ data: Job }` | Single job detail |

### 3.3. Updated shelf endpoint — BREAKING CHANGE

`PUT /shelves/:slotCode/package` now returns:

```json
// 202 Accepted
{ "jobId": "...", "status": "dispatched" }
```

Instead of the previous 200 with the shelf slot object.

**New flow in shelf-service:**
1. Validate source slot exists + has package
2. Validate target slot exists + is empty
3. Create Job in `DISPATCHED` status
4. Set source slot to `RESERVED`, target slot to `RESERVED` (using existing `SlotStatus.RESERVED` enum)
5. Emit `job:dispatch` to robot namespace via RobotGateway
6. Return 202 `{ jobId, status: "dispatched" }`

This is a BREAKING change — the web app must handle 202 and the new response shape.

### 3.4. Robot Gateway — Socket.io `/robot` namespace

```typescript
@WebSocketGateway({ namespace: '/robot', cors: { ... } })
export class RobotGateway {
  // Single brain client connection management
  handleConnection(client: Socket) { /* validate ROBOT_BRAIN_TOKEN */ }
  handleDisconnect(client: Socket) { /* clear brain reference */ }

  // Emit to brain
  dispatchJob(job: Job): void { this.server.emit('job:dispatch', jobData); }

  // Receive from brain
  @SubscribeMessage('job:status')
  handleJobStatus(client: Socket, payload: { jobId: string; status: JobStatus }): void { /* update DB */ }
}
```

**Connection management:**
- Only one brain client at a time. If a second brain connects, the old one is disconnected.
- Validates `ROBOT_BRAIN_TOKEN` on `connection` event — client must send token in `auth` handshake data.

### 3.5. User-facing events

`EventsGateway` (existing, default namespace) emits:
- `job:created` when a job is dispatched
- `job:updated` when job status changes

These are consumed by the web app for real-time updates.

---

## 4. Phase 5 — Brain Wiring

### 4.1. New file: api_client.py

`BrainApiClient` class wrapping `python-socketio[asyncio_client]`:

```python
class BrainApiClient:
    async def connect(self) -> None
    async def disconnect(self) -> None
    async def emit_state(self, state: BrainState) -> None  # to /robot namespace
    async def emit_job_status(self, job_id: str, status: str) -> None
    def on_job_dispatch(self, callback) -> None  # register handler
```

- Connects to `API_SOCKET_URL` with `ROBOT_BRAIN_TOKEN` in auth handshake
- Namespace: `/robot`
- Reconnection: auto-reconnect with exponential backoff

### 4.2. install-pi.sh addition

```
pip3 install --break-system-packages "python-socketio[asyncio_client]"
```

### 4.3. brain_node.py updates

New methods:
- `_init_api_client()` — instantiate `BrainApiClient` on boot
- `_handle_job_dispatch(payload)` — called when `job:dispatch` received
- `_execute_job(job)` — async coroutine that walks state machine with faked movement

**State machine flow for a job** (faked movement: sleep instead of real drive):

```
IDLE → JOB_NAV_TO_PICKUP (emit IN_PROGRESS, sleep 5s)
     → JOB_NAV_TO_DROPOFF (emit job:status, sleep 5s)
     → JOB_PLACE (emit job:status, sleep 3s)
     → IDLE (emit COMPLETED)
```

**The execute_job coroutine:**
```python
async def _execute_job(self, job: dict) -> None:
    job_id = job['_id']
    try:
        self.transition_to(BrainState.JOB_NAV_TO_PICKUP, f'job {job_id}')
        await self._api_client.emit_job_status(job_id, 'IN_PROGRESS')
        # Fake: navigate_to would be called here in Phase 6
        await asyncio.sleep(5)

        self.transition_to(BrainState.JOB_NAV_TO_DROPOFF, f'job {job_id}')
        await asyncio.sleep(5)

        self.transition_to(BrainState.JOB_PLACE, f'job {job_id}')
        await asyncio.sleep(3)

        self.transition_to(BrainState.IDLE, f'job {job_id} completed')
        await self._api_client.emit_job_status(job_id, 'COMPLETED')
    except Exception as e:
        self.get_logger().error(f'job {job_id} failed: {e}')
        await self._api_client.emit_job_status(job_id, 'FAILED')
        self.transition_to(BrainState.ERROR, f'job {job_id} failed')
```

### 4.4. deploy.sh updates

```bash
export API_SOCKET_URL="${API_SOCKET_URL:-https://api.nguyen-robot.io.vn}"
export ROBOT_BRAIN_TOKEN="${ROBOT_BRAIN_TOKEN:-}"
```

These are added to the brain PM2 service environment.

---

## 5. Web App Updates

### 5.1. New env var

```
NEXT_PUBLIC_API_BASE_URL=https://api.nguyen-robot.io.vn  # already exists
```

No new public vars — JWT is managed in RTK Query interceptor, not public.

### 5.2. Login page

New route: `/login`

Simple form:
- Email input
- Password input
- Submit button
- Error/loading states

On success: store JWT in `localStorage`, redirect to `/inventory`

### 5.3. RTK Query interceptor

Add request interceptor that reads JWT from `localStorage` and attaches `Authorization: Bearer <token>` header to every request (except auth endpoints).

Add response interceptor: on 401, redirect to `/login`.

### 5.4. Inventory page update

- Handle 202 response from `PUT /shelves/:slotCode/package`
- Show toast: "Đã gửi lệnh AGV — Job #{jobId}"
- Subscribe to Socket.io `job:created`, `job:updated` events
- Show real-time job status in a table/section
- Track job lifecycle

---

## 6. New Env Vars Summary

| Variable | Where | Purpose |
|---|---|---|
| `JWT_SIGN_SECRET` | `apps/api/.env` | JWT signing secret |
| `ROBOT_BRAIN_TOKEN` | `apps/api/.env`, `services/robot/.env` | Brain↔API auth |
| `API_SOCKET_URL` | `services/robot/.env` | Brain's API endpoint |

All new vars must be added to GitHub Actions secrets and referenced in `deploy.yml`.

---

## 7. File Changes Summary

### New files (API — apps/api)

| File | Purpose |
|---|---|
| `src/modules/auth/auth.module.ts` | Auth module |
| `src/modules/auth/auth.controller.ts` | Register + login endpoints |
| `src/modules/auth/auth.service.ts` | Register/login logic |
| `src/modules/auth/auth.schema.ts` | User Mongoose schema |
| `src/modules/auth/dto/register.dto.ts` | `{ email, password }` validation |
| `src/modules/auth/dto/login.dto.ts` | `{ email, password }` validation |
| `src/modules/auth/jwt-auth.guard.ts` | JWT guard with Public decorator |
| `src/modules/auth/jwt.strategy.ts` | Passport JWT strategy |
| `src/modules/job/job.module.ts` | Job module |
| `src/modules/job/job.controller.ts` | `GET /jobs`, `GET /jobs/:id` |
| `src/modules/job/job.service.ts` | `dispatchMove()` logic |
| `src/modules/job/job.schema.ts` | Job Mongoose schema |
| `src/modules/job/dto/dispatch-move.dto.ts` | `{ packageId, fromSlotCode, toSlotCode }` |
| `src/modules/robot/robot.module.ts` | Robot gateway module |
| `src/modules/robot/robot.gateway.ts` | `/robot` Socket.io namespace |
| `src/modules/robot/robot.service.ts` | Brain client management |

### New files (Robot — services/robot)

| File | Purpose |
|---|---|
| `api_client.py` | Socket.io client for brain↔API |

### New files (Web — apps/web)

| File | Purpose |
|---|---|
| `src/app/login/page.tsx` | Login page |
| (RTK update) | Interceptor config |

### Modified files

| File | Change |
|---|---|
| `apps/api/src/app.module.ts` | Register AuthModule, JobModule, RobotModule |
| `apps/api/src/modules/shelf/shelf-controller.ts` | Return 202 instead of 200 on move |
| `apps/api/src/modules/shelf/shelf-service.ts` | Call JobService.dispatchMove instead of direct slot swap |
| `apps/api/src/gateway/events-gateway.ts` | Add `emitJobCreated`, `emitJobUpdated` |
| `apps/web/src/app/inventory/page.tsx` | Handle 202, job toast, real-time updates |
| `apps/web/src/lib/api.ts` (or RTK config) | Add JWT interceptor |
| `services/robot/src/.../brain_node.py` | API client integration + job execution |
| `services/robot/deploy.sh` | Add `API_SOCKET_URL`, `ROBOT_BRAIN_TOKEN` |
| `services/robot/install-pi.sh` | Add `python-socketio[asyncio_client]` |
| `.github/workflows/deploy.yml` | Add new secrets |
| `apps/api/CLAUDE.md` | Document new modules and env vars |
| `services/robot/CLAUDE.md` | Document API client |

---

## 8. Verification Gates

### Auth
- `POST /auth/register` → 201 user created
- `POST /auth/login` with wrong password → 401
- `POST /auth/login` with unapproved user → 403
- `POST /auth/login` with correct credentials → 200 JWT
- `GET /jobs` without JWT → 401
- `GET /api` without JWT → 200 (public)

### Job
- `POST /shelves/S1A1/package { targetSlotCode: "S2C3" }` with valid JWT → 202 `{ jobId }`
- `GET /jobs` → returns list
- `GET /jobs/:id` → returns single job

### Robot namespace
- Connect Socket.io to `/robot` with `ROBOT_BRAIN_TOKEN` → accepted
- Connect without token → rejected
- After job dispatch, `job:dispatch` event received on robot namespace

### Brain (Phase 5 — faked)
- `pm2 logs nexus-robot-brain` shows connect to API
- After dispatch, brain transitions: IDLE → JOB_NAV_TO_PICKUP → JOB_NAV_TO_DROPOFF → JOB_PLACE → IDLE
- `GET /jobs/:id` shows COMPLETED status

### Web
- `/login` page renders, login works
- Inventory page shows "Đã gửi lệnh AGV" toast
- Job status updates in real time
- Unauthenticated access redirects to `/login`
