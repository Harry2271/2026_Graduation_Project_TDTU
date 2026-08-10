import { configureStore } from '@reduxjs/toolkit';
import calibrateReducer from './calibrateSlice';
import { inventoryApi } from './services/inventoryApi';

export const makeStore = () => {
  return configureStore({
    reducer: {
      calibrate: calibrateReducer,
      [inventoryApi.reducerPath]: inventoryApi.reducer,
    },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware().concat(inventoryApi.middleware),
  });
};

export type AppStore = ReturnType<typeof makeStore>;
export type RootState = ReturnType<AppStore['getState']>;
export type AppDispatch = AppStore['dispatch'];

// Legacy singleton kept for backward-compatible imports (e.g. hooks.ts types).
export const store = makeStore();
