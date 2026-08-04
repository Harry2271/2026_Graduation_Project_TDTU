# Zone Inventory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chuyển luồng quản lý kiện hàng từ chọn ô kệ sang 4 khu tập kết không giới hạn, có trạng thái pending/placed, thống kê realtime, và hoàn tất giải phóng AprilTag.

**Architecture:** Giữ nguyên `Shelf`, `ShelfSlot`, Job, Calibrate, `services/robot/`, firmware và camera. Thêm `zoneCode` trực tiếp vào `Package`; backend cung cấp assignment + aggregate stats, web dùng RTK Query/Socket.IO, mobile xây API client + Zustand/Socket.IO từ Expo starter.

**Tech Stack:** NestJS 11, Mongoose, Socket.IO, Next.js 16, Redux Toolkit/RTK Query, Expo 55, React Native, Zustand, TypeScript strict, Yarn.

---

## File map

### Backend
- Modify `apps/api/src/modules/package/schemas/package.schema.ts`: add `zoneCode`, remove legacy package slot fields.
- Create `apps/api/src/modules/package/dto/assign-zone.dto.ts`: validate `S1`–`S4` or `null`.
- Modify package repository interface/implementation: zone update and stats aggregation.
- Modify package service/interface/controller: zone assignment, stats, create/finish behavior, and route ordering.
- Create `apps/api/src/scripts/migrate-package-zone.ts`: idempotent backfill for existing documents; invoke from the existing startup path without touching robot modules.

### Web
- Modify `apps/web/src/types/inventory.ts`: package zone and stats types; remove cell-selection types/helpers only where no longer used.
- Modify `apps/web/src/store/services/baseApi.ts` and `inventoryApi.ts`: Stats tag, zone mutation, stats query, socket cache updates.
- Modify `apps/web/src/store/store.ts` and delete `apps/web/src/store/inventorySlice.ts`: remove obsolete source/destination selection state.
- Rewrite `apps/web/src/app/inventory/page.tsx`: stats widget, filters, package list, zone assignment, completion.
- Modify `apps/web/src/app/products/page.tsx`: replace shelf/cell assignment modal with four-zone picker.
- Modify `apps/web/src/app/products/[id]/page.tsx`: show zone and allow zone assignment while preserving AprilTag/QR/finish actions.
- Do not modify map, camera, telemetry, trajectory, calibrate, robot, or firmware files.

### Mobile
- Modify `apps/mobile/package.json`: add only required `zustand` and `socket.io-client` dependencies.
- Create `apps/mobile/src/types/inventory.ts`, `src/lib/api.ts`, `src/lib/socket.ts`, `src/store/usePackageStore.ts`.
- Create `apps/mobile/src/components/StatsWidget.tsx`, `PackageCard.tsx`, `ZonePicker.tsx`.
- Rewrite `apps/mobile/src/app/index.tsx` as dashboard; create `packages.tsx` and `packages/[id].tsx`; update tab routes/components.
- Preserve the existing Expo theme and do not add robot/camera/telemetry features.

### Documentation
- Create `docs/superpowers/specs/plan-for-robot.md`: future-only robot/zone migration plan; no implementation in this phase.

---

## Task 1: Backend package zone model and DTO

**Files:**
- Modify: `apps/api/src/modules/package/schemas/package.schema.ts`
- Create: `apps/api/src/modules/package/dto/assign-zone.dto.ts`

- [ ] **Step 1: Add the zone enum and schema field.**

Define a `PackageZone` enum with `S1`, `S2`, `S3`, `S4`; add `zoneCode` as nullable, default `null`, with the enum constraint. Remove `sourceSlotCode` and `targetSlotCode` from the Package class and Swagger metadata. Keep status/tagId indexes unchanged.

- [ ] **Step 2: Add DTO validation.**

`AssignZoneDto` must accept `zoneCode: PackageZone | null`, use `@IsEnum(PackageZone)` with `@IsOptional()`/nullable handling compatible with the global ValidationPipe, and document the nullable request in Swagger. Use an explicit DTO field rather than accepting arbitrary strings.

