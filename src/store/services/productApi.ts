import { baseApi } from "./baseApi";
import { Product, ApiResponse } from "../../types/product";

export const productApi = baseApi.injectEndpoints({
  endpoints: (builder) => ({
    getProducts: builder.query<Product[], void>({
      query: () => "/breeds",
      transformResponse: (response: ApiResponse<Product[]>) => response.data,
    }),
    getProductById: builder.query<Product, string>({
      query: (id) => `/breeds/${id}`,
      transformResponse: (response: ApiResponse<Product>) => response.data,
    }),
  }),
});

export const { useGetProductsQuery, useGetProductByIdQuery } = productApi;
