import { baseApi } from './baseApi'
import { getSocket } from '@/lib/socket'
import type {
  Package,
  PackagePaginatedResponseDto,
  PackageStatus,
  PackageStats,
  ZoneCode,
  Shelf,
  ShelfSlot,
  MovePackageDto,
  Job,
  DispatchMovePayload,
  DispatchMoveResponse,
  RobotMapFile,
  BrainHealth,
} from '@/types/inventory'

// Tag type helpers matching RTK Query's FullTagDescription
type TagType = 'Packages' | 'Shelves' | 'Slots' | 'Jobs' | 'Stats'
type TagDescription = { type: TagType } | { type: TagType; id: string | number }

function compareJobHistory(a: Job, b: Job): number {
  const completedAtA = a.completedAt ? new Date(a.completedAt).getTime() : 0
  const completedAtB = b.completedAt ? new Date(b.completedAt).getTime() : 0
  return (
    completedAtB - completedAtA ||
    new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime()
  )
}

export const inventoryApi = baseApi.injectEndpoints({
  endpoints: (builder) => ({
    // ─── Packages ─────────────────────────────────────────────────
    getPackages: builder.query<Package[], void>({
      query: () => '/packages',
      transformResponse: (response: PackagePaginatedResponseDto) => response.items,
      providesTags: (): TagDescription[] => [{ type: 'Packages' }],
      async onCacheEntryAdded(_arg, { updateCachedData, cacheEntryRemoved, dispatch }) {
        const socket = getSocket()

        socket.on('package:created', (newPkg: Package) => {
          updateCachedData((draft) => {
            if (!Array.isArray(draft)) return
            const exists = draft.some((p) => p._id === newPkg._id)
            if (!exists) draft.push(newPkg)
          })
          dispatch(inventoryApi.util.invalidateTags(['Stats']))
        })

        socket.on('package:updated', (updatedPkg: Package) => {
          updateCachedData((draft) => {
            if (!Array.isArray(draft)) return
            const idx = draft.findIndex((p) => p._id === updatedPkg._id)
            if (idx >= 0) draft[idx] = updatedPkg
          })
          dispatch(inventoryApi.util.invalidateTags(['Stats']))
        })

        socket.on('package:deleted', (id: string) => {
          updateCachedData((draft) => {
            if (!Array.isArray(draft)) return
            const idx = draft.findIndex((p) => p._id === id)
            if (idx >= 0) draft.splice(idx, 1)
          })
          dispatch(inventoryApi.util.invalidateTags(['Stats']))
        })

        await cacheEntryRemoved
        socket.off('package:created')
        socket.off('package:updated')
        socket.off('package:deleted')
      },
    }),

    getPackageById: builder.query<Package, string>({
      query: (id) => `/packages/${id}`,
      providesTags: (_result, _error, id): TagDescription[] => [
        { type: 'Packages' },
        { type: 'Packages', id },
      ],
      async onCacheEntryAdded(arg, { updateCachedData, cacheEntryRemoved, dispatch }) {
        const socket = getSocket()

        socket.on('package:updated', (updatedPkg: Package) => {
          if (updatedPkg._id !== arg) return
          updateCachedData((draft) => {
            if (!draft) return
            Object.assign(draft, updatedPkg)
          })
        })

        socket.on('package:deleted', (id: string) => {
          if (id !== arg) return
          dispatch(inventoryApi.util.invalidateTags([{ type: 'Packages', id }]))
        })

        await cacheEntryRemoved
        socket.off('package:updated')
        socket.off('package:deleted')
      },
    }),

    getPackageByTagId: builder.query<Package, number>({
      query: (tagId) => `/packages/by-tag/${tagId}`,
      providesTags: (_result, _error, tagId): TagDescription[] => [
        { type: 'Packages' },
        { type: 'Packages', id: tagId },
      ],
    }),

    createPackage: builder.mutation<Package, { packageName: string }>({
      query: (body) => ({ url: '/packages', method: 'POST', body }),
      invalidatesTags: (): TagDescription[] => [{ type: 'Packages' }],
    }),

    updatePackage: builder.mutation<Package, { id: string; packageName: string }>({
      query: ({ id, ...body }) => ({
        url: `/packages/${id}`,
        method: 'PUT',
        body,
      }),
      invalidatesTags: (): TagDescription[] => [{ type: 'Packages' }],
    }),

    deletePackage: builder.mutation<void, string>({
      query: (id) => ({ url: `/packages/${id}`, method: 'DELETE' }),
      invalidatesTags: (): TagDescription[] => [{ type: 'Packages' }],
    }),

    patchPackageStatus: builder.mutation<Package, { id: string; status: PackageStatus }>({
      query: ({ id, status }) => ({
        url: `/packages/${id}/status`,
        method: 'PATCH',
        body: { status },
      }),
      invalidatesTags: (_r, _e, { id }): TagDescription[] => [
        { type: 'Packages' },
        { type: 'Packages', id },
      ],
    }),

    // ─── Stats (zone UX) ──────────────────────────────────────────
    getPackageStats: builder.query<PackageStats, void>({
      query: () => '/packages/stats',
      providesTags: (): TagDescription[] => [{ type: 'Stats' }],
    }),

    assignToZone: builder.mutation<Package, { id: string; zoneCode: ZoneCode | null }>({
      query: ({ id, zoneCode }) => ({
        url: `/packages/${id}/zone`,
        method: 'PATCH',
        body: { zoneCode },
      }),
      invalidatesTags: (): TagDescription[] => [{ type: 'Packages' }, { type: 'Stats' }],
    }),

    // ─── Shelves ─────────────────────────────────────────────────
    getShelves: builder.query<Shelf[], void>({
      query: () => '/shelves',
      providesTags: (): TagDescription[] => [{ type: 'Shelves' }],
    }),

    // ─── Slots ───────────────────────────────────────────────────
    getAllSlots: builder.query<ShelfSlot[], void>({
      query: () => '/shelves/slots',
      providesTags: (): TagDescription[] => [{ type: 'Slots' }],
      async onCacheEntryAdded(_arg, { updateCachedData, cacheEntryRemoved }) {
        const socket = getSocket()

        socket.on('shelf:updated', (updatedSlot: ShelfSlot) => {
          updateCachedData((draft) => {
            if (!Array.isArray(draft)) return

            // ── Step 1: Upsert the updated slot ────────────────────
            const destIdx = draft.findIndex((s) => s.code === updatedSlot.code)
            const prevDestSlot = destIdx >= 0 ? draft[destIdx] : null

            // ── Step 2: Find the source slot — the slot that previously
            // held the same package but is NOT the destination.
            // This handles both MOVE and ASSIGN scenarios. ─────────────
            const sourceSlot = draft.find(
              (s) => s.packageId === updatedSlot.packageId && s.code !== updatedSlot.code
            )

            if (sourceSlot) {
              // Package moved from sourceSlot → updatedSlot
              sourceSlot.packageId = null
              sourceSlot.status = 'AVAILABLE'
            } else if (
              prevDestSlot &&
              prevDestSlot.packageId &&
              prevDestSlot.packageId !== updatedSlot.packageId
            ) {
              // Package was replaced in-place (assign to an occupied slot)
              // The displaced package becomes unassigned — no slot to show it.
              // We leave it orphaned in the packages list; the backend owns
              // that state and will re-emit if the slot is ever used again.
              prevDestSlot.packageId = null
              prevDestSlot.status = 'AVAILABLE'
            }

            // ── Step 3: Upsert destination slot ─────────────────────
            if (destIdx >= 0) {
              draft[destIdx] = updatedSlot
            } else {
              draft.push(updatedSlot)
            }
          })
        })

        await cacheEntryRemoved
        socket.off('shelf:updated')
      },
    }),

    getSlotsByShelf: builder.query<ShelfSlot[], string>({
      query: (shelfCode) => `/shelves/${shelfCode}/slots`,
      providesTags: (): TagDescription[] => [{ type: 'Slots' }],
    }),

    assignPackageToSlot: builder.mutation<ShelfSlot, { slotCode: string; packageId: string }>({
      query: ({ slotCode, ...body }) => ({
        url: `/shelves/${slotCode}/package`,
        method: 'POST',
        body,
      }),
      invalidatesTags: (): TagDescription[] => [{ type: 'Slots' }, { type: 'Packages' }],
    }),

    movePackage: builder.mutation<
      DispatchMoveResponse,
      { sourceSlotCode: string; targetSlotCode: string }
    >({
      query: ({ sourceSlotCode, targetSlotCode }) => ({
        url: `/shelves/${sourceSlotCode}/package`,
        method: 'PUT',
        body: { targetSlotCode } as MovePackageDto,
      }),
      invalidatesTags: (): TagDescription[] => [{ type: 'Slots' }, { type: 'Packages' }],
    }),

    dispatchMove: builder.mutation<DispatchMoveResponse, DispatchMovePayload>({
      query: (body) => ({
        url: '/jobs/dispatch',
        method: 'POST',
        body,
      }),
      invalidatesTags: (): TagDescription[] => [{ type: 'Jobs' }, { type: 'Slots' }],
    }),

    getJobs: builder.query<Job[], void>({
      query: () => '/jobs',
      providesTags: (): TagDescription[] => [{ type: 'Jobs' }],
      async onCacheEntryAdded(_arg, { updateCachedData, cacheEntryRemoved }) {
        const socket = getSocket()
        socket.on('job:created', (newJob: Job) => {
          updateCachedData((draft) => {
            if (!Array.isArray(draft)) return
            const exists = draft.some((job) => job._id === newJob._id)
            if (!exists) {
              draft.push(newJob)
              draft.sort(compareJobHistory)
            }
          })
        })
        socket.on('job:updated', (updatedJob: Job) => {
          updateCachedData((draft) => {
            if (!Array.isArray(draft)) return
            const idx = draft.findIndex((job) => job._id === updatedJob._id)
            if (idx >= 0) {
              draft[idx] = updatedJob
              draft.sort(compareJobHistory)
            }
          })
        })
        await cacheEntryRemoved
        socket.off('job:created')
        socket.off('job:updated')
      },
    }),

    removePackageFromSlot: builder.mutation<void, string>({
      query: (slotCode) => ({
        url: `/shelves/${slotCode}/package`,
        method: 'DELETE',
      }),
      invalidatesTags: (): TagDescription[] => [{ type: 'Slots' }, { type: 'Packages' }],
    }),

    // ─── Calibrate (Phase 1) ──────────────────────────────────────
    assignCoordinates: builder.mutation<
      ShelfSlot,
      { slotCode: string; slotX: number; slotY: number; facingTheta?: number | null }
    >({
      query: ({ slotCode, ...body }) => ({
        url: `/shelves/${slotCode}/coordinates`,
        method: 'PUT',
        body,
      }),
      invalidatesTags: (): TagDescription[] => [{ type: 'Slots' }],
    }),

    assignCoordinatesBatch: builder.mutation<
      ShelfSlot[],
      {
        entries: Array<{
          slotCode: string
          slotX: number
          slotY: number
          facingTheta?: number | null
        }>
      }
    >({
      query: (body) => ({
        url: '/shelves/coordinates/batch',
        method: 'PUT',
        body,
      }),
      invalidatesTags: (): TagDescription[] => [{ type: 'Slots' }],
    }),

    assignAprilTag: builder.mutation<ShelfSlot, { slotCode: string; aprilTagId: number }>({
      query: ({ slotCode, ...body }) => ({
        url: `/shelves/${slotCode}/april-tag`,
        method: 'PUT',
        body,
      }),
      invalidatesTags: (): TagDescription[] => [{ type: 'Slots' }],
    }),

    // ─── Maps (Phase 4) ──────────────────────────────────────
    getRobotHealth: builder.query<BrainHealth, void>({
      query: () => '/jobs/health',
      providesTags: (): TagDescription[] => [{ type: 'Jobs' }],
    }),

    getRobotMaps: builder.query<RobotMapFile[], void>({
      query: () => '/robot/maps',
    }),

    saveRobotMap: builder.mutation<{ savedAs: string }, { name?: string }>({
      query: (body) => ({
        url: '/robot/maps/save',
        method: 'POST',
        body,
      }),
    }),
  }),
})

export const {
  useGetPackagesQuery,
  useGetPackageByIdQuery,
  useGetPackageByTagIdQuery,
  useCreatePackageMutation,
  useUpdatePackageMutation,
  useDeletePackageMutation,
  usePatchPackageStatusMutation,
  useGetPackageStatsQuery,
  useAssignToZoneMutation,
  useGetShelvesQuery,
  useGetAllSlotsQuery,
  useGetSlotsByShelfQuery,
  useAssignPackageToSlotMutation,
  useMovePackageMutation,
  useRemovePackageFromSlotMutation,
  useAssignCoordinatesMutation,
  useAssignCoordinatesBatchMutation,
  useAssignAprilTagMutation,
  useDispatchMoveMutation,
  useGetJobsQuery,
  useGetRobotHealthQuery,
  useGetRobotMapsQuery,
  useSaveRobotMapMutation,
} = inventoryApi
