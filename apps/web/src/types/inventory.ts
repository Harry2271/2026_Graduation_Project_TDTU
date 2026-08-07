// ─── Backend API types (from swagger.json) ───────────────────────────

export type PackageStatus = 'CREATED' | 'IN_PROGRESS' | 'FINISHED';

export type ZoneCode = 'S1' | 'S2' | 'S3' | 'S4';

export interface Package {
  _id: string;
  packageName: string;
  status: PackageStatus;
  tagId: number | null;
  zoneCode: ZoneCode | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface PackageStats {
  total: number;
  unplaced: number;
  zones: Record<ZoneCode, number>;
}

export interface PaginationMeta {
  total: number;
  page: number;
  limit: number;
  hasNext: boolean;
}

export interface PackagePaginatedResponseDto {
  items: Package[];
  meta: PaginationMeta;
}

export interface Shelf {
  code: string;       // S1, S2, S3, S4
  rows: number;
  columns: number;
  totalSlots: number;
}

export interface ShelfSlot {
  code: string;        // S1A1, S1B2, ... (shelf + row + column)
  shelf: string;      // S1, S2, S3, S4
  row: string;        // A, B, C, D
  column: number;     // 1, 2, 3, 4
  status: 'AVAILABLE' | 'OCCUPIED' | 'RESERVED' | 'TRANSIT';
  packageId: string | null;
  slotX?: number;          // meters in SLAM map frame (Calibrate)
  slotY?: number;          // meters in SLAM map frame (Calibrate)
  facingTheta?: number;    // radians, yaw the robot must face (Calibrate)
  aprilTagId?: number;     // 0..586, fixed physical tag ID (Calibrate)
}

export interface MovePackageDto {
  targetSlotCode: string;
}

export interface AssignPackageDto {
  packageId: string;
}

// ─── Frontend display types (used in UI) ────────────────────────────

export interface PackageItem {
  _id: string;
  packageName: string;
  shelfId: number;   // derived from slot.code (e.g. "S1A1" → 1)
  cell: string;      // derived from slot.code (e.g. "S1A1" → "A1")
  importedAt: string;
}

export interface MoveCommandPayload {
  from: { shelfId: number; cell: string };
  to: { shelfId: number; cell: string };
}

export interface MoveCommandResponse {
  success: boolean;
  message?: string;
}

// ─── Job types (Phase 4) ──────────────────────────────────────────

export type JobStatus = 'QUEUED' | 'DISPATCHED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export type JobPhase =
  | 'NONE'
  | 'NAVIGATE_DROPOFF'
  | 'AT_DOCK'
  | 'UNLOADING'
  | 'RETURNING';

export interface Job {
  _id: string;
  // Simplified workflow — only destination is required. Legacy fields stay
  // optional so existing rows (pre-simplification) still hydrate.
  packageId?: string | null;
  fromSlotCode?: string;
  toSlotCode: string;
  status: JobStatus;
  phase?: JobPhase;
  failureReason?: string;
  queuedAt?: string;
  startedAt?: string;
  pickupAt?: string;
  dropoffAt?: string;
  unloadAt?: string;
  totalDurationMs?: number;
  fullCycleDurationMs?: number;
  travelToPickupMs?: number;
  travelToDropoffMs?: number;
  unloadDurationMs?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface DispatchMoveResponse {
  jobId: string;
}

export interface DispatchMovePayload {
  toSlotCode: string;
  operationId?: string;
}

export interface RobotMapFile {
  name: string;
  sizeBytes: number;
  savedAt?: string;
}

export interface BrainHealth {
  connected: boolean;
  runningJobId: string | null;
  lastSeenAt: string | null;
}
