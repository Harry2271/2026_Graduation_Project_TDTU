'use client';

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { getRobotSocket } from '@/lib/robotSocket';

// ── Payload shapes (mirror firmware type-130/131 + web_bridge.py envelope) ──

export interface Esp32MotorStatus {
  t: number; // target PWM
  r: number; // current RPM
}

export interface Esp32SystemState {
  imu: boolean;
  pwr: boolean;
  sharp: number; // cm
  obs: boolean;
  tof_mm: number;
  cyl: string;
}

export interface Esp32Status {
  ts: number;
  type: 131;
  mode: string;
  estop: boolean;
  max_pct: number;
  nav?: [number, number, number];
  motors?: Esp32MotorStatus[];
  ir?: boolean[];
  st?: Esp32SystemState;
}

export interface Esp32EncoderMotor {
  id: number;
  name: string;
  count: number;
  rpm: number;
}

export interface Esp32Power {
  bus_v?: number;
  voltage_mv?: number;
  current_ma?: number;
  current_a?: number;
  power_mw?: number;
  power_w?: number;
  uptime_ms?: number;
}

export type Esp32Encoder = Esp32EncoderMotor[];

export type WsStatus = 'connecting' | 'connected' | 'disconnected';

interface TelemetryContextValue {
  status: Esp32Status | null;
  encoder: Esp32Encoder | null;
  power: Esp32Power | null;
  wsStatus: WsStatus;
  lastReceivedAt: number; // Date.now() of last esp32 frame
}

const TelemetryContext = createContext<TelemetryContextValue>({
  status: null,
  encoder: null,
  power: null,
  wsStatus: 'connecting',
  lastReceivedAt: 0,
});

export function useRobotTelemetry() {
  return useContext(TelemetryContext);
}

// ── Render throttle ────────────────────────────────────────────────────────
// ESP32 sends ~2 Hz but brain_node might ask for status bursts. Throttle
// setState to 5 Hz so React doesn't drown in renders when the panel mounts
// across every page.
const RENDER_INTERVAL_MS = 200;

// ── Component ──────────────────────────────────────────────────────────────

export function RobotTelemetryProvider({ children }: { children: ReactNode }) {
  // Refs hold the latest payload — never trigger a render themselves.
  const statusRef = useRef<Esp32Status | null>(null);
  const encoderRef = useRef<Esp32Encoder | null>(null);
  const powerRef = useRef<Esp32Power | null>(null);
  const lastReceivedRef = useRef(0);
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // State mirrors refs at RENDER_INTERVAL_MS — the only path that re-renders.
  const [snapshot, setSnapshot] = useState<TelemetryContextValue>({
    status: null,
    encoder: null,
    power: null,
    wsStatus: 'connecting',
    lastReceivedAt: 0,
  });

  // ── Flush refs → state (throttled) ────────────────────────────────────────
  useEffect(() => {
    flushTimerRef.current = setInterval(() => {
      setSnapshot((prev) => {
        const next: TelemetryContextValue = {
          status: statusRef.current,
          encoder: encoderRef.current,
          power: powerRef.current,
          wsStatus: prev.wsStatus,
          lastReceivedAt: lastReceivedRef.current,
        };
        // Skip re-render if nothing changed (deep-equal on key timestamps).
        if (
          next.status === prev.status &&
          next.encoder === prev.encoder &&
          next.power === prev.power &&
          next.wsStatus === prev.wsStatus &&
          next.lastReceivedAt === prev.lastReceivedAt
        ) {
          return prev;
        }
        return next;
      });
    }, RENDER_INTERVAL_MS);
    return () => {
      if (flushTimerRef.current) clearInterval(flushTimerRef.current);
    };
  }, []);

  // ── Shared WebSocket subscriptions ────────────────────────────────────────
  useEffect(() => {
    const robotSocket = getRobotSocket();
    const setWsStatus = (s: WsStatus) => {
      setSnapshot((prev) => (prev.wsStatus === s ? prev : { ...prev, wsStatus: s }));
    };
    const onStatus = (data: unknown) => {
      statusRef.current = data as Esp32Status;
      lastReceivedRef.current = Date.now();
    };
    const onEncoder = (data: unknown) => {
      encoderRef.current = data as Esp32Encoder;
      lastReceivedRef.current = Date.now();
    };
    const onPower = (data: unknown) => {
      powerRef.current = data as Esp32Power;
      lastReceivedRef.current = Date.now();
    };
    const onConnected = () => setWsStatus('connected');
    const onDisconnected = () => setWsStatus('disconnected');

    robotSocket.on('esp32_status', onStatus);
    robotSocket.on('esp32_encoder', onEncoder);
    robotSocket.on('esp32_power', onPower);
    robotSocket.on('connected', onConnected);
    robotSocket.on('disconnected', onDisconnected);
    setWsStatus(robotSocket.isConnected() ? 'connected' : 'connecting');

    return () => {
      robotSocket.off('esp32_status', onStatus);
      robotSocket.off('esp32_encoder', onEncoder);
      robotSocket.off('esp32_power', onPower);
      robotSocket.off('connected', onConnected);
      robotSocket.off('disconnected', onDisconnected);
    };
  }, []);

  const value = useMemo(() => snapshot, [snapshot]);
  return (
    <TelemetryContext.Provider value={value}>
      {children}
    </TelemetryContext.Provider>
  );
}