- [ ] **Step 3: Run the API type check.**

Run `yarn workspace @robot-for-nguyen/api build`.
Expected: the build may report consumers that still reference removed slot fields; record those exact files for Task 5 instead of changing robot/job code.

---

## Task 2: Backend repository, service, controller, and stats

**Files:**
- Modify: `apps/api/src/modules/package/interfaces/package-repository.interface.ts`
- Modify: `apps/api/src/modules/package/package-repository.ts`
- Modify: `apps/api/src/modules/package/interfaces/package-service.interface.ts`
- Modify: `apps/api/src/modules/package/package-service.ts`
- Modify: `apps/api/src/modules/package/package-controller.ts`
- Create or modify: package stats/response DTO files under `apps/api/src/modules/package/dto/`

- [ ] **Step 1: Extend repository contracts.**

Add signatures equivalent to:

```ts
assignZone(id: string, zoneCode: PackageZone | null): Promise<Package | null>;
getActiveStats(): Promise<{ total: number; unplaced: number; zones: Record<PackageZone, number> }>;
```

Keep all existing repository methods used by robot-facing code unchanged.

- [ ] **Step 2: Implement zone update and aggregation.**

Use `findByIdAndUpdate(id, { zoneCode }, { new: true }).lean()` for assignment. Implement one MongoDB aggregation matching `{ status: { $ne: PackageStatus.FINISHED } }`, grouping by `$zoneCode`, and normalize missing groups to zero for all four zones. Set `unplaced` from the null/missing group and ensure `total` equals all active records.

- [ ] **Step 3: Extend service behavior.**

Add `assignZone(id, zoneCode)` that finds the package, rejects `FINISHED` with `BadRequestException`, updates through the repository, emits the existing `package:updated` event, and returns the updated package. Add `getStats()` delegating to the repository. Set `zoneCode: null` in `create()`. When finishing via `changeStatus()` or `markFinished()`, update `{ status: FINISHED, tagId: null, zoneCode: null }`. Remove only the call from `PackageService.remove()` to `clearSlotByPackageId`; leave `ShelfService` and all slot methods intact.

- [ ] **Step 4: Add controller routes with safe ordering.**

Add `@Get('stats')` before `@Get(':id')`, and add `@Patch(':id/zone')`. The zone controller passes the validated DTO to the service. Return the existing Package object and stats response shape:

```ts
{ total: number; unplaced: number; zones: { S1: number; S2: number; S3: number; S4: number } }
```

- [ ] **Step 5: Build the API.**

Run `yarn workspace @robot-for-nguyen/api build`.
Expected: PASS without changes under `services/robot`, `firmware`, or camera code.

---

## Task 3: Idempotent existing-data migration

**Files:**
- Create: `apps/api/src/scripts/migrate-package-zone.ts`
- Modify: the API bootstrap/startup file that owns one-time data initialization, only if needed

- [ ] **Step 1: Implement the migration function.**

Accept the injected Package model or connection and update only documents that do not yet have `zoneCode`. Derive `S1`–`S4` from a valid legacy `targetSlotCode` prefix (`/^S[1-4]/`); otherwise use `null`. Unset `sourceSlotCode` and `targetSlotCode` after setting `zoneCode`. Make the operation idempotent so a restart cannot overwrite a manually assigned zone.

- [ ] **Step 2: Invoke migration once at startup.**

Call the migration after Mongoose models are ready and before serving requests. Do not import or modify any robot, firmware, camera, Job, Shelf, or ShelfSlot implementation.

- [ ] **Step 3: Verify migration behavior.**

Use a disposable local MongoDB dataset or the existing API environment to verify: legacy `S2C3` becomes `zoneCode: 'S2'`; an unplaced legacy package becomes `null`; rerunning does not change a package already carrying `zoneCode`.

---

## Task 4: Web API types, RTK Query, and state cleanup

**Files:**
- Modify: `apps/web/src/types/inventory.ts`
- Modify: `apps/web/src/store/services/baseApi.ts`
- Modify: `apps/web/src/store/services/inventoryApi.ts`
- Modify: `apps/web/src/store/store.ts`
- Delete: `apps/web/src/store/inventorySlice.ts` if no remaining consumer exists

