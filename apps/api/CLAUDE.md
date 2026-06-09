# CLAUDE.md - Park Smart API Development Guide

> Comprehensive development guide for the NestJS "Park Smart" warehouse/package management backend.

---

## Project Overview

**Name:** `nguyen-tdtu` — Park Smart API
**Type:** NestJS REST API + WebSocket backend
**Purpose:** Manage warehouse shelves and packages for an automated robot system (Tran Duc Nguyen)
**Database:** MongoDB via Mongoose ODM
**Port:** `5000` (configurable via `PORT` env var, defaults to `5000`)
**Frontend:** React/Next.js app at `https://web.nguyen-robot.io.vn`

---

## Tech Stack

| Category        | Library/Framework                     |
| --------------- | ------------------------------------ |
| Runtime         | Node.js                              |
| Framework       | NestJS v11                           |
| Language        | TypeScript 5.7 (strict mode)         |
| Database        | MongoDB + Mongoose v8                |
| Config          | `@nestjs/config` + `dotenv`          |
| Validation      | `class-validator` + `class-transformer` |
| API Docs        | Swagger (`@nestjs/swagger`)          |
| WebSocket       | Socket.io (`@nestjs/websockets`)     |
| HTTP Client     | `@nestjs/axios`                     |
| Health Check    | `@nestjs/terminus`                   |
| Scheduler      | `@nestjs/schedule`                   |
| Package Manager | Yarn                                 |

---

## Architecture

### Layered Architecture (Controller → Service → Repository)

All modules follow strict separation of concerns:

```
HTTP Request
    │
    ▼
Controller     ← Handles request/response, delegates to service. Zero business logic.
    │
    ▼
Service         ← Business logic, orchestration, validation of domain rules.
    │
    ▼
Repository      ← Data access only (Mongoose queries). No business logic.
```

### Module Structure

Every module lives in `src/modules/<module-name>/` with this layout:

```
<module>/
├── dto/
│   ├── create-<module>.dto.ts    ← POST body validation
│   ├── update-<module>.dto.ts    ← PATCH/PUT body validation
│   └── <other>.dto.ts            ← Query, params, response DTOs
├── interfaces/
│   ├── <module>-repository.interface.ts  ← Repository contract
│   └── <module>-service.interface.ts    ← Service contract
├── schemas/
│   └── <module>.schema.ts        ← Mongoose schema + document type
├── <module>-controller.ts        ← HTTP endpoints
├── <module>-service.ts           ← Business logic
├── <module>-repository.ts        ← Data access
└── <module>.module.ts            ← NestJS module wiring
```

### Module Inventory

| Module     | Purpose                                          | Key Entities              |
| ---------- | ------------------------------------------------ | ------------------------- |
| `app`      | Root module — health check endpoint              | `AppController`, `AppService` |
| `gateway`  | Global WebSocket broadcast (Socket.io)           | `EventsGateway`           |
| `package`  | Package CRUD + pagination                        | `Package`, `PackageController`, `PackageService`, `PackageRepository` |
| `shelf`    | Shelf/slot management + package placement/moving | `Shelf`, `ShelfSlot`, `ShelfController`, `ShelfService`, `ShelfRepository` |

---

## Operational Commands

```bash
# Install dependencies
yarn install

# Development (watch mode with hot reload)
yarn start:dev

# Build for production
yarn build

# Start production build
yarn start:prod

# Lint with ESLint
yarn lint

# Auto-fix lint issues
yarn lint --fix

# Format code with Prettier
yarn format

# Run unit tests
yarn test

# Run tests in watch mode
yarn test --watch

# Run e2e tests
yarn test:e2e
```

---

## API Endpoints

### App (Root)

| Method | Path       | Description         |
| ------ | ---------- | ------------------- |
| GET    | `/`        | Health check — returns "Hello World!" |
| GET    | `/api/docs` | Swagger UI         |
| GET    | `/api/docs.json` | OpenAPI JSON spec |

