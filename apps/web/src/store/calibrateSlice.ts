import { createSlice, type PayloadAction } from '@reduxjs/toolkit'

interface CalibrateState {
  selectedSlotCode: string | null
}

const initialState: CalibrateState = {
  selectedSlotCode: null,
}

export const calibrateSlice = createSlice({
  name: 'calibrate',
  initialState,
  reducers: {
    setSelectedCalibrateSlot: (state, action: PayloadAction<string>) => {
      state.selectedSlotCode = action.payload
    },
    clearSelectedCalibrateSlot: (state) => {
      state.selectedSlotCode = null
    },
  },
})

export const { setSelectedCalibrateSlot, clearSelectedCalibrateSlot } = calibrateSlice.actions

export const selectSelectedCalibrateSlot = (state: { calibrate: CalibrateState }) =>
  state.calibrate.selectedSlotCode

export default calibrateSlice.reducer