- [ ] **Step 1: Update domain types.**

Add `zoneCode: 'S1' | 'S2' | 'S3' | 'S4' | null` to Package and define:

```ts
export interface PackageStats {
  total: number;
  unplaced: number;
  zones: Record<'S1' | 'S2' | 'S3' | 'S4', number>;
}
```

Remove `SelectedCell`, `parseSlotCode`, and `toSlotCode` only after confirming no calibrate/robot-facing web page imports them.

- [ ] **Step 2: Add RTK Query endpoints and tags.**

Add `Stats` to `tagTypes`; add `getPackageStats` with `providesTags: ['Stats']`; add `assignToZone` with body `{ zoneCode }` and invalidation for `Packages` and `Stats`. Preserve existing slot/job/calibrate endpoints.

- [ ] **Step 3: Update Socket.IO cache behavior.**

In the existing `onCacheEntryAdded` listener, treat `package:updated`, `package:created`, and `package:deleted` as invalidating/refetching package stats as well as updating package list cache. Do not alter raw robot WebSocket handling.

- [ ] **Step 4: Remove obsolete Redux selection state.**

Confirm `inventorySlice` has no remaining imports; remove its reducer and actions from the live store. Leave `calibrateSlice` untouched.

- [ ] **Step 5: Run web type checking.**

Run the app's existing type-check/build command from `apps/web` or `yarn workspace @robot-for-nguyen/web build`.
Expected: failures, if any, are only from old inventory page consumers to be resolved in Task 5.

---

## Task 5: Web inventory and products zone UX

**Files:**
- Rewrite: `apps/web/src/app/inventory/page.tsx`
- Modify: `apps/web/src/app/products/page.tsx`
- Modify: `apps/web/src/app/products/[id]/page.tsx`
- Create if useful: focused shared zone UI under `apps/web/src/components/`

- [ ] **Step 1: Replace inventory cell UI with stats and package list.**

Render Vietnamese dashboard cards for total active, S1–S4 counts, and unplaced. Render searchable/filterable package rows with zone badge, status, creation date, zone picker, finish confirmation, and delete confirmation. Do not import slot-code helpers, `ShelfCard`, source/destination Redux actions, move mutation, or robot controls.

- [ ] **Step 2: Replace Products shelf/cell modal.**

Keep create/edit/delete/search/pagination/AprilTag printing. Replace the two-step shelf/cell picker and occupied-cell logic with four zone buttons calling `assignToZone`. Show `Chưa vào khu` when `zoneCode` is null.

- [ ] **Step 3: Update package detail.**

Show the zone badge and a four-zone assignment control. Keep AprilTag/QR rendering, print behavior, name editing, and finish confirmation unchanged except that finish now causes the backend to clear zone and tag.

- [ ] **Step 4: Exercise the golden path in the browser.**

Run `yarn dev:web`, then verify: create package → appears pending; choose S1 → badge and stats update; move to S2 → counts move; finish → package leaves active stats and tagId is null. Verify existing camera, telemetry, map, and calibrate routes still load without modifications.

---

## Task 6: Mobile package API, state, and components

**Files:**
- Modify: `apps/mobile/package.json`
- Create: `apps/mobile/src/types/inventory.ts`
- Create: `apps/mobile/src/lib/api.ts`
- Create: `apps/mobile/src/lib/socket.ts`
- Create: `apps/mobile/src/store/usePackageStore.ts`
- Create: `apps/mobile/src/components/StatsWidget.tsx`
- Create: `apps/mobile/src/components/PackageCard.tsx`
- Create: `apps/mobile/src/components/ZonePicker.tsx`

- [ ] **Step 1: Add dependencies.**

Use Yarn to add versions compatible with Expo 55/React 19: `zustand` and `socket.io-client`. Do not add Redux or a UI library unless the existing starter cannot implement the required controls.

- [ ] **Step 2: Define mobile types and REST wrapper.**