### Packages (`/packages`)

| Method | Path        | Description                      | Status Codes |
| ------ | ----------- | -------------------------------- | ------------ |
| POST   | `/packages` | Create a new package             | 201, 400     |
| GET    | `/packages` | List all packages (paginated)    | 200          |
| GET    | `/packages/:id` | Get package by ID            | 200, 404     |
| PUT    | `/packages/:id` | Update package by ID           | 200, 404     |
| DELETE | `/packages/:id` | Delete package (also clears slot) | 204, 404   |

**Pagination query params (GET `/packages`):**
- `page` — 1-based page number (default: `1`)
- `limit` — items per page (default: `10`, max: `100`)

**Response shape:**
```json
{
  "items": [...],
  "meta": {
    "total": 42,
    "page": 1,
    "limit": 10,
    "hasNext": true
  }
}
```

### Shelves (`/shelves`)

| Method | Path                      | Description                          | Status Codes |
| ------ | ------------------------- | ------------------------------------ | ------------ |
| GET    | `/shelves`                | List all shelves (S1–S4)             | 200          |
| GET    | `/shelves/slots`          | List all slots across all shelves     | 200          |
| GET    | `/shelves/:shelfCode/slots` | List slots for a specific shelf    | 200          |
| POST   | `/shelves/:slotCode/package` | Assign a package to a slot        | 201, 400, 404 |
| PUT    | `/shelves/:slotCode/package` | Move package to another slot     | 200, 400, 404 |
| DELETE | `/shelves/:slotCode/package` | Remove package from a slot       | 204, 400, 404 |
| PUT    | `/shelves/:slotCode/coordinates` | Set (slotX, slotY, facingTheta) | 200, 400, 404 |
| PUT    | `/shelves/coordinates/batch` | Bulk-set coordinates (Calibrate) | 200, 400 |
| PUT    | `/shelves/:slotCode/april-tag` | Assign fixed AprilTag ID (0..586) | 200, 400, 404 |
| GET    | `/shelves/april-tag/:aprilTagId` | Lookup slot by AprilTag (robot vision) | 200, 404 |

### Robot Maps (`/api/robot`)

| Method | Path                      | Description                          | Status Codes |
| ------ | ------------------------- | ------------------------------------ | ------------ |
| GET    | `/api/robot/map-image`    | Latest saved SLAM map (PGM)          | 200, 404 |
| GET    | `/api/robot/map-image/:name` | Specific named map                | 200, 404 |

**Slot codes follow the pattern:** `{shelf}{row}{column}` — e.g., `S1A1`, `S2D4`.
- Shelf codes: `S1`, `S2`, `S3`, `S4`
- Row letters: `A`, `B`, `C`, `D`
- Columns: `1`–`4`
- Total slots: 4 shelves × 4 rows × 4 columns = **64 slots**

**Slot status enum (`SlotStatus`):**
- `AVAILABLE` — slot is empty and ready for assignment
- `OCCUPIED` — slot contains a package
- `RESERVED` — robot job created; package still at previous slot
- `TRANSIT` — package is on the robot (in transit between slots)

**Slot coordinates (Calibrate):** each slot may carry a `(slotX, slotY, facingTheta)` triple and an `aprilTagId` (0..586). All four are set via the Calibrate page (`/calibrate`):
- `PUT /shelves/:slotCode/coordinates` — single slot
- `PUT /shelves/coordinates/batch` — bulk
- `PUT /shelves/:slotCode/april-tag` — assign fixed AprilTag ID
- `GET /shelves/april-tag/:aprilTagId` — robot-vision lookup

`aprilTagId` has a partial unique index (only when present) so the 64 seeded slots can coexist with `aprilTagId: null`.

---

## WebSocket Events

`EventsGateway` (`src/gateway/events-gateway.ts`) broadcasts real-time updates via Socket.io on the same server port (`5000`).

