import { useEffect, useRef, useCallback } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import {
  useMapStore,
  type MapData,
  type PoseData,
  type ScanData,
  type InfoData,
} from '@/store/useMapStore';

// Robot WebSocket URL — same env the web app uses (NEXT_PUBLIC_WS_URL).
// Default is the production Pi address; mobile dev on the same network can override.
const ROBOT_WS_URL =
  process.env.EXPO_PUBLIC_ROBOT_WS_URL ??
  process.env.EXPO_PUBLIC_WS_URL ??
  'wss://map.nguyen-robot.io.vn';

// Token for robot WebSocket authentication. The production wss:// URL sits
// behind a reverse-proxy that injects the token, but direct LAN dev needs
// it appended to the query string. Set EXPO_PUBLIC_WS_AUTH_TOKEN (or the
// monorepo-level ROBOT_BRAIN_TOKEN) in your mobile .env for local testing.
const WS_AUTH_TOKEN =
  process.env.EXPO_PUBLIC_WS_AUTH_TOKEN ??
  process.env.EXPO_PUBLIC_ROBOT_BRAIN_TOKEN ??
  '';

const INITIAL_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30_000;
const PING_INTERVAL = 5000;

export type RobotCommand =
  | { type: 'cmd'; command: string }
  | { type: 'esp32'; cmd: Record<string, unknown> }
  | { type: 'teleop'; vx: number; vy: number; omega: number }
  | { type: 'cylinder'; action: 'extend' | 'retract' | 'stop' }
  | { type: 'demo'; action: string }
  | { type: 'control_mode'; mode: 'AUTO' | 'MANUAL' };

/**
 * Connects to the robot's raw WebSocket (port 9091, served by
 * services/robot/src/.../web_bridge.py) and pumps scan/pose/map/info
 * messages into the global map store. Also exposes `sendCommand` so
 * the UI can drive mapping + ESP32 + cylinder.
 *
 * Reconnects with exponential backoff (1s → 30s), pauses while the
 * app is backgrounded, and resumes cleanly when foregrounded.
 */
export function useRobotWs(autoConnect = true) {
  const wsRef = useRef<WebSocket | null>(null);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef<number>(INITIAL_RECONNECT_DELAY);
  const manualCloseRef = useRef<boolean>(false);

  const setWsStatus = useMapStore((s) => s.setWsStatus);
  const setMapData = useMapStore((s) => s.setMapData);
  const setPose = useMapStore((s) => s.setPose);
  const setScanData = useMapStore((s) => s.setScanData);
  const setStatusText = useMapStore((s) => s.setStatusText);
  const setInfo = useMapStore((s) => s.setInfo);
  const bumpScanCount = useMapStore((s) => s.bumpScanCount);

  const dispatch = useCallback(
    (msg: { type: string; data?: unknown }) => {
      switch (msg.type) {
        case 'map':
        case 'map_layer': {
          setMapData(msg.data as MapData);
          setInfo({ map: true });
          break;
        }
        case 'pose': {
          setPose(msg.data as PoseData);
          setInfo({ pose: true });
          break;
        }
        case 'scan': {
          const scan = msg.data as ScanData;
          setScanData(scan);
          bumpScanCount();
          setInfo({ lidar: true });
          break;
        }
        case 'status': {
          const raw = (msg.data as string) ?? '';
          setStatusText(raw);
          const upper = raw.toUpperCase();
          if (upper.startsWith('STATE=MAPPING'))
            setInfo({ mode: 'mapping_active' });
          else if (upper.startsWith('STATE=LIVE')) setInfo({ mode: 'live' });
          else if (upper.startsWith('STATE=IDLE')) setInfo({ mode: 'idle' });
          break;
        }
        case 'info': {
          setInfo(msg.data as Partial<InfoData>);
          break;
        }
        case 'mode': {
          setInfo({ mode: msg.data as string });
          break;
        }
      }
    },
    [
      bumpScanCount,
      setInfo,
      setMapData,
      setPose,
      setScanData,
      setStatusText,
    ],
  );

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    manualCloseRef.current = false;
    setWsStatus('connecting');

    let ws: WebSocket;
    try {
      const url = WS_AUTH_TOKEN
        ? `${ROBOT_WS_URL}${ROBOT_WS_URL.includes('?') ? '&' : '?'}token=${encodeURIComponent(WS_AUTH_TOKEN)}`
        : ROBOT_WS_URL;
      ws = new WebSocket(url);
    } catch {
      setWsStatus('disconnected');
      scheduleReconnect();
      return;
    }
    wsRef.current = ws;

    ws.onopen = () => {
      setWsStatus('connected');
      reconnectDelayRef.current = INITIAL_RECONNECT_DELAY;
      pingTimerRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, PING_INTERVAL);
    };

    ws.onmessage = (event) => {
      const data = event.data;
      // Robot's web_bridge.py emits JSON text frames. RN's WebSocket onmessage
      // exposes `data` as a string for text frames. Binary frames (gzipped
      // map layers from the server) are not handled here — they fall back to
      // the standard map/scan flow without the gzip optimisation, which is
      // fine on a mobile screen and keeps the JS bridge work minimal.
      if (typeof data === 'string') {
        try {
          dispatch(JSON.parse(data));
        } catch {
          // Malformed JSON — ignore; the server may have sent a partial frame.
        }
      }
    };

    ws.onerror = () => {
      setWsStatus('disconnected');
    };

    ws.onclose = () => {
      setWsStatus('disconnected');
      if (pingTimerRef.current) {
        clearInterval(pingTimerRef.current);
        pingTimerRef.current = null;
      }
      wsRef.current = null;
      if (!manualCloseRef.current) scheduleReconnect();
    };
  }, [dispatch, setInfo, setWsStatus]);

  const scheduleReconnect = useCallback(() => {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      const delay = reconnectDelayRef.current;
      reconnectDelayRef.current = Math.min(delay * 2, MAX_RECONNECT_DELAY);
      connect();
    }, reconnectDelayRef.current);
  }, [connect]);

  const disconnect = useCallback(() => {
    manualCloseRef.current = true;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (pingTimerRef.current) {
      clearInterval(pingTimerRef.current);
      pingTimerRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setWsStatus('idle');
  }, [setWsStatus]);

  const sendCommand = useCallback((cmd: RobotCommand) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(cmd));
    return true;
  }, []);

  useEffect(() => {
    if (!autoConnect) return;
    connect();

    // Pause/resume the socket on app backgrounding. RN reuses a single
    // socket across background; we close on background and let the
    // reconnect loop restore when foregrounded.
    const onAppStateChange = (state: AppStateStatus) => {
      if (state === 'background' || state === 'inactive') {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.close();
        }
      } else if (state === 'active') {
        if (!wsRef.current || wsRef.current.readyState === WebSocket.CLOSED) {
          reconnectDelayRef.current = INITIAL_RECONNECT_DELAY;
          connect();
        }
      }
    };
    const sub = AppState.addEventListener('change', onAppStateChange);

    return () => {
      sub.remove();
      disconnect();
    };
  }, [autoConnect, connect, disconnect]);

  return { connect, disconnect, sendCommand };
}
