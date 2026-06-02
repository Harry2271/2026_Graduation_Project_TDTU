import { createSlice, PayloadAction } from '@reduxjs/toolkit';

export interface SelectedCell {
  shelfId: number;
  cell: string;
}

interface InventoryState {
  source: SelectedCell | null;
  dest: SelectedCell | null;
}

const initialState: InventoryState = {
  source: null,
  dest: null,
};

export const inventorySlice = createSlice({
  name: 'inventory',
  initialState,
  reducers: {
    setSource: (state, action: PayloadAction<SelectedCell | null>) => {
      state.source = action.payload;
    },
    setDest: (state, action: PayloadAction<SelectedCell | null>) => {
      state.dest = action.payload;
    },
    resetInventory: (state) => {
      state.source = null;
      state.dest = null;
    },
  },
});

export const { setSource, setDest, resetInventory } = inventorySlice.actions;
export default inventorySlice.reducer;
