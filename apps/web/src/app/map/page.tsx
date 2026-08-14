'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { MapPin, RotateCcw, ZoomIn, ZoomOut, Maximize2, Compass, Target, WifiOff, Crosshair, Activity, Power, Zap, Keyboard, Rocket, ChevronUp, ChevronDown, ChevronLeft, ChevronRight, Cpu } from 'lucide-react';
import { Button, App, Tooltip } from 'antd';

const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL || 'wss://map.nguyen-robot.io.vn';
const WS_AUTH_TOKEN = process.env.NEXT_PUBLIC_WS_AUTH_TOKEN;

function authenticatedWsUrl(url: string): string {
  if (!WS_AUTH_TOKEN) return url;
  const wsUrl = new URL(url);
  wsUrl.searchParams.set('token', WS_AUTH_TOKEN);
  return wsUrl.toString();
}

interface ScanData { points: { x: number; y: number }[]; count: number; }

interface MapData { width: number; height: number; resolution: number; origin_x: number; origin_y: number; origin_theta: number; data: number[]; }

interface PoseData { x: number; y: number; theta: number; }
interface InfoData { lidar: boolean; map: boolean; pose: boolean; mode: string; coverage_pct?: number; }
interface Esp32Status { estop?: boolean; mode?: string; max_pct?: number; st?: { imu?: boolean; pwr?: boolean; sharp?: number; obs?: boolean; tof_mm?: number; cyl?: string }; motors?: { t?: number; r?: number }[]; }
interface DemoStatus { state?: string; action?: string; zone?: string; message?: string; error?: string; }
interface ControlModeStatus { mode?: string; active_mode?: string; source?: string; reason?: string; }

// ── Shared canvas helpers ─────────────────────────────────────────────────────

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
const MINI_SIZE = 320;
const MINI_RANGE = 3.0; // metres visible in minimap

