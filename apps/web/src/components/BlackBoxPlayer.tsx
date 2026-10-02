'use client';

import { useState, useRef, useEffect } from 'react';
import { Play, Pause, Upload, SkipBack, SkipForward } from 'lucide-react';

// ── Type definitions ───────────────────────────────────────────────────────

interface BlackBoxSample {
  ts: number; // timestamp ms
  nav: [number, number, number]; // [vx, vy, ω]
  mt: [number, number, number, number]; // motor targets (PWM)
  mr: [number, number, number, number]; // motor RPMs
  imu: [number, number, number]; // [heading, ax, ay]
  sl: number; // safety level (0-3)
  ir: [boolean, boolean, boolean, boolean]; // [L, F, R, B]
  tof: number; // front ToF distance mm
}

interface BlackBoxData {
  type: 147;
  trigger?: number; // trigger frame index
  samples: BlackBoxSample[];
}

// ── Constants ──────────────────────────────────────────────────────────────

const SAFETY_COLORS = ['#00ff88', '#ffb800', '#ff8c00', '#ff3b5c'];
const SAFETY_LABELS = ['SAFE', 'CAUTION', 'WARNING', 'CRITICAL'];
const MOTOR_NAMES = ['FL', 'FR', 'RL', 'RR'];
const IR_LABELS = ['L', 'F', 'R', 'B'];

// ── Main Component ─────────────────────────────────────────────────────────

