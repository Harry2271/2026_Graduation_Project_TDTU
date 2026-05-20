import { baseApi } from "./baseApi";
import type {
  Package,
  PackagePaginatedResponseDto,
  Shelf,
  ShelfSlot,
  MovePackageDto,
} from "@/types/inventory";

// Tag type helpers matching RTK Query's FullTagDescription
type TagType = "Packages" | "Shelves" | "Slots";
type TagDescription =
  | { type: TagType }
  | { type: TagType; id: string | number };

export const inventoryApi = baseApi.injectEndpoints({
  endpoints: (builder) => ({
    // ─── Packages ─────────────────────────────────────────────────
    getPackages: builder.query<Package[], void>({
      query: () => "/packages",
      transformResponse: (response: PackagePaginatedResponseDto) => response.items,
      providesTags: (): TagDescription[] => [{ type: "Packages" }],
    }),

    getPackageById: builder.query<Package, string>({
      query: (id) => `/packages/${id}`,
      providesTags: (_result, _error, id): TagDescription[] => [
        { type: "Packages" },
        { type: "Packages", id },
      ],
    }),

    createPackage: builder.mutation<Package, { packageName: string }>({
      query: (body) => ({ url: "/packages", method: "POST", body }),
      invalidatesTags: (): TagDescription[] => [{ type: "Packages" }],
    }),

    updatePackage: builder.mutation<Package, { id: string; packageName: string }>({
      query: ({ id, ...body }) => ({
        url: `/packages/${id}`,
        method: "PUT",
        body,
      }),
      invalidatesTags: (): TagDescription[] => [{ type: "Packages" }],
    }),

    deletePackage: builder.mutation<void, string>({
      query: (id) => ({ url: `/packages/${id}`, method: "DELETE" }),
      invalidatesTags: (): TagDescription[] => [{ type: "Packages" }],
    }),

    // ─── Shelves ─────────────────────────────────────────────────
    getShelves: builder.query<Shelf[], void>({
      query: () => "/shelves",
      providesTags: (): TagDescription[] => [{ type: "Shelves" }],
    }),

    // ─── Slots ───────────────────────────────────────────────────
    getAllSlots: builder.query<ShelfSlot[], void>({
      query: () => "/shelves/slots",
      providesTags: (): TagDescription[] => [{ type: "Slots" }],
    }),

    getSlotsByShelf: builder.query<ShelfSlot[], string>({
      query: (shelfCode) => `/shelves/${shelfCode}/slots`,
      providesTags: (): TagDescription[] => [{ type: "Slots" }],
    }),

    assignPackageToSlot: builder.mutation<
      ShelfSlot,
      { slotCode: string; packageId: string }
    >({
      query: ({ slotCode, ...body }) => ({
        url: `/shelves/${slotCode}/package`,
        method: "POST",
        body,
      }),
      invalidatesTags: (): TagDescription[] => [
        { type: "Slots" },
        { type: "Packages" },
      ],
    }),

    movePackage: builder.mutation<
      ShelfSlot,
      { sourceSlotCode: string; targetSlotCode: string }
    >({
      query: ({ sourceSlotCode, targetSlotCode }) => ({
        url: `/shelves/${sourceSlotCode}/package`,
        method: "PUT",
        body: { targetSlotCode } as MovePackageDto,
      }),
      invalidatesTags: (): TagDescription[] => [
        { type: "Slots" },
        { type: "Packages" },
      ],
    }),

    removePackageFromSlot: builder.mutation<void, string>({
      query: (slotCode) => ({
        url: `/shelves/${slotCode}/package`,
        method: "DELETE",
      }),
      invalidatesTags: (): TagDescription[] => [
        { type: "Slots" },
        { type: "Packages" },
      ],
    }),
  }),
});

export const {
  useGetPackagesQuery,
  useGetPackageByIdQuery,
  useCreatePackageMutation,
  useUpdatePackageMutation,
  useDeletePackageMutation,
  useGetShelvesQuery,
  useGetAllSlotsQuery,
  useGetSlotsByShelfQuery,
  useAssignPackageToSlotMutation,
  useMovePackageMutation,
  useRemovePackageFromSlotMutation,
} = inventoryApi;
