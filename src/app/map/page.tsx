'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { MapPin, RotateCcw, ZoomIn, ZoomOut, Maximize2, Ruler, Compass, Target, WifiOff } from 'lucide-react';
import { Button, notification, Tooltip, Modal } from 'antd';

const WS_URL = 'wss://map.nguyen-robot.io.vn';

// ─── Types ─────────────────────────────────────────────────────────────────

interface ScanData {
  points: { x: number; y: number }[];
  count: number;
}

interface MapData {
  width: number;
  height: number;
  resolution: number;
  origin_x: number;
  origin_y: number;
  origin_theta: number;
  data: number[];
}

interface PoseData { x: number; y: number; theta: number; }

interface InfoData { lidar: boolean; map: boolean; pose: boolean; mode: string; coverage_pct?: number; }

// ─── Coordinate helpers ────────────────────────────────────────────────────

/** World → canvas pixel (canvas Y is down, grid Y is up → flip) */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function worldToCanvas(wx: number, wy: number, map: MapData): { cx: number; cy: number } {
  return {
    cx: (wx - map.origin_x) / map.resolution,
    cy: (map.height - 1) - (wy - map.origin_y) / map.resolution,
  };
}

/** Scan frame → world frame, based on lidarAxis orientation */
function robotToWorld(rx: number, ry: number, pose: PoseData, lidarAxis: number): { wx: number; wy: number } {
  const c = Math.cos(pose.theta);
  const s = Math.sin(pose.theta);
  let fx: number, fy: number;
  switch (lidarAxis) {
    case 0: fx =  rx; fy =  ry; break; // +X = forward
    case 1: fx =  ry; fy = -rx; break; // +Y = forward
    case 2: fx = -rx; fy = -ry; break; // -X = forward
    case 3: fx = -ry; fy =  rx; break; // -Y = forward
    default: fx =  rx; fy =  ry; break;
  }
  return { wx: c * fx - s * fy + pose.x, wy: s * fx + c * fy + pose.y };
}

// ─── Component ─────────────────────────────────────────────────────────────

