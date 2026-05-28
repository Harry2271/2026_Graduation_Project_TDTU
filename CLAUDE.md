# CLAUDE.md - Project Development Guide

This document defines the coding standards, project architecture, and operational commands for this Next.js frontend project.

## Operational Commands (Using Yarn)

- **Install Dependencies:** `yarn install`
- **Development Mode:** `yarn dev`
- **Build Project:** `yarn build`
- **Linting:** `yarn lint`
- **Run Tests:** `yarn test` (if configured)
- **Type Checking:** `npx tsc --noEmit` (or via IDE)

## System Architecture (App Router + Redux Toolkit)

Follow the layered architecture to ensure separation of concerns:

1. **App Router (Route Segments):** Next.js App Router handles routing and layouts via `src/app/`. Each route segment is a directory with a `page.tsx`.
2. **Store (Redux Toolkit):** Global state lives in `src/store/`. Use RTK Query for server state, plain slices for UI state.
3. **Components:** Shared UI components go in `src/components/`. Page-specific sub-components may live at the bottom of the page file or in a co-located component folder.
4. **Types:** Shared TypeScript types live in `src/types/`.

### Directory Structure

```
src/
  app/                  # Next.js App Router (route segments)
    layout.tsx          # Root layout with StoreProvider
    page.tsx            # Redirects to /inventory
    StoreProvider.tsx   # Redux Provider wrapper
    globals.css         # Tailwind v4 + CSS variables
    inventory/page.tsx  # Feature: warehouse grid management
    map/page.tsx        # Feature: SLAM map viewer (WebSocket)
    camera/page.tsx      # Feature: robot camera feed
    products/           # Feature: legacy product catalog
  components/
    Sidebar.tsx         # Fixed left navigation sidebar
    MainLayout.tsx      # Shell: Sidebar + main content area
  store/
    store.ts            # Legacy store (active, used by pages)
    index.ts            # Store factory with typed makeStore
    hooks.ts            # Typed Redux hooks (useAppDispatch, useAppSelector)
    inventorySlice.ts   # Plain slice: source/dest cell selection
    apiSlice.ts         # RTK Query: packages API (mock in-memory)
    services/
      baseApi.ts        # Base API for injectEndpoints pattern
      productApi.ts     # Injects into baseApi for products
  types/
    product.ts
    inventory.ts
```

## Redux Toolkit Patterns

### Typed Hooks (always use these)

```typescript
// src/store/hooks.ts
export const useAppDispatch = useDispatch.withTypes<AppDispatch>();
export const useAppSelector = useSelector.withTypes<RootState>();
export const useAppStore = useStore.withTypes<AppStore>();
```

```typescript
// In components
const dispatch = useAppDispatch();
const items = useAppSelector((state) => state.inventory.items);
```

### RTK Query API Structure

Use `createApi` from `@reduxjs/toolkit/query/react`. Follow the existing `apiSlice` pattern:

- **`reducerPath`**: Unique string key for the API slice in the store.
- **`baseQuery`**: Use `fetchBaseQuery` for real APIs, or `queryFn` for mock/in-memory data.
- **`tagTypes`**: Define tags for cache invalidation (e.g., `['Packages']`).
- **`endpoints`**: Use `builder.query<T, Args>` for reads, `builder.mutation<T, Args>` for writes.
- **`providesTags` / `invalidatesTags`**: Use for cache management.

```typescript
export const apiSlice = createApi({
  reducerPath: 'api',
  baseQuery: fetchBaseQuery({ baseUrl: '/' }),
  tagTypes: ['Packages'],
  endpoints: (builder) => ({
    getPackages: builder.query<PackageItem[], void>({
      queryFn: async () => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        return { data: mockPackagesData.map((pkg) => ({ ...pkg })) };
      },
      providesTags: ['Packages'],
    }),
    submitMoveCommand: builder.mutation<MoveCommandResponse, MoveCommandPayload>({
      queryFn: async (payload) => { /* ... */ },
      invalidatesTags: ['Packages'],
    }),
  }),
});

export const { useGetPackagesQuery, useSubmitMoveCommandMutation } = apiSlice;
```

### Plain Slice Pattern

Use `createSlice` for UI state that does not need server synchronization.

