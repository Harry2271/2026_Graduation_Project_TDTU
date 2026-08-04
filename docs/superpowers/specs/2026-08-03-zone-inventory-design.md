# Spec: Chuyển đổi mô hình hàng hóa từ Shelf-Slot sang Zone (Tập kết)

**Date:** 2026-08-03
**Scope:** FE (apps/web), BE (apps/api), Mobile (apps/mobile). Robot/ESP32/Camera KHÔNG SỬA trong phiên này.
**Output:** `plan-for-robot.md` riêng cho phần robot (Phase 2).

---

## Context & Problem

Hiện tại, kiện hàng (`Package`) được gắn với một ô cụ thể trên kệ (`ShelfSlot`, mã `S1A1`...`S4D4`). Khi thêm hàng mới, người dùng chọn chính xác ô nào trên kệ nào. Mô hình này không phù hợp với thực tế kho hàng tập kết — nơi hàng được đưa về 4 khu (giống 4 kệ hiện tại) và có thể chứa bao nhiêu cũng được.

**Mục tiêu:** Chuyển mô hình sang "khu tập kết" (4 khu `S1`–`S4`). Hàng chỉ cần được gán vào khu, không chọn ô cụ thể. Vẫn giữ nguyên logic AprilTag, robot/ESP32, camera (không sửa).

---

## 1. Data Model

### 1.1 Package Schema — thay đổi

```typescript
// apps/api/src/modules/package/schemas/package.schema.ts
export class Package {
  _id!: string;
  packageName!: string;             // giữ nguyên
  status!: PackageStatus;           // giữ nguyên: CREATED | IN_PROGRESS | FINISHED
  tagId!: number | null;            // giữ nguyên: auto-allocate khi tạo, release khi FINISHED
  zoneCode!: string | null;         // THÊM MỚI: "S1" | "S2" | "S3" | "S4" | null
                                    // null = chưa vào khu (pending), có giá trị = đã vào khu
  // XÓA: sourceSlotCode (string | null) — thay bằng zoneCode
  // XÓA: targetSlotCode (string | null) — thay bằng zoneCode
  createdAt!: Date;
  updatedAt!: Date;
}
```

- `zoneCode` có partial unique index? **KHÔNG** — nhiều package có thể cùng zone (không giới hạn số lượng).
- `tagId` index giữ nguyên (partial unique khi numeric).
- **Migration:** Script backfill one-shot (xem §4).

### 1.2 Shelf / ShelfSlot — KHÔNG THAY ĐỔI

Cả `Shelf` schema, `ShelfSlot` schema, `SlotStatus` enum, Calibrate endpoints, và Job endpoints đều giữ nguyên. Chúng vẫn phục vụ robot + plan robot Phase 2.

- `GET /shelves`, `GET /shelves/slots`, `GET /shelves/:shelfCode/slots` — giữ nguyên.
- `PUT /shelves/:slotCode/coordinates`, `PUT /shelves/coordinates/batch` — giữ nguyên.
- `PUT /shelves/:slotCode/april-tag`, `GET /shelves/april-tag/:aprilTagId` — giữ nguyên.
- `POST /shelves/:slotCode/package` — giữ nguyên (cho robot dispatch).
- `PUT /shelves/:slotCode/package` — giữ nguyên (move robot job).
- `DELETE /shelves/:slotCode/package` — giữ nguyên (remove robot job).

### 1.3 Job Schema — KHÔNG THAY ĐỔI

`Job.fromSlotCode`, `Job.toSlotCode` giữ nguyên. Plan robot Phase 2 sẽ chuyển sang zone-based.

---

## 2. Backend API (apps/api)

### 2.1 New Endpoints

#### PATCH `/packages/:id/zone` — Đặt/chuyển khu

**Request:**
```json
{ "zoneCode": "S1" }     // hoặc "S2", "S3", "S4"
// hoặc
{ "zoneCode": null }      // đưa ra khỏi khu (quay về pending)
```

**Response:** `200 OK` — updated `Package` object.

