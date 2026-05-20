import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";

export const baseApi = createApi({
  reducerPath: "api",
  baseQuery: fetchBaseQuery({ baseUrl: process.env.NEXT_PUBLIC_API_BASE_URL || "/" }),
  tagTypes: ["Packages", "Shelves", "Slots"],
  endpoints: () => ({}),
});