function drawMinimap(ctx: CanvasRenderingContext2D, scan: ScanData | null, pose: PoseData | null, lidarAxis: number) {
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

  // Scan points — always draw if scan data exists.
  // When pose is null, render in robot-local frame (centered on radar).
  // Use the supplied lidarAxis so axis selector takes effect.
  if (scan?.points.length) {
    const points = scan.points.length > 300 ? scan.points.filter((_, i) => i % 3 === 0) : scan.points;
    const effPose: PoseData = pose ?? { x: 0, y: 0, theta: 0 };
    ctx.fillStyle = 'rgba(0,212,255,0.85)';
    for (const pt of points) {
      const wp = robotToWorld(pt.x, pt.y, effPose, lidarAxis);
      const sx = cx + wp.wx * scale;
      const sy = cy - wp.wy * scale;
      if (sx < 0 || sx > W || sy < 0 || sy > H) continue;
      ctx.beginPath();
      ctx.arc(sx, sy, 1.4, 0, Math.PI * 2);
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
  const robotLockRef = useRef<boolean>(true);
  const connectWsRef = useRef<() => void>(() => {});
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef(1000);
  const lidarAxisRef = useRef<number>(1);
  const occGridRef = useRef<MapData | null>(null);
  const occScaleRef = useRef<number>(0.05);
  const occSizeRef = useRef<number>(500);
  const scanBoundsRef = useRef<{ minX: number; maxX: number; minY: number; maxY: number } | null>(null);
  const offscreenRef = useRef<HTMLCanvasElement | null>(null);
  const occOffscreenRef = useRef<HTMLCanvasElement | null>(null);
  const obstacleOffscreenRef = useRef<HTMLCanvasElement | null>(null);
  const obstacleDataRef = useRef<MapData | null>(null);
  const miniCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [scanCount, setScanCount] = useState(0);

  // ── Robot control state ────────────────────────────────────────────
  const [controlMode, setControlMode] = useState<'AUTO' | 'MANUAL'>('MANUAL');
  const [controlModeStatus, setControlModeStatus] = useState<ControlModeStatus>({});
  const [demoStatus, setDemoStatus] = useState<DemoStatus>({});
  const [esp32Status, setEsp32Status] = useState<Esp32Status | null>(null);
  const [ackLog, setAckLog] = useState<{ ts: number; type: string; data: unknown }[]>([]);
  const [robotErrors, setRobotErrors] = useState<Array<{ ts: number; severity: string; code: string; message: string }>>([]);
  const pendingCommandLabelsRef = useRef<Map<string, string>>(new Map());

  // Keyboard state for teleop
  const keysPressed = useRef<Set<string>>(new Set());
  const teleopRef = useRef<{ vx: number; vy: number; omega: number } | null>(null);
  const teleopSendTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => { mapDataRef.current = mapData; }, [mapData]);
  useEffect(() => { poseRef.current = pose; }, [pose]);
  useEffect(() => { scanDataRef.current = scanData; }, [scanData]);
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  useEffect(() => { headingUpRef.current = isHeadingUp; }, [isHeadingUp]);
  useEffect(() => { robotLockRef.current = isRobotLock; }, [isRobotLock]);
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

  // eslint-disable-next-line react-hooks/exhaustive-deps
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
      if (!off) {
        buildMapImage();
      }
      if (!offscreenRef.current) return;
      const { width: gw, height: gh, resolution: res, origin_x, origin_y } = mapDataRef.current;
      const minScale = Math.min(W, H) * 0.75 / Math.max(gw, gh);
      const rawFit = Math.min(W / gw, H / gh) * zoom;
      const scale = Math.max(rawFit, minScale);
      const centerX = robotLockRef.current && p ? p.x : 0;
      const centerY = robotLockRef.current && p ? p.y : 0;
      // OccupancyGrid origin is bottom-left; canvas origin is top-left.
      // Grid row 0 = world top = origin_y + gh*res. In screen space (Y-down), world Y+ = screen Y−.
      const mapX = W / 2 + (origin_x - centerX) / res * scale;
      const mapY = H / 2 - (origin_y + gh * res - centerY) / res * scale;

      ctx.save();
      if (p && isHU) {
        const cx2 = W / 2;
        const cy2 = H / 2;
        ctx.translate(cx2, cy2); ctx.rotate(-p.theta - Math.PI / 2); ctx.translate(-cx2, -cy2);
      }
      ctx.drawImage(offscreenRef.current, mapX, mapY, gw * scale, gh * scale);
      ctx.restore();

      const worldToScreen = (wx: number, wy: number) => {
        let sx = W / 2 + (wx - centerX) * scale / res;
        let sy = H / 2 - (wy - centerY) * scale / res;
        if (p && isHU) {
          const cx2 = W / 2;
          const cy2 = H / 2;
          const cos = Math.cos(-p.theta - Math.PI / 2); const sin = Math.sin(-p.theta - Math.PI / 2);
          const dx = sx - cx2; const dy2 = sy - cy2;
          sx = cx2 + cos * dx - sin * dy2; sy = cy2 + sin * dx + cos * dy2;
        }
        return { sx, sy };
      };

      // ── Overlay: locally-built occupancy grid (if any) ────────────
      if (occOffscreenRef.current && occGridRef.current) {
        const og = occGridRef.current;
        const oRes = og.resolution;
        const oHalf = (og.width * oRes) / 2;
        const oMinScale = Math.min(W, H) * 0.75 / Math.max(og.width, og.height);
        const oRawFit = Math.min(W / og.width, H / og.height) * zoom;
        const oScale = Math.max(oRawFit, oMinScale);
        // Local occ grid is centered on world (0,0) → screen center.
        const oMapX = W / 2 + og.origin_x / oRes * oScale;
        const oMapY = H / 2 - (og.origin_y + og.height * oRes) / oRes * oScale;
        ctx.save();
        if (p && isHU) {
          const cx2 = W / 2, cy2 = H / 2;
          ctx.translate(cx2, cy2); ctx.rotate(-p.theta - Math.PI / 2); ctx.translate(-cx2, -cy2);
        }
        ctx.globalAlpha = 0.7;
        ctx.drawImage(occOffscreenRef.current, oMapX, oMapY, og.width * oScale, og.height * oScale);
        ctx.globalAlpha = 1;
        ctx.restore();
        // Suppress unused-variable lint
        void oHalf;
      }

      // ── Overlay: obstacle layer (if any) ──────────────────────────
      const obstacleData = obstacleDataRef.current;
      if (obstacleOffscreenRef.current && obstacleData) {
        const { width: odW, height: odH, resolution: oRes, origin_x: obstacleOriginX, origin_y: obstacleOriginY } = obstacleData;
        const oScale = scale * oRes / res;
        const oMapX = W / 2 + (obstacleOriginX - centerX) / res * scale;
        const oMapY = H / 2 - (obstacleOriginY + odH * oRes - centerY) / res * scale;
        ctx.save();
        if (p && isHU) {
          const cx2 = W / 2, cy2 = H / 2;
          ctx.translate(cx2, cy2); ctx.rotate(-p.theta - Math.PI / 2); ctx.translate(-cx2, -cy2);
        }
        // Tint obstacle layer red so it's distinct from the base map.
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 0.5;
        ctx.drawImage(obstacleOffscreenRef.current, oMapX, oMapY, odW * oScale, odH * oScale);
        ctx.globalAlpha = 1;
        ctx.restore();
      }

      // ── Live scan points projected into world coords ──────────────
      const scanA = scanDataRef.current;
      if (p && scanA?.points.length) {
        const axis = lidarAxisRef.current;
        ctx.beginPath();
        for (let i = 0; i < scanA.points.length; i++) {
          const wp = robotToWorld(scanA.points[i].x, scanA.points[i].y, p, axis);
          const sp = worldToScreen(wp.wx, wp.wy);
          if (i === 0) ctx.moveTo(sp.sx, sp.sy); else ctx.lineTo(sp.sx, sp.sy);
        }
        ctx.strokeStyle = 'rgba(0,212,255,0.25)'; ctx.lineWidth = 1; ctx.stroke();
        ctx.fillStyle = 'rgba(0,212,255,0.85)';
        for (let i = 0; i < scanA.points.length; i += 2) {
          const wp = robotToWorld(scanA.points[i].x, scanA.points[i].y, p, axis);
          const sp = worldToScreen(wp.wx, wp.wy);
          ctx.beginPath(); ctx.arc(sp.sx, sp.sy, 1.8, 0, Math.PI * 2); ctx.fill();
        }
      }

      if (p) { const rp = worldToScreen(p.x, p.y); drawRobot(ctx, rp.sx, rp.sy, zoom); }
      return;
    }

    // ── Path B: scan-only (no server map) ──────────────────────────
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
      const axis = lidarAxisRef.current;
      // Apply lidarAxis transform in robot-local frame.
      const lx = (pt: { x: number; y: number }) => {
        switch (axis) {
          case 0: return  pt.x;
          case 1: return  pt.y;
          case 2: return -pt.x;
          case 3: return -pt.y;
          default: return pt.x;
        }
      };
      const ly = (pt: { x: number; y: number }) => {
        switch (axis) {
          case 0: return  pt.y;
          case 1: return -pt.x;
          case 2: return -pt.y;
          case 3: return  pt.x;
          default: return pt.y;
        }
      };

      ctx.beginPath();
      for (let i = 0; i < scan.points.length; i++) {
        const sx = robotScreenX + lx(scan.points[i]) * scale;
        const sy = robotScreenY - ly(scan.points[i]) * scale;
        if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
      }
      ctx.strokeStyle = 'rgba(0,212,255,0.3)'; ctx.lineWidth = 1.5; ctx.stroke();

      ctx.fillStyle = 'rgba(0,212,255,0.9)';
      for (let i = 0; i < scan.points.length; i += 2) {
        const sx = robotScreenX + lx(scan.points[i]) * scale;
        const sy = robotScreenY - ly(scan.points[i]) * scale;
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
          if (mctx) drawMinimap(mctx, scanDataRef.current, poseRef.current, lidarAxisRef.current);
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
      const ws = new WebSocket(authenticatedWsUrl(WS_URL));
      ws.onopen = () => {
        setWsStatus('connected');
        reconnectDelayRef.current = 1000;
        pingRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ type: 'ping' })); }
        }, 5000);
      };
      ws.onmessage = (event) => {
        function dispatch(msg: { type: string; data?: unknown }) {
          console.log('[WS] dispatch:', msg.type, msg.type === 'map_layer'
            ? `${(msg.data as MapData)?.width}x${(msg.data as MapData)?.height} cells=${(msg.data as MapData)?.data?.length}`
            : msg.type === 'pose' ? `x=${(msg.data as PoseData)?.x?.toFixed(2)} y=${(msg.data as PoseData)?.y?.toFixed(2)}`
            : '');
          switch (msg.type) {
            case 'map':
            case 'map_layer': {
              const incoming = msg.data as MapData;
              setMapData(incoming);
              mapDataRef.current = incoming;
              break;
            }
            case 'obstacle_layer': {
              const od = msg.data as MapData;
              if (!obstacleOffscreenRef.current) obstacleOffscreenRef.current = document.createElement('canvas');
              drawGridToCanvas(od, obstacleOffscreenRef.current);
              obstacleDataRef.current = od;
              break;
            }
            case 'pose': setPose({ ...(msg.data as PoseData) }); poseRef.current = { ...(msg.data as PoseData) }; break;
            case 'scan':
              setScanData({ ...(msg.data as ScanData) });
              scanDataRef.current = msg.data as ScanData;
              setScanCount(c => c + 1);
              buildOccupancyGrid(msg.data as ScanData);
              break;
            case 'status': {
              const raw = (msg.data as string) || '';
              setStatusText(raw);
              // Derive mode from status string like "STATE=MAPPING x=0.10 ..."
              const upper = raw.toUpperCase();
              if (upper.startsWith('STATE=MAPPING')) setInfo(prev => ({ ...prev, mode: 'mapping_active' }));
              else if (upper.startsWith('STATE=LIVE')) setInfo(prev => ({ ...prev, mode: 'live' }));
              else if (upper.startsWith('STATE=IDLE')) setInfo(prev => ({ ...prev, mode: 'idle' }));
              break;
            }
            case 'info': setInfo(msg.data as InfoData); break;
            case 'mode': setInfo(prev => ({ ...prev, mode: msg.data as string })); break;
            case 'esp32_status': setEsp32Status(msg.data as Esp32Status); break;
            case 'demo_status': { const ds = msg.data as DemoStatus; setDemoStatus(ds); break; }
            case 'control_mode_status': { const cms = msg.data as ControlModeStatus; setControlModeStatus(cms); const m = cms.mode ?? cms.active_mode; if (m === 'AUTO' || m === 'MANUAL') setControlMode(m); break; }
            case 'ack': {
              const data = (msg.data ?? {}) as { command?: string; accepted?: boolean; ok?: boolean; error?: string };
              const entry = { ts: Date.now(), type: msg.type, data };
              setAckLog(prev => [entry, ...prev].slice(0, 20));
              const label = data.command ? pendingCommandLabelsRef.current.get(data.command) : undefined;
              if (data.command) pendingCommandLabelsRef.current.delete(data.command);
              if (data.accepted ?? data.ok ?? false) {
                notification.success({ title: 'Robot đã nhận lệnh', description: label ?? data.command ?? 'Lệnh điều khiển', placement: 'topRight' });
              } else {
                notification.error({ title: 'Robot từ chối lệnh', description: data.error ?? label ?? data.command ?? 'Lệnh điều khiển', placement: 'topRight' });
              }
              break;
            }
            case 'robot_error': {
              const ed = (msg.data ?? {}) as { severity?: string; code?: string; message?: string; ts?: string };
              const entry = {
                ts: Date.now(),
                severity: ed.severity ?? 'error',
                code: ed.code ?? 'UNKNOWN',
                message: ed.message ?? 'Robot reported an error',
              };
              setRobotErrors(prev => [entry, ...prev].slice(0, 50));
              break;
            }
          }
        }
        async function parse(data: ArrayBuffer | Blob | string) {
          try {
            const bytes = data instanceof Blob ? null : (data instanceof ArrayBuffer ? new Uint8Array(data) : null);
            const isGzip = bytes && bytes[0] === 0x1f && bytes[1] === 0x8b;
            let text: string;
            if (data instanceof Blob) {
              const buf = await data.arrayBuffer();
              return parse(buf);
            } else if (isGzip && bytes) {
              const ds = new DecompressionStream('gzip');
              const writer = ds.writable.getWriter();
              writer.write(bytes);
              await writer.close();
              text = await new Response(ds.readable).text();
            } else {
              text = typeof data === 'string' ? data : new TextDecoder().decode(data as ArrayBuffer);
            }
            dispatch(JSON.parse(text));
          } catch (err) {
            console.warn('[WS] parse error:', err);
          }
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

  // Surface robot errors as toasts the first time they arrive (notification API is one-shot per call).
  const notifiedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (robotErrors.length === 0) return;
    const newest = robotErrors[0];
    const key = `${newest.ts}-${newest.code}-${newest.message}`;
    if (notifiedRef.current.has(key)) return;
    notifiedRef.current.add(key);
    // Cap the dedupe set so it doesn't grow unbounded.
    if (notifiedRef.current.size > 200) {
      const arr = Array.from(notifiedRef.current);
      notifiedRef.current = new Set(arr.slice(arr.length - 200));
    }
    const sev = newest.severity.toLowerCase();
    const titleBySeverity: Record<string, string> = {
      critical: '⛔ LỖI NGHIÊM TRỌNG',
      error: '❌ LỖI ROBOT',
      warning: '⚠️ CẢNH BÁO',
    };
    const title = titleBySeverity[sev] ?? '🤖 ROBOT';
    const cfg: { message: string; description: string; type: 'error' | 'warning' | 'info' } =
      sev === 'critical'
        ? { message: title, description: `${newest.code}: ${newest.message}`, type: 'error' }
        : sev === 'warning'
        ? { message: title, description: `${newest.code}: ${newest.message}`, type: 'warning' }
        : { message: title, description: `${newest.code}: ${newest.message}`, type: 'error' };
    notification.open({
      ...cfg,
      placement: 'topRight',
      duration: sev === 'critical' ? 0 : 8,
    });
  }, [robotErrors, notification]);

  const handleZoomIn = () => setZoom(v => Math.min(8, +(v + 0.5).toFixed(2)));
  const handleZoomOut = () => setZoom(v => Math.max(0.1, +(v - 0.5).toFixed(2)));
  const resetView = () => { setZoom(1); };

  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [isClearingLidar, setIsClearingLidar] = useState(false);
  const [isIdling, setIsIdling] = useState(false);

  const sendCmd = useCallback((command: string, label: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      notification.warning({ title: 'Mất kết nối', description: 'Không thể gửi lệnh. Đang thử kết nối lại...', placement: 'topRight' });
      connectWsRef.current(); return;
    }
    pendingCommandLabelsRef.current.set(command, label);
    wsRef.current.send(JSON.stringify({ type: 'cmd', command }));
    console.log('[WS] → cmd:', command);
  }, [notification]);

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
  const handleIdle = () => {
    setIsIdling(true); sendCmd('idle', 'chuyển về IDLE');
    setTimeout(() => setIsIdling(false), 1500);
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

  // ── Robot command callbacks ────────────────────────────────────────
  const sendWs = useCallback((obj: Record<string, unknown>) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      notification.warning({ title: 'Mất kết nối', description: 'Không thể gửi lệnh.', placement: 'topRight' });
      connectWsRef.current(); return false;
    }
    wsRef.current.send(JSON.stringify(obj));
    return true;
  }, [notification]);

  const sendEsp32 = useCallback((cmd: Record<string, unknown>) => {
    if (sendWs({ type: 'esp32', cmd })) console.log('[WS] → esp32:', cmd);
  }, [sendWs]);

  const sendTeleop = useCallback((vx: number, vy: number, omega: number) => {
    sendWs({ type: 'teleop', vx, vy, omega });
  }, [sendWs]);

  const sendCylinder = useCallback((action: 'extend' | 'retract' | 'stop') => {
    if (sendWs({ type: 'cylinder', action })) {
      console.log('[WS] → cylinder:', action);
      notification.success({ title: 'Thành công', description: `Cylinder: ${action}`, placement: 'topRight' });
    }
  }, [sendWs, notification]);

  const sendDemo = useCallback((action: string) => {
    if (sendWs({ type: 'demo', action })) {
      console.log('[WS] → demo:', action);
      notification.success({ title: 'Thành công', description: `Demo ${action.toUpperCase()}`, placement: 'topRight' });
    }
  }, [sendWs, notification]);

  const sendControlMode = useCallback((mode: 'AUTO' | 'MANUAL') => {
    if (sendWs({ type: 'control_mode', mode })) {
      console.log('[WS] → control_mode:', mode);
      notification.success({ title: 'Thành công', description: `Chế độ: ${mode}`, placement: 'topRight' });
    }
  }, [sendWs, notification]);

  const handleEStop = useCallback(() => {
    modal.confirm({
      title: '🛑 E-STOP KHẨN CẤP',
      content: 'Ngay lập tức dừng tất cả động cơ và ngắt hệ thống điều khiển. Tiếp tục?',
      okText: 'XÁC NHẬN E-STOP',
      cancelText: 'Hủy',
      centered: true,
      okButtonProps: { danger: true, style: { borderRadius: '8px', fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", background: '#ff3b5c', border: '2px solid #ff3b5c', boxShadow: '0 0 24px rgba(255,59,92,0.6)' } },
      cancelButtonProps: { style: { borderRadius: '8px', fontFamily: "'JetBrains Mono', monospace" } },
      styles: { body: { background: 'var(--bg-surface)', color: 'var(--text-primary)' }, mask: { backdropFilter: 'blur(4px)' } },
      onOk: () => sendEsp32({ cmd: 'e_stop' }),
    });
  }, [modal, sendEsp32]);

  const sendKeyboardMotion = useCallback(() => {
    if (controlMode !== 'MANUAL') return;
    const keys = keysPressed.current;
    const speed = 120;
    const vx = (keys.has('w') || keys.has('arrowup') ? speed : 0) + (keys.has('s') || keys.has('arrowdown') ? -speed : 0);
    const vy = (keys.has('d') || keys.has('arrowright') ? speed : 0) + (keys.has('a') || keys.has('arrowleft') ? -speed : 0);
    const omega = (keys.has('e') ? speed : 0) + (keys.has('q') ? -speed : 0);
    const motion = { vx, vy, omega };
    teleopRef.current = motion;
    sendTeleop(vx, vy, omega);
  }, [controlMode, sendTeleop]);

  useEffect(() => {
    const controlledKeys = new Set(['w', 'a', 's', 'd', 'q', 'e', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (!controlledKeys.has(key) || controlMode !== 'MANUAL') return;
      event.preventDefault();
      keysPressed.current.add(key);
      sendKeyboardMotion();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (!controlledKeys.has(key)) return;
      event.preventDefault();
      keysPressed.current.delete(key);
      sendKeyboardMotion();
    };
    const stopOnBlur = () => {
      keysPressed.current.clear();
      teleopRef.current = null;
      sendTeleop(0, 0, 0);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', stopOnBlur);
    teleopSendTimerRef.current = setInterval(() => {
      if (controlMode === 'MANUAL' && teleopRef.current) sendKeyboardMotion();
    }, 50);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', stopOnBlur);
      if (teleopSendTimerRef.current) clearInterval(teleopSendTimerRef.current);
      teleopSendTimerRef.current = null;
      keysPressed.current.clear();
    };
  }, [controlMode, sendKeyboardMotion, sendTeleop]);

  const handleModeSwitch = useCallback((mode: 'AUTO' | 'MANUAL') => {
    keysPressed.current.clear();
    teleopRef.current = null;
    sendEsp32({ cmd: 'stop' });
    sendControlMode(mode);
  }, [sendControlMode, sendEsp32]);

  const isOnline = wsStatus === 'connected';
  const isMapping = info.mode === 'mapping_idle' || info.mode === 'mapping_active' || info.mode === 'mapping';

  const modeColor = isMapping || info.mode === 'scan_obstacle' ? 'var(--warning)' : 'var(--success)';
  const modeBg = isMapping || info.mode === 'scan_obstacle' ? 'rgba(255,184,0,0.15)' : 'rgba(0,255,136,0.1)';

  return (
    <div
      className="flex flex-col min-h-dvh select-none overflow-hidden"
      style={{ background: 'var(--bg-void)', fontFamily: "'JetBrains Mono', system-ui" }}
    >
      {/* ─── Header ─────────────────────────────────────────────────── */}
      <div
        className="px-4 md:px-8 py-4 flex flex-wrap items-center justify-between gap-3 md:gap-4 relative z-10"
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
                />
              )}
            </div>
          )}
        </div>

        {/* Right: Status + Controls — hidden on phones (status is shown in top bar) */}
        <div className="hidden md:flex items-center gap-3 flex-wrap">
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

            <Tooltip title="Chuyển về trạng thái IDLE (hủy mapping hiện tại)">
              <Button
                size="large"
                icon={<Power size={15} />}
                loading={isIdling}
                onClick={handleIdle}
                disabled={info.mode === 'idle'}
                style={{
                  borderRadius: '10px',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontWeight: 600,
                  fontSize: '12px',
                  background: 'rgba(156,163,175,0.1)',
                  border: '1px solid rgba(156,163,175,0.3)',
                  color: 'var(--text-secondary)',
                  display: 'flex', alignItems: 'center', gap: '6px',
                }}
              >
                IDLE
              </Button>
            </Tooltip>
          </div>
        </div>
      </div>

      {/* ─── Robot Control Panel ─────────────────────────────────────────── */}
      <div
        className="px-4 md:px-8 py-3 flex flex-wrap items-start justify-between gap-3 relative z-10"
        style={{
          background: 'rgba(8,11,16,0.95)',
          borderTop: '1px solid var(--border-dim)',
          boxShadow: 'inset 0 1px 0 rgba(0,212,255,0.08)',
        }}
      >
        {/* Left: Manual controls */}
        <div className="flex flex-col gap-2 min-w-[300px]">
          <span style={{ color: 'var(--text-muted)', fontSize: 10, fontWeight: 800, fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.08em' }}>ĐIỀU KHIỂN THỦ CÔNG</span>
          <div className="flex items-center gap-3">
            {/* Mode toggle */}
            <div className="flex items-center gap-1 p-1 rounded-xl" style={{ border: '1px solid var(--border-mid)' }}>
              <button
                onClick={() => handleModeSwitch('MANUAL')}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-bold text-[11px] cursor-pointer transition-all"
                style={
                  controlMode === 'MANUAL'
                    ? { background: 'rgba(0,212,255,0.18)', color: 'var(--accent)', border: '1px solid rgba(0,212,255,0.4)', boxShadow: '0 0 12px rgba(0,212,255,0.15)' }
                    : { background: 'transparent', color: 'var(--text-muted)', border: '1px solid transparent' }
                }
              >
                <Keyboard size={13} />
                MANUAL
              </button>
              <button
                onClick={() => handleModeSwitch('AUTO')}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-bold text-[11px] cursor-pointer transition-all"
                style={
                  controlMode === 'AUTO'
                    ? { background: 'rgba(0,255,136,0.18)', color: 'var(--success)', border: '1px solid rgba(0,255,136,0.4)', boxShadow: '0 0 12px rgba(0,255,136,0.15)' }
                    : { background: 'transparent', color: 'var(--text-muted)', border: '1px solid transparent' }
                }
              >
                <Rocket size={13} />
                AUTO
              </button>
            </div>

            {/* D-pad (manual only) */}
            {controlMode === 'MANUAL' && (
              <div className="grid grid-cols-3 gap-1 p-1.5 rounded-xl" style={{ border: '1px solid var(--border-mid)' }}>
                <div />
                <button
                  className="w-8 h-8 rounded-lg flex items-center justify-center cursor-pointer transition-all active:scale-90"
                  style={{ background: 'rgba(0,212,255,0.12)', border: '1px solid rgba(0,212,255,0.3)', color: 'var(--accent)' }}
                  onMouseDown={() => { keysPressed.current.add('w'); sendKeyboardMotion(); }}
                  onMouseUp={() => { keysPressed.current.delete('w'); sendKeyboardMotion(); }}
                  onMouseLeave={() => { keysPressed.current.delete('w'); sendKeyboardMotion(); }}
                >
                  <ChevronUp size={16} />
                </button>
                <div />
                <button
                  className="w-8 h-8 rounded-lg flex items-center justify-center cursor-pointer transition-all active:scale-90"
                  style={{ background: 'rgba(0,212,255,0.12)', border: '1px solid rgba(0,212,255,0.3)', color: 'var(--accent)' }}
                  onMouseDown={() => { keysPressed.current.add('a'); sendKeyboardMotion(); }}
                  onMouseUp={() => { keysPressed.current.delete('a'); sendKeyboardMotion(); }}
                  onMouseLeave={() => { keysPressed.current.delete('a'); sendKeyboardMotion(); }}
                >
                  <ChevronLeft size={16} />
                </button>
                <button
                  className="w-8 h-8 rounded-lg flex items-center justify-center cursor-pointer transition-all active:scale-90"
                  style={{ background: 'rgba(255,59,92,0.15)', border: '1px solid rgba(255,59,92,0.4)', color: 'var(--danger)' }}
                  onMouseDown={() => { sendEsp32({ cmd: 'stop' }); }}
                >
                  ■
                </button>
                <button
                  className="w-8 h-8 rounded-lg flex items-center justify-center cursor-pointer transition-all active:scale-90"
                  style={{ background: 'rgba(0,212,255,0.12)', border: '1px solid rgba(0,212,255,0.3)', color: 'var(--accent)' }}
                  onMouseDown={() => { keysPressed.current.add('d'); sendKeyboardMotion(); }}
                  onMouseUp={() => { keysPressed.current.delete('d'); sendKeyboardMotion(); }}
                  onMouseLeave={() => { keysPressed.current.delete('d'); sendKeyboardMotion(); }}
                >
                  <ChevronRight size={16} />
                </button>
                <div />
                <button
                  className="w-8 h-8 rounded-lg flex items-center justify-center cursor-pointer transition-all active:scale-90"
                  style={{ background: 'rgba(0,212,255,0.12)', border: '1px solid rgba(0,212,255,0.3)', color: 'var(--accent)' }}
                  onMouseDown={() => { keysPressed.current.add('s'); sendKeyboardMotion(); }}
                  onMouseUp={() => { keysPressed.current.delete('s'); sendKeyboardMotion(); }}
                  onMouseLeave={() => { keysPressed.current.delete('s'); sendKeyboardMotion(); }}
                >
                  <ChevronDown size={16} />
                </button>
                <div />
              </div>
            )}

            {/* Cylinder controls */}
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => sendCylinder('extend')}
                className="px-3 py-1.5 rounded-lg font-bold text-[11px] cursor-pointer transition-all"
                style={{ background: 'rgba(255,184,0,0.12)', border: '1px solid rgba(255,184,0,0.3)', color: 'var(--warning)' }}
              >
                ▲ NÂNG
              </button>
              <button
                onClick={() => sendCylinder('stop')}
                className="px-3 py-1.5 rounded-lg font-bold text-[11px] cursor-pointer transition-all"
                style={{ background: 'rgba(156,163,175,0.12)', border: '1px solid rgba(156,163,175,0.3)', color: 'var(--text-secondary)' }}
              >
                ■
              </button>
              <button
                onClick={() => sendCylinder('retract')}
                className="px-3 py-1.5 rounded-lg font-bold text-[11px] cursor-pointer transition-all"
                style={{ background: 'rgba(0,212,255,0.12)', border: '1px solid rgba(0,212,255,0.3)', color: 'var(--accent)' }}
              >
                ▼ HẠ
              </button>
            </div>
          </div>
        </div>

        {/* Center: Autonomous controls */}
        <div className="flex flex-col gap-2">
          <span style={{ color: 'var(--text-muted)', fontSize: 10, fontWeight: 800, fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.08em' }}>TỰ ĐỘNG / KHU VỰC</span>
          <div className="flex items-center gap-2">
          {['A', 'B', 'C', 'D'].map(zone => (
            <button
              key={zone}
              onClick={() => sendDemo(zone)}
              disabled={controlMode !== 'AUTO'}
              className="px-4 py-2 rounded-lg font-bold text-[12px] cursor-pointer transition-all"
              style={{
                background: controlMode === 'AUTO' ? 'rgba(0,255,136,0.12)' : 'rgba(156,163,175,0.06)',
                border: `1px solid ${controlMode === 'AUTO' ? 'rgba(0,255,136,0.35)' : 'rgba(156,163,175,0.15)'}`,
                color: controlMode === 'AUTO' ? 'var(--success)' : 'var(--text-muted)',
                opacity: controlMode === 'AUTO' ? 1 : 0.4,
              }}
            >
              {zone}
            </button>
          ))}
          <button
            onClick={() => sendDemo('full')}
            disabled={controlMode !== 'AUTO'}
            className="px-4 py-2 rounded-lg font-bold text-[12px] cursor-pointer transition-all"
            style={{
              background: controlMode === 'AUTO' ? 'rgba(0,212,255,0.12)' : 'rgba(156,163,175,0.06)',
              border: `1px solid ${controlMode === 'AUTO' ? 'rgba(0,212,255,0.35)' : 'rgba(156,163,175,0.15)'}`,
              color: controlMode === 'AUTO' ? 'var(--accent)' : 'var(--text-muted)',
              opacity: controlMode === 'AUTO' ? 1 : 0.4,
            }}
          >
            FULL
          </button>
          <button
            onClick={() => sendDemo('stop')}
            className="px-4 py-2 rounded-lg font-bold text-[12px] cursor-pointer transition-all"
            style={{ background: 'rgba(255,59,92,0.12)', border: '1px solid rgba(255,59,92,0.35)', color: 'var(--danger)' }}
          >
            STOP
          </button>

          {/* E-STOP (priority) */}
          <button
            onClick={handleEStop}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg font-bold text-[12px] cursor-pointer transition-all"
            style={{
              background: 'linear-gradient(135deg, rgba(255,59,92,0.2), rgba(220,30,60,0.15))',
              border: '2px solid var(--danger)',
              color: 'var(--danger)',
              boxShadow: '0 0 20px rgba(255,59,92,0.3), inset 0 1px 0 rgba(255,255,255,0.05)',
              letterSpacing: '0.08em',
            }}
          >
            🛑 E-STOP
          </button>
          </div>
        </div>

        {/* Right: ESP32 status panel */}
        <div className="flex items-center gap-3">
          {esp32Status && (
            <div
              className="flex flex-col gap-1 px-3 py-2 rounded-xl"
              style={{ background: 'rgba(17,24,39,0.8)', border: '1px solid var(--border-dim)' }}
            >
              <div className="flex items-center gap-2">
                <Cpu size={11} style={{ color: esp32Status.estop ? 'var(--danger)' : 'var(--success)' }} />
                <span className="text-[9px] font-bold" style={{ color: esp32Status.estop ? 'var(--danger)' : 'var(--success)', letterSpacing: '0.08em' }}>
                  {esp32Status.estop ? 'E-STOP' : esp32Status.mode?.toUpperCase() || 'IDLE'}
                </span>
              </div>
              {esp32Status.st && (
                <div className="flex items-center gap-2 text-[8px]" style={{ color: 'var(--text-muted)' }}>
                  <span>TOF:{esp32Status.st.tof_mm ?? '?'}mm</span>
                  <span>CYL:{esp32Status.st.cyl ?? '?'}</span>
                  <span>OBS:{esp32Status.st.obs ? '●' : '○'}</span>
                </div>
              )}
            </div>
          )}

          {demoStatus.state && demoStatus.state !== 'idle' && (
            <div
              className="flex items-center gap-2 px-3 py-2 rounded-xl"
              style={{
                background: 'rgba(0,255,136,0.06)',
                border: '1px solid rgba(0,255,136,0.2)',
              }}
            >
              <span className="text-[9px] font-bold" style={{ color: 'var(--success)', letterSpacing: '0.08em' }}>
                DEMO: {demoStatus.state?.toUpperCase()} {demoStatus.action ? `→ ${demoStatus.action}` : ''}
              </span>
              {demoStatus.message && (
                <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>{demoStatus.message}</span>
              )}
            </div>
          )}

          {controlModeStatus.source && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-xl" style={{ background: 'rgba(17,24,39,0.8)', border: '1px solid var(--border-dim)' }}>
              <span className="text-[9px] font-bold" style={{ color: controlMode === 'AUTO' ? 'var(--success)' : 'var(--accent)', letterSpacing: '0.08em' }}>
                {controlMode} {controlModeStatus.reason ? `(${controlModeStatus.reason})` : ''}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* ─── Robot error banner ──────────────────────────────────────────────── */}
      {robotErrors.length > 0 && (() => {
        const top = robotErrors[0];
        const sev = top.severity.toLowerCase();
        const cfgBySev: Record<string, { bg: string; border: string; icon: string; label: string }> = {
          critical: { bg: 'rgba(220,30,60,0.18)', border: 'rgba(255,59,92,0.7)', icon: '⛔', label: 'LỖI NGHIÊM TRỌNG' },
          error:    { bg: 'rgba(255,59,92,0.10)',  border: 'rgba(255,59,92,0.45)', icon: '❌', label: 'LỖI ROBOT' },
          warning:  { bg: 'rgba(255,184,0,0.12)',  border: 'rgba(255,184,0,0.5)',  icon: '⚠️', label: 'CẢNH BÁO' },
        };
        const cfg = cfgBySev[sev] ?? cfgBySev.error;
        const hidden = robotErrors.length - 1;
        return (
          <div
            data-testid="robot-error-banner"
            className="px-4 md:px-8 py-2 flex flex-wrap items-center justify-between gap-2 relative z-10"
            style={{
              background: cfg.bg,
              borderTop: `1px solid ${cfg.border}`,
              borderBottom: `1px solid ${cfg.border}`,
              boxShadow: sev === 'critical' ? '0 0 24px rgba(255,59,92,0.35), inset 0 0 12px rgba(255,59,92,0.1)' : 'inset 0 0 8px rgba(0,0,0,0.2)',
              animation: sev === 'critical' ? 'pulse-glow 1.4s ease-in-out infinite' : undefined,
            }}
          >
            <div className="flex items-center gap-3 min-w-0">
              <span className="text-base leading-none">{cfg.icon}</span>
              <div className="flex flex-col min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-bold tracking-widest" style={{ color: cfg.border, fontFamily: "'JetBrains Mono', monospace" }}>
                    {cfg.label}
                  </span>
                  <span className="text-[10px] font-mono" style={{ color: 'var(--text-secondary)' }}>
                    {top.code}
                  </span>
                  {hidden > 0 && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded-md" style={{ background: cfg.border, color: '#060910', fontWeight: 700, letterSpacing: '0.06em' }}>
                      +{hidden}
                    </span>
                  )}
                </div>
                <span className="text-[11px] truncate" style={{ color: 'var(--text-primary)' }}>
                  {top.message}
                </span>
              </div>
            </div>
            <button
              onClick={() => setRobotErrors([])}
              className="px-2 py-1 rounded-md text-[10px] font-bold cursor-pointer transition-all"
              style={{
                background: 'rgba(8,11,16,0.6)',
                border: `1px solid ${cfg.border}`,
                color: cfg.border,
                fontFamily: "'JetBrains Mono', monospace",
                letterSpacing: '0.08em',
              }}
            >
              ✕ XÓA
            </button>
          </div>
        );
      })()}

      {/* ─── Canvas viewer ───────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 p-2 md:p-5">
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

          <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" style={{ imageRendering: 'pixelated', zIndex: 1 }} />
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
function StatChip({ label, value, color }: { label: string; value: string; color: string }) {
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