**Logic:**
1. Tìm package theo `id`. Nếu không có → `404`.
2. Validate `zoneCode` là `null` hoặc `"S1"`–`"S4"` (regex `/^S[1-4]$/`).
3. Set `zoneCode` trên package, save.
4. Emit `package:updated` WebSocket event.
5. Return updated package.

**Behavior khi chuyển zone:**
- `null` → `"S1"`: hàng chuyển từ pending sang placed (vào khu S1).
- `"S1"` → `"S2"`: hàng chuyển giữa các khu.
- `"S1"` → `null`: hàng ra khỏi khu (quay về pending). Vẫn giữ nguyên `tagId`.
- Nếu package đã `FINISHED`: `400 Bad Request` — "Không thể đặt khu cho hàng đã hoàn tất".

**DTO:**
```typescript
// apps/api/src/modules/package/dto/assign-zone.dto.ts
export class AssignZoneDto {
  @ApiProperty({ description: 'Zone code: "S1"-"S4" or null to unplace', example: 'S1', nullable: true })
  zoneCode: string | null;
}
```

#### GET `/packages/stats` — Thống kê realtime

**Response:**
```json
{
  "total": 42,
  "unplaced": 5,
  "zones": { "S1": 12, "S2": 10, "S3": 8, "S4": 7 }
}
```

- **total** = số package có `status !== FINISHED`.
- **unplaced** = `zoneCode === null && status !== FINISHED`.
- **zones[S1]** = số package có `zoneCode === "S1" && status !== FINISHED`.
- `total === unplaced + zones.S1 + zones.S2 + zones.S3 + zones.S4` (luôn đúng).

**Logic:** Aggregate query — đếm count theo zoneCode cho package chưa FINISHED.

### 2.2 Changes to Existing Endpoints

#### POST `/packages` — Tạo hàng mới

Trước: tạo `{ packageName, status: CREATED, tagId }`.
Sau: tạo `{ packageName, status: CREATED, tagId, zoneCode: null }`.

#### PATCH `/packages/:id/status` — Chuyển trạng thái

Khi chuyển sang `FINISHED`: giữ nguyên logic hiện tại (xoá `tagId`). Thêm: set `zoneCode = null`.

#### DELETE `/packages/:id` — Xoá hàng

Giữ nguyên. Loại bỏ logic `shelfService.clearSlotByPackageId()` trong `PackageService.remove()` — vì hàng mới không dùng slot nữa.

#### GET `/packages` — Liệt kê

Mỗi item trả về thêm `zoneCode`. Frontend dùng để hiển thị badge zone (S1–S4) hoặc "Chưa xếp".

### 2.3 Files cần sửa

| File | Thay đổi |
|------|----------|
| `package.schema.ts` | Thêm `zoneCode`, xoá `sourceSlotCode`/`targetSlotCode` |
| `create-package.dto.ts` | Không thay đổi (chỉ nhận `packageName`) |
| `assign-zone.dto.ts` | **TẠO MỚI** |
| `package-service.ts` | Thêm `assignZone()`, `getStats()`, sửa `create()` (thêm zoneCode null), sửa `changeStatus()` (xoá zone khi FINISHED), sửa `remove()` (bỏ clearSlotByPackageId) |
| `package-controller.ts` | Thêm `PATCH /:id/zone`, `GET /stats` |
| `package-repository.ts` | Thêm `assignZone()`, `getStats()` |
| `package-repository.interface.ts` | Thêm method signatures |
| `package-service.interface.ts` | Thêm method signatures |
| `package.module.ts` | Không thay đổi (vẫn forwardRef ShelfModule) |
| `events-gateway.ts` | Không thay đổi (phát `package:updated` sẵn) |

### 2.4 ShelfService — thay đổi

| File | Thay đổi |
|------|----------|
| `shelf-service.ts` | Bỏ phương thức `clearSlotByPackageId()` hoặc giữ nguyên (cho robot). Không gọi từ `PackageService.remove()` nữa. |
| `shelf.module.ts` | Không thay đổi |
| `shelf-controller.ts` | Không thay đổi |

**Lưu ý:** `ShelfService.clearSlotByPackageId()` vẫn giữ trong code cho robot/plan robot Phase 2. Chỉ không gọi từ `PackageService` nữa.

