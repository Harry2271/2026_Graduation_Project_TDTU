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

const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL || 'wss://map.nguyen-robot.io.vn';
const WS_AUTH_TOKEN = process.env.NEXT_PUBLIC_WS_AUTH_TOKEN;

function authenticatedWsUrl(url: string): string {
  if (!WS_AUTH_TOKEN) return url;
  const wsUrl = new URL(url);
  wsUrl.searchParams.set('token', WS_AUTH_TOKEN);
  return wsUrl.toString();
}

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
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef(1000);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
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

  // ── WebSocket lifecycle ───────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    function setWsStatus(s: WsStatus) {
      setSnapshot((prev) => (prev.wsStatus === s ? prev : { ...prev, wsStatus: s }));
    }

    function dispatch(raw: string) {
      try {
        const msg = JSON.parse(raw) as { type: string; data?: unknown };
        if (msg.type === 'esp32_status') {
          statusRef.current = msg.data as Esp32Status;
          lastReceivedRef.current = Date.now();
        } else if (msg.type === 'esp32_encoder') {
          encoderRef.current = msg.data as Esp32Encoder;
          lastReceivedRef.current = Date.now();
        } else if (msg.type === 'esp32_power') {
          powerRef.current = msg.data as Esp32Power;
          lastReceivedRef.current = Date.now();
        }
      } catch {
        // ignore malformed frame
      }
    }

    async function parse(data: ArrayBuffer | Blob | string): Promise<void> {
      if (data instanceof Blob) {
        const buf = await data.arrayBuffer();
        await parse(buf);
        return;
      }
      const bytes =
        data instanceof ArrayBuffer ? new Uint8Array(data) : null;

      // ── Pre-parse filter: skip map_layer/obstacle_layer early ───────────
      // gzip payloads begin with 0x1f 0x8b; raw JSON for status/encoder
      // starts with '{'. The robot's web_bridge emits ~1.5 MB gzip map_layer
      // frames every 200 ms — decompressing them only to discard them
      // pushed the browser to OOM within a couple of minutes. Use a small
      // JSON prefix sniff instead:
      //   * {"type": "esp32_..." → keep
      //   * everything else (incl. gzip) → drop
      if (bytes) {
        // gzip magic: skip everything gzip-compressed. map_layer + obstacle_layer
        // are the only gzipped types; neither is needed by this panel.
        if (bytes[0] === 0x1f && bytes[1] === 0x8b) return;

        const text = new TextDecoder().decode(bytes);
        // json.dumps() in web_bridge.py inserts a space after the colon by
        // default. Allow optional JSON whitespace so valid ESP32 envelopes
        // are not discarded before JSON.parse().
        if (!/^\{"type"\s*:\s*"esp32_/.test(text)) return;
        dispatch(text);
        return;
      }

      if (typeof data === 'string') {
        if (!/^\{"type"\s*:\s*"esp32_/.test(data)) return;
        dispatch(data);
      }
    }

    function connect() {
      if (typeof window === 'undefined') return;
      if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) return;
      setWsStatus('connecting');
      try {
        const ws = new WebSocket(authenticatedWsUrl(WS_URL));
        wsRef.current = ws;
        ws.onopen = () => {
          if (cancelled) return;
          setWsStatus('connected');
          reconnectDelayRef.current = 1000;
          if (pingTimerRef.current) clearInterval(pingTimerRef.current);
          pingTimerRef.current = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'ping' }));
            }
          }, 5000);
        };
        ws.onmessage = (event) => {
          if (cancelled) return;
          parse(event.data as ArrayBuffer | Blob | string).catch(() => {
            /* swallow */
          });
        };
        ws.onclose = () => {
          if (cancelled) return;
          setWsStatus('disconnected');
          if (pingTimerRef.current) clearInterval(pingTimerRef.current);
          if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
          const delay = reconnectDelayRef.current;
          reconnectDelayRef.current = Math.min(delay * 2, 30000);
          reconnectTimerRef.current = setTimeout(connect, delay);
        };
        ws.onerror = () => setWsStatus('disconnected');
      } catch {
        setWsStatus('disconnected');
      }
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (pingTimerRef.current) clearInterval(pingTimerRef.current);
      if (flushTimerRef.current) clearInterval(flushTimerRef.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, []);

  const value = useMemo(() => snapshot, [snapshot]);
  return (
    <TelemetryContext.Provider value={value}>
      {children}
    </TelemetryContext.Provider>
  );
}
