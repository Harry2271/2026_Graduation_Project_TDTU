'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { MapPin, RotateCcw, ZoomIn, ZoomOut, Maximize2, Ruler, Compass, Target, WifiOff, Crosshair } from 'lucide-react';
import { Button, App, Tooltip, Modal } from 'antd';

const WS_URL = 'wss://map.nguyen-robot.io.vn';

interface ScanData { points: { x: number; y: number }[]; count: number; }

interface MapData { width: number; height: number; resolution: number; origin_x: number; origin_y: number; origin_theta: number; data: number[]; }

interface PoseData { x: number; y: number; theta: number; }
interface InfoData { lidar: boolean; map: boolean; pose: boolean; mode: string; coverage_pct?: number; }

function robotToWorld(rx: number, ry: number, pose: PoseData, lidarAxis: number): { wx: number; wy: number } {
  const c = Math.cos(pose.theta);
  const s = Math.sin(pose.theta);
  let fx: number, fy: number;
  switch (lidarAxis) {
    case 0: fx =  rx; fy =  ry; break;
    case 1: fx =  ry; fy = -rx; break;
    case 2: fx = -rx; fy = -ry; break;
    case 3: fx = -ry; fy =  rx; break;
    default: fx =  rx; fy =  ry; break;
  }
  return { wx: c * fx - s * fy + pose.x, wy: s * fx + c * fy + pose.y };
}

