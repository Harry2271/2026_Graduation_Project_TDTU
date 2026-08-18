'use client';

import { useEffect, useRef, useState } from 'react';

interface Sample { time: number; raw: number; filtered: number; }

const samples: Sample[] = Array.from({ length: 31 }, (_, index) => {
  const time = index * 20;
  const raw = time < 60 ? 0 : 300;
  const previous = index === 0 ? 0 : 0;
  return { time, raw, filtered: previous };
}).reduce<Sample[]>((all, current) => {
  const prior = all.at(-1)?.filtered ?? 0;
  all.push({ ...current, filtered: prior * 0.7 + current.raw * 0.3 });
  return all;
}, []);

export default function EmaResponseChart() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 0, height: 330 });
  const [hovered, setHovered] = useState<Sample | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: Math.floor(entry.contentRect.width), height: 330 }));
    observer.observe(canvas.parentElement ?? canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.width * dpr;
    canvas.height = size.height * dpr;
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.scale(dpr, dpr);
    const pad = { top: 32, right: 28, bottom: 40, left: 54 };
    const plotWidth = size.width - pad.left - pad.right;
    const plotHeight = size.height - pad.top - pad.bottom;
    const x = (time: number) => pad.left + (time / 600) * plotWidth;
    const y = (rpm: number) => pad.top + plotHeight - (rpm / 350) * plotHeight;
    context.fillStyle = '#0c0f14'; context.fillRect(0, 0, size.width, size.height);
    context.font = '10px monospace'; context.lineWidth = 1;
    for (let rpm = 0; rpm <= 350; rpm += 50) {
      context.strokeStyle = 'rgba(255,255,255,0.08)'; context.beginPath(); context.moveTo(pad.left, y(rpm)); context.lineTo(size.width - pad.right, y(rpm)); context.stroke();
      context.fillStyle = '#8b97a8'; context.textAlign = 'right'; context.fillText(String(rpm), pad.left - 8, y(rpm) + 3);
    }
    for (let time = 0; time <= 600; time += 100) {
      context.strokeStyle = 'rgba(255,255,255,0.05)'; context.beginPath(); context.moveTo(x(time), pad.top); context.lineTo(x(time), pad.top + plotHeight); context.stroke();
      context.fillStyle = '#8b97a8'; context.textAlign = 'center'; context.fillText(`${time}ms`, x(time), size.height - 14);
    }
    context.strokeStyle = '#b5c0cd'; context.beginPath(); context.moveTo(pad.left, pad.top); context.lineTo(pad.left, pad.top + plotHeight); context.lineTo(size.width - pad.right, pad.top + plotHeight); context.stroke();
    context.strokeStyle = '#ffb800'; context.setLineDash([6, 4]); context.beginPath(); context.moveTo(x(60), y(300)); context.lineTo(x(600), y(300)); context.stroke(); context.setLineDash([]);
    context.strokeStyle = '#ffb800'; context.setLineDash([4, 3]); context.beginPath(); samples.forEach((sample, index) => index === 0 ? context.moveTo(x(sample.time), y(sample.raw)) : context.lineTo(x(sample.time), y(sample.raw))); context.stroke(); context.setLineDash([]);
    context.strokeStyle = '#00d4ff'; context.lineWidth = 2.5; context.beginPath(); samples.forEach((sample, index) => index === 0 ? context.moveTo(x(sample.time), y(sample.filtered)) : context.lineTo(x(sample.time), y(sample.filtered))); context.stroke();
    context.strokeStyle = '#00ff88'; context.setLineDash([3, 3]); context.beginPath(); context.moveTo(x(180), pad.top); context.lineTo(x(180), pad.top + plotHeight); context.stroke(); context.setLineDash([]);
    context.fillStyle = '#00ff88'; context.textAlign = 'center'; context.fillText('95% ≈ 180ms', x(180), pad.top - 8);
    if (hovered) { context.fillStyle = '#e8ecf0'; context.beginPath(); context.arc(x(hovered.time), y(hovered.filtered), 4, 0, Math.PI * 2); context.fill(); }
  }, [hovered, size]);

  function onPointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const time = Math.max(0, Math.min(600, ((event.clientX - rect.left - 54) / Math.max(rect.width - 82, 1)) * 600));
    setHovered(samples[Math.round(time / 20)] ?? null);
  }

  return (
    <div>
      <div className="relative rounded-lg border" style={{ borderColor: 'var(--border-dim)' }}>
        <canvas ref={canvasRef} onPointerMove={onPointerMove} onPointerLeave={() => setHovered(null)} aria-label="Biểu đồ phản hồi bộ lọc EMA alpha bằng 0.3" className="block w-full cursor-crosshair rounded-lg" />
        {hovered && <div className="pointer-events-none absolute top-3 right-3 rounded-md border px-3 py-2 font-mono text-[11px]" style={{ background: 'rgba(8,11,16,0.95)', borderColor: 'var(--border-mid)', color: 'var(--text-primary)' }}><div>{hovered.time} ms</div><div style={{ color: '#ffb800' }}>Raw: {hovered.raw.toFixed(1)} RPM</div><div style={{ color: '#00d4ff' }}>EMA: {hovered.filtered.toFixed(1)} RPM</div></div>}
      </div>
      <div className="mt-3 flex flex-wrap gap-4 text-xs" style={{ color: 'var(--text-secondary)' }}><span><i className="mr-2 inline-block h-0.5 w-5 align-middle" style={{ background: '#ffb800' }} />RPM thực tế / target</span><span><i className="mr-2 inline-block h-0.5 w-5 align-middle" style={{ background: '#00d4ff' }} />RPM sau EMA α=0.3</span></div>
      <table className="mt-4 w-full text-left text-xs"><caption className="sr-only">Mẫu dữ liệu phản hồi EMA</caption><thead style={{ color: 'var(--text-muted)' }}><tr><th className="py-2">Thời gian</th><th>RPM raw</th><th>EMA output</th></tr></thead><tbody>{[0, 60, 120, 180, 240].map((time) => { const sample = samples[time / 20]; return <tr key={time} className="border-t" style={{ borderColor: 'var(--border-dim)', color: 'var(--text-secondary)' }}><td className="py-2">{time} ms</td><td>{sample.raw.toFixed(1)}</td><td>{sample.filtered.toFixed(1)}</td></tr>; })}</tbody></table>
    </div>
  );
}