### 2.5 Migration Script (one-shot)

Chạy khi deploy, trong `main.ts` startup hoặc script tách riêng:

```typescript
// apps/api/src/scripts/migrate-package-zone.ts
// Với mỗi package có targetSlotCode != null:
//   zoneCode = targetSlotCode.substring(0, 2)  // "S1A1" → "S1"
//   Xoá sourceSlotCode, targetSlotCode
//   Save
// Với mỗi package có targetSlotCode == null:
//   zoneCode = null
//   Xoá sourceSlotCode, targetSlotCode
//   Save
// ShelfSlot: KHÔNG XÓA — giữ nguyên cho robot
```

---

## 3. Web Frontend (apps/web)

### 3.1 Types

```typescript
// apps/web/src/types/inventory.ts
export interface Package {
  _id: string;
  packageName: string;
  status: 'CREATED' | 'IN_PROGRESS' | 'FINISHED';
  tagId: number | null;
  zoneCode: string | null;    // THÊM
  createdAt?: string;
  updatedAt?: string;
  // XÓA: sourceSlotCode, targetSlotCode
}

export interface PackageStats {
  total: number;
  unplaced: number;
  zones: Record<'S1' | 'S2' | 'S3' | 'S4', number>;
}

// XÓA: SelectedCell interface
// GIỮ: Shelf, ShelfSlot types (cho robot/calibrate)
```

**Xoá helper functions:** `parseSlotCode()`, `toSlotCode()` — không dùng trong zone flow.

### 3.2 Store (Redux)

#### XÓA: `inventorySlice.ts`

Bỏ hoàn toàn `inventorySlice` (source/dest cell selection). Không còn chọn ô.

#### THÊM: `inventoryApi.ts`

Thêm endpoints mới:
```typescript
assignToZone: builder.mutation<Package, { id: string; zoneCode: string | null }>({
  query: ({ id, zoneCode }) => ({
    url: `/packages/${id}/zone`,
    method: 'PATCH',
    body: { zoneCode },
  }),
  invalidatesTags: [{ type: 'Packages', id: 'LIST' }, { type: 'Stats' }],
}),

getPackageStats: builder.query<PackageStats, void>({
  query: () => '/packages/stats',
  providesTags: [{ type: 'Stats' }],
}),
```

**Socket.IO:** Thêm event listener `package:updated` → invalidate `Stats` tag (debounce 300ms).

### 3.3 Inventory Page (`/inventory`) — redesign

**Bỏ:** Warehouse grid 4x4, shelf cards, cell selection modal, source/dest command bar, `ShelfCard` component.

**Thay bằng:**

#### Dashboard Widget (đầu trang)

```
┌──────────┬──────────┬──────────┬──────────┬──────────┬──────────┐
│ Tổng: 42 │ S1: 12   │ S2: 10   │ S3: 8    │ S4: 7    │ Chưa xếp: 5 │
└──────────┴──────────┴──────────┴──────────┴──────────┴──────────┘
```

- Hiện real-time (Socket.IO, debounce 300ms).
- Hover vào zone badge để highlight package thuộc zone đó.

#### Danh sách package

Bảng/list hiển thị:
- Tên hàng, Trạng thái (badge), Zone (badge S1–S4 hoặc "Chưa xếp"), Ngày tạo, Hành động.
- **Search:** theo tên, tagId, `_id` (giữ nguyên).
- **Filter:** theo zone (S1–S4, Tất cả, Chưa xếp).
- **Hành động mỗi dòng:**
  - "Đưa vào khu" — Popover 4 nút S1–S4. Click → gọi `assignToZone({ id, zoneCode: "Sx" })`.
  - "Hoàn tất" — Confirmation modal → gọi `patchStatus({ id, status: "FINISHED" })`.
  - "Xoá" — Popconfirm → `deletePackage({ id })`.
  - Badge zone: hiển thị S1–S4 nếu `zoneCode !== null`, nếu null hiển thị "Chưa xếp".

### 3.4 Products Page (`/products`) — thay đổi

**Bỏ:** Modal chọn shelf → cell ("Xếp kệ").