| Event Name           | Payload                              | Triggered By           |
| -------------------- | ------------------------------------ | ---------------------- |
| `package:created`    | Created `Package` object             | `PackageService.create()` |
| `package:updated`    | Updated `Package` object             | `PackageService.update()` |
| `package:deleted`    | Deleted package ID (string)         | `PackageService.remove()` |
| `shelf:updated`      | Updated `ShelfSlot` object or partial | `ShelfService` slot mutations |

**CORS origins (WebSocket):** `https://web.nguyen-robot.io.vn`, `http://localhost:3000`, `http://localhost:8081`

---

## Database Schema Reference

### Package (`packages` collection)

```typescript
{
  _id: ObjectId,          // auto-generated
  packageName: string,     // required, max 255 chars
  createdAt: Date,        // auto (Mongoose timestamps)
  updatedAt: Date,        // auto (Mongoose timestamps)
}
```

### Shelf (`shelves` collection)

```typescript
{
  _id: ObjectId,
  code: string,           // "S1", "S2", "S3", "S4" — unique
  rows: number,           // 4
  columns: number,        // 4
  totalSlots: number,     // 16
  createdAt: Date,
  updatedAt: Date,
}
```

### ShelfSlot (`shelfslots` collection)

```typescript
{
  _id: ObjectId,
  code: string,           // "S1A1" through "S4D4" — unique
  shelf: string,         // "S1"–"S4"
  row: string,            // "A"–"D"
  column: number,         // 1–4
  status: SlotStatus,    // AVAILABLE | OCCUPIED | RESERVED | TRANSIT
  packageId: ObjectId | null,  // ref to Package
  slotX?: number,         // meters in SLAM map frame (set during Calibrate)
  slotY?: number,         // meters in SLAM map frame (set during Calibrate)
  facingTheta?: number,   // radians, yaw the robot must face when stopped here
  aprilTagId?: number,    // 0..586, fixed physical tag ID (set during Calibrate)
  createdAt: Date,
  updatedAt: Date,
}
```

**Shelf initialization:** On app startup (`ShelfService.onModuleInit`), if no shelves exist in DB, the service auto-creates 4 shelves and 64 slots. This is a one-time seed — subsequent restarts skip initialization.

---

## CORS Configuration

Both REST and WebSocket CORS are restricted to:

```
https://web.nguyen-robot.io.vn
http://localhost:3000
http://localhost:8081
```

Allowed methods: `GET`, `POST`, `PUT`, `DELETE`, `PATCH`
Allowed headers: `Content-Type`, `Authorization`
Credentials: `true`

---

## Global Middleware & Pipes

### ValidationPipe (Global)

Applied to all routes via `app.useGlobalPipes()` in `main.ts`:

- `whitelist: true` — strips fields not defined in DTOs
- `forbidNonWhitelisted: true` — rejects requests with unknown fields
- `transform: true` — coerces query param types (e.g., strings → numbers)

---

## Dependency Injection Patterns

### String Injection Tokens (for Interfaces)

TypeScript interfaces are erased at runtime. NestJS requires a token to resolve interface dependencies. The pattern used throughout:

```typescript
// interfaces/package-repository.interface.ts
export const IPACKAGE_REPOSITORY = 'IPACKAGE_REPOSITORY';
export interface IPackageRepository { ... }
```

```typescript
// package-repository.ts
export const PackageRepositoryProvider = {
  provide: IPACKAGE_REPOSITORY,
  useClass: PackageRepository,
};
```

```typescript
// package-service.ts
constructor(
  @Inject(IPACKAGE_REPOSITORY)
  private readonly packageRepository: IPackageRepository,
) {}
```

**All interface tokens used in this project:**

