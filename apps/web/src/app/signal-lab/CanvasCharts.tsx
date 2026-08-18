'use client';

import { useEffect, useRef, useState } from 'react';
import type { LidarPoint, LidarZones, PidSeries } from './simulation';

const colors = { accent: '#00d4ff', target: '#00d4ff', actual: '#8b97a8', error: '#ffb800', pwm: '#00ff88', success: '#00ff88', danger: '#ff3b5c', primary: '#e8ecf0', surface: '#080b10', grid: 'rgba(255,255,255,0.08)', ink: '#8b97a8' };

function useCanvasSize(height: number) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 0, height });
  useEffect(() => {
    const element = ref.current?.parentElement;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: Math.floor(entry.contentRect.width), height }));
    observer.observe(element);
    return () => observer.disconnect();
  }, [height]);
  return { ref, size };
}

function setupCanvas(canvas: HTMLCanvasElement, width: number, height: number) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr; canvas.height = height * dpr; canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
  const context = canvas.getContext('2d');
  context?.scale(dpr, dpr);
  return context;
}

function drawSeries(context: CanvasRenderingContext2D, values: number[], color: string, width: number, x: (index: number) => number, y: (value: number) => number, dash: number[] = []) {
  context.strokeStyle = color; context.lineWidth = width; context.setLineDash(dash); context.beginPath();
  values.forEach((value, index) => index === 0 ? context.moveTo(x(index), y(value)) : context.lineTo(x(index), y(value)));
  context.stroke(); context.setLineDash([]);
}

export function PidLineChart({ series, compare }: { series: PidSeries; compare?: PidSeries[] }) {
  const { ref, size } = useCanvasSize(300);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const canvas = ref.current; if (!canvas || !size.width) return;
    const context = setupCanvas(canvas, size.width, size.height); if (!context) return;
    const pad = { top: 30, right: 18, bottom: 38, left: 52 }; const width = size.width - pad.left - pad.right; const height = size.height - pad.top - pad.bottom;
    const x = (index: number) => pad.left + index / (series.time.length - 1) * width; const y = (value: number) => pad.top + height - Math.max(0, Math.min(350, value)) / 350 * height;
    context.fillStyle = colors.surface; context.fillRect(0, 0, size.width, size.height); context.font = '10px monospace';
    for (let value = 0; value <= 350; value += 50) { context.strokeStyle = colors.grid; context.beginPath(); context.moveTo(pad.left, y(value)); context.lineTo(size.width - pad.right, y(value)); context.stroke(); context.fillStyle = colors.ink; context.textAlign = 'right'; context.fillText(String(value), pad.left - 8, y(value) + 3); }
    for (let index = 0; index <= 5; index += 1) { const point = Math.round(index / 5 * (series.time.length - 1)); context.strokeStyle = colors.grid; context.beginPath(); context.moveTo(x(point), pad.top); context.lineTo(x(point), pad.top + height); context.stroke(); context.fillStyle = colors.ink; context.textAlign = 'center'; context.fillText(`${series.time[point].toFixed(1)}s`, x(point), size.height - 14); }
    if (compare) { compare.forEach((trace, index) => drawSeries(context, trace.actual, [colors.target, colors.error, colors.actual][index], index === 0 ? 2.5 : 1.8, x, y, index === 0 ? [] : [6, 3])); drawSeries(context, series.target, colors.ink, 1.5, x, y, [8, 4]); }
    else { drawSeries(context, series.target, colors.target, 2, x, y, [8, 4]); drawSeries(context, series.actual, colors.actual, 2.5, x, y); drawSeries(context, series.error, colors.error, 1.5, x, y, [4, 3]); }
    if (hover !== null) { context.strokeStyle = colors.primary; context.setLineDash([3, 3]); context.beginPath(); context.moveTo(x(hover), pad.top); context.lineTo(x(hover), pad.top + height); context.stroke(); context.setLineDash([]); }
  }, [ref, series, compare, size, hover]);
  return <div className="relative"><canvas ref={ref} onPointerMove={(event) => { const rect = event.currentTarget.getBoundingClientRect(); const index = Math.round(((event.clientX - rect.left - 52) / Math.max(rect.width - 70, 1)) * (series.time.length - 1)); setHover(Math.max(0, Math.min(series.time.length - 1, index))); }} onPointerLeave={() => setHover(null)} aria-label="Biểu đồ RPM target và actual của PID" className="block w-full cursor-crosshair" />{hover !== null && <div className="pointer-events-none absolute right-3 top-3 rounded border px-3 py-2 font-mono text-[10px]" style={{ background: 'rgba(8,11,16,.95)', borderColor: 'var(--border-mid)', color: 'var(--text-primary)' }}>t={series.time[hover].toFixed(2)}s · target={series.target[hover].toFixed(1)} · actual={series.actual[hover].toFixed(1)}</div>}</div>;
}