**Thay bằng:** Nút "Đưa vào khu" → Popover chọn 4 zone S1–S4 (giống inventory page).

Giữ nguyên: Them kien hang modal, Sua, In QR, Xoa, pagination, search.

### 3.5 Product Detail Page (`/products/[id]`) — thay đổi nhỏ

- Hiển thị badge zone (S1–S4 hoặc "Chưa xếp").
- Nút "Đưa vào khu" (Popover zone selector).
- Giữ nguyên: In tem (AprilTag + QR), Hoàn tất, Sua ten.

### 3.6 Calibrate Page — KHÔNG THAY ĐỔI

Vẫn giữ nguyên: gán toa độ SLAM cho từng slot, gán AprilTag cho slot. Dành cho robot/plan robot Phase 2.

### 3.7 Map/Camera/Telemetry/Trajectory Pages — KHÔNG THAY ĐỔI

### 3.8 Files cần sửa

| File | Thay đổi |
|------|----------|
| `src/types/inventory.ts` | Thêm `zoneCode` vào Package, thêm `PackageStats`, xoá `SelectedCell`, bỏ helpers |
| `src/store/inventorySlice.ts` | **XÓA FILE** |
| `src/store/store.ts` | Bỏ `inventoryReducer` khỏi store |
| `src/store/services/inventoryApi.ts` | Thêm `assignToZone`, `getPackageStats`, thêm tag `Stats` |
| `src/app/inventory/page.tsx` | **Viết lại**: dashboard widget + danh sách package |
| `src/app/products/page.tsx` | Bỏ modal shelf+cell, thêm Popover zone |
| `src/app/products/[id]/page.tsx` | Thêm badge zone, nút "Đưa vào khu" |

---

## 4. Mobile App (apps/mobile)

**Trạng thái hiện tại:** Expo 55 starter template trắng — không có bất kỳ feature inventory nào.

**Phạm vi trong phiên này:** Xây mới mobile inventory cơ bản:
- Danh sách package + phân trang.
- Thêm hàng mới (pending).
- Dashboard widget thống kê (tổng, theo zone, chưa xếp).
- Đưa vào khu (chọn S1–S4 từ dropdown/list).
- Hoàn tất hàng (xác nhận).
- Socket.IO realtime cho danh sách + stats.

**KHÔNG bao gồm trong phiên này:**
- Robot controls, SLAM map, calibrate, camera, telemetry.
- In tem/AprilTag (in mobile khó — giữ cho web).
- Authentication (để sau).

### 4.1 Architecture

- **Routing:** expo-router, file-based.
- **State management:** Zustand (theo CLAUDE.md mobile).
- **API client:** `fetch` wrapper + Socket.IO client (`socket.io-client`).
- **UI:** `react-native-paper` hoặc Expo-compatible component library + themed-text/themed-view hiện có.

### 4.2 Screens

```
apps/mobile/src/app/
├── _layout.tsx              (giữ root layout + tabs)
├── index.tsx                → DashboardScreen (stats widget + recent packages)
├── packages.tsx             → PackageListScreen (danh sách + thêm + filter zone)
├── packages/
│   └── [id].tsx             → PackageDetailScreen (chi tiết + zone + hoàn tất)
└── explore.tsx              → giữ nguyên hoặc đổi thành Settings
```

Tabs: `Dashboard` | `Kiện hàng`

### 4.3 API Client

```typescript
// apps/mobile/src/lib/api.ts
const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL;

export const api = {
  getPackages: (page: number, limit: number) => ...,
  createPackage: (name: string) => ...,
  assignToZone: (id: string, zoneCode: string | null) => ...,
  patchStatus: (id: string, status: string) => ...,
  deletePackage: (id: string) => ...,
  getStats: () => ...,
};
```

### 4.4 Files tạo mới