| Token                      | Defined In                              |
| -------------------------- | --------------------------------------- |
| `IPACKAGE_REPOSITORY`      | `src/modules/package/interfaces/...`     |
| `IPACKAGE_SERVICE`         | `src/modules/package/interfaces/...`     |
| `ISHELF_REPOSITORY`        | `src/modules/shelf/interfaces/...`      |
| `ISHELF_SERVICE`           | `src/modules/shelf/interfaces/...`      |

### Circular Dependency Resolution

`PackageModule` and `ShelfModule` have a circular dependency (`PackageService` needs `ShelfService` to clear slots, `ShelfService` needs `PackageService` to validate packages). Resolved using:

```typescript
// In ShelfService
@Inject(forwardRef(() => PackageService))
private readonly packageService: PackageService,

// In PackageService
@Inject(forwardRef(() => ShelfService))
private readonly shelfService: ShelfService,
```

Both modules also use `forwardRef(() => OtherModule)` in their `imports` arrays.

---

## Coding Guidelines

### TypeScript Rules

- **Strict mode is enforced.** Do not use `any`.
- Use definite assignment assertion (`!`) on Mongoose schema properties (assigned at runtime):
  ```typescript
  @Prop({ required: true })
  packageName!: string;  // ← ! required
  ```
- Do **not** manually declare `_id` in schemas — MongoDB auto-manages it.
- Use `HydratedDocument<T>` for Mongoose document types.

### Naming Conventions

| Element          | Convention    | Example                          |
| ---------------- | ------------ | -------------------------------- |
| Class            | PascalCase   | `PackageController`              |
| Interface        | PascalCase + `I` prefix | `IPackageRepository` |
| Method/Variable  | camelCase    | `findAllPaginated`               |
| File/Folder      | kebab-case   | `package-repository.interface.ts`|
| DTO class        | PascalCase   | `CreatePackageDto`               |
| Enum value       | SCREAMING_SNAKE_CASE | `SlotStatus.AVAILABLE` |
| Module/Component | PascalCase   | `GatewayModule`                  |

### Function Design

- Keep functions short and focused (Single Responsibility Principle).
- Zero business logic in controllers — only request parsing and response formatting.
- All database access goes through repositories — services never call `Model` directly.

### Error Handling

- Throw NestJS built-in exceptions: `NotFoundException`, `BadRequestException`.
- **Never** expose raw database errors or stack traces to the client.
- Validation errors are handled automatically by the `ValidationPipe`.

---

## Environment Variables

| Variable | Required | Description |
| ---------- | -------- | ------------------------------------ |
| `MONGO_URI` | **Yes** | MongoDB connection string |
| `PORT` | No | Server port (default: `5000`) |
| `MAPS_DIR` | No | Directory where the robot saves SLAM map images (PGM files). Default: `/home/pi/robot_ws/maps`. Used by `/api/robot/map-image*` to serve the map to the Calibrate page. |
| `JWT_SIGN_SECRET` | **Yes** | JWT signing secret for auth. Generate with `openssl rand -hex 32`. |
| `ROBOT_BRAIN_TOKEN` | **Yes** | Shared secret for brain↔API Socket.io auth. Generate with `openssl rand -hex 32`. |

---

## Swagger / API Documentation

Swagger UI is available at `http://localhost:<PORT>/api/docs`.
Raw OpenAPI JSON is at `http://localhost:<PORT>/api/docs.json`.

All DTOs and schemas are decorated with `@ApiProperty()` from `@nestjs/swagger` for auto-generated documentation.

---

## File Index

### Root / Entry

| File                              | Purpose                              |
| --------------------------------- | ------------------------------------ |
| `src/main.ts`                     | Bootstrap — app factory, CORS, pipes, Swagger |
| `src/app.module.ts`               | Root NestJS module                  |
| `src/app.controller.ts`           | Root health-check controller        |
| `src/app.service.ts`              | Root health-check service           |
| `src/config/database.config.ts`   | MongoDB connection config           |

### Gateway Module

