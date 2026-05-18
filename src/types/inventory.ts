export interface PackageItem {
  id: string;
  code: string;
  name: string;
  sender: string;
  recipient: string;
  shelfId: number; // 1, 2, 3, 4
  cell: string;    // A1, B2, ...
  weight: number;  // kg
  status: 'stored' | 'moving' | 'exporting';
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