export default function MapPage() {
  const [wsStatus, setWsStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [mapData, setMapData] = useState<MapData | null>(null);
  const [pose, setPose] = useState<PoseData | null>(null);
  const [scanData, setScanData] = useState<ScanData | null>(null);
  const [statusText, setStatusText] = useState('');
  const [info, setInfo] = useState<InfoData>({ lidar: false, map: false, pose: false, mode: 'live' });

  // Viewport state
  const [isHeadingUp, setIsHeadingUp] = useState(true);
  const [isRobotLock, setIsRobotLock] = useState(true);
  const [zoom, setZoom] = useState(1);
  // Debug: lidar axis orientation (0=+X, 1=+Y, 2=-X, 3=-Y)
  const [lidarAxis, setLidarAxis] = useState(1);

  // Refs (mutable state that doesn't trigger re-renders)
  const mapDataRef = useRef<MapData | null>(null);
  const poseRef = useRef<PoseData | null>(null);
  const scanDataRef = useRef<ScanData | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animRef = useRef<number>(0);
  const pingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const zoomRef = useRef<number>(1);
  const headingUpRef = useRef<boolean>(true);
  const connectWsRef = useRef<() => void>(() => {});
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef(1000);
  const lidarAxisRef = useRef<number>(1);

  // Generated occupancy grid (from accumulated LIDAR scans)
  const occGridRef = useRef<MapData | null>(null);
  const occScaleRef = useRef<number>(0.05); // 5 cm/cell
  const occSizeRef = useRef<number>(500);    // 500×500 cells = ±12.5 m at 5cm/cell

  // Accumulated scan bounds for auto-fit scale
  const scanBoundsRef = useRef<{ minX: number; maxX: number; minY: number; maxY: number } | null>(null);

  // Sync state → refs
  useEffect(() => { mapDataRef.current = mapData; }, [mapData]);
  useEffect(() => { poseRef.current = pose; }, [pose]);
  useEffect(() => { scanDataRef.current = scanData; }, [scanData]);
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  useEffect(() => { headingUpRef.current = isHeadingUp; }, [isHeadingUp]);
  useEffect(() => { lidarAxisRef.current = lidarAxis; }, [lidarAxis]);

  // ─── Canvas resize ──────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const container = canvas.parentElement;
    if (!container) return;

    const observer = new ResizeObserver(() => {
      canvas.width = container.clientWidth;
      canvas.height = container.clientHeight;
    });
    observer.observe(container);
    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;
    return () => observer.disconnect();
  }, []);

  // ─── Offscreen canvas for map grid (incremental updates) ───────
  const offscreenRef = useRef<HTMLCanvasElement | null>(null);
  const prevMapDataRef = useRef<number[] | null>(null);
  const [occGridVersion, setOccGridVersion] = useState(0);

  // Offscreen canvas for generated occupancy grid
  const occOffscreenRef = useRef<HTMLCanvasElement | null>(null);
  const prevOccGridRef = useRef<number[] | null>(null);

  // Build generated grid image whenever the grid is updated
  useEffect(() => {
    const grid = occGridRef.current;
    if (!grid) return;
    const { width: gw, height: gh } = grid;

    let off = occOffscreenRef.current;
    if (!off || off.width !== gw || off.height !== gh) {
      off = document.createElement('canvas');
      off.width = gw;
      off.height = gh;
      occOffscreenRef.current = off;
      prevOccGridRef.current = null;
    }

    const ctx = off.getContext('2d');
    if (!ctx) return;
    let imgData: ImageData;
    try {
      imgData = ctx.getImageData(0, 0, gw, gh);
    } catch {
      return;
    }
    const buf = imgData.data;
    const prev = prevOccGridRef.current;

    if (prev && prev.length === grid.data.length) {
      for (let i = 0; i < grid.data.length; i++) {
        if (prev[i] !== grid.data[i]) {
          const j = i * 4;
          const v = grid.data[i];
          if (v === 100) {
            buf[j] = 0; buf[j+1] = 0; buf[j+2] = 0; buf[j+3] = 255;
          } else if (v === 0) {
            buf[j] = 255; buf[j+1] = 255; buf[j+2] = 255; buf[j+3] = 255;
          } else {
            buf[j] = 128; buf[j+1] = 128; buf[j+2] = 128; buf[j+3] = 255;
          }
        }
      }
    } else {
      for (let i = 0; i < grid.data.length; i++) {
        const v = grid.data[i];
        const j = i * 4;
        if (v === 100) {
          buf[j] = 0; buf[j+1] = 0; buf[j+2] = 0; buf[j+3] = 255;
        } else if (v === 0) {
          buf[j] = 255; buf[j+1] = 255; buf[j+2] = 255; buf[j+3] = 255;
        } else {
          buf[j] = 128; buf[j+1] = 128; buf[j+2] = 128; buf[j+3] = 255;
        }
      }
    }

    prevOccGridRef.current = [...grid.data];
    ctx.putImageData(imgData, 0, 0);
    setOccGridVersion(v => v + 1);
  }, [occGridRef.current?.data.length]);

  const buildMapImage = useCallback(() => {
    const map = mapDataRef.current;
    if (!map) return;
    const { width: gw, height: gh } = map;

    let off = offscreenRef.current;
    if (!off || off.width !== gw || off.height !== gh) {
      off = document.createElement('canvas');
      off.width = gw;
      off.height = gh;
      offscreenRef.current = off;
      prevMapDataRef.current = null;
    }

    const ctx = off.getContext('2d');
    if (!ctx) return;

    // Get existing pixel buffer — avoids allocate/free every update
    let imgData: ImageData;
    try {
      imgData = ctx.getImageData(0, 0, gw, gh);
    } catch {
      // Canvas not ready — skip
      return;
    }
    const buf = imgData.data;
    const prev = prevMapDataRef.current;

    if (prev && prev.length === map.data.length) {
      // Incremental: only update cells that changed
      for (let i = 0; i < map.data.length; i++) {
        if (prev[i] !== map.data[i]) {
          const j = i * 4;
          const v = map.data[i];
          if (v === 100) {
            // Occupied — black
            buf[j] = 0; buf[j+1] = 0; buf[j+2] = 0; buf[j+3] = 255;
          } else if (v === 0) {
            // Free — white
            buf[j] = 255; buf[j+1] = 255; buf[j+2] = 255; buf[j+3] = 255;
          } else {
            // Unknown — gray
            buf[j] = 128; buf[j+1] = 128; buf[j+2] = 128; buf[j+3] = 255;
          }
        }
      }
    } else {
      // Full rebuild on first load or resize
      for (let i = 0; i < map.data.length; i++) {
        const v = map.data[i];
        const j = i * 4;
        if (v === 100) {
          buf[j] = 0; buf[j+1] = 0; buf[j+2] = 0; buf[j+3] = 255;
        } else if (v === 0) {
          buf[j] = 255; buf[j+1] = 255; buf[j+2] = 255; buf[j+3] = 255;
        } else {
          buf[j] = 128; buf[j+1] = 128; buf[j+2] = 128; buf[j+3] = 255;
        }
      }
    }

    prevMapDataRef.current = [...map.data];
    ctx.putImageData(imgData, 0, 0);
  }, []);

  // Rebuild map image whenever map data changes
  useEffect(() => {
    if (mapData) buildMapImage();
  }, [mapData, buildMapImage]);

  // ─── Build occupancy grid from accumulated LIDAR scans ─────────────────
  function buildOccupancyGrid(scan: ScanData) {
    const p = poseRef.current;
    if (!p || !scan.points.length) return;

    const res = occScaleRef.current;
    const size = occSizeRef.current;
    const half = (size * res) / 2;

    // Init or re-use grid
    let grid = occGridRef.current;
    if (!grid || grid.width !== size || grid.height !== size) {
      grid = {
        width: size,
        height: size,
        resolution: res,
        origin_x: -half,
        origin_y: -half,
        origin_theta: 0,
        data: new Array(size * size).fill(-1), // -1 = unknown
      };
      occGridRef.current = grid;
    }

    // Track per-ray passes to avoid double-counting
    const visitedFree = new Set<number>();

    for (let i = 0; i < scan.points.length; i++) {
      const wp = robotToWorld(scan.points[i].x, scan.points[i].y, p, lidarAxisRef.current);
      const wx = wp.wx;
      const wy = wp.wy;

      // Mark free cells along the ray (bresenham from robot to endpoint)
      const rx = Math.round((p.x + half) / res);
      const ry = Math.round(size - (p.y + half) / res);
      const ex = Math.round((wx + half) / res);
      const ey = Math.round(size - (wy + half) / res);

      const dx = Math.abs(ex - rx);
      const dy = Math.abs(ey - ry);
      const sx = rx < ex ? 1 : -1;
      const sy = ry < ey ? 1 : -1;
      let err = dx - dy;
      let cx = rx;
      let cy = ry;

      while (true) {
        if (cx < 0 || cx >= size || cy < 0 || cy >= size) break;
        const idx = cy * size + cx;
        if (cx === ex && cy === ey) break;
        if (!visitedFree.has(idx)) {
          visitedFree.add(idx);
          if (grid!.data[idx] === -1) grid!.data[idx] = 0; // free
        }
        const e2 = 2 * err;
        if (e2 > -dy) { err -= dy; cx += sx; }
        if (e2 < dx) { err += dx; cy += sy; }
      }

      // Mark endpoint as occupied
      if (ex >= 0 && ex < size && ey >= 0 && ey < size) {
        const idx = ey * size + ex;
        if (grid!.data[idx] !== 0) grid!.data[idx] = 100; // occupied
      }

      // Track world bounds of all scan endpoints for auto-fit
      const b = scanBoundsRef.current;
      if (!b) {
        scanBoundsRef.current = { minX: wx, maxX: wx, minY: wy, maxY: wy };
      } else {
        scanBoundsRef.current = {
          minX: Math.min(b.minX, wx),
          maxX: Math.max(b.maxX, wx),
          minY: Math.min(b.minY, wy),
          maxY: Math.max(b.maxY, wy),
        };
      }
    }
  }

  // ─── Draw overlay (robot + LIDAR on top of map image) ─────────────────
  function drawOverlay() {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;
    const zoom = zoomRef.current;
    const isHU = headingUpRef.current;
    const p = poseRef.current;

    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, W, H);

    const map = mapDataRef.current || occGridRef.current;

    // ── Map-based drawing ────────────────────────────────────────────────
    if (map) {
      const isGenerated = !mapDataRef.current;
      const off = isGenerated ? occOffscreenRef.current : offscreenRef.current;
      if (!off) return;

      const { width: gw, height: gh, resolution: res, origin_x, origin_y } = map;
      const scaleX = (W / gw) * zoom;
      const scaleY = (H / gh) * zoom;
      const scale = Math.min(scaleX, scaleY);
      const mapX = (W - gw * scale) / 2;
      const mapY = (H - gh * scale) / 2;

      ctx.save();
      if (p && isHU) {
        const cx = mapX + (p.x - origin_x) / res * scale;
        const cy = mapY + (gh - (p.y - origin_y) / res) * scale;
        ctx.translate(cx, cy);
        ctx.rotate(-p.theta - Math.PI / 2);
        ctx.translate(-cx, -cy);
      }
      ctx.drawImage(off, mapX, mapY, gw * scale, gh * scale);
      ctx.restore();

      const worldToScreen = (wx: number, wy: number) => {
        const gx = (wx - origin_x) / res;
        const gy = (wy - origin_y) / res;
        let sx = mapX + gx * scale;
        let sy = mapY + gy * scale;
        if (p && isHU) {
          const cx = mapX + (p.x - origin_x) / res * scale;
          const cy = mapY + (p.y - origin_y) / res * scale;
          const cos = Math.cos(-p.theta - Math.PI / 2);
          const sin = Math.sin(-p.theta - Math.PI / 2);
          const dx = sx - cx; const dy = sy - cy;
          sx = cx + cos * dx - sin * dy;
          sy = cy + sin * dx + cos * dy;
        }
        return { sx, sy };
      };

      // LIDAR scan on map
      const scan = scanDataRef.current;
      if (p && scan && scan.points.length > 0) {
        ctx.beginPath();
        for (let i = 0; i < scan.points.length; i++) {
          const wp = robotToWorld(scan.points[i].x, scan.points[i].y, p, lidarAxisRef.current);
          const sp = worldToScreen(wp.wx, wp.wy);
          if (i === 0) ctx.moveTo(sp.sx, sp.sy);
          else ctx.lineTo(sp.sx, sp.sy);
        }
        ctx.strokeStyle = 'rgba(59,130,246,0.12)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = 'rgba(59,130,246,0.6)';
        for (let i = 0; i < scan.points.length; i += 2) {
          const wp = robotToWorld(scan.points[i].x, scan.points[i].y, p, lidarAxisRef.current);
          const sp = worldToScreen(wp.wx, wp.wy);
          ctx.beginPath();
          ctx.arc(sp.sx, sp.sy, 1, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Robot on map
      if (p) {
        const rp = worldToScreen(p.x, p.y);
        drawRobot(ctx, rp.sx, rp.sy, zoom);
      }

      return;
    }

    // ── No map: draw robot + LIDAR scan in world-scaled space ────────────
    const scan = scanDataRef.current;
    const hasScan = p && scan && scan.points.length > 0;

    // Auto-fit: calculate scale from accumulated scan bounds so everything fits in canvas
    const bounds = scanBoundsRef.current;
    const padding = 0.3; // meters of padding around the scan
    let scale: number;
    if (bounds) {
      const worldW = bounds.maxX - bounds.minX + padding * 2;
      const worldH = bounds.maxY - bounds.minY + padding * 2;
      scale = Math.min((W - 40) / worldW, (H - 40) / worldH) * zoom;
    } else {
      // No scans yet — use default: fit 6 m range in the shorter canvas dimension
      const defaultRange = 6.0;
      scale = Math.min(W, H) / defaultRange * zoom;
    }
    // Canvas center (also rotation center for heading-up)
    const cx = W / 2;
    const cy = H / 2;

    // world→canvas: center on accumulated bounds (or world origin if no bounds yet)
    const worldToCanvas = (wx: number, wy: number) => {
      let sx: number, sy: number;
      if (bounds) {
        // Center the bounds region in the canvas
        const worldCX = (bounds.minX + bounds.maxX) / 2;
        const worldCY = (bounds.minY + bounds.maxY) / 2;
        sx = cx + (wx - worldCX) * scale;
        sy = cy + (wy - worldCY) * scale;
      } else {
        sx = cx + wx * scale;
        sy = cy + wy * scale;
      }
      if (isHU && p) {
        const cos = Math.cos(-p.theta - Math.PI / 2);
        const sin = Math.sin(-p.theta - Math.PI / 2);
        const dx = sx - cx; const dy = sy - cy;
        sx = cx + cos * dx - sin * dy;
        sy = cy + sin * dx + cos * dy;
      }
      return { sx, sy };
    };

    // Draw robot at bounds-center (or at pose if tracking)
    const robotPx = Math.max(14, scale * 0.15);
    const robotPos = isHU && p ? worldToCanvas(p.x, p.y) : worldToCanvas(0, 0);
    drawRobot(ctx, robotPos.sx, robotPos.sy, zoom);

    // Draw LIDAR scan
    if (hasScan) {
      ctx.beginPath();
      for (let i = 0; i < scan.points.length; i++) {
        const wp = robotToWorld(scan.points[i].x, scan.points[i].y, p!, lidarAxisRef.current);
        const sp = worldToCanvas(wp.wx, wp.wy);
        if (i === 0) ctx.moveTo(sp.sx, sp.sy);
        else ctx.lineTo(sp.sx, sp.sy);
      }
      ctx.strokeStyle = 'rgba(59,130,246,0.25)';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.fillStyle = 'rgba(59,130,246,0.7)';
      for (let i = 0; i < scan.points.length; i += 2) {
        const wp = robotToWorld(scan.points[i].x, scan.points[i].y, p!, lidarAxisRef.current);
        const sp = worldToCanvas(wp.wx, wp.wy);
        ctx.beginPath();
        ctx.arc(sp.sx, sp.sy, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // ─── Draw robot shape at screen position ───────────────────────────────
  function drawRobot(ctx: CanvasRenderingContext2D, sx: number, sy: number, zoom: number) {
    const robotPx = Math.max(12, zoom * 0.8);
    ctx.save();
    ctx.translate(sx, sy);
    ctx.beginPath();
    ctx.arc(0, 0, robotPx, 0, Math.PI * 2);
    ctx.fillStyle = '#22c55e';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
    const aLen = robotPx * 2;
    const aW = robotPx * 0.7;
    ctx.beginPath();
    ctx.moveTo(aLen, 0);
    ctx.lineTo(aLen - aW, -aW * 0.5);
    ctx.lineTo(aLen - aW, aW * 0.5);
    ctx.closePath();
    ctx.fillStyle = '#ef4444';
    ctx.fill();
    ctx.restore();
  }

  // ─── Render loop ────────────────────────────────────────────────────────
  useEffect(() => {
    let lastTs = 0;

    const loop = (ts: number) => {
      if (ts - lastTs >= 33) {
        drawOverlay();
        lastTs = ts;
      }
      animRef.current = requestAnimationFrame(loop);
    };

    animRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animRef.current);
  }, []);

  // ─── WebSocket ───────────────────────────────────────────────────────
  function connectWs() {
    if (typeof window === 'undefined') return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    setWsStatus('connecting');
    try {
      const ws = new WebSocket(WS_URL);

      ws.onopen = () => {
        setWsStatus('connected');
        reconnectDelayRef.current = 1000; // reset backoff on successful connect
        pingRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
          }
        }, 5000);
      };

      ws.onmessage = (event) => {
        try {
          const msg: { type: string; data?: unknown } = JSON.parse(event.data as string);
          switch (msg.type) {
            case 'map':
              setMapData({ ...(msg.data as MapData) });
              mapDataRef.current = msg.data as MapData;
              break;
            case 'pose':
              setPose({ ...(msg.data as PoseData) });
              poseRef.current = msg.data as PoseData;
              break;
            case 'scan':
              setScanData({ ...(msg.data as ScanData) });
              scanDataRef.current = msg.data as ScanData;
              buildOccupancyGrid(msg.data as ScanData);
              break;
            case 'status':
              setStatusText((msg.data as string) || '');
              break;
            case 'info':
              setInfo(msg.data as InfoData);
              break;
            case 'mode':
              setInfo(prev => ({ ...prev, mode: msg.data as string }));
              break;
            case 'pong':
              break;
          }
        } catch {
          // ignore
        }
      };

      ws.onclose = () => {
        setWsStatus('disconnected');
        if (pingRef.current) clearInterval(pingRef.current);
        // Auto-reconnect with exponential backoff
        if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = setTimeout(() => {
          reconnectDelayRef.current = Math.min(reconnectDelayRef.current * 2, 30000);
          connectWs();
        }, reconnectDelayRef.current);
      };
      ws.onerror = () => {
        setWsStatus('disconnected');
      };

      wsRef.current = ws;
    } catch {
      setWsStatus('disconnected');
    }
  }

  useEffect(() => { connectWsRef.current = connectWs; });

  useEffect(() => {
    connectWsRef.current();
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
      if (pingRef.current) clearInterval(pingRef.current);
    };
  }, []);

  // ─── Controls ─────────────────────────────────────────────────────────
  const handleZoomIn = () => setZoom(v => Math.min(8, +(v + 0.5).toFixed(2)));
  const handleZoomOut = () => setZoom(v => Math.max(0.1, +(v - 0.5).toFixed(2)));
  const resetView = () => { setZoom(1); };

  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

  const sendCmd = useCallback((command: string, label: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      notification.warning({ title: 'Mất kết nối', description: 'Không thể gửi lệnh. Đang thử kết nối lại...', placement: 'topRight' });
      connectWsRef.current();
      return;
    }
    wsRef.current.send(JSON.stringify({ type: 'cmd', action: 'mapping', command }));
    notification.success({ title: 'Thành công', description: `Đã gửi lệnh ${label}`, placement: 'topRight' });
  }, []);

  const handleStartScan = () => {
    setIsStarting(true);
    sendCmd('start', 'bắt đầu quét bản đồ');
    occGridRef.current = null;
    occOffscreenRef.current = null;
    scanBoundsRef.current = null;
    setTimeout(() => setIsStarting(false), 1500);
  };

  const handleStopScan = () => {
    setIsStopping(true);
    sendCmd('stop', 'dừng quét bản đồ');
    setTimeout(() => setIsStopping(false), 1500);
  };

  const handleResetMap = () => {
    setIsResetting(true);
    sendCmd('reset', 'xóa bản đồ');
    mapDataRef.current = null;
    setMapData(null);
    occGridRef.current = null;
    occOffscreenRef.current = null;
    scanBoundsRef.current = null;
    setTimeout(() => setIsResetting(false), 1500);
  };

  const confirmReset = () => {
    Modal.confirm({
      title: 'Xác nhận xóa bản đồ',
      content: 'Thao tác này sẽ xóa toàn bộ dữ liệu bản đồ. Tiếp tục?',
      okText: 'Xác nhận Xóa',
      cancelText: 'Hủy',
      okButtonProps: { danger: true },
      onOk: handleResetMap,
    });
  };

  const isOnline = wsStatus === 'connected';

  return (
    <div className="p-8 min-h-screen flex flex-col bg-slate-100 select-none font-sans">
      {/* ── Header ── */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 pb-6">
        <div>
          <h1 className="text-3xl font-extrabold text-slate-900 flex items-center gap-3 tracking-tight">
            <MapPin className="text-red-500" size={32} />
            Bản Đồ SLAM — Real-time
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            LIDAR scan · Occupancy Grid · Robot pose trực tiếp từ robot
          </p>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <div className={`flex items-center gap-2 px-3.5 py-2.5 rounded-2xl text-xs font-bold border ${isOnline ? 'text-emerald-600 border-emerald-300 bg-emerald-50' : 'text-rose-600 border-rose-300 bg-rose-50'}`}>
            <span className={`w-2.5 h-2.5 rounded-full ${isOnline ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'}`} />
            {isOnline ? 'Robot Online' : 'Robot Offline'}
          </div>

          {isOnline && (
            <div className="flex items-center gap-2 px-3.5 py-2.5 rounded-2xl text-xs font-bold border border-slate-200 bg-slate-50 text-slate-600">
              <span className={`w-2 h-2 rounded-full ${info.lidar ? 'bg-blue-500 animate-pulse' : 'bg-slate-300'}`} title="LIDAR" />
              <span className={`w-2 h-2 rounded-full ${info.map ? 'bg-emerald-500' : 'bg-slate-300'}`} title="Map" />
              <span className={`w-2 h-2 rounded-full ${info.pose ? 'bg-amber-500' : 'bg-slate-300'}`} title="Pose" />
              <span className={`ml-1 px-2 py-0.5 rounded font-mono font-bold ${info.mode === 'mapping' ? 'text-yellow-600' : info.mode === 'live' ? 'text-emerald-600' : 'text-slate-500'}`}>
                {info.mode?.toUpperCase() || 'IDLE'}
              </span>
              {info.coverage_pct !== undefined && (
                <span className="font-mono text-blue-600" title="Độ phủ bản đồ">{info.coverage_pct}%</span>
              )}
              <span className="font-mono text-slate-400">{statusText || 'IDLE'}</span>
            </div>
          )}

          {pose && isOnline && (
            <div className="px-3.5 py-2.5 rounded-2xl text-xs font-mono font-bold text-slate-600 border border-slate-200 bg-slate-50">
              x:{pose.x.toFixed(2)} y:{pose.y.toFixed(2)} θ:{(pose.theta * 180 / Math.PI).toFixed(0)}°
            </div>
          )}

          <div className="flex items-center gap-2">
            <Tooltip title="Bắt đầu quét bản đồ (mapping mode)">
              <Button
                type="primary"
                size="large"
                icon={<MapPin size={18} className={isStarting ? 'animate-pulse' : ''} />}
                loading={isStarting}
                onClick={handleStartScan}
                disabled={info.mode === 'mapping'}
                className="flex items-center gap-2 rounded-2xl font-bold shadow-md"
              >
                Bắt Đầu Quét
              </Button>
            </Tooltip>

            <Tooltip title="Dừng quét, chuyển sang chế độ định vị">
              <Button
                size="large"
                icon={<Target size={18} className={isStopping ? 'animate-pulse' : ''} />}
                loading={isStopping}
                onClick={handleStopScan}
                disabled={info.mode !== 'mapping'}
                className="flex items-center gap-2 rounded-2xl font-bold shadow-md border-amber-400 text-amber-600 hover:text-amber-700 hover:border-amber-500"
              >
                Dừng Quét
              </Button>
            </Tooltip>

            <Tooltip title="Xóa bản đồ và quét lại từ đầu">
              <Button
                type="primary"
                danger
                size="large"
                icon={<RotateCcw size={18} className={isResetting ? 'animate-spin' : ''} />}
                loading={isResetting}
                onClick={confirmReset}
                className="flex items-center gap-2 rounded-2xl font-bold shadow-md"
              >
                Xóa Bản Đồ
              </Button>
            </Tooltip>
          </div>
        </div>
      </div>

      {/* ── Canvas viewer — fills remaining height ── */}      <div className="flex-1 min-h-0">
        <div className="relative w-full h-full bg-slate-900 rounded-3xl border border-slate-800 shadow-2xl overflow-hidden">

          {/* Legend — top left */}
          <div className="absolute top-4 left-4 z-10 flex items-center gap-5 bg-slate-950/85 backdrop-blur-md px-5 py-3 rounded-2xl border border-slate-800 text-xs font-bold tracking-wide text-slate-300 pointer-events-none">
            <span className="flex items-center gap-2"><span className="w-3.5 h-3.5 rounded-sm bg-white border border-slate-300 inline-block" /> Lối đi</span>
            <span className="flex items-center gap-2"><span className="w-3.5 h-3.5 rounded-sm bg-slate-500 border border-slate-600 inline-block" /> Chưa biết</span>
            <span className="flex items-center gap-2"><span className="w-3.5 h-3.5 rounded-sm bg-black border border-slate-600 inline-block" /> Vách tường</span>
            <span className="flex items-center gap-2 border-l border-slate-700 pl-4"><span className="w-3.5 h-3.5 rounded-full bg-green-500 border-2 border-white inline-block" /> Robot</span>
            <span className="flex items-center gap-2 border-l border-slate-700 pl-4"><span className="w-3.5 h-3.5 rounded-full bg-blue-500/60 border border-blue-400 inline-block" /> LIDAR scan</span>
            {mapData && (
              <span className="border-l border-slate-700 pl-4 font-mono text-slate-400 text-xs">
                {mapData.width}×{mapData.height} @ {mapData.resolution}m
              </span>
            )}
            {!mapData && occGridRef.current && (
              <span className="border-l border-slate-700 pl-4 font-mono text-slate-400 text-xs">
                {occGridRef.current.width}×{occGridRef.current.height} @ {occGridRef.current.resolution}m (từ LIDAR)
              </span>
            )}
          </div>

          {/* Heading-up / robot-lock — top right */}
          <div className="absolute top-4 right-4 z-10 flex items-center gap-2 bg-slate-950/85 backdrop-blur-md p-1.5 rounded-2xl border border-slate-800">
            <Tooltip title="Xoay bản đồ để robot luôn hướng lên">
              <button
                onClick={() => setIsHeadingUp(v => !v)}
                className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${isHeadingUp ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'}`}
              >
                <Compass size={16} />
                Heading-Up
              </button>
            </Tooltip>
            <Tooltip title="Giữ robot ở trung tâm màn hình">
              <button
                onClick={() => setIsRobotLock(v => !v)}
                className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${isRobotLock ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'}`}
              >
                <Target size={16} />
                Khóa Trung Tâm
              </button>
            </Tooltip>
          </div>

          {/* Debug: lidar axis — top center */}
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 bg-slate-950/85 backdrop-blur-md p-1.5 rounded-2xl border border-slate-800 text-xs font-bold">
            <span className="text-slate-400 px-2">Lidar AX:</span>
            {[
              { val: 0, label: '+X' },
              { val: 1, label: '+Y' },
              { val: 2, label: '-X' },
              { val: 3, label: '-Y' },
            ].map(({ val, label }) => (
              <button
                key={val}
                onClick={() => setLidarAxis(val)}
                className={`px-3 py-1.5 rounded-lg transition-all cursor-pointer font-mono ${lidarAxis === val ? 'bg-amber-500 text-black' : 'bg-slate-800 text-slate-400 hover:text-white'}`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Zoom presets — bottom left */}
          <div className="absolute bottom-4 left-4 z-10 flex items-center gap-2 bg-slate-950/85 backdrop-blur-md p-2 rounded-2xl border border-slate-800">
            <div className="flex items-center gap-1.5 px-2 text-slate-400 text-xs font-bold">
              <Ruler size={16} className="text-blue-400" />
              <span>Zoom:</span>
            </div>
            <div className="flex gap-1 bg-slate-900 p-1 rounded-xl border border-slate-800">
              {[0.5, 1, 2, 4].map(z => (
                <button
                  key={z}
                  onClick={() => setZoom(z)}
                  className={`px-3.5 py-1.5 rounded-lg font-mono text-xs font-bold cursor-pointer transition-all ${zoom === z ? 'bg-blue-600 text-white shadow' : 'text-slate-400 hover:text-white hover:bg-slate-800'}`}
                >
                  {z}×
                </button>
              ))}
            </div>
          </div>

          {/* Zoom controls — bottom right */}
          <div className="absolute bottom-4 right-4 z-10 flex items-center gap-2 bg-slate-950/85 backdrop-blur-md p-2 rounded-2xl border border-slate-800">
            <Tooltip title="Thu nhỏ">
              <button onClick={handleZoomOut} className="w-10 h-10 rounded-xl bg-slate-900 hover:bg-slate-800 text-slate-300 hover:text-blue-400 flex items-center justify-center transition-all border border-slate-800 cursor-pointer">
                <ZoomOut size={18} />
              </button>
            </Tooltip>
            <span className="font-mono text-sm px-2 font-bold text-amber-400 min-w-[56px] text-center">
              {Math.round(zoom * 100)}%
            </span>
            <Tooltip title="Phóng to">
              <button onClick={handleZoomIn} className="w-10 h-10 rounded-xl bg-slate-900 hover:bg-slate-800 text-slate-300 hover:text-blue-400 flex items-center justify-center transition-all border border-slate-800 cursor-pointer">
                <ZoomIn size={18} />
              </button>
            </Tooltip>
            <div className="w-px h-6 bg-slate-800 mx-1" />
            <Tooltip title="Đặt lại tầm nhìn">
              <button onClick={resetView} className="w-10 h-10 rounded-xl bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-emerald-400 flex items-center justify-center transition-all border border-slate-800 cursor-pointer">
                <Maximize2 size={18} />
              </button>
            </Tooltip>
          </div>

          {/* Disconnected overlay */}
          {!isOnline && (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-slate-900/80 backdrop-blur-sm rounded-3xl gap-4">
              <WifiOff size={48} className="text-slate-500" />
              <div className="text-center">
                <p className="text-slate-300 font-bold text-lg">Mất kết nối với robot</p>
                <p className="text-slate-500 text-sm mt-1">Đang thử kết nối lại...</p>
              </div>
              <Button onClick={() => connectWsRef.current()} className="rounded-xl font-bold">Thử kết nối lại</Button>
            </div>
          )}

          {/* Canvas */}
          <canvas
            ref={canvasRef}
            className="w-full h-full block"
            style={{ imageRendering: 'pixelated' }}
          />
        </div>
      </div>
    </div>
  );
}