Reuse the backend response shapes exactly. Implement a small fetch wrapper that reads `EXPO_PUBLIC_API_BASE_URL`, sends JSON, throws on non-2xx responses, and exposes `getPackages`, `getStats`, `createPackage`, `assignToZone`, `patchStatus`, and `deletePackage`.

- [ ] **Step 3: Implement the store and realtime updates.**

Create Zustand state for packages, stats, loading/error, and actions to load/refetch/create/assign/finish/delete. Subscribe to the Socket.IO API origin and refetch packages/stats on `package:created`, `package:updated`, and `package:deleted`. Disconnect on provider unmount or app cleanup.

- [ ] **Step 4: Implement focused components.**

`StatsWidget` renders total, each zone, and pending. `PackageCard` renders name/status/zone and actions. `ZonePicker` presents exactly S1–S4 plus a pending option when moving out of a zone. All user-facing text is Vietnamese.

- [ ] **Step 5: Run mobile TypeScript validation.**

Run `yarn workspace @robot-for-nguyen/mobile typecheck` if defined, otherwise `npx tsc --noEmit` from `apps/mobile`.
Expected: PASS before adding route screens.

---

## Task 7: Mobile dashboard, package list, and detail routes

**Files:**
- Rewrite: `apps/mobile/src/app/index.tsx`
- Create: `apps/mobile/src/app/packages.tsx`
- Create: `apps/mobile/src/app/packages/[id].tsx`
- Modify: `apps/mobile/src/components/app-tabs.tsx`
- Modify: `apps/mobile/src/components/app-tabs.web.tsx`
- Modify: `apps/mobile/src/app/_layout.tsx` only if the store provider must be mounted there

- [ ] **Step 1: Mount the store/socket lifecycle.**

Mount a lightweight provider or hook in the root layout that loads initial packages/stats and cleans up the socket on unmount. Preserve the existing theme provider and splash behavior.

- [ ] **Step 2: Build the dashboard route.**

Render `StatsWidget` and a short active-package summary with navigation to `/packages`. Include loading, error, and retry states.

- [ ] **Step 3: Build the package list route.**

Render search/filter controls, a create modal that only asks for package name, package cards, zone picker assignment, finish confirmation, and delete confirmation. New packages remain pending until the user explicitly chooses a zone.

- [ ] **Step 4: Build the detail route.**

Load the selected package from store or API, show its name/status/tagId/zone, allow zone assignment and finish, and navigate back after deletion. Do not implement AprilTag printing, robot movement, camera, telemetry, or calibrate.

- [ ] **Step 5: Update tabs and verify Expo.**

Rename tabs to Vietnamese dashboard/package labels while keeping Expo web/native route compatibility. Run `npx expo start`, verify dashboard → package list → create pending → assign S1 → finish, and check that Socket.IO updates another open client.

---

## Task 8: Documentation and final verification

**Files:**
- Create: `docs/superpowers/specs/plan-for-robot.md`
- Modify only if needed: relevant API/web/mobile `.env.example` files for mobile API URL documentation

- [ ] **Step 1: Write the future robot plan.**

Document zone-based Job schema/API, Calibrate zone coordinates, robot service zone-to-slot resolution, migration compatibility, safety/rollback, and required hardware validation. Explicitly state that this task does not modify `services/robot/`, `firmware/`, camera code, or current Job/Calibrate behavior.

- [ ] **Step 2: Verify repository boundaries.**

Run `git diff --name-only` and confirm no path under `services/robot/`, `firmware/`, camera stream implementation, or calibrate page was changed.

- [ ] **Step 3: Run final checks.**

Run:

```bash
yarn workspace @robot-for-nguyen/api build
yarn workspace @robot-for-nguyen/web build
npx tsc --noEmit --project apps/mobile/tsconfig.json
```

Then use the browser/Expo app for the golden paths in Tasks 5 and 7. Record any environment-only failures separately from code failures.

- [ ] **Step 4: Review the final diff.**

Check that FINISHED packages are excluded from all stats, tagId and zoneCode are cleared together, multiple packages can share one zone, pending creation never requires a zone, and slot/robot APIs remain unchanged.
