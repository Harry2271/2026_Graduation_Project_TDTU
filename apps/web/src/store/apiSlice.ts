import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react'

// Legacy placeholder — no longer used by the inventory page.
// Real API calls are handled by src/store/services/inventoryApi.ts
export const apiSlice = createApi({
  reducerPath: 'legacyApi',
  baseQuery: fetchBaseQuery({ baseUrl: '/' }),
  endpoints: () => ({}),
})