export default function MapPage() {
  const { notification } = App.useApp();
  const [wsStatus, setWsStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [mapData, setMapData] = useState<MapData | null>(null);
  const [pose, setPose] = useState<PoseData | null>(null);
  const [scanData, setScanData] = useState<ScanData | null>(null);
  const [statusText, setStatusText] = useState('');
  const [info, setInfo] = useState<InfoData>({ lidar: false, map: false, pose: false, mode: 'live' });
  const [isHeadingUp, setIsHeadingUp] = useState(true);
  const [isRobotLock, setIsRobotLock] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [lidarAxis, setLidarAxis] = useState(0);

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
  const lidarAxisRef = useRef<number>(0);
  const occGridRef = useRef<MapData | null>(null);
  const occScaleRef = useRef<number>(0.05);
  const occSizeRef = useRef<number>(500);
  const scanBoundsRef = useRef<{ minX: number; maxX: number; minY: number; maxY: number } | null>(null);
  const offscreenRef = useRef<HTMLCanvasElement | null>(null);
  const prevMapDataRef = useRef<number[] | null>(null);
  // Version counter used to force re-render when occupancy grid offscreen canvas is rebuilt.
  // The value itself is intentionally unused — only the state setter triggers React updates.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [occGridVersion, setOccGridVersion] = useState(0);
  const occOffscreenRef = useRef<HTMLCanvasElement | null>(null);
  const prevOccGridRef = useRef<number[] | null>(null);

  useEffect(() => { mapDataRef.current = mapData; }, [mapData]);
  useEffect(() => { poseRef.current = pose; }, [pose]);
  useEffect(() => { scanDataRef.current = scanData; }, [scanData]);
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  useEffect(() => { headingUpRef.current = isHeadingUp; }, [isHeadingUp]);
  useEffect(() => { lidarAxisRef.current = lidarAxis; }, [lidarAxis]);

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

  // Build occupancy grid image (reads from occGridRef, draws to occOffscreenRef)
  // drawOverlay reads occOffscreenRef.current directly on each animation frame.
  useEffect(() => {
    const grid = occGridRef.current;
    if (!grid) return;
    const { width: gw, height: gh } = grid;
    let off = occOffscreenRef.current;
    if (!off || off.width !== gw || off.height !== gh) {
      off = document.createElement('canvas');
      off.width = gw; off.height = gh;
      occOffscreenRef.current = off;
      prevOccGridRef.current = null;
    }
    const ctx = off.getContext('2d');
    if (!ctx) return;
    let imgData: ImageData;
    try { imgData = ctx.getImageData(0, 0, gw, gh); } catch { return; }
    const buf = imgData.data;
    const prev = prevOccGridRef.current;
    if (prev && prev.length === grid.data.length) {
      for (let i = 0; i < grid.data.length; i++) {
        if (prev[i] !== grid.data[i]) {
          const j = i * 4;
          const v = grid.data[i];
          if (v === 100) { buf[j]=0; buf[j+1]=0; buf[j+2]=0; buf[j+3]=255; }
          else if (v === 0) { buf[j]=255; buf[j+1]=255; buf[j+2]=255; buf[j+3]=255; }
          else { buf[j]=128; buf[j+1]=128; buf[j+2]=128; buf[j+3]=255; }
        }
      }
    } else {
      for (let i = 0; i < grid.data.length; i++) {
        const v = grid.data[i];
        const j = i * 4;
        if (v === 100) { buf[j]=0; buf[j+1]=0; buf[j+2]=0; buf[j+3]=255; }
        else if (v === 0) { buf[j]=255; buf[j+1]=255; buf[j+2]=255; buf[j+3]=255; }
        else { buf[j]=128; buf[j+1]=128; buf[j+2]=128; buf[j+3]=255; }
      }
    }
    prevOccGridRef.current = [...grid.data];
    ctx.putImageData(imgData, 0, 0);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOccGridVersion(v => v + 1);
  }, [occGridRef.current?.data.length]);

  const buildMapImage = useCallback(() => {
    const map = mapDataRef.current;
    if (!map) return;
    const { width: gw, height: gh } = map;
    let off = offscreenRef.current;
    if (!off || off.width !== gw || off.height !== gh) {
      off = document.createElement('canvas');
      off.width = gw; off.height = gh;
      offscreenRef.current = off;
      prevMapDataRef.current = null;
    }
    const ctx = off.getContext('2d');
    if (!ctx) return;
    let imgData: ImageData;
    try { imgData = ctx.getImageData(0, 0, gw, gh); } catch { return; }
    const buf = imgData.data;
    const prev = prevMapDataRef.current;
    if (prev && prev.length === map.data.length) {
      for (let i = 0; i < map.data.length; i++) {
        if (prev[i] !== map.data[i]) {
          const j = i * 4;
          const v = map.data[i];
          if (v === 100) { buf[j]=0; buf[j+1]=0; buf[j+2]=0; buf[j+3]=255; }
          else if (v === 0) { buf[j]=255; buf[j+1]=255; buf[j+2]=255; buf[j+3]=255; }
          else { buf[j]=128; buf[j+1]=128; buf[j+2]=128; buf[j+3]=255; }
        }
      }
    } else {
      for (let i = 0; i < map.data.length; i++) {
        const v = map.data[i];
        const j = i * 4;
        if (v === 100) { buf[j]=0; buf[j+1]=0; buf[j+2]=0; buf[j+3]=255; }
        else if (v === 0) { buf[j]=255; buf[j+1]=255; buf[j+2]=255; buf[j+3]=255; }
        else { buf[j]=128; buf[j+1]=128; buf[j+2]=128; buf[j+3]=255; }
      }
    }
    prevMapDataRef.current = [...map.data];
    ctx.putImageData(imgData, 0, 0);
  }, []);

  useEffect(() => { if (mapData) buildMapImage(); }, [mapData, buildMapImage]);

  function buildOccupancyGrid(scan: ScanData) {
    const p = poseRef.current;
    if (!p || !scan.points.length) return;
    const res = occScaleRef.current;
    const size = occSizeRef.current;
    const half = (size * res) / 2;
    let grid = occGridRef.current;
    if (!grid || grid.width !== size || grid.height !== size) {
      grid = { width: size, height: size, resolution: res, origin_x: -half, origin_y: -half, origin_theta: 0, data: new Array(size * size).fill(-1) };
      occGridRef.current = grid;
    }
    const visitedFree = new Set<number>();
    for (let i = 0; i < scan.points.length; i++) {
      const wp = robotToWorld(scan.points[i].x, scan.points[i].y, p, lidarAxisRef.current);
      const wx = wp.wx; const wy = wp.wy;
      const rx = Math.round((p.x + half) / res);
      const ry = Math.round(size - (p.y + half) / res);
      const ex = Math.round((wx + half) / res);
      const ey = Math.round(size - (wy + half) / res);
      const dx = Math.abs(ex - rx); const dy = Math.abs(ey - ry);
      const sx = rx < ex ? 1 : -1; const sy = ry < ey ? 1 : -1;
      let err = dx - dy; let cx = rx; let cy = ry;
      while (true) {
        if (cx < 0 || cx >= size || cy < 0 || cy >= size) break;
        const idx = cy * size + cx;
        if (cx === ex && cy === ey) break;
        if (!visitedFree.has(idx)) { visitedFree.add(idx); if (grid!.data[idx] === -1) grid!.data[idx] = 0; }
        const e2 = 2 * err;
        if (e2 > -dy) { err -= dy; cx += sx; }
        if (e2 < dx) { err += dx; cy += sy; }
      }
      if (ex >= 0 && ex < size && ey >= 0 && ey < size) { const idx = ey * size + ex; if (grid!.data[idx] !== 0) grid!.data[idx] = 100; }
      const b = scanBoundsRef.current;
      if (!b) { scanBoundsRef.current = { minX: wx, maxX: wx, minY: wy, maxY: wy }; }
      else { scanBoundsRef.current = { minX: Math.min(b.minX, wx), maxX: Math.max(b.maxX, wx), minY: Math.min(b.minY, wy), maxY: Math.max(b.maxY, wy) }; }
    }
  }

  function drawOverlay() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = canvas.width; const H = canvas.height;
    const zoom = zoomRef.current; const isHU = headingUpRef.current;
    const p = poseRef.current;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#080b10';
    ctx.fillRect(0, 0, W, H);

    const map = mapDataRef.current || occGridRef.current;
    if (map) {
      const isGenerated = !mapDataRef.current;
      const off = isGenerated ? occOffscreenRef.current : offscreenRef.current;
      if (!off) return;
      const { width: gw, height: gh, resolution: res, origin_x, origin_y } = map;
      const scaleX = (W / gw) * zoom; const scaleY = (H / gh) * zoom;
      const scale = Math.min(scaleX, scaleY);
      const mapX = (W - gw * scale) / 2; const mapY = (H - gh * scale) / 2;
      ctx.save();
      if (p && isHU) {
        const cx = mapX + (p.x - origin_x) / res * scale;
        const cy = mapY + (gh - (p.y - origin_y) / res) * scale;
        ctx.translate(cx, cy); ctx.rotate(-p.theta - Math.PI / 2); ctx.translate(-cx, -cy);
      }
      ctx.drawImage(off, mapX, mapY, gw * scale, gh * scale);
      ctx.restore();
      const worldToScreen = (wx: number, wy: number) => {
        const gx = (wx - origin_x) / res; const gy = (wy - origin_y) / res;
        let sx = mapX + gx * scale; let sy = mapY + gy * scale;
        if (p && isHU) {
          const cx = mapX + (p.x - origin_x) / res * scale; const cy = mapY + (p.y - origin_y) / res * scale;
          const cos = Math.cos(-p.theta - Math.PI / 2); const sin = Math.sin(-p.theta - Math.PI / 2);
          const dx = sx - cx; const dy = sy - cy;
          sx = cx + cos * dx - sin * dy; sy = cy + sin * dx + cos * dy;
        }
        return { sx, sy };
      };
      const scan = scanDataRef.current;
      if (p && scan && scan.points.length > 0) {
        ctx.beginPath();
        for (let i = 0; i < scan.points.length; i++) {
          const wp = robotToWorld(scan.points[i].x, scan.points[i].y, p, lidarAxisRef.current);
          const sp = worldToScreen(wp.wx, wp.wy);
          if (i === 0) ctx.moveTo(sp.sx, sp.sy); else ctx.lineTo(sp.sx, sp.sy);
        }
        ctx.strokeStyle = 'rgba(0,212,255,0.12)'; ctx.lineWidth = 1; ctx.stroke();
        ctx.fillStyle = 'rgba(0,212,255,0.6)';
        for (let i = 0; i < scan.points.length; i += 2) {
          const wp = robotToWorld(scan.points[i].x, scan.points[i].y, p, lidarAxisRef.current);
          const sp = worldToScreen(wp.wx, wp.wy);
          ctx.beginPath(); ctx.arc(sp.sx, sp.sy, 1, 0, Math.PI * 2); ctx.fill();
        }
      }
      if (p) { const rp = worldToScreen(p.x, p.y); drawRobot(ctx, rp.sx, rp.sy, zoom); }
      return;
    }

    const scan = scanDataRef.current;
    const hasScan = p && scan && scan.points.length > 0;
    const bounds = scanBoundsRef.current;
    const padding = 0.3;
    let scale: number;
    if (bounds) {
      const worldW = bounds.maxX - bounds.minX + padding * 2;
      const worldH = bounds.maxY - bounds.minY + padding * 2;
      scale = Math.min((W - 40) / worldW, (H - 40) / worldH) * zoom;
    } else {
      const defaultRange = 6.0;
      scale = Math.min(W, H) / defaultRange * zoom;
    }
    const cx = W / 2; const cy = H / 2;
    const worldToCanvas = (wx: number, wy: number) => {
      let sx: number, sy: number;
      if (bounds) {
        const worldCX = (bounds.minX + bounds.maxX) / 2; const worldCY = (bounds.minY + bounds.maxY) / 2;
        sx = cx + (wx - worldCX) * scale; sy = cy + (wy - worldCY) * scale;
      } else { sx = cx + wx * scale; sy = cy + wy * scale; }
      if (isHU && p) {
        const cos = Math.cos(-p.theta - Math.PI / 2); const sin = Math.sin(-p.theta - Math.PI / 2);
        const dx = sx - cx; const dy = sy - cy;
        sx = cx + cos * dx - sin * dy; sy = cy + sin * dx + cos * dy;
      }
      return { sx, sy };
    };
    const robotPos = isHU && p ? worldToCanvas(p.x, p.y) : worldToCanvas(0, 0);
    drawRobot(ctx, robotPos.sx, robotPos.sy, zoom);
    if (hasScan) {
      ctx.beginPath();
      for (let i = 0; i < scan.points.length; i++) {
        const wp = robotToWorld(scan.points[i].x, scan.points[i].y, p!, lidarAxisRef.current);
        const sp = worldToCanvas(wp.wx, wp.wy);
        if (i === 0) ctx.moveTo(sp.sx, sp.sy); else ctx.lineTo(sp.sx, sp.sy);
      }
      ctx.strokeStyle = 'rgba(0,212,255,0.25)'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.fillStyle = 'rgba(0,212,255,0.7)';
      for (let i = 0; i < scan.points.length; i += 2) {
        const wp = robotToWorld(scan.points[i].x, scan.points[i].y, p!, lidarAxisRef.current);
        const sp = worldToCanvas(wp.wx, wp.wy);
        ctx.beginPath(); ctx.arc(sp.sx, sp.sy, 2, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  function drawRobot(ctx: CanvasRenderingContext2D, sx: number, sy: number, zoom: number) {
    const robotPx = Math.max(12, zoom * 0.8);
    ctx.save();
    ctx.translate(sx, sy);
    ctx.beginPath();
    ctx.arc(0, 0, robotPx, 0, Math.PI * 2);
    ctx.fillStyle = '#00ff88';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
    const aLen = robotPx * 2; const aW = robotPx * 0.7;
    ctx.beginPath();
    ctx.moveTo(aLen, 0); ctx.lineTo(aLen - aW, -aW * 0.5); ctx.lineTo(aLen - aW, aW * 0.5); ctx.closePath();
    ctx.fillStyle = '#ff3b5c';
    ctx.fill();
    ctx.restore();
  }

  // Animation loop reads from refs (not state) — exhaustive-deps would cause stale closures
  useEffect(() => {
    let lastTs = 0;
    const loop = (ts: number) => {
      if (ts - lastTs >= 33) { drawOverlay(); lastTs = ts; }
      animRef.current = requestAnimationFrame(loop);
    };
    animRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function connectWs() {
    if (typeof window === 'undefined') return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    setWsStatus('connecting');
    try {
      const ws = new WebSocket(WS_URL);
      ws.onopen = () => {
        setWsStatus('connected');
        reconnectDelayRef.current = 1000;
        pingRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ type: 'ping' })); }
        }, 5000);
      };
      ws.onmessage = (event) => {
        try {
          const msg: { type: string; data?: unknown } = JSON.parse(event.data as string);
          switch (msg.type) {
            case 'map': setMapData({ ...(msg.data as MapData) }); mapDataRef.current = msg.data as MapData; break;
            case 'pose': setPose({ ...(msg.data as PoseData) }); poseRef.current = { ...(msg.data as PoseData) }; break;
            case 'scan': setScanData({ ...(msg.data as ScanData) }); scanDataRef.current = msg.data as ScanData; buildOccupancyGrid(msg.data as ScanData); break;
            case 'status': setStatusText((msg.data as string) || ''); break;
            case 'info': setInfo(msg.data as InfoData); break;
            case 'mode': setInfo(prev => ({ ...prev, mode: msg.data as string })); break;
          }
        } catch { /* ignore */ }
      };
      ws.onclose = () => {
        setWsStatus('disconnected');
        if (pingRef.current) clearInterval(pingRef.current);
        if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = setTimeout(() => {
          reconnectDelayRef.current = Math.min(reconnectDelayRef.current * 2, 30000);
          connectWs();
        }, reconnectDelayRef.current);
      };
      ws.onerror = () => { setWsStatus('disconnected'); };
      wsRef.current = ws;
    } catch { setWsStatus('disconnected'); }
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

  const handleZoomIn = () => setZoom(v => Math.min(8, +(v + 0.5).toFixed(2)));
  const handleZoomOut = () => setZoom(v => Math.max(0.1, +(v - 0.5).toFixed(2)));
  const resetView = () => { setZoom(1); };

  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [isClearingLidar, setIsClearingLidar] = useState(false);

  const sendCmd = useCallback((command: string, label: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      notification.warning({ title: 'Mất kết nối', description: 'Không thể gửi lệnh. Đang thử kết nối lại...', placement: 'topRight' });
      connectWsRef.current(); return;
    }
    wsRef.current.send(JSON.stringify({ type: 'cmd', action: 'mapping', command }));
    notification.success({ title: 'Thành công', description: `Đã gửi lệnh ${label}`, placement: 'topRight' });
  }, []);

  const handleStartScan = () => {
    setIsStarting(true); sendCmd('start', 'bắt đầu quét bản đồ');
    if (occGridRef.current) { occGridRef.current.data = new Array(occGridRef.current.width * occGridRef.current.height).fill(-1); }
    occGridRef.current = null; occOffscreenRef.current = null; prevOccGridRef.current = null; scanBoundsRef.current = null;
    setOccGridVersion(v => v + 1);
    setTimeout(() => setIsStarting(false), 1500);
  };
  const handleStopScan = () => { setIsStopping(true); sendCmd('stop', 'dừng quét bản đồ'); setTimeout(() => setIsStopping(false), 1500); };
  const handleResetMap = () => {
    setIsResetting(true); sendCmd('reset', 'xóa bản đồ');
    mapDataRef.current = null; setMapData(null);
    occGridRef.current = null; occOffscreenRef.current = null; scanBoundsRef.current = null;
    setTimeout(() => setIsResetting(false), 1500);
  };
  const handleClearLidarGrid = () => {
    setIsClearingLidar(true);
    occGridRef.current = null; occOffscreenRef.current = null; prevOccGridRef.current = null; scanBoundsRef.current = null;
    setOccGridVersion(v => v + 1);
    setTimeout(() => setIsClearingLidar(false), 1500);
  };
  const confirmReset = () => {
    Modal.confirm({
      title: 'Xác nhận xóa bản đồ',
      content: 'Thao tác này sẽ xóa toàn bộ dữ liệu bản đồ. Tiếp tục?',
      okText: 'Xác nhận Xóa', cancelText: 'Hủy', okButtonProps: { danger: true },
      onOk: handleResetMap,
    });
  };

  const isOnline = wsStatus === 'connected';

  return (
    <div
      className="flex flex-col h-screen select-none overflow-hidden"
      style={{ background: 'var(--bg-void)', fontFamily: "'JetBrains Mono', system-ui" }}
    >
      {/* ─── Header ──────────────────────────────────────── */}
      <div
        className="px-8 py-5 flex flex-wrap items-center justify-between gap-4 relative z-10"
        style={{
          background: 'linear-gradient(180deg, rgba(0,212,255,0.04) 0%, transparent 100%)',
          borderBottom: '1px solid var(--border-dim)',
          boxShadow: '0 4px 24px rgba(0,0,0,0.3)',
        }}
      >
        <div>
          <div className="flex items-center gap-3 mb-1">
            <MapPin size={22} style={{ color: 'var(--accent)' }} />
            <h1
              className="text-display text-xl"
              style={{ fontFamily: "'JetBrains Mono', monospace", color: 'var(--text-primary)', letterSpacing: '-0.02em' }}
            >
              BẢN ĐỒ SLAM
            </h1>
            <span
              className="text-[9px] font-bold px-2 py-1 rounded-md"
              style={{
                background: isOnline ? 'rgba(0,255,136,0.1)' : 'rgba(255,59,92,0.1)',
                border: `1px solid ${isOnline ? 'rgba(0,255,136,0.25)' : 'rgba(255,59,92,0.25)'}`,
                color: isOnline ? 'var(--success)' : 'var(--danger)',
                fontFamily: "'JetBrains Mono', monospace",
                letterSpacing: '0.1em',
              }}
            >
              {isOnline ? 'LIVE' : 'OFFLINE'}
            </span>
          </div>
          <p className="text-xs" style={{ color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.04em' }}>
            LIDAR Scan · Occupancy Grid · Robot Pose &mdash; Real-time
          </p>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {/* Connection status */}
          <div
            className="flex items-center gap-2 px-4 py-2.5 rounded-2xl text-xs font-bold border"
            style={
              isOnline
                ? { background: 'rgba(0,255,136,0.08)', borderColor: 'rgba(0,255,136,0.2)', color: 'var(--success)' }
                : { background: 'rgba(255,59,92,0.08)', borderColor: 'rgba(255,59,92,0.2)', color: 'var(--danger)' }
            }
          >
            <span
              className="w-2 h-2 rounded-full"
              style={{ background: isOnline ? 'var(--success)' : 'var(--danger)', boxShadow: isOnline ? '0 0 8px var(--success-glow)' : 'none' }}
            />
            {isOnline ? 'Robot Online' : 'Robot Offline'}
          </div>

          {/* Info cluster */}
          {isOnline && (
            <div
              className="flex items-center gap-3 px-4 py-2.5 rounded-2xl text-xs font-bold border"
              style={{ background: 'var(--bg-surface)', borderColor: 'var(--border-dim)', color: 'var(--text-secondary)' }}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${info.lidar ? 'animate-pulse' : ''}`} style={{ background: info.lidar ? 'var(--accent)' : 'var(--text-muted)' }} title="LIDAR" />
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: info.map ? 'var(--success)' : 'var(--text-muted)' }} title="Map" />
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: info.pose ? 'var(--warning)' : 'var(--text-muted)' }} title="Pose" />
              <span
                className="px-2 py-0.5 rounded font-mono font-bold text-[10px]"
                style={{
                  background: info.mode === 'mapping' ? 'rgba(255,184,0,0.15)' : 'rgba(0,255,136,0.1)',
                  color: info.mode === 'mapping' ? 'var(--warning)' : 'var(--success)',
                  fontFamily: "'JetBrains Mono', monospace",
                }}
              >
                {info.mode?.toUpperCase() || 'IDLE'}
              </span>
              {info.coverage_pct !== undefined && (
                <span className="font-mono text-[10px]" style={{ color: 'var(--accent)', fontFamily: "'JetBrains Mono', monospace" }}>
                  {info.coverage_pct}%
                </span>
              )}
              <span className="font-mono text-[10px]" style={{ color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}>
                {statusText || 'IDLE'}
              </span>
            </div>
          )}

          {/* Pose */}
          {pose && isOnline && (
            <div
              className="px-3.5 py-2.5 rounded-2xl text-xs font-mono font-bold border"
              style={{ background: 'var(--bg-surface)', borderColor: 'var(--border-dim)', color: 'var(--text-secondary)' }}
            >
              <span style={{ color: 'var(--accent)', fontFamily: "'JetBrains Mono', monospace", fontSize: '11px' }}>
                x:{pose.x.toFixed(2)} y:{pose.y.toFixed(2)} θ:{(pose.theta * 180 / Math.PI).toFixed(0)}°
              </span>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex items-center gap-2">
            <Tooltip title="Bắt đầu quét bản đồ">
              <Button
                type="primary"
                size="large"
                icon={<MapPin size={16} />}
                loading={isStarting}
                onClick={handleStartScan}
                disabled={info.mode === 'mapping'}
                style={{
                  background: 'linear-gradient(135deg, #00d4ff, #00b8e6)',
                  border: 'none',
                  color: '#080b10',
                  borderRadius: '12px',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  boxShadow: '0 4px 20px rgba(0,212,255,0.3)',
                }}
              >
                Bắt Đầu Quét
              </Button>
            </Tooltip>

            <Tooltip title="Dừng quét, chuyển sang định vị">
              <Button
                size="large"
                icon={<Target size={16} />}
                loading={isStopping}
                onClick={handleStopScan}
                disabled={info.mode !== 'mapping'}
                style={{
                  borderRadius: '12px',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontWeight: 600,
                  background: 'rgba(255,184,0,0.08)',
                  border: '1px solid rgba(255,184,0,0.25)',
                  color: 'var(--warning)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                Dừng Quét
              </Button>
            </Tooltip>

            <Tooltip title="Xóa bản đồ và quét lại">
              <Button
                type="primary"
                danger
                size="large"
                icon={<RotateCcw size={16} />}
                loading={isResetting}
                onClick={confirmReset}
                style={{
                  borderRadius: '12px',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                Xóa Bản Đồ
              </Button>
            </Tooltip>

            <Tooltip title="Xóa chỉ lưới LIDAR, giữ nguyên bản đồ nền">
              <Button
                size="large"
                icon={<Crosshair size={16} />}
                loading={isClearingLidar}
                onClick={handleClearLidarGrid}
                style={{
                  borderRadius: '12px',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontWeight: 600,
                  background: 'rgba(0,212,255,0.08)',
                  border: '1px solid rgba(0,212,255,0.2)',
                  color: 'var(--accent)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                Xóa Lưới LIDAR
              </Button>
            </Tooltip>
          </div>
        </div>
      </div>

      {/* ─── Canvas viewer ─────────────────────────────────── */}
      <div className="flex-1 min-h-0 p-6">
        <div
          className="relative w-full h-full rounded-3xl overflow-hidden"
          style={{
            background: 'var(--bg-base)',
            border: '1px solid var(--border-dim)',
            boxShadow: '0 8px 48px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.04)',
          }}
        >
          {/* Legend */}
          <div
            className="absolute top-4 left-4 z-10 flex items-center gap-5 px-5 py-3 rounded-2xl"
            style={{
              background: 'rgba(8,11,16,0.85)',
              backdropFilter: 'blur(16px)',
              border: '1px solid var(--border-mid)',
            }}
          >
            {[
              { color: '#fff', label: 'Lối đi' },
              { color: '#808080', label: 'Chưa biết' },
              { color: '#000', label: 'Vách' },
            ].map(({ label, color }) => (
              <span key={label} className="flex items-center gap-2 text-[11px] font-bold" style={{ color: 'var(--text-secondary)', fontFamily: "'JetBrains Mono', monospace" }}>
                <span className="w-4 h-4 rounded-sm border border-opacity-30" style={{ background: color, borderColor: color === '#fff' ? '#555' : '#444' }} />
                {label}
              </span>
            ))}
            <span className="border-l border-opacity-20 pl-4" style={{ borderColor: 'rgba(255,255,255,0.1)' }}>
              <span className="flex items-center gap-2 text-[11px] font-bold" style={{ color: 'var(--text-secondary)', fontFamily: "'JetBrains Mono', monospace" }}>
                <span className="w-4 h-4 rounded-full" style={{ background: '#00ff88', boxShadow: '0 0 6px rgba(0,255,136,0.5)' }} />
                Robot
              </span>
            </span>
            <span className="border-l border-opacity-20 pl-4" style={{ borderColor: 'rgba(255,255,255,0.1)' }}>
              <span className="flex items-center gap-2 text-[11px] font-bold" style={{ color: 'var(--text-secondary)', fontFamily: "'JetBrains Mono', monospace" }}>
                <span className="w-4 h-4 rounded-full" style={{ background: 'rgba(0,212,255,0.5)' }} />
                LIDAR scan
              </span>
            </span>
            {mapData && (
              <span className="border-l border-opacity-20 pl-4 font-mono text-[10px]" style={{ color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}>
                {mapData.width}×{mapData.height} @ {mapData.resolution}m
              </span>
            )}
          </div>

          {/* Heading-up / robot-lock controls */}
          <div
            className="absolute top-4 right-4 z-10 flex items-center gap-2 p-1.5 rounded-2xl"
            style={{ background: 'rgba(8,11,16,0.85)', backdropFilter: 'blur(16px)', border: '1px solid var(--border-mid)' }}
          >
            <Tooltip title="Robot luôn hướng lên">
              <button
                onClick={() => setIsHeadingUp(v => !v)}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer"
                style={
                  isHeadingUp
                    ? { background: 'rgba(0,212,255,0.15)', color: 'var(--accent)', border: '1px solid rgba(0,212,255,0.25)' }
                    : { background: 'var(--bg-raised)', color: 'var(--text-muted)', border: '1px solid var(--border-dim)' }
                }
              >
                <Compass size={16} />
                Heading-Up
              </button>
            </Tooltip>
            <Tooltip title="Giữ robot ở trung tâm">
              <button
                onClick={() => setIsRobotLock(v => !v)}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer"
                style={
                  isRobotLock
                    ? { background: 'rgba(0,255,136,0.12)', color: 'var(--success)', border: '1px solid rgba(0,255,136,0.25)' }
                    : { background: 'var(--bg-raised)', color: 'var(--text-muted)', border: '1px solid var(--border-dim)' }
                }
              >
                <Target size={16} />
                Khóa Trung Tâm
              </button>
            </Tooltip>
          </div>

          {/* Lidar axis */}
          <div
            className="absolute top-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 p-1.5 rounded-2xl"
            style={{ background: 'rgba(8,11,16,0.85)', backdropFilter: 'blur(16px)', border: '1px solid var(--border-mid)' }}
          >
            <span className="text-[10px] px-2" style={{ color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}>Lidar AX:</span>
            {[{ val: 0, label: '+X' }, { val: 1, label: '+Y' }, { val: 2, label: '-X' }, { val: 3, label: '-Y' }].map(({ val, label }) => (
              <button
                key={val}
                onClick={() => setLidarAxis(val)}
                className="px-3 py-1.5 rounded-lg transition-all cursor-pointer font-mono text-xs font-bold"
                style={
                  lidarAxis === val
                    ? { background: 'rgba(255,184,0,0.2)', color: 'var(--warning)', border: '1px solid rgba(255,184,0,0.3)' }
                    : { background: 'var(--bg-raised)', color: 'var(--text-muted)', border: '1px solid var(--border-dim)' }
                }
              >
                {label}
              </button>
            ))}
          </div>

          {/* Zoom presets */}
          <div
            className="absolute bottom-4 left-4 z-10 flex items-center gap-2 p-2 rounded-2xl"
            style={{ background: 'rgba(8,11,16,0.85)', backdropFilter: 'blur(16px)', border: '1px solid var(--border-mid)' }}
          >
            <div className="flex items-center gap-1.5 px-2" style={{ color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace", fontSize: '11px' }}>
              <Ruler size={14} style={{ color: 'var(--accent)' }} />
              <span>Zoom:</span>
            </div>
            <div className="flex gap-1 p-1 rounded-xl" style={{ background: 'var(--bg-raised)', border: '1px solid var(--border-dim)' }}>
              {[0.5, 1, 2, 4].map(z => (
                <button
                  key={z}
                  onClick={() => setZoom(z)}
                  className="px-3.5 py-1.5 rounded-lg font-mono text-xs font-bold cursor-pointer transition-all"
                  style={
                    zoom === z
                      ? { background: 'var(--accent)', color: '#080b10' }
                      : { background: 'transparent', color: 'var(--text-muted)' }
                  }
                >
                  {z}×
                </button>
              ))}
            </div>
          </div>

          {/* Zoom controls */}
          <div
            className="absolute bottom-4 right-4 z-10 flex items-center gap-2 p-2 rounded-2xl"
            style={{ background: 'rgba(8,11,16,0.85)', backdropFilter: 'blur(16px)', border: '1px solid var(--border-mid)' }}
          >
            <Tooltip title="Thu nhỏ">
              <button
                onClick={handleZoomOut}
                className="w-10 h-10 rounded-xl flex items-center justify-center transition-all cursor-pointer"
                style={{ background: 'var(--bg-raised)', border: '1px solid var(--border-mid)', color: 'var(--text-secondary)' }}
              >
                <ZoomOut size={18} />
              </button>
            </Tooltip>
            <span
              className="font-mono text-sm px-2 font-bold min-w-[56px] text-center"
              style={{ color: 'var(--warning)', fontFamily: "'JetBrains Mono', monospace", fontSize: '12px' }}
            >
              {Math.round(zoom * 100)}%
            </span>
            <Tooltip title="Phóng to">
              <button
                onClick={handleZoomIn}
                className="w-10 h-10 rounded-xl flex items-center justify-center transition-all cursor-pointer"
                style={{ background: 'var(--bg-raised)', border: '1px solid var(--border-mid)', color: 'var(--text-secondary)' }}
              >
                <ZoomIn size={18} />
              </button>
            </Tooltip>
            <div className="w-px h-6 mx-1" style={{ background: 'var(--border-dim)' }} />
            <Tooltip title="Đặt lại tầm nhìn">
              <button
                onClick={resetView}
                className="w-10 h-10 rounded-xl flex items-center justify-center transition-all cursor-pointer"
                style={{ background: 'var(--bg-raised)', border: '1px solid var(--border-mid)', color: 'var(--text-secondary)' }}
              >
                <Maximize2 size={18} />
              </button>
            </Tooltip>
          </div>

          {/* Disconnected overlay */}
          {!isOnline && (
            <div
              className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4"
              style={{ background: 'rgba(8,11,16,0.85)', backdropFilter: 'blur(8px)', borderRadius: '24px' }}
            >
              <WifiOff size={48} style={{ color: 'var(--text-muted)' }} />
              <div className="text-center">
                <p className="text-base font-bold" style={{ color: 'var(--text-primary)', fontFamily: "'JetBrains Mono', monospace" }}>
                  Mất kết nối với robot
                </p>
                <p className="text-sm mt-1" style={{ color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}>
                  Đang thử kết nối lại...
                </p>
              </div>
              <Button
                onClick={() => connectWsRef.current()}
                style={{
                  borderRadius: '10px',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontWeight: 600,
                  background: 'rgba(0,212,255,0.1)',
                  border: '1px solid rgba(0,212,255,0.25)',
                  color: 'var(--accent)',
                }}
              >
                Thử kết nối lại
              </Button>
            </div>
          )}

          <canvas ref={canvasRef} className="w-full h-full block" style={{ imageRendering: 'pixelated' }} />
        </div>
      </div>
    </div>
  );
}
