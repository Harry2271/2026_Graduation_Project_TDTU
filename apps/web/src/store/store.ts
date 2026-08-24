import { configureStore } from '@reduxjs/toolkit'
import calibrateReducer from './calibrateSlice'
import { inventoryApi } from './services/inventoryApi'

export const store = configureStore({
  reducer: {
    calibrate: calibrateReducer,
    [inventoryApi.reducerPath]: inventoryApi.reducer,
  },
  middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(inventoryApi.middleware),
})

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch
