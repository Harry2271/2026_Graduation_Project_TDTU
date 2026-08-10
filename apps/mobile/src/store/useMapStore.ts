import { create } from 'zustand';

export type ScanPoint = { x: number; y: number };
export type ScanData = { points: ScanPoint[]; count: number };
export type PoseData = { x: number; y: number; theta: number };
export type MapData = {
  width: number;
  height: number;
  resolution: number;
  origin_x: number;
  origin_y: number;
  origin_theta: number;
  data: number[];
};
export type InfoData = {
  lidar: boolean;
  map: boolean;
  pose: boolean;
  mode: string;
  coverage_pct?: number;
};

type MapStore = {
  wsStatus: 'idle' | 'connecting' | 'connected' | 'disconnected';
  mapData: MapData | null;
  pose: PoseData | null;
  scanData: ScanData | null;
  statusText: string;
  info: InfoData;
  scanCount: number;
  lastUpdate: number;
  setWsStatus: (s: MapStore['wsStatus']) => void;
  setMapData: (m: MapData) => void;
  setPose: (p: PoseData) => void;
  setScanData: (s: ScanData) => void;
  setStatusText: (t: string) => void;
  setInfo: (i: Partial<InfoData>) => void;
  bumpScanCount: () => void;
  reset: () => void;
};

export const useMapStore = create<MapStore>((set) => ({
  wsStatus: 'idle',
  mapData: null,
  pose: null,
  scanData: null,
  statusText: '',
  info: { lidar: false, map: false, pose: false, mode: 'live' },
  scanCount: 0,
  lastUpdate: 0,

  setWsStatus: (wsStatus) => set({ wsStatus }),
  setMapData: (mapData) => set({ mapData, lastUpdate: Date.now() }),
  setPose: (pose) => set({ pose, lastUpdate: Date.now() }),
  setScanData: (scanData) => set({ scanData, lastUpdate: Date.now() }),
  setStatusText: (statusText) => set({ statusText }),
  setInfo: (i) =>
    set((state) => ({ info: { ...state.info, ...i }, lastUpdate: Date.now() })),
  bumpScanCount: () => set((s) => ({ scanCount: s.scanCount + 1 })),
  reset: () =>
    set({
      mapData: null,
      pose: null,
      scanData: null,
      statusText: '',
      info: { lidar: false, map: false, pose: false, mode: 'live' },
      scanCount: 0,
    }),
}));
