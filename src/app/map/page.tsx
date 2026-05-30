'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { MapPin, RotateCcw, ZoomIn, ZoomOut, Maximize2, Ruler, Compass, Target, WifiOff, Crosshair, Activity } from 'lucide-react';
import { Button, App, Tooltip } from 'antd';

const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL || 'wss://map.nguyen-robot.io.vn';

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

// ── MiniMap canvas ref (separate from main canvas) ──────────────────────────
const MINI_SIZE = 160;
const MINI_RANGE = 3.0; // metres visible in minimap

function drawMinimap(ctx: CanvasRenderingContext2D, scan: ScanData | null, pose: PoseData | null, occGrid: MapData | null) {
  const W = MINI_SIZE, H = MINI_SIZE;
  ctx.clearRect(0, 0, W, H);

  // Dark radar background
  ctx.fillStyle = 'rgba(8,11,16,0.95)';
  ctx.fillRect(0, 0, W, H);

  // Radar rings
  const cx = W / 2, cy = H / 2;
  const scale = (MINI_SIZE / 2 - 10) / MINI_RANGE;
  for (let r = 1; r <= 3; r++) {
    ctx.beginPath();
    ctx.arc(cx, cy, r * scale * (MINI_RANGE / 3), 0, Math.PI * 2);
    ctx.strokeStyle = r === 3 ? 'rgba(0,212,255,0.3)' : 'rgba(0,212,255,0.12)';
    ctx.lineWidth = r === 3 ? 1.5 : 0.8;
    ctx.stroke();
  }

  // Crosshairs
  ctx.strokeStyle = 'rgba(0,212,255,0.15)';
  ctx.lineWidth = 0.5;
  ctx.beginPath(); ctx.moveTo(cx, 4); ctx.lineTo(cx, H - 4); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(4, cy); ctx.lineTo(W - 4, cy); ctx.stroke();

  // Scan points in robot-local frame
  if (scan?.points.length && pose) {
    const points = scan.points.length > 300 ? scan.points.filter((_, i) => i % 3 === 0) : scan.points;
    ctx.fillStyle = 'rgba(0,212,255,0.7)';
    for (const pt of points) {
      const wp = robotToWorld(pt.x, pt.y, pose, 1);
      const sx = cx + wp.wx * scale;
      const sy = cy - wp.wy * scale;
      if (sx < 0 || sx > W || sy < 0 || sy > H) continue;
      ctx.beginPath();
      ctx.arc(sx, sy, 1.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Robot dot at center
  if (pose) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.beginPath();
    ctx.arc(0, 0, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#00ff88';
    ctx.shadowColor = '#00ff88';
    ctx.shadowBlur = 8;
    ctx.fill();
    // Direction arrow
    ctx.beginPath();
    ctx.moveTo(8, 0);
    ctx.lineTo(4, -3);
    ctx.lineTo(4, 3);
    ctx.closePath();
    ctx.fillStyle = '#ff3b5c';
    ctx.shadowColor = '#ff3b5c';
    ctx.shadowBlur = 6;
    ctx.fill();
    ctx.restore();
  } else {
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,255,136,0.5)';
    ctx.fill();
  }

  // Border glow
  ctx.strokeStyle = 'rgba(0,212,255,0.4)';
  ctx.lineWidth = 1;
  ctx.shadowColor = 'rgba(0,212,255,0.3)';
  ctx.shadowBlur = 6;
  ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
  ctx.shadowBlur = 0;
}

export default function MapPage() {
  const { notification, modal } = App.useApp();
  const [wsStatus, setWsStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [mapData, setMapData] = useState<MapData | null>(null);
  const [pose, setPose] = useState<PoseData | null>(null);
  const [scanData, setScanData] = useState<ScanData | null>(null);
  const [statusText, setStatusText] = useState('');
  const [info, setInfo] = useState<InfoData>({ lidar: false, map: false, pose: false, mode: 'live' });
  const [isHeadingUp, setIsHeadingUp] = useState(true);
  const [isRobotLock, setIsRobotLock] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [lidarAxis, setLidarAxis] = useState(1);

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
  const occGridRef = useRef<MapData | null>(null);
  const occScaleRef = useRef<number>(0.05);
  const occSizeRef = useRef<number>(500);
  const scanBoundsRef = useRef<{ minX: number; maxX: number; minY: number; maxY: number } | null>(null);
  const offscreenRef = useRef<HTMLCanvasElement | null>(null);
  const prevMapDataRef = useRef<number[] | null>(null);
  const occOffscreenRef = useRef<HTMLCanvasElement | null>(null);
  const miniCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [scanCount, setScanCount] = useState(0);

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

  function drawGridToCanvas(grid: MapData, canvas: HTMLCanvasElement) {
    const { width: gw, height: gh, data } = grid;
    if (canvas.width !== gw || canvas.height !== gh) {
      canvas.width = gw; canvas.height = gh;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const imgData = ctx.createImageData(gw, gh);
    const buf = imgData.data;
    for (let i = 0; i < data.length; i++) {
      const j = i * 4;
      const v = data[i];
      if (v === 100) { buf[j]=0; buf[j+1]=0; buf[j+2]=0; buf[j+3]=255; }
      else if (v === 0) { buf[j]=255; buf[j+1]=255; buf[j+2]=255; buf[j+3]=255; }
      else { buf[j]=128; buf[j+1]=128; buf[j+2]=128; buf[j+3]=255; }
    }
    ctx.putImageData(imgData, 0, 0);
  }

  function buildMapImage() {
    const map = mapDataRef.current;
    if (!map) return;
    if (!offscreenRef.current) offscreenRef.current = document.createElement('canvas');
    drawGridToCanvas(map, offscreenRef.current);
    prevMapDataRef.current = [...map.data];
  }

  function buildOccupancyGrid(scan: ScanData) {
    const p = poseRef.current;
    if (!p) return;
    if (!scan.points.length) return;

    const res = occScaleRef.current;
    const size = occSizeRef.current;
    const half = (size * res) / 2;

    if (!occGridRef.current || occGridRef.current.width !== size || occGridRef.current.height !== size) {
      occGridRef.current = {
        width: size, height: size, resolution: res,
        origin_x: -half, origin_y: -half, origin_theta: 0,
        data: new Array(size * size).fill(-1),
      };
    }
    const grid = occGridRef.current;

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
        if (!visitedFree.has(idx)) {
          visitedFree.add(idx);
          if (grid.data[idx] === -1) grid.data[idx] = 0;
        }
        const e2 = 2 * err;
        if (e2 > -dy) { err -= dy; cx += sx; }
        if (e2 < dx) { err += dx; cy += sy; }
      }
      if (ex >= 0 && ex < size && ey >= 0 && ey < size) {
        const idx = ey * size + ex;
        if (grid.data[idx] !== 0) grid.data[idx] = 100;
      }

      const b = scanBoundsRef.current;
      if (!b) scanBoundsRef.current = { minX: wx, maxX: wx, minY: wy, maxY: wy };
      else {
        scanBoundsRef.current = {
          minX: Math.min(b.minX, wx), maxX: Math.max(b.maxX, wx),
          minY: Math.min(b.minY, wy), maxY: Math.max(b.maxY, wy),
        };
      }
    }

    if (!occOffscreenRef.current) occOffscreenRef.current = document.createElement('canvas');
    drawGridToCanvas(grid, occOffscreenRef.current);
  }

  useEffect(() => {
    let mounted = true;
    const id = setTimeout(() => { if (mounted) connectWs(); }, 0);
    return () => { mounted = false; clearTimeout(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { if (mapData) buildMapImage(); }, [mapData]);

  function drawOverlay() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = canvas.width; const H = canvas.height;
    if (W === 0 || H === 0) return;

    const zoom = zoomRef.current;
    const isHU = headingUpRef.current;
    const p = poseRef.current;
    ctx.imageSmoothingEnabled = false;

    // ── Deep space background ──────────────────────────────────────
    const bgGrad = ctx.createRadialGradient(W/2, H/2, 0, W/2, H/2, Math.max(W, H) * 0.7);
    bgGrad.addColorStop(0, '#0c1220');
    bgGrad.addColorStop(1, '#060910');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, W, H);

    // ── Subtle dot-grid background ──────────────────────────────────
    ctx.fillStyle = 'rgba(0,212,255,0.04)';
    const gridStep = 48;
    for (let x = 0; x < W; x += gridStep) {
      for (let y = 0; y < H; y += gridStep) {
        ctx.fillRect(x, y, 1, 1);
      }
    }

    // ── Crosshair center lines ─────────────────────────────────────
    ctx.strokeStyle = 'rgba(0,212,255,0.06)';
    ctx.lineWidth = 0.5;
    ctx.setLineDash([6, 8]);
    ctx.beginPath(); ctx.moveTo(W/2, 0); ctx.lineTo(W/2, H); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, H/2); ctx.lineTo(W, H/2); ctx.stroke();
    ctx.setLineDash([]);

    // ── Outer border frame ──────────────────────────────────────────
    const pad = 1;
    ctx.strokeStyle = 'rgba(0,212,255,0.12)';
    ctx.lineWidth = 1;
    ctx.strokeRect(pad, pad, W - pad*2, H - pad*2);
    // Corner accents
    const cLen = 24;
    const corners = [[pad, pad, 1, 1], [W-pad, pad, -1, 1], [pad, H-pad, 1, -1], [W-pad, H-pad, -1, -1]] as [number, number, number, number][];
    for (const [cx2, cy2, dx, dy] of corners) {
      ctx.strokeStyle = 'rgba(0,212,255,0.5)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx2, cy2 + dy * cLen);
      ctx.lineTo(cx2, cy2);
      ctx.lineTo(cx2 + dx * cLen, cy2);
      ctx.stroke();
    }

    // ── Path A: server map ──────────────────────────────────────────
    if (mapDataRef.current) {
      const off = offscreenRef.current;
      if (!off) { buildMapImage(); return; }
      const { width: gw, height: gh, resolution: res, origin_x, origin_y } = mapDataRef.current;
      const minScale = Math.min(W, H) * 0.75 / Math.max(gw, gh);
      const rawFit = Math.min(W / gw, H / gh) * zoom;
      const scale = Math.max(rawFit, minScale);
      const mapX = W / 2 + origin_x / res * scale;
      const mapY = H / 2 - origin_y / res * scale;

      ctx.save();
      if (p && isHU) {
        const cx2 = mapX + (p.x - origin_x) / res * scale;
        const cy2 = mapY + (gh - (p.y - origin_y) / res) * scale;
        ctx.translate(cx2, cy2); ctx.rotate(-p.theta - Math.PI / 2); ctx.translate(-cx2, -cy2);
      }
      ctx.drawImage(off, mapX, mapY, gw * scale, gh * scale);
      ctx.restore();

      const worldToScreen = (wx: number, wy: number) => {
        let sx = mapX + (wx - origin_x) / res * scale;
        let sy = mapY + (wy - origin_y) / res * scale;
        if (p && isHU) {
          const cx2 = mapX + (p.x - origin_x) / res * scale;
          const cy2 = mapY + (p.y - origin_y) / res * scale;
          const cos = Math.cos(-p.theta - Math.PI / 2); const sin = Math.sin(-p.theta - Math.PI / 2);
          const dx = sx - cx2; const dy2 = sy - cy2;
          sx = cx2 + cos * dx - sin * dy2; sy = cy2 + sin * dx + cos * dy2;
        }
        return { sx, sy };
      };

      const scan = scanDataRef.current;
      if (p && scan?.points.length) {
        ctx.beginPath();
        for (let i = 0; i < scan.points.length; i++) {
          const wp = robotToWorld(scan.points[i].x, scan.points[i].y, p, lidarAxisRef.current);
          const sp = worldToScreen(wp.wx, wp.wy);
          if (i === 0) ctx.moveTo(sp.sx, sp.sy); else ctx.lineTo(sp.sx, sp.sy);
        }
        ctx.strokeStyle = 'rgba(0,212,255,0.15)'; ctx.lineWidth = 1; ctx.stroke();
        ctx.fillStyle = 'rgba(0,212,255,0.7)';
        for (let i = 0; i < scan.points.length; i += 2) {
          const wp = robotToWorld(scan.points[i].x, scan.points[i].y, p, lidarAxisRef.current);
          const sp = worldToScreen(wp.wx, wp.wy);
          ctx.beginPath(); ctx.arc(sp.sx, sp.sy, 1.5, 0, Math.PI * 2); ctx.fill();
        }
      }
      if (p) { const rp = worldToScreen(p.x, p.y); drawRobot(ctx, rp.sx, rp.sy, zoom); }
      return;
    }

    // ── Path B: occupancy grid ──────────────────────────────────────
    if (occGridRef.current && occOffscreenRef.current) {
      const off = occOffscreenRef.current;
      const { width: gw, height: gh, resolution: res, origin_x, origin_y } = occGridRef.current;
      const minScale = Math.min(W, H) * 0.75 / Math.max(gw, gh);
      const rawFit = Math.min(W / gw, H / gh) * zoom;
      const scale = Math.max(rawFit, minScale);
      const mapX = W / 2 + origin_x / res * scale;
      const mapY = H / 2 - origin_y / res * scale;

      ctx.save();
      if (p && isHU) {
        const cx2 = mapX + (p.x - origin_x) / res * scale;
        const cy2 = mapY + (gh - (p.y - origin_y) / res) * scale;
        ctx.translate(cx2, cy2); ctx.rotate(-p.theta - Math.PI / 2); ctx.translate(-cx2, -cy2);
      }
      ctx.drawImage(off, mapX, mapY, gw * scale, gh * scale);
      ctx.restore();

      const worldToScreen = (wx: number, wy: number) => {
        let sx = mapX + (wx - origin_x) / res * scale;
        let sy = mapY + (wy - origin_y) / res * scale;
        if (p && isHU) {
          const cx2 = mapX + (p.x - origin_x) / res * scale;
          const cy2 = mapY + (p.y - origin_y) / res * scale;
          const cos = Math.cos(-p.theta - Math.PI / 2); const sin = Math.sin(-p.theta - Math.PI / 2);
          const dx = sx - cx2; const dy2 = sy - cy2;
          sx = cx2 + cos * dx - sin * dy2; sy = cy2 + sin * dx + cos * dy2;
        }
        return { sx, sy };
      };

      if (p) { const rp = worldToScreen(p.x, p.y); drawRobot(ctx, rp.sx, rp.sy, zoom); }
      return;
    }

    // ── Path C: scan-only ────────────────────────────────────────────
    const scan = scanDataRef.current;
    const defaultRange = 6.0;
    const scale = Math.max(Math.min(W, H) / defaultRange * zoom, 60);

    const robotScreenX = W / 2;
    const robotScreenY = H / 2;

    if (isHU && p) {
      ctx.save();
      ctx.translate(robotScreenX, robotScreenY);
      ctx.rotate(-p.theta - Math.PI / 2);
      ctx.translate(-robotScreenX, -robotScreenY);
    }

    drawRobot(ctx, robotScreenX, robotScreenY, zoom);

    if (scan?.points.length) {
      ctx.beginPath();
      for (let i = 0; i < scan.points.length; i++) {
        const sx = robotScreenX + scan.points[i].x * scale;
        const sy = robotScreenY - scan.points[i].y * scale;
        if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
      }
      ctx.strokeStyle = 'rgba(0,212,255,0.3)'; ctx.lineWidth = 1.5; ctx.stroke();

      ctx.fillStyle = 'rgba(0,212,255,0.9)';
      for (let i = 0; i < scan.points.length; i += 2) {
        const sx = robotScreenX + scan.points[i].x * scale;
        const sy = robotScreenY - scan.points[i].y * scale;
        ctx.beginPath(); ctx.arc(sx, sy, 2.5, 0, Math.PI * 2); ctx.fill();
      }
    }

    if (isHU && p) ctx.restore();
  }

  function drawRobot(ctx: CanvasRenderingContext2D, sx: number, sy: number, zoom: number) {
    const robotPx = Math.max(14, zoom * 1.5);
    ctx.save();
    ctx.translate(sx, sy);

    // Glow ring
    ctx.beginPath(); ctx.arc(0, 0, robotPx + 6, 0, Math.PI * 2);
    const glowGrad = ctx.createRadialGradient(0, 0, robotPx, 0, 0, robotPx + 10);
    glowGrad.addColorStop(0, 'rgba(0,255,136,0.25)');
    glowGrad.addColorStop(1, 'rgba(0,255,136,0)');
    ctx.fillStyle = glowGrad;
    ctx.fill();

    // Body
    ctx.beginPath(); ctx.arc(0, 0, robotPx, 0, Math.PI * 2);
    const bodyGrad = ctx.createRadialGradient(-robotPx*0.3, -robotPx*0.3, 0, 0, 0, robotPx);
    bodyGrad.addColorStop(0, '#22ff99');
    bodyGrad.addColorStop(1, '#00cc66');
    ctx.fillStyle = bodyGrad;
    ctx.shadowColor = '#00ff88';
    ctx.shadowBlur = 16;
    ctx.fill();

    // Ring
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.shadowBlur = 0;
    ctx.stroke();

    // Direction arrow
    const aLen = robotPx * 2; const aW = robotPx * 0.7;
    ctx.beginPath();
    ctx.moveTo(aLen, 0); ctx.lineTo(aLen - aW, -aW * 0.5); ctx.lineTo(aLen - aW, aW * 0.5); ctx.closePath();
    ctx.fillStyle = '#ff3b5c';
    ctx.shadowColor = '#ff3b5c';
    ctx.shadowBlur = 10;
    ctx.fill();
    ctx.restore();
  }

  useEffect(() => {
    let lastTs = 0;
    let frameCount = 0;
    const loop = (ts: number) => {
      if (ts - lastTs >= 33) {
        drawOverlay();
        // Update minimap every ~2 frames
        frameCount++;
        if (frameCount % 2 === 0 && miniCanvasRef.current) {
          const mctx = miniCanvasRef.current.getContext('2d');
          if (mctx) drawMinimap(mctx, scanDataRef.current, poseRef.current, occGridRef.current);
        }
        lastTs = ts;
      }
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
        function dispatch(msg: { type: string; data?: unknown }) {
          switch (msg.type) {
            case 'map':
            case 'map_layer':
              setMapData({ ...(msg.data as MapData) });
              mapDataRef.current = msg.data as MapData;
              break;
            case 'pose': setPose({ ...(msg.data as PoseData) }); poseRef.current = { ...(msg.data as PoseData) }; break;
            case 'scan':
              setScanData({ ...(msg.data as ScanData) });
              scanDataRef.current = msg.data as ScanData;
              setScanCount(c => c + 1);
              buildOccupancyGrid(msg.data as ScanData);
              break;
            case 'status': setStatusText((msg.data as string) || ''); break;
            case 'info': setInfo(msg.data as InfoData); break;
            case 'mode': setInfo(prev => ({ ...prev, mode: msg.data as string })); break;
          }
        }
        function parse(data: ArrayBuffer | Blob | string) {
          const bytes = data instanceof Blob ? null : (data instanceof ArrayBuffer ? new Uint8Array(data) : null);
          const isGzip = bytes && bytes[0] === 0x1f && bytes[1] === 0x8b;
          let text: string;
          if (data instanceof Blob) {
            data.arrayBuffer().then(buf => parse(buf));
            return;
          } else if (isGzip && bytes) {
            const ds = new DecompressionStream('gzip');
            const writer = ds.writable.getWriter();
            writer.write(bytes);
            writer.close();
            new Response(ds.readable).text().then(t => { try { dispatch(JSON.parse(t)); } catch { /* ignore */ } });
            return;
          } else {
            text = typeof data === 'string' ? data : new TextDecoder().decode(data as ArrayBuffer);
          }
          try { dispatch(JSON.parse(text)); } catch { /* ignore */ }
        }
        parse(event.data);
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
    occGridRef.current = null; occOffscreenRef.current = null; scanBoundsRef.current = null;
    setScanCount(0);
    setTimeout(() => setIsStarting(false), 1500);
  };
  const handleStopScan = () => { setIsStopping(true); sendCmd('stop', 'dừng quét bản đồ'); setTimeout(() => setIsStopping(false), 1500); };
  const handleResetMap = () => {
    setIsResetting(true); sendCmd('reset', 'xóa bản đồ');
    mapDataRef.current = null; setMapData(null);
    occGridRef.current = null; occOffscreenRef.current = null; scanBoundsRef.current = null;
    setScanCount(0);
    setTimeout(() => setIsResetting(false), 1500);
  };
  const handleClearLidarGrid = () => {
    setIsClearingLidar(true);
    occGridRef.current = null; occOffscreenRef.current = null; scanBoundsRef.current = null;
    setScanCount(0);
    setTimeout(() => setIsClearingLidar(false), 1500);
  };
  const confirmReset = () => {
    modal.confirm({
      title: 'Xác nhận xóa bản đồ',
      content: 'Thao tác này sẽ xóa toàn bộ dữ liệu bản đồ và không thể hoàn tác. Tiếp tục?',
      okText: 'Xác nhận Xóa',
      cancelText: 'Hủy',
      centered: true,
      okButtonProps: { danger: true, style: { borderRadius: '8px', fontFamily: "'JetBrains Mono', monospace" } },
      cancelButtonProps: { style: { borderRadius: '8px', fontFamily: "'JetBrains Mono', monospace" } },
      styles: {
        body: { background: 'var(--bg-surface)', color: 'var(--text-primary)' },
        mask: { backdropFilter: 'blur(4px)' }
      },
      onOk: handleResetMap,
    });
  };

  const isOnline = wsStatus === 'connected';
  const isMapping = info.mode === 'mapping_idle' || info.mode === 'mapping_active' || info.mode === 'mapping';

  const modeColor = isMapping || info.mode === 'scan_obstacle' ? 'var(--warning)' : 'var(--success)';
  const modeBg = isMapping || info.mode === 'scan_obstacle' ? 'rgba(255,184,0,0.15)' : 'rgba(0,255,136,0.1)';

  return (
    <div
      className="flex flex-col h-screen select-none overflow-hidden"
      style={{ background: 'var(--bg-void)', fontFamily: "'JetBrains Mono', system-ui" }}
    >
      {/* ─── Header ─────────────────────────────────────────────────── */}
      <div
        className="px-8 py-4 flex flex-wrap items-center justify-between gap-4 relative z-10"
        style={{
          background: 'linear-gradient(180deg, rgba(0,212,255,0.06) 0%, rgba(0,212,255,0.02) 60%, transparent 100%)',
          borderBottom: '1px solid var(--border-dim)',
          boxShadow: '0 0 40px rgba(0,212,255,0.06), 0 4px 24px rgba(0,0,0,0.4)',
        }}
      >
        {/* Left: Branding */}
        <div className="flex items-center gap-5">
          <div className="relative">
            {/* Animated glow dot */}
            <div
              className="absolute -inset-1 rounded-xl"
              style={{
                background: 'radial-gradient(ellipse at center, rgba(0,212,255,0.2) 0%, transparent 70%)',
                animation: 'pulse-glow 3s ease-in-out infinite',
              }}
            />
            <div
              className="relative flex items-center gap-3 px-4 py-2.5 rounded-xl border"
              style={{
                background: 'rgba(0,212,255,0.08)',
                borderColor: 'rgba(0,212,255,0.3)',
                boxShadow: '0 0 20px rgba(0,212,255,0.1), inset 0 1px 0 rgba(0,212,255,0.1)',
              }}
            >
              <div
                className="w-8 h-8 rounded-lg flex items-center justify-center"
                style={{
                  background: 'linear-gradient(135deg, rgba(0,212,255,0.2), rgba(0,180,230,0.1))',
                  border: '1px solid rgba(0,212,255,0.3)',
                }}
              >
                <MapPin size={16} style={{ color: 'var(--accent)' }} />
              </div>
              <div>
                <h1
                  className="text-display text-base leading-none"
                  style={{ fontFamily: "'JetBrains Mono', monospace", color: 'var(--text-primary)', letterSpacing: '0.06em' }}
                >
                  SLAM<span style={{ color: 'var(--accent)' }}>_</span>MAP
                </h1>
                <div className="flex items-center gap-2 mt-0.5">
                  <span
                    className="inline-block w-1.5 h-1.5 rounded-full"
                    style={{
                      background: isOnline ? 'var(--success)' : 'var(--danger)',
                      boxShadow: isOnline ? '0 0 6px var(--success)' : 'none',
                    }}
                  />
                  <span className="text-[9px] font-bold" style={{
                    color: isOnline ? 'var(--success)' : 'var(--danger)',
                    fontFamily: "'JetBrains Mono', monospace",
                    letterSpacing: '0.12em'
                  }}>
                    {isOnline ? '● LIVE' : '○ OFFLINE'}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Divider */}
          <div className="h-10 w-px" style={{ background: 'linear-gradient(180deg, transparent, var(--border-mid), transparent)' }} />

          {/* Stats row */}
          {isOnline && (
            <div className="flex items-center gap-4">
              <StatChip label="SCANS" value={scanCount.toLocaleString()} color="var(--accent)" />
              {info.coverage_pct !== undefined && (
                <StatChip label="COV" value={`${info.coverage_pct}%`} color="var(--success)" />
              )}
              {pose && (
                <StatChip
                  label="POSE"
                  value={`${pose.x.toFixed(2)}, ${pose.y.toFixed(2)}`}
                  color="var(--warning)"
                  mono
                />
              )}
            </div>
          )}
        </div>

        {/* Right: Status + Controls */}
        <div className="flex items-center gap-3 flex-wrap">
          {/* Status cluster */}
          {isOnline && (
            <div
              className="flex items-center gap-2.5 px-4 py-2.5 rounded-xl border"
              style={{ background: 'rgba(17,24,39,0.8)', borderColor: 'var(--border-dim)' }}
            >
              {/* LIDAR */}
              <div className="flex items-center gap-1.5">
                <div
                  className={`w-2 h-2 rounded-full ${info.lidar ? 'animate-ping' : ''}`}
                  style={{ background: info.lidar ? 'var(--accent)' : 'var(--text-muted)' }}
                />
                <span className="text-[9px] font-bold" style={{ color: info.lidar ? 'var(--accent)' : 'var(--text-muted)', letterSpacing: '0.08em' }}>LIDAR</span>
              </div>
              <div className="w-px h-4" style={{ background: 'var(--border-dim)' }} />
              {/* MAP */}
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full" style={{ background: info.map ? 'var(--success)' : 'var(--text-muted)' }} />
                <span className="text-[9px] font-bold" style={{ color: info.map ? 'var(--success)' : 'var(--text-muted)', letterSpacing: '0.08em' }}>MAP</span>
              </div>
              <div className="w-px h-4" style={{ background: 'var(--border-dim)' }} />
              {/* POSE */}
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full" style={{ background: info.pose ? 'var(--warning)' : 'var(--text-muted)' }} />
                <span className="text-[9px] font-bold" style={{ color: info.pose ? 'var(--warning)' : 'var(--text-muted)', letterSpacing: '0.08em' }}>POSE</span>
              </div>
              <div className="w-px h-4" style={{ background: 'var(--border-dim)' }} />
              {/* Mode */}
              <span
                className="px-2 py-0.5 rounded-md font-bold text-[9px]"
                style={{ background: modeBg, color: modeColor, letterSpacing: '0.1em' }}
              >
                {info.mode?.toUpperCase() || 'IDLE'}
              </span>
              {statusText && (
                <span className="text-[9px]" style={{ color: 'var(--text-muted)', letterSpacing: '0.04em' }}>
                  {statusText}
                </span>
              )}
            </div>
          )}

          {/* Action buttons */}
          <div className="flex items-center gap-2">
            <Tooltip title="Bắt đầu quét bản đồ">
              <Button
                type="primary"
                size="large"
                icon={<MapPin size={15} />}
                loading={isStarting}
                onClick={handleStartScan}
                disabled={isMapping || info.mode === 'scan_obstacle'}
                style={{
                  background: 'linear-gradient(135deg, #00d4ff, #0090cc)',
                  border: 'none',
                  color: '#060910',
                  borderRadius: '10px',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontWeight: 700,
                  fontSize: '12px',
                  boxShadow: '0 0 24px rgba(0,212,255,0.35), 0 2px 8px rgba(0,0,0,0.3)',
                  display: 'flex', alignItems: 'center', gap: '6px',
                  letterSpacing: '0.04em',
                }}
              >
                BẮT ĐẦU
              </Button>
            </Tooltip>

            <Tooltip title="Dừng quét, chuyển sang định vị">
              <Button
                size="large"
                icon={<Target size={15} />}
                loading={isStopping}
                onClick={handleStopScan}
                disabled={!isMapping}
                style={{
                  borderRadius: '10px',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontWeight: 600,
                  fontSize: '12px',
                  background: 'rgba(255,184,0,0.1)',
                  border: '1px solid rgba(255,184,0,0.3)',
                  color: 'var(--warning)',
                  display: 'flex', alignItems: 'center', gap: '6px',
                  boxShadow: '0 0 16px rgba(255,184,0,0.1)',
                }}
              >
                DỪNG
              </Button>
            </Tooltip>

            <Tooltip title="Xóa bản đồ và quét lại">
              <Button
                size="large"
                icon={<RotateCcw size={15} />}
                loading={isResetting}
                onClick={confirmReset}
                style={{
                  borderRadius: '10px',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontWeight: 600,
                  fontSize: '12px',
                  background: 'rgba(255,59,92,0.1)',
                  border: '1px solid rgba(255,59,92,0.3)',
                  color: 'var(--danger)',
                  display: 'flex', alignItems: 'center', gap: '6px',
                }}
              >
                XÓA
              </Button>
            </Tooltip>

            <Tooltip title="Xóa chỉ lưới LIDAR, giữ nguyên bản đồ nền">
              <Button
                size="large"
                icon={<Crosshair size={15} />}
                loading={isClearingLidar}
                onClick={handleClearLidarGrid}
                style={{
                  borderRadius: '10px',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontWeight: 600,
                  fontSize: '12px',
                  background: 'rgba(0,212,255,0.08)',
                  border: '1px solid rgba(0,212,255,0.2)',
                  color: 'var(--accent)',
                  display: 'flex', alignItems: 'center', gap: '6px',
                }}
              >
                LIDAR CLR
              </Button>
            </Tooltip>
          </div>
        </div>
      </div>

      {/* ─── Canvas viewer ───────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 p-5">
        <div
          className="relative w-full h-full rounded-2xl overflow-hidden"
          style={{
            background: 'var(--bg-base)',
            border: '1px solid var(--border-dim)',
            boxShadow: '0 0 80px rgba(0,0,0,0.6), 0 0 40px rgba(0,212,255,0.04), inset 0 1px 0 rgba(255,255,255,0.03)',
          }}
        >
          {/* Subtle grid texture on container */}
          <div
            className="absolute inset-0 pointer-events-none opacity-30"
            style={{
              backgroundImage: 'linear-gradient(rgba(0,212,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(0,212,255,0.03) 1px, transparent 1px)',
              backgroundSize: '48px 48px',
            }}
          />

          {/* Radar minimap — top-right corner */}
          <div
            className="absolute top-4 right-4 z-20 flex flex-col gap-1"
          >
            <div
              className="flex items-center gap-2 px-3 py-1.5 rounded-t-xl"
              style={{
                background: 'rgba(8,11,16,0.9)',
                borderTop: '1px solid rgba(0,212,255,0.3)',
                borderLeft: '1px solid rgba(0,212,255,0.3)',
                borderRight: '1px solid rgba(0,212,255,0.3)',
                borderBottom: 'none',
              }}
            >
              <Activity size={10} style={{ color: 'var(--accent)' }} />
              <span className="text-[9px] font-bold" style={{ color: 'var(--accent)', letterSpacing: '0.12em' }}>
                RADAR
              </span>
              <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>±{MINI_RANGE}m</span>
            </div>
            <canvas
              ref={miniCanvasRef}
              width={MINI_SIZE}
              height={MINI_SIZE}
              className="block rounded-b-xl"
              style={{
                borderLeft: '1px solid rgba(0,212,255,0.3)',
                borderRight: '1px solid rgba(0,212,255,0.3)',
                borderBottom: '1px solid rgba(0,212,255,0.3)',
                imageRendering: 'pixelated',
              }}
            />
          </div>

          {/* Legend — top-left */}
          <div
            className="absolute top-4 left-4 z-10 flex flex-col gap-1.5 px-4 py-3 rounded-xl"
            style={{
              background: 'rgba(8,11,16,0.88)',
              backdropFilter: 'blur(16px)',
              border: '1px solid var(--border-mid)',
              boxShadow: '0 4px 24px rgba(0,0,0,0.3)',
            }}
          >
            <span className="text-[9px] font-bold mb-0.5" style={{ color: 'var(--text-muted)', letterSpacing: '0.12em' }}>LEGEND</span>
            <div className="flex items-center gap-3">
              {[
                { color: '#fff', label: 'Free', border: '#555' },
                { color: '#808080', label: 'Unknown', border: '#444' },
                { color: '#000', label: 'Wall', border: '#333' },
              ].map(({ label, color, border }) => (
                <div key={label} className="flex items-center gap-1.5">
                  <span className="w-3.5 h-3.5 rounded-sm" style={{ background: color, border: `1px solid ${border}` }} />
                  <span className="text-[10px] font-bold" style={{ color: 'var(--text-secondary)', letterSpacing: '0.04em' }}>{label}</span>
                </div>
              ))}
              <div className="flex items-center gap-1.5">
                <div className="w-3.5 h-3.5 rounded-full" style={{ background: '#00ff88', boxShadow: '0 0 6px rgba(0,255,136,0.6)' }} />
                <span className="text-[10px] font-bold" style={{ color: 'var(--text-secondary)', letterSpacing: '0.04em' }}>Robot</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-3.5 h-3.5 rounded-full" style={{ background: 'rgba(0,212,255,0.7)' }} />
                <span className="text-[10px] font-bold" style={{ color: 'var(--text-secondary)', letterSpacing: '0.04em' }}>Scan</span>
              </div>
            </div>
            {mapData && (
              <div className="pt-1.5 mt-0.5" style={{ borderTop: '1px solid var(--border-dim)' }}>
                <span className="text-[9px] font-mono" style={{ color: 'var(--text-muted)', letterSpacing: '0.06em' }}>
                  {mapData.width}×{mapData.height} @ {mapData.resolution.toFixed(3)}m
                </span>
              </div>
            )}
          </div>

          {/* Lidar axis — top-center */}
          <div
            className="absolute top-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1 px-2 py-1.5 rounded-xl"
            style={{
              background: 'rgba(8,11,16,0.88)',
              backdropFilter: 'blur(16px)',
              border: '1px solid var(--border-mid)',
            }}
          >
            <span className="text-[9px] px-1.5" style={{ color: 'var(--text-muted)', letterSpacing: '0.08em', fontFamily: "'JetBrains Mono', monospace" }}>
              AXIS:
            </span>
            {[{ val: 0, label: '+X' }, { val: 1, label: '+Y' }, { val: 2, label: '-X' }, { val: 3, label: '-Y' }].map(({ val, label }) => (
              <button
                key={val}
                onClick={() => setLidarAxis(val)}
                className="px-2.5 py-1 rounded-lg transition-all cursor-pointer font-mono text-[10px] font-bold"
                style={
                  lidarAxis === val
                    ? { background: 'rgba(255,184,0,0.2)', color: 'var(--warning)', border: '1px solid rgba(255,184,0,0.35)', letterSpacing: '0.06em', boxShadow: '0 0 10px rgba(255,184,0,0.15)' }
                    : { background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border-dim)', letterSpacing: '0.06em' }
                }
              >
                {label}
              </button>
            ))}
          </div>

          {/* Bottom-left: Heading-Up + Robot-Lock */}
          <div
            className="absolute bottom-4 left-4 z-10 flex items-center gap-1.5 p-1.5 rounded-xl"
            style={{
              background: 'rgba(8,11,16,0.88)',
              backdropFilter: 'blur(16px)',
              border: '1px solid var(--border-mid)',
            }}
          >
            <Tooltip title="Robot luôn hướng lên">
              <button
                onClick={() => setIsHeadingUp(v => !v)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-all cursor-pointer"
                style={
                  isHeadingUp
                    ? { background: 'rgba(0,212,255,0.15)', color: 'var(--accent)', border: '1px solid rgba(0,212,255,0.25)', boxShadow: '0 0 10px rgba(0,212,255,0.1)' }
                    : { background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border-dim)' }
                }
              >
                <Compass size={13} />
                <span className="text-[10px] font-bold" style={{ letterSpacing: '0.06em' }}>HEADING</span>
              </button>
            </Tooltip>
            <Tooltip title="Giữ robot ở trung tâm">
              <button
                onClick={() => setIsRobotLock(v => !v)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-all cursor-pointer"
                style={
                  isRobotLock
                    ? { background: 'rgba(0,255,136,0.12)', color: 'var(--success)', border: '1px solid rgba(0,255,136,0.25)', boxShadow: '0 0 10px rgba(0,255,136,0.08)' }
                    : { background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border-dim)' }
                }
              >
                <Target size={13} />
                <span className="text-[10px] font-bold" style={{ letterSpacing: '0.06em' }}>LOCK</span>
              </button>
            </Tooltip>
          </div>

          {/* Bottom-right: Zoom controls */}
          <div
            className="absolute bottom-4 right-4 z-10 flex items-center gap-2 p-2 rounded-xl"
            style={{
              background: 'rgba(8,11,16,0.88)',
              backdropFilter: 'blur(16px)',
              border: '1px solid var(--border-mid)',
            }}
          >
            <Tooltip title="Thu nhỏ">
              <button
                onClick={handleZoomOut}
                className="w-9 h-9 rounded-lg flex items-center justify-center transition-all cursor-pointer"
                style={{ background: 'var(--bg-raised)', border: '1px solid var(--border-mid)', color: 'var(--text-secondary)' }}
              >
                <ZoomOut size={16} />
              </button>
            </Tooltip>
            <div
              className="px-2 py-1 rounded-lg text-center min-w-13"
              style={{ background: 'var(--bg-raised)', border: '1px solid var(--border-dim)' }}
            >
              <span
                className="font-mono font-bold text-[11px]"
                style={{ color: 'var(--warning)', fontFamily: "'JetBrains Mono', monospace" }}
              >
                {Math.round(zoom * 100)}%
              </span>
            </div>
            <Tooltip title="Phóng to">
              <button
                onClick={handleZoomIn}
                className="w-9 h-9 rounded-lg flex items-center justify-center transition-all cursor-pointer"
                style={{ background: 'var(--bg-raised)', border: '1px solid var(--border-mid)', color: 'var(--text-secondary)' }}
              >
                <ZoomIn size={16} />
              </button>
            </Tooltip>
            <div className="w-px h-6 mx-0.5" style={{ background: 'var(--border-dim)' }} />
            {/* Zoom presets */}
            {[0.5, 1, 2, 4].map(z => (
              <button
                key={z}
                onClick={() => setZoom(z)}
                className="px-2 py-1 rounded-lg font-mono text-[10px] font-bold cursor-pointer transition-all"
                style={
                  zoom === z
                    ? { background: 'var(--accent)', color: '#060910', border: '1px solid var(--accent)' }
                    : { background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border-dim)' }
                }
              >
                {z}×
              </button>
            ))}
            <div className="w-px h-6 mx-0.5" style={{ background: 'var(--border-dim)' }} />
            <Tooltip title="Đặt lại tầm nhìn">
              <button
                onClick={resetView}
                className="w-9 h-9 rounded-lg flex items-center justify-center transition-all cursor-pointer"
                style={{ background: 'var(--bg-raised)', border: '1px solid var(--border-mid)', color: 'var(--text-secondary)' }}
              >
                <Maximize2 size={16} />
              </button>
            </Tooltip>
          </div>

          {/* Corner HUD accents — CSS-based */}
          {[
            { top: 0, left: 0, borderTop: '1px', borderLeft: '1px', bRadius: '0 0 12px 0' },
            { top: 0, right: 0, borderTop: '1px', borderRight: '1px', bRadius: '0 0 0 12px' },
            { bottom: 0, left: 0, borderBottom: '1px', borderLeft: '1px', bRadius: '0 12px 0 0' },
            { bottom: 0, right: 0, borderBottom: '1px', borderRight: '1px', bRadius: '12px 0 0 0' },
          ].map((pos, i) => (
            <div
              key={i}
              className="absolute pointer-events-none z-[5]"
              style={{
                ...pos,
                width: 48,
                height: 48,
                borderColor: 'rgba(0,212,255,0.4)',
                borderStyle: 'solid',
                borderWidth: pos.bRadius.includes('1') ? '1px' : '0',
                borderTopWidth: pos.borderTop ?? '0',
                borderBottomWidth: pos.borderBottom ?? '0',
                borderLeftWidth: pos.borderLeft ?? '0',
                borderRightWidth: pos.borderRight ?? '0',
                borderRadius: pos.bRadius,
              }}
            />
          ))}

          {/* Disconnected overlay */}
          {!isOnline && (
            <div
              className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-5"
              style={{ background: 'rgba(8,11,16,0.88)', backdropFilter: 'blur(12px)' }}
            >
              {/* Animated rings */}
              <div className="relative">
                <div
                  className="absolute inset-0 rounded-full"
                  style={{
                    background: 'radial-gradient(circle, rgba(255,59,92,0.1) 0%, transparent 70%)',
                    animation: 'pulse-glow 2s ease-in-out infinite',
                  }}
                />
                <WifiOff size={52} style={{ color: 'var(--text-muted)' }} />
              </div>
              <div className="text-center space-y-1">
                <p className="text-base font-bold" style={{ color: 'var(--text-primary)', fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.04em' }}>
                  Mất kết nối robot
                </p>
                <p className="text-sm" style={{ color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}>
                  Đang thử kết nối lại...
                </p>
              </div>
              <Button
                onClick={() => connectWsRef.current()}
                style={{
                  borderRadius: '10px',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontWeight: 600,
                  fontSize: '12px',
                  background: 'rgba(0,212,255,0.1)',
                  border: '1px solid rgba(0,212,255,0.25)',
                  color: 'var(--accent)',
                  boxShadow: '0 0 20px rgba(0,212,255,0.1)',
                }}
              >
                Thử kết nối lại
              </Button>
            </div>
          )}

          <canvas ref={canvasRef} className="w-full h-full block" style={{ imageRendering: 'pixelated', position: 'relative', zIndex: 1 }} />
        </div>
      </div>

      <style jsx>{`
        @keyframes pulse-glow {
          0%, 100% { opacity: 0.6; transform: scale(1); }
          50% { opacity: 1; transform: scale(1.05); }
        }
      `}</style>
    </div>
  );
}

// ── Small stat chip component ───────────────────────────────────────────────
function StatChip({ label, value, color, mono }: { label: string; value: string; color: string; mono?: boolean }) {
  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 rounded-lg"
      style={{
        background: 'rgba(17,24,39,0.6)',
        border: '1px solid var(--border-dim)',
      }}
    >
      <span className="text-[8px] font-bold" style={{ color: 'var(--text-muted)', letterSpacing: '0.1em' }}>
        {label}
      </span>
      <span
        className="font-mono font-bold text-[11px]"
        style={{ color, fontFamily: "'JetBrains Mono', monospace" }}
      >
        {value}
      </span>
    </div>
  );
}