| File                              | Purpose                              |
| --------------------------------- | ------------------------------------ |
| `src/gateway/gateway.module.ts`   | Global WebSocket module             |
| `src/gateway/events-gateway.ts`   | Socket.io event emitter             |

### Package Module

| File                              | Purpose                              |
| --------------------------------- | ------------------------------------ |
| `src/modules/package/package.module.ts` | Module wiring                  |
| `src/modules/package/package-controller.ts` | HTTP endpoints for packages |
| `src/modules/package/package-service.ts` | Business logic for packages    |
| `src/modules/package/package-repository.ts` | MongoDB data access         |
| `src/modules/package/schemas/package.schema.ts` | Mongoose schema            |
| `src/modules/package/interfaces/package-repository.interface.ts` | Repository contract |
| `src/modules/package/interfaces/package-service.interface.ts` | Service contract |
| `src/modules/package/dto/create-package.dto.ts` | `packageName` — create request |
| `src/modules/package/dto/update-package.dto.ts` | `packageName?` — update request |
| `src/modules/package/dto/pagination.dto.ts` | `PaginationQueryDto`, `PaginationMeta`, `PaginatedResponseDto` |
| `src/modules/package/dto/package-paginated-response.dto.ts` | Swagger-typed paginated response |

### Shelf Module

| File                              | Purpose                              |
| --------------------------------- | ------------------------------------ |
| `src/modules/shelf/shelf.module.ts` | Module wiring                      |
| `src/modules/shelf/shelf-controller.ts` | HTTP endpoints for shelves     |
| `src/modules/shelf/shelf-service.ts` | Business logic + slot initialization |
| `src/modules/shelf/shelf-repository.ts` | MongoDB data access            |
| `src/modules/shelf/schemas/shelf.schema.ts` | Shelf entity schema            |
| `src/modules/shelf/schemas/shelf-slot.schema.ts` | ShelfSlot schema + `SlotStatus` enum |
| `src/modules/shelf/interfaces/shelf-repository.interface.ts` | Repository contract |
| `src/modules/shelf/interfaces/shelf-service.interface.ts` | Service contract |
| `src/modules/shelf/dto/assign-package.dto.ts` | `packageId` — assign to slot |
| `src/modules/shelf/dto/move-package.dto.ts` | `targetSlotCode` — move package |
| `src/modules/shelf/dto/assign-coordinates.dto.ts` | `slotX, slotY, facingTheta` — Calibrate single slot |
| `src/modules/shelf/dto/assign-coordinates-batch.dto.ts` | `entries: [...]` — Calibrate bulk |
| `src/modules/shelf/dto/assign-april-tag.dto.ts` | `aprilTagId` (0..586) — Calibrate AprilTag |
| `src/modules/maps/maps.controller.ts` | `GET /api/robot/map-image` — serve SLAM map PGM to the Calibrate page |
| `src/modules/shelf/shelf.token.ts` | String token `ISHELF_REPOSITORY`    |

---

## Common Development Tasks

### Adding a new field to Package

1. Add `@Prop()` to `src/modules/package/schemas/package.schema.ts`
2. Update `CreatePackageDto` (add `@IsString()`, `@MaxLength()`)
3. Update `UpdatePackageDto` (optional, add `@IsOptional()`)
4. Update `PackageRepository` if custom DB logic needed
5. Update Swagger `@ApiProperty()` descriptions
6. Emit WebSocket event in `PackageService` if the field affects real-time UI

### Adding a new endpoint to ShelfController

1. Add method to `IShelfService` interface (`src/modules/shelf/interfaces/shelf-service.interface.ts`)
2. Implement in `ShelfService`
3. Add method to `IShelfRepository` interface if DB access needed
4. Implement in `ShelfRepository`
5. Add route in `ShelfController` with `@ApiTags`, `@ApiOperation`, `@ApiResponse` decorators
6. If real-time updates needed, call `eventsGateway.emitShelfUpdated(...)` in the service