export function BlackBoxPlayer() {
  const [data, setData] = useState<BlackBoxData | null>(null);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const playIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // ── File upload handler ──────────────────────────────────────────────────

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const json = JSON.parse(ev.target?.result as string);
        if (json.type === 147 && Array.isArray(json.samples)) {
          setData(json);
          setCurrentFrame(0);
          setPlaying(false);
        } else {
          alert('Invalid type 147 JSON format');
        }
      } catch (err) {
        alert('Failed to parse JSON: ' + (err as Error).message);
      }
    };
    reader.readAsText(file);
  };

  const handlePasteJSON = () => {
    const input = prompt('Paste type 147 JSON:');
    if (!input) return;
    try {
      const json = JSON.parse(input);
      if (json.type === 147 && Array.isArray(json.samples)) {
        setData(json);
        setCurrentFrame(0);
        setPlaying(false);
      } else {
        alert('Invalid type 147 JSON format');
      }
    } catch (err) {
      alert('Failed to parse JSON: ' + (err as Error).message);
    }
  };

  // ── Playback controls ────────────────────────────────────────────────────

  useEffect(() => {
    if (playing && data) {
      const interval = 100 / speed; // base 100ms per frame
      playIntervalRef.current = setInterval(() => {
        setCurrentFrame((prev) => {
          if (prev >= data.samples.length - 1) {
            setPlaying(false);
            return prev;
          }
          return prev + 1;
        });
      }, interval);
    } else {
      if (playIntervalRef.current) {
        clearInterval(playIntervalRef.current);
        playIntervalRef.current = null;
      }
    }
    return () => {
      if (playIntervalRef.current) clearInterval(playIntervalRef.current);
    };
  }, [playing, speed, data]);

  const togglePlay = () => setPlaying((p) => !p);
  const stepForward = () => setCurrentFrame((p) => Math.min((data?.samples.length ?? 1) - 1, p + 1));
  const stepBack = () => setCurrentFrame((p) => Math.max(0, p - 1));
  const jumpToTrigger = () => {
    if (data?.trigger !== undefined) {
      setCurrentFrame(Math.min(data.trigger, data.samples.length - 1));
    }
  };

  // ── Current sample ───────────────────────────────────────────────────────

  const sample = data?.samples[currentFrame];
  const isTriggerFrame = data?.trigger === currentFrame;
  const safetyColor = SAFETY_COLORS[sample?.sl ?? 0];

  // ── Render ───────────────────────────────────────────────────────────────

  if (!data) {
    return (
      <div
        className="flex flex-col items-center justify-center h-full gap-4 p-8"
        style={{ background: 'var(--bg-void)', color: 'var(--text-primary)' }}
      >
        <div className="text-center">
          <h2 className="text-xl font-bold mb-2" style={{ color: 'var(--accent)' }}>
            Black Box Player
          </h2>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            Upload or paste type 147 telemetry JSON
          </p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={() => fileInputRef.current?.click()}
            className="px-4 py-2 rounded-lg flex items-center gap-2"
            style={{
              background: 'var(--accent)',
              color: 'var(--bg-void)',
              border: '1px solid var(--accent)',
            }}
          >
            <Upload size={16} />
            Upload File
          </button>
          <button
            onClick={handlePasteJSON}
            className="px-4 py-2 rounded-lg"
            style={{
              background: 'rgba(0,212,255,0.1)',
              color: 'var(--accent)',
              border: '1px solid var(--accent)',
            }}
          >
            Paste JSON
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          onChange={handleFileUpload}
          className="hidden"
        />
      </div>
    );
  }

  return (
    <div
      className="flex flex-col h-full"
      style={{
        background: safetyColor ? `linear-gradient(180deg, ${safetyColor}15, var(--bg-void))` : 'var(--bg-void)',
        transition: 'background 0.3s',
      }}
    >
      {/* Header */}
      <div
        className="px-4 py-3 border-b flex items-center justify-between"
        style={{ borderColor: 'var(--border-dim)', background: 'rgba(0,0,0,0.3)' }}
      >
        <div>
          <h2 className="text-lg font-bold" style={{ color: 'var(--accent)' }}>
            Black Box Player
          </h2>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {data.samples.length} samples • {((data.samples[data.samples.length - 1]?.ts ?? 0) / 1000).toFixed(1)}s
          </p>
        </div>
        <button
          onClick={() => {
            setData(null);
            setCurrentFrame(0);
            setPlaying(false);
          }}
          className="text-xs px-3 py-1 rounded"
          style={{ background: 'rgba(255,59,92,0.2)', color: 'var(--danger)' }}
        >
          Close
        </button>
      </div>

      {/* Timeline scrubber */}
      <div
        className="px-4 py-3 border-b"
        style={{ borderColor: 'var(--border-dim)', background: 'rgba(0,0,0,0.2)' }}
      >
        <div className="flex items-center gap-3 mb-2">
          <span className="text-xs font-bold" style={{ color: 'var(--text-muted)' }}>
            Frame {currentFrame + 1} / {data.samples.length}
          </span>
          {isTriggerFrame && (
            <span
              className="text-xs px-2 py-0.5 rounded font-bold"
              style={{ background: 'var(--danger)', color: 'white' }}
            >
              TRIGGER
            </span>
          )}
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {sample ? `${sample.ts}ms` : '—'}
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={data.samples.length - 1}
          value={currentFrame}
          onChange={(e) => setCurrentFrame(Number(e.target.value))}
          className="w-full"
          style={{ accentColor: safetyColor }}
        />
        {/* Trigger marker */}
        {data.trigger !== undefined && (
          <div
            className="relative h-1 mt-1"
            style={{
              width: '100%',
              pointerEvents: 'none',
            }}
          >
            <div
              className="absolute top-0 w-1 h-3 rounded"
              style={{
                left: `${(data.trigger / (data.samples.length - 1)) * 100}%`,
                background: 'var(--danger)',
                transform: 'translateX(-50%)',
              }}
            />
          </div>
        )}
      </div>

      {/* Controls */}
      <div
        className="px-4 py-3 border-b flex items-center gap-3"
        style={{ borderColor: 'var(--border-dim)', background: 'rgba(0,0,0,0.2)' }}
      >
        <button
          onClick={stepBack}
          className="p-2 rounded"
          style={{ background: 'rgba(0,212,255,0.1)', color: 'var(--accent)' }}
        >
          <SkipBack size={16} />
        </button>
        <button
          onClick={togglePlay}
          className="p-2 rounded"
          style={{ background: 'var(--accent)', color: 'var(--bg-void)' }}
        >
          {playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <button
          onClick={stepForward}
          className="p-2 rounded"
          style={{ background: 'rgba(0,212,255,0.1)', color: 'var(--accent)' }}
        >
          <SkipForward size={16} />
        </button>
        <div className="flex items-center gap-2">
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Speed:
          </span>
          {[0.5, 1, 2, 4].map((s) => (
            <button
              key={s}
              onClick={() => setSpeed(s)}
              className="text-xs px-2 py-1 rounded"
              style={{
                background: speed === s ? 'var(--accent)' : 'rgba(0,212,255,0.1)',
                color: speed === s ? 'var(--bg-void)' : 'var(--accent)',
              }}
            >
              {s}x
            </button>
          ))}
        </div>
        {data.trigger !== undefined && (
          <button
            onClick={jumpToTrigger}
            className="text-xs px-3 py-1 rounded ml-auto"
            style={{ background: 'rgba(255,59,92,0.2)', color: 'var(--danger)' }}
          >
            Jump to Trigger
          </button>
        )}
      </div>

      {/* Telemetry display */}
      {sample && (
        <div className="flex-1 overflow-y-auto p-4 grid grid-cols-2 gap-4">
          {/* Safety level */}
          <SafetyLevelCard level={sample.sl} />

          {/* Nav vector */}
          <NavVectorCard vx={sample.nav[0]} vy={sample.nav[1]} omega={sample.nav[2]} />

          {/* Motor RPM chart */}
          <MotorRPMChart
            targets={sample.mt}
            rpms={sample.mr}
            samples={data.samples.slice(Math.max(0, currentFrame - 50), currentFrame + 1)}
          />

          {/* IMU orientation */}
          <IMUCard heading={sample.imu[0]} ax={sample.imu[1]} ay={sample.imu[2]} />

          {/* IR sensors */}
          <IRSensorCard ir={sample.ir} />

          {/* ToF distance */}
          <ToFCard distance={sample.tof} />
        </div>
      )}
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────

function SafetyLevelCard({ level }: { level: number }) {
  const color = SAFETY_COLORS[level];
  const label = SAFETY_LABELS[level];
  return (
    <div
      className="p-4 rounded-lg"
      style={{ background: 'rgba(0,0,0,0.4)', border: `2px solid ${color}` }}
    >
      <div className="text-xs font-bold mb-2" style={{ color: 'var(--text-muted)' }}>
        SAFETY LEVEL
      </div>
      <div className="flex items-center gap-3">
        <div
          className="text-4xl font-bold"
          style={{ color, fontFamily: "'JetBrains Mono', monospace" }}
        >
          {level}
        </div>
        <div
          className="px-3 py-1 rounded font-bold text-sm"
          style={{ background: color, color: 'black' }}
        >
          {label}
        </div>
      </div>
    </div>
  );
}

function NavVectorCard({ vx, vy, omega }: { vx: number; vy: number; omega: number }) {
  const scale = 50;
  const mag = Math.sqrt(vx * vx + vy * vy);
  const angle = Math.atan2(vy, vx) * (180 / Math.PI);

  return (
    <div
      className="p-4 rounded-lg flex flex-col"
      style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid var(--border-dim)' }}
    >
      <div className="text-xs font-bold mb-2" style={{ color: 'var(--text-muted)' }}>
        NAV VECTOR
      </div>
      <div className="flex-1 flex items-center justify-center relative">
        <svg width="100" height="100" viewBox="-50 -50 100 100">
          <circle cx="0" cy="0" r="45" fill="none" stroke="var(--border-mid)" strokeWidth="1" />
          <line x1="0" y1="0" x2="0" y2="-40" stroke="var(--text-muted)" strokeWidth="1" />
          <text x="0" y="-45" fontSize="8" fill="var(--text-muted)" textAnchor="middle">
            Y
          </text>
          <line x1="0" y1="0" x2="40" y2="0" stroke="var(--text-muted)" strokeWidth="1" />
          <text x="45" y="0" fontSize="8" fill="var(--text-muted)" textAnchor="middle">
            X
          </text>
          {mag > 0 && (
            <>
              <line
                x1="0"
                y1="0"
                x2={(vx / scale) * 40}
                y2={-(vy / scale) * 40}
                stroke="var(--accent)"
                strokeWidth="3"
                markerEnd="url(#arrowhead)"
              />
              <defs>
                <marker
                  id="arrowhead"
                  markerWidth="10"
                  markerHeight="7"
                  refX="9"
                  refY="3.5"
                  orient="auto"
                >
                  <polygon points="0 0, 10 3.5, 0 7" fill="var(--accent)" />
                </marker>
              </defs>
            </>
          )}
          {omega !== 0 && (
            <circle
              cx="0"
              cy="0"
              r="30"
              fill="none"
              stroke={omega > 0 ? 'var(--warning)' : 'var(--danger)'}
              strokeWidth="2"
              strokeDasharray="5,5"
              opacity="0.6"
            />
          )}
        </svg>
      </div>
      <div className="text-xs space-y-1" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
        <div style={{ color: 'var(--text-primary)' }}>
          vx: {vx.toFixed(2)} | vy: {vy.toFixed(2)}
        </div>
        <div style={{ color: 'var(--text-primary)' }}>ω: {omega.toFixed(2)}</div>
      </div>
    </div>
  );
}

function MotorRPMChart({
  targets,
  rpms,
  samples,
}: {
  targets: number[];
  rpms: number[];
  samples: BlackBoxSample[];
}) {
  const maxRpm = 333;
  const chartHeight = 100;

  return (
    <div
      className="p-4 rounded-lg col-span-2"
      style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid var(--border-dim)' }}
    >
      <div className="text-xs font-bold mb-3" style={{ color: 'var(--text-muted)' }}>
        MOTOR RPM (last 50 frames)
      </div>
      <div className="grid grid-cols-4 gap-4 mb-3">
        {rpms.map((rpm, i) => (
          <div key={i} className="text-center">
            <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              {MOTOR_NAMES[i]}
            </div>
            <div
              className="text-lg font-bold"
              style={{ color: 'var(--accent)', fontFamily: "'JetBrains Mono', monospace" }}
            >
              {rpm}
            </div>
            <div className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
              PWM {targets[i]}
            </div>
          </div>
        ))}
      </div>
      <svg width="100%" height={chartHeight} viewBox={`0 0 ${samples.length * 2} ${chartHeight}`}>
        {/* Grid lines */}
        {[0, maxRpm / 2, maxRpm].map((rpm, i) => (
          <line
            key={i}
            x1="0"
            y1={chartHeight - (rpm / maxRpm) * chartHeight}
            x2={samples.length * 2}
            y2={chartHeight - (rpm / maxRpm) * chartHeight}
            stroke="var(--border-mid)"
            strokeWidth="0.5"
          />
        ))}
        {/* RPM lines */}
        {[0, 1, 2, 3].map((motorIdx) => {
          const color = ['#00ff88', '#00d4ff', '#ffb800', '#ff3b5c'][motorIdx];
          const points = samples
            .map((s, i) => {
              const rpm = Math.abs(s.mr[motorIdx] ?? 0);
              const y = chartHeight - (rpm / maxRpm) * chartHeight;
              return `${i * 2},${y}`;
            })
            .join(' ');
          return (
            <polyline
              key={motorIdx}
              points={points}
              fill="none"
              stroke={color}
              strokeWidth="1.5"
              opacity="0.8"
            />
          );
        })}
      </svg>
    </div>
  );
}

function IMUCard({ heading, ax, ay }: { heading: number; ax: number; ay: number }) {
  return (
    <div
      className="p-4 rounded-lg"
      style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid var(--border-dim)' }}
    >
      <div className="text-xs font-bold mb-2" style={{ color: 'var(--text-muted)' }}>
        IMU ORIENTATION
      </div>
      <div className="flex items-center justify-center mb-3">
        <div className="relative w-24 h-24">
          <svg width="96" height="96" viewBox="0 0 96 96">
            <circle cx="48" cy="48" r="40" fill="none" stroke="var(--border-mid)" strokeWidth="2" />
            <line
              x1="48"
              y1="48"
              x2={48 + 35 * Math.sin((heading * Math.PI) / 180)}
              y2={48 - 35 * Math.cos((heading * Math.PI) / 180)}
              stroke="var(--accent)"
              strokeWidth="3"
              markerEnd="url(#heading-arrow)"
            />
            <defs>
              <marker
                id="heading-arrow"
                markerWidth="8"
                markerHeight="6"
                refX="7"
                refY="3"
                orient="auto"
              >
                <polygon points="0 0, 8 3, 0 6" fill="var(--accent)" />
              </marker>
            </defs>
            <text x="48" y="12" fontSize="10" fill="var(--text-muted)" textAnchor="middle">
              N
            </text>
          </svg>
        </div>
      </div>
      <div className="text-xs space-y-1" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
        <div style={{ color: 'var(--text-primary)' }}>Heading: {heading.toFixed(1)}°</div>
        <div style={{ color: 'var(--text-primary)' }}>
          Accel: {ax.toFixed(2)}, {ay.toFixed(2)}
        </div>
      </div>
    </div>
  );
}

function IRSensorCard({ ir }: { ir: boolean[] }) {
  return (
    <div
      className="p-4 rounded-lg"
      style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid var(--border-dim)' }}
    >
      <div className="text-xs font-bold mb-3" style={{ color: 'var(--text-muted)' }}>
        IR SENSORS (E18-D80NK)
      </div>
      <div className="flex items-center justify-around">
        {ir.map((on, i) => (
          <div key={i} className="flex flex-col items-center gap-2">
            <div
              className="w-8 h-8 rounded-full"
              style={{
                background: on ? 'var(--danger)' : 'var(--bg-raised)',
                boxShadow: on ? '0 0 12px var(--danger)' : 'inset 0 0 6px rgba(0,0,0,0.4)',
                border: `2px solid ${on ? 'var(--danger)' : 'var(--border-mid)'}`,
              }}
            />
            <span
              className="text-xs font-bold"
              style={{ color: on ? 'var(--danger)' : 'var(--text-muted)' }}
            >
              {IR_LABELS[i]}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ToFCard({ distance }: { distance: number }) {
  const display = distance >= 9999 ? '∞' : distance.toString();
  const barPct = Math.min(100, (distance / 2000) * 100);

  return (
    <div
      className="p-4 rounded-lg"
      style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid var(--border-dim)' }}
    >
      <div className="text-xs font-bold mb-2" style={{ color: 'var(--text-muted)' }}>
        ToF DISTANCE (VL53L1X)
      </div>
      <div className="flex items-baseline gap-2 mb-2">
        <span
          className="text-3xl font-bold"
          style={{ color: 'var(--accent)', fontFamily: "'JetBrains Mono', monospace" }}
        >
          {display}
        </span>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          mm
        </span>
      </div>
      <div className="h-2 rounded-full overflow-hidden" style={{ background: 'var(--bg-raised)' }}>
        <div
          className="h-full transition-all duration-200"
          style={{ width: `${barPct}%`, background: 'var(--accent)' }}
        />
      </div>
    </div>
  );
}