```typescript
// src/store/inventorySlice.ts
import { createSlice } from '@reduxjs/toolkit';

interface InventoryState {
  source: SelectedCell | null;
  dest: SelectedCell | null;
}

const initialState: InventoryState = { source: null, dest: null };

export const inventorySlice = createSlice({
  name: 'inventory',
  initialState,
  reducers: {
    setSource: (state, action: PayloadAction<SelectedCell>) => {
      state.source = action.payload;
    },
    setDest: (state, action: PayloadAction<SelectedCell>) => {
      state.dest = action.payload;
    },
    resetInventory: (state) => {
      state.source = null;
      state.dest = null;
    },
  },
});

export const { setSource, setDest, resetInventory } = inventorySlice.actions;
```

## Coding Guidelines

### TypeScript

- **Strict mode is enabled** (`"strict": true` in `tsconfig.json`). Avoid `any` — use proper types.
- **Path alias:** Use `@/*` to reference `src/*` (e.g., `import { PackageItem } from '@/types/inventory'`).
- All component props and function arguments must have explicit types.

### Naming Conventions

| Category | Convention | Example |
|---|---|---|
| Components (files) | PascalCase | `Sidebar.tsx`, `MainLayout.tsx` |
| Hooks / utilities | camelCase | `useInventory.ts`, `formatDate.ts` |
| Store slices / API slices | kebab-case | `inventory-slice.ts`, `api-slice.ts` |
| Types / interfaces | PascalCase | `PackageItem`, `MoveCommandPayload` |
| Variables / functions | camelCase | `getPackages`, `shelfId`, `selectedCell` |
| CSS / Tailwind | kebab-case | `bg-gray-100`, `text-primary` |
| Route directories | kebab-case | `inventory/`, `camera/` |

### Component Patterns

- Use **functional components** only. No class components.
- Use **client components** by declaring `"use client"` at the top of any file using React hooks, Redux hooks, Ant Design components, or browser APIs.
- Keep components **small and focused**. Extract page-specific sub-components to the bottom of the page file or a co-located component file.
- Prefer `useState`, `useEffect`, `useCallback`, `useMemo` over class-based state.

### Styling

- **Tailwind CSS v4** for layout, spacing, and custom styling. Use `@theme inline` in `globals.css` to map CSS variables to Tailwind utilities.
- **Ant Design** components for complex UI (Modal, Table, Form, Badge, etc.) via `AntdRegistry` for SSR support.
- **CSS variables** in `globals.css` for theme colors (`--background`, `--foreground`). Dark mode via `prefers-color-scheme`.
- Avoid inline styles except for dynamic values.

## UI Libraries

- **Ant Design v6**: Use pre-built components from `antd` for forms, modals, tables, badges, etc.
- **Lucide React**: Use for iconography (`lucide-react`). Avoid `@ant-design/icons` for new code unless Ant Design components require them.
- **No emotion/styled-components**: Use Tailwind + Ant Design for all styling.

## Error Handling

- Use Ant Design's `message` API for user-facing feedback: `message.success('Thành công!')`, `message.error('Lỗi!')`.
- Wrap async operations in try/catch blocks. Handle loading and error states in components.
- For RTK Query errors, the `error` property on the query result object contains the error details.

## Important Project Notes

- **Bilingual UI**: All user-facing text is in Vietnamese. Keep it consistent.
- **Mock data** for packages lives in-memory in `src/store/apiSlice.ts`. It resets on server restart.
- **WebSocket**: `map/page.tsx` connects to `wss://map.nguyen-robot.io.vn` (robot-core's web_bridge.py on port 9091). Handle connection state gracefully.
- **Real-time (Socket.IO)**: `src/lib/socket.ts` manages the Socket.IO connection to `NEXT_PUBLIC_API_BASE_URL`. Socket events are wired into `inventoryApi` via RTK Query's `onCacheEntryAdded` lifecycle hook — no extra state needed. Events update the RTK Query cache directly, so all subscribed components auto-re-render.
  | Event | Effect on cache |
  |---|---|
  | `package:created` | Prepend new package to `getPackages` cache |
  | `package:updated` | Replace matching package in `getPackages` cache |
  | `package:deleted` | Remove matching package from `getPackages` cache |
  | `shelf:updated` | Upsert slot in `getAllSlots` cache |
- **Docker**: `next.config.ts` uses `output: 'standalone'` for containerized deployment.
- **No testing framework** is currently installed. Do not add tests unless explicitly requested.
