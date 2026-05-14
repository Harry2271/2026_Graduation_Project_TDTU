import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';

export const apiSlice = createApi({
  reducerPath: 'api',
  baseQuery: fetchBaseQuery({ baseUrl: '/' }),
  endpoints: (builder) => ({
    submitMoveCommand: builder.mutation<{ success: boolean }, any>({
      queryFn: async () => {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return { data: { success: true } };
      },
    }),
  }),
});

export const { useSubmitMoveCommandMutation } = apiSlice;
