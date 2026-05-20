import { configureStore } from '@reduxjs/toolkit';
import inventoryReducer from './inventorySlice';
import { inventoryApi } from './services/inventoryApi';

export const store = configureStore({
  reducer: {
    inventory: inventoryReducer,
    [inventoryApi.reducerPath]: inventoryApi.reducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware().concat(inventoryApi.middleware),
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
