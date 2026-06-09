// ─── Backend API types (from swagger.json) ───────────────────────────

export type PackageStatus = 'CREATED' | 'IN_PROGRESS' | 'FINISHED';

export interface Package {
  _id: string;
  packageName: string;
  status: PackageStatus;
  tagId: number | null;
  createdAt?: string;
  updatedAt?: string;
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

export interface SelectedCell {
  shelfId: number;
  cell: string;
}

export interface MoveCommandPayload {
  from: SelectedCell;
  to: SelectedCell;
}

export interface MoveCommandResponse {
  success: boolean;
  message?: string;
}

// ─── Job types (Phase 4) ──────────────────────────────────────────

export type JobStatus = 'DISPATCHED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';

export interface Job {
  _id: string;
  packageId: string;
  fromSlotCode: string;
  toSlotCode: string;
  status: JobStatus;
  createdAt?: string;
  updatedAt?: string;
}

export interface DispatchMoveResponse {
  jobId: string;
}

// ─── Slot code helpers ──────────────────────────────────────────────

/**
 * Converts a backend slot code like "S1A1" to frontend { shelfId, cell }.
 */
export function parseSlotCode(code: string): { shelfId: number; cell: string } {
  const match = code.match(/^S(\d)([A-Z])(\d)$/);
  if (!match) return { shelfId: 0, cell: '' };
  return {
    shelfId: parseInt(match[1], 10),
    cell: `${match[2]}${match[3]}`,
  };
}

/**
 * Converts frontend { shelfId, cell } to a backend slot code like "S1A1".
 */
export function toSlotCode(shelfId: number, cell: string): string {
  return `S${shelfId}${cell}`;
}
