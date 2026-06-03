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
  status: 'AVAILABLE' | 'OCCUPIED';
  packageId: string | null;
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
