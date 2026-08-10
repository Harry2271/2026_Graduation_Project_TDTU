import { create } from 'zustand';

import { api } from '@/lib/api';
import { disconnectSocket, getSocket } from '@/lib/socket';
import type { Package, PackageStats, PackageStatus, ZoneCode } from '@/types/inventory';

type PackageStore = {
  packages: Package[];
  stats: PackageStats | null;
  isLoading: boolean;
  error: string | null;
  load: () => Promise<void>;
  create: (name: string) => Promise<Package>;
  assign: (id: string, zoneCode: ZoneCode | null) => Promise<void>;
  finish: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  subscribe: () => () => void;
  /** Clear all state — call from logout to avoid stale data leaking into
   *  the next authenticated session. */
  reset: () => void;
};

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Không thể kết nối máy chủ.';

export const usePackageStore = create<PackageStore>((set, get) => ({
  packages: [],
  stats: null,
  isLoading: false,
  error: null,

  load: async () => {
    set({ isLoading: true, error: null });
    try {
      const [packagesResponse, stats] = await Promise.all([api.getPackages(), api.getStats()]);
      set({ packages: packagesResponse.items, stats, isLoading: false });
    } catch (error) {
      set({ error: errorMessage(error), isLoading: false });
    }
  },

  create: async (name) => {
    const created = await api.createPackage(name);
    set((state) => ({ packages: [created, ...state.packages] }));
    await get().load();
    return created;
  },

  assign: async (id, zoneCode) => {
    set({ error: null });
    try {
      await api.assignToZone(id, zoneCode);
    } catch (error) {
      set({ error: errorMessage(error) });
      throw error;
    }
    await get().load();
  },

  finish: async (id) => {
    set({ error: null });
    try {
      await api.patchStatus(id, 'FINISHED');
    } catch (error) {
      set({ error: errorMessage(error) });
      throw error;
    }
    await get().load();
  },

  remove: async (id) => {
    set({ error: null });
    try {
      await api.deletePackage(id);
    } catch (error) {
      set({ error: errorMessage(error) });
      throw error;
    }
    await get().load();
  },

  subscribe: () => {
    const socket = getSocket();
    const refresh = () => void get().load();
    socket.on('package:created', refresh);
    socket.on('package:updated', refresh);
    socket.on('package:deleted', refresh);
    return () => {
      socket.off('package:created', refresh);
      socket.off('package:updated', refresh);
      socket.off('package:deleted', refresh);
      disconnectSocket();
    };
  },

  reset: () => set({ packages: [], stats: null, isLoading: false, error: null }),
}));