export function PwmChart({ series }: { series: PidSeries }) {
  const { ref, size } = useCanvasSize(210);
  useEffect(() => {
    const canvas = ref.current; if (!canvas || !size.width) return; const context = setupCanvas(canvas, size.width, size.height); if (!context) return;
    const pad = { top: 28, right: 18, bottom: 35, left: 52 }; const width = size.width - pad.left - pad.right; const height = size.height - pad.top - pad.bottom; const x = (index: number) => pad.left + index / (series.time.length - 1) * width; const y = (value: number) => pad.top + height - value / 550 * height;
    context.fillStyle = colors.surface; context.fillRect(0, 0, size.width, size.height); context.font = '10px monospace';
    for (let value = 0; value <= 550; value += 110) { context.strokeStyle = colors.grid; context.beginPath(); context.moveTo(pad.left, y(value)); context.lineTo(size.width - pad.right, y(value)); context.stroke(); context.fillStyle = colors.ink; context.textAlign = 'right'; context.fillText(String(value), pad.left - 8, y(value) + 3); }
    drawSeries(context, series.pwm, colors.pwm, 2, x, y);
    context.strokeStyle = colors.ink; context.setLineDash([6, 3]); context.beginPath(); context.moveTo(pad.left, y(511)); context.lineTo(size.width - pad.right, y(511)); context.stroke(); context.setLineDash([]);
    context.fillStyle = colors.ink; context.textAlign = 'center'; context.fillText('0–511 PWM duty · max 511', size.width / 2, size.height - 12);
  }, [ref, series, size]);
  return <canvas ref={ref} aria-label="Biểu đồ PWM duty output" className="block w-full" />;
}

export function PolarScanChart({ points, sweep }: { points: LidarPoint[]; sweep: number }) {
  const { ref, size } = useCanvasSize(390);
  useEffect(() => {
    const canvas = ref.current; if (!canvas || !size.width) return; const context = setupCanvas(canvas, size.width, size.height); if (!context) return; const side = Math.min(size.width, size.height); const cx = size.width / 2; const cy = size.height / 2; const radius = side * .38; const map = (distance: number) => radius * Math.min(distance, 5) / 5;
    context.fillStyle = colors.surface; context.fillRect(0, 0, size.width, size.height); context.strokeStyle = colors.grid; context.lineWidth = 1;
    for (let meter = 1; meter <= 5; meter += 1) { context.beginPath(); context.arc(cx, cy, map(meter), 0, Math.PI * 2); context.stroke(); context.fillStyle = colors.ink; context.font = '9px monospace'; context.fillText(`${meter}m`, cx + 5, cy - map(meter) + 12); }
    for (let degree = 0; degree < 360; degree += 45) { const radians = degree * Math.PI / 180; context.beginPath(); context.moveTo(cx, cy); context.lineTo(cx + Math.cos(radians) * radius, cy - Math.sin(radians) * radius); context.stroke(); }
    context.setLineDash([6, 4]); context.strokeStyle = colors.error; context.beginPath(); context.arc(cx, cy, map(1.5), 0, Math.PI * 2); context.stroke(); context.setLineDash([]);
    points.forEach((point) => { const radians = point.degree * Math.PI / 180; const distance = map(point.distance); context.fillStyle = point.distance < 1.5 ? colors.danger : colors.accent; context.beginPath(); context.arc(cx + Math.cos(radians) * distance, cy - Math.sin(radians) * distance, point.distance < 1.5 ? 3 : 2, 0, Math.PI * 2); context.fill(); });
    const radians = sweep * Math.PI / 180; context.strokeStyle = colors.target; context.beginPath(); context.moveTo(cx, cy); context.lineTo(cx + Math.cos(radians) * radius, cy - Math.sin(radians) * radius); context.stroke(); context.fillStyle = colors.primary; context.font = 'bold 11px system-ui'; context.textAlign = 'center'; context.fillText('FRONT', cx, cy - radius - 8); context.fillText('REAR', cx, cy + radius + 16);
  }, [points, size, sweep]);
  return <canvas ref={ref} aria-label="LiDAR polar scan 360 độ" className="block w-full" />;
}

export function ZoneBarChart({ zones }: { zones: LidarZones }) {
  const { ref, size } = useCanvasSize(230);
  useEffect(() => { const canvas = ref.current; if (!canvas || !size.width) return; const context = setupCanvas(canvas, size.width, size.height); if (!context) return; const values = [['Front', zones.front, colors.accent], ['Left', zones.left, colors.success], ['Right', zones.right, '#8b97a8'], ['Rear', zones.rear, colors.error]] as const; const left = 74; const top = 30; const width = size.width - left - 24; context.fillStyle = colors.surface; context.fillRect(0, 0, size.width, size.height); context.font = '11px monospace'; values.forEach(([label, value, color], index) => { const y = top + index * 42; context.fillStyle = colors.ink; context.textAlign = 'right'; context.fillText(label, left - 10, y + 17); context.fillStyle = 'rgba(255,255,255,.08)'; context.fillRect(left, y, width, 25); context.fillStyle = value < 1.5 ? colors.danger : color; context.fillRect(left, y, Math.min(value / 5, 1) * width, 25); context.fillStyle = colors.primary; context.textAlign = 'left'; context.fillText(`${value.toFixed(2)}m`, left + Math.min(value / 5, 1) * width + 8, y + 17); }); context.strokeStyle = colors.error; context.setLineDash([5, 3]); const threshold = left + 1.5 / 5 * width; context.beginPath(); context.moveTo(threshold, top); context.lineTo(threshold, top + 150); context.stroke(); context.setLineDash([]); context.fillStyle = colors.error; context.textAlign = 'center'; context.fillText('1.5m', threshold, 20); }, [size, zones]);
  return <canvas ref={ref} aria-label="Khoảng cách tối thiểu theo bốn zone LiDAR" className="block w-full" />;
}