| File | Mô tả |
|------|-------|
| `src/lib/api.ts` | REST client wrapper |
| `src/lib/socket.ts` | Socket.IO singleton |
| `src/store/usePackageStore.ts` | Zustand store |
| `src/app/index.tsx` | Rewrite → DashboardScreen |
| `src/app/packages.tsx` | PackageListScreen |
| `src/app/packages/[id].tsx` | PackageDetailScreen |
| `src/components/PackageCard.tsx` | Package list item |
| `src/components/ZonePicker.tsx` | Popover/dropdown chọn zone |
| `src/components/StatsWidget.tsx` | Dashboard stats cards |
| `package.json` | Thêm `socket.io-client`, `zustand` (nếu chưa có) |

---

## 5. plan-for-robot.md (Phase 2, riêng biệt)

File `docs/superpowers/specs/plan-for-robot.md` sẽ ghi:

1. **Job dispatch — chuyển sang zone:**
   - Job schema: thêm `fromZoneCode`/`toZoneCode`, bỏ `fromSlotCode`/`toSlotCode`.
   - JobService.dispatchMove(): dùng zone thay slot.
   - RobotGateway: gửi zone-based job cho services/robot.

2. **Calibrate page — chuyển từ slot sang zone:**
   - Assign toa độ SLAM cho 4 khu (không còn 64 ô).
   - Mỗi zone có centroid (slotX, slotY, facingTheta).
   - Bỏ UI 4×4 grid trong Calibrate, thay bằng 4 zone cards.

3. **Robot service (services/robot/):**
   - Nhận job zone-based → xác định slot mục tiêu trong khu (logic robot).
   - Có thể cần thêm `ZoneManager` module trong robot service.
   - Firmware KHÔNG SỬA (robot vẫn vận chuyển đến slot cụ thể, zone manager xác định slot nào).

4. **ShelfSlot collection:**
   - Giữ nguyên 64 slots cho robot定位.
   - Zone manager map zoneCode → slot(s) trong zone đó.

---

## 6. Verification

### Backend

1. `yarn build` — không lỗi TypeScript.
2. Test endpoints thủ công:
   - `POST /packages` → trả về `{ ..., zoneCode: null, tagId: <number> }`.
   - `PATCH /packages/:id/zone { zoneCode: "S1" }` → trả về `{ ..., zoneCode: "S1" }`.
   - `GET /packages/stats` → `{ total: N, unplaced: M, zones: {S1: x, S2: y, ...} }`.
   - `PATCH /packages/:id/status { status: "FINISHED" }` → `zoneCode: null`, `tagId: null`.
   - `DELETE /packages/:id` → 204.
3. Swagger UI (`/api/docs`) hiển thị đúng endpoints mới.
4. Socket.IO: mở 2 browser tab → thêm hàng ở tab 1 → tab 2 thấy realtime update.

### Web

1. `yarn dev:web` → truy cập `http://localhost:3000`.
2. Inventory page: hiển thị stats widget + danh sách package.
3. Thêm hàng → hàng xuất hiện ở "Chưa xếp" trong danh sách.
4. Bấm "Đưa vào khu" → chọn S1 → badge hiển thị S1, stats cập nhật realtime.
5. Hoàn tất hàng → hàng biến mất khỏi stats (FINISHED).
6. Search/filter hoạt động đúng.

### Mobile

1. `npx expo start` → mở trên simulator/device.
2. Tab Dashboard hiển thị stats.
3. Tab Kiện hàng hiển thị danh sách, thêm hàng, đưa vào khu, hoàn tất.
4. Socket.IO realtime hoạt động.

### Migration

1. Deploy backend → migration script chạy tự động khi startup.
2. Kiểm tra package cũ đã xếp kệ có `zoneCode` đúng.
3. Package chưa xếp có `zoneCode: null`.

---

## 7. Scope Boundaries (KHÔNG làm)

- ❌ Sửa `services/robot/` — robot code giữ nguyên tuyệt đối.
- ❌ Sửa `firmware/` — ESP32 code giữ nguyên.
- ❌ Sửa camera stream.
- ❌ Sửa Calibrate page trong phiên này (giữ nguyên cho Phase 2).
- ❌ Sửa Job schema/Service trong phiên này (giữ nguyên cho Phase 2).
- ❌ Xóa `ShelfSlot` collection — giữ nguyên cho robot定位.
- ❌ Thêm authentication cho mobile.
- ❌ In tem AprilTag trên mobile.
