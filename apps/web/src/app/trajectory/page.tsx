'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, Grid, Text, Line } from '@react-three/drei';
import * as THREE from 'three';
import {
  RotateCcw, Play, Pause, Trash2, Download, WifiOff,
  Compass, Activity, Cpu,
} from 'lucide-react';
import { Button, Tooltip, App } from 'antd';
import {
  Quaternion, Vec3,
  bodyToWorld, makeStationaryDetector, normalizeQuat, quatSlerp,
  wrapDeg,
} from '@/lib/imuTransform';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface ImuSample {
  ts: number;          // ms (ESP32 uptime)
  quat: Quaternion;    // w, x, y, z
  accel: Vec3;         // m/s^2 body frame (gravity removed by BNO055)
  gyro: Vec3;          // deg/s
  heading: number;     // deg
  quatValid?: boolean;
  cal: { sys: number; gyro: number; accel: number; mag: number };
}

interface TrailPoint {
  position: THREE.Vector3;
  quat: Quaternion;
  heading: number;
  color: THREE.Color;
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'wss://map.nguyen-robot.io.vn';
const MAX_TRAIL = 800;              // 40s at 20 Hz
const SAMPLE_RATE = 20;             // Hz (ESP32 type-134 rate)
const INTEGRATION_DT = 1 / SAMPLE_RATE;
const HP_CUTOFF = 0.1;              // Hz – drift-suppression corner frequency
const QUAT_SMOOTH_ALPHA = 0.35;     // Slerp smoothing for jitter

// ─────────────────────────────────────────────────────────────────────────────
// High-pass filter (simple first-order RC, per axis)
// ─────────────────────────────────────────────────────────────────────────────

class HighPass3 {
  private prevIn: [number, number, number] = [0, 0, 0];
  private prevOut: [number, number, number] = [0, 0, 0];
  private a: number;

  constructor(cutoffHz: number, sampleRate: number) {
    const RC = 1 / (2 * Math.PI * cutoffHz);
    const dt = 1 / sampleRate;
    this.a = RC / (RC + dt);
  }
  reset() { this.prevIn = [0, 0, 0]; this.prevOut = [0, 0, 0]; }
  filter(x: [number, number, number]): [number, number, number] {
    const out: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      out[i] = this.a * (this.prevOut[i] + x[i] - this.prevIn[i]);
      this.prevIn[i] = x[i];
      this.prevOut[i] = out[i];
    }
    return out;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock data generator (when no real robot is connected)
// ─────────────────────────────────────────────────────────────────────────────

let mockTick = 0;

function generateMockSample(): ImuSample {
  mockTick++;
  const t = mockTick * INTEGRATION_DT;

  // Simulate a small figure-8 walking path
  const speed = 0.3;
  const ax = speed * Math.cos(t * 0.5);
  const ay = speed * Math.sin(t);

  // Body-frame accel from world-frame path (negate gravity direction for simplicity)
  const accel: Vec3 = [ax, ay, 0.05 * Math.sin(t * 3)];
  const gyro: Vec3 = [0, 0, 20 * Math.cos(t * 0.5)]; // gentle yaw
  const heading = wrapDeg(mockTick * 2.5);
  const phi = heading * Math.PI / 180;

  const quat: Quaternion = [
    Math.cos(phi / 2),
    0,
    0,
    Math.sin(phi / 2),
  ];

  return {
    ts: mockTick * 50,
    quat,
    accel,
    gyro,
    heading,
    cal: { sys: 3, gyro: 3, accel: 3, mag: 3 },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3D Sub-Components
// ─────────────────────────────────────────────────────────────────────────────

/** Small wireframe box representing the robot chassis. */
function RobotBody({ quaternion }: { quaternion: THREE.Quaternion }) {
  const meshRef = useRef<THREE.Group>(null);

  useFrame(() => {
    if (meshRef.current) {
      meshRef.current.quaternion.slerp(quaternion, 0.25);
    }
  });

  return (
    <group ref={meshRef}>
      {/* Chassis */}
      <mesh position={[0, 0.03, 0]}>
        <boxGeometry args={[0.30, 0.04, 0.45]} />
        <meshStandardMaterial color="#1a3a2a" transparent opacity={0.7} />
      </mesh>
      {/* Front arrow */}
      <mesh position={[0.24, 0.03, 0]} rotation={[0, 0, -Math.PI / 2]}>
        <coneGeometry args={[0.025, 0.07, 8]} />
        <meshStandardMaterial color="#ff3b5c" emissive="#ff3b5c" emissiveIntensity={0.4} />
      </mesh>
      {/* Four mecanum wheels */}
      {[[-0.15, -0.20], [-0.15, 0.20], [0.15, -0.20], [0.15, 0.20]].map(
        ([x, z], i) => (
          <mesh key={i} position={[x, 0, z]} rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[0.048, 0.048, 0.025, 16]} />
            <meshStandardMaterial color="#222" />
          </mesh>
        ),
      )}
      {/* Heading text */}
      <Text
        position={[0, 0.15, 0]}
        fontSize={0.06}
        color="#00d4ff"
        anchorX="center"
        anchorY="bottom"
        font={undefined}
      >
        {'ROBOT'}
      </Text>
    </group>
  );
}

/** Three colored arrows (R/G/B = X/Y/Z body axes) fixed to the robot. */
function BodyAxes({ quaternion }: { quaternion: THREE.Quaternion }) {
  const groupRef = useRef<THREE.Group>(null);
  const arrowLength = 0.18;
  const tipLen = 0.04;
  const tipR = 0.012;

  useFrame(() => {
    if (groupRef.current) {
      groupRef.current.quaternion.slerp(quaternion, 0.25);
    }
  });

  return (
    <group ref={groupRef}>
      <group rotation={[0, 0, 0]}>
        <mesh position={[arrowLength / 2, 0.05, 0]}>
          <boxGeometry args={[arrowLength, 0.004, 0.004]} />
          <meshBasicMaterial color="#ff4444" />
        </mesh>
      </group>
      <group rotation={[0, 0, Math.PI / 2]}>
        <mesh position={[arrowLength / 2, 0.05, 0]}>
          <boxGeometry args={[arrowLength, 0.004, 0.004]} />
          <meshBasicMaterial color="#44ff44" />
        </mesh>
      </group>
      <group rotation={[Math.PI / 2, 0, 0]}>
        <mesh position={[arrowLength / 2, 0.05, 0]}>
          <boxGeometry args={[arrowLength, 0.004, 0.004]} />
          <meshBasicMaterial color="#4488ff" />
        </mesh>
      </group>
    </group>
  );
}

/** Trajectory trail rendered as a single gradient-colored line (drei <Line>). */
function TrajectoryTrail({ points }: { points: TrailPoint[] }) {
  const positions = useMemo(() => {
    return points.map((p) => [p.position.x, p.position.y, p.position.z] as [number, number, number]);
  }, [points]);

  const colors = useMemo(() => {
    if (points.length < 2) return undefined;
    const c: [number, number, number][] = points.map((_, i) => {
      const t = i / Math.max(points.length - 1, 1);
      const col = new THREE.Color().setHSL(0.53, 1.0, 0.15 + t * 0.4);
      return [col.r, col.g, col.b];
    });
    return c;
  }, [points]);

  if (points.length < 2) return null;

  return (
    <Line
      points={positions}
      vertexColors={colors}
      lineWidth={2}
      transparent
      opacity={0.85}
    />
  );
}

/** Camera that smoothly follows the robot position. */
function CameraRig({ target }: { target: THREE.Vector3 }) {
  const { camera } = useThree();
  const camTarget = useRef(new THREE.Vector3());

  useFrame(() => {
    camTarget.current.lerp(target, 0.03);
    camera.lookAt(camTarget.current);
  });

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
//3D Scene
// ─────────────────────────────────────────────────────────────────────────────

function Scene3D({ trail, robotQuat, robotPos }: {
  trail: TrailPoint[];
  robotQuat: THREE.Quaternion;
  robotPos: THREE.Vector3;
}) {
  return (
    <>
      <ambientLight intensity={0.6} />
      <directionalLight position={[5, 8, 5]} intensity={0.8} />
      <OrbitControls
        enableDamping
        dampingFactor={0.12}
        target={[robotPos.x, 0.1, robotPos.z]}
        minDistance={0.5}
        maxDistance={20}
      />
      <CameraRig target={robotPos} />

      {/* Ground grid */}
      <Grid
        infiniteGrid
        cellSize={1}
        cellThickness={0.6}
        cellColor="rgba(0,212,255,0.12)"
        sectionSize={5}
        sectionThickness={1.2}
        sectionColor="rgba(0,212,255,0.25)"
        fadeDistance={30}
        position={[0, 0, 0]}
      />
      <axesHelper args={[0.6]} />

      {/* Trajectory trail */}
      <TrajectoryTrail points={trail} />

      {/* Robot */}
      <group position={robotPos}>
        <RobotBody quaternion={robotQuat} />
        <BodyAxes quaternion={robotQuat} />
      </group>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Telemetry sidebar panel
// ─────────────────────────────────────────────────────────────────────────────

function CompassRing({ heading }: { heading: number }) {
  const rad = (heading * Math.PI) / 180;
  const r = 32;
  const cx = 40, cy = 40;
  return (
    <svg width={80} height={80} viewBox="0 0 80 80">
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(0,212,255,0.2)" strokeWidth={2} />
      {[0, 90, 180, 270].map((d) => {
        const a = ((d - 90) * Math.PI) / 180;
        return (
          <text
            key={d}
            x={cx + (r + 6) * Math.cos(a)}
            y={cy + (r + 6) * Math.sin(a)}
            textAnchor="middle"
            dominantBaseline="central"
            fill="rgba(255,255,255,0.4)"
            fontSize={7}
            fontFamily="'JetBrains Mono', monospace"
          >
            {d === 0 ? 'N' : d === 90 ? 'E' : d === 180 ? 'S' : 'W'}
          </text>
        );
      })}
      <line
        x1={cx}
        y1={cy}
        x2={cx + r * 0.85 * Math.cos(rad - Math.PI / 2)}
        y2={cy + r * 0.85 * Math.sin(rad - Math.PI / 2)}
        stroke="#00ff88"
        strokeWidth={2.5}
        strokeLinecap="round"
      />
      <circle cx={cx} cy={cy} r={3} fill="#00ff88" />
    </svg>
  );
}

function AccelBar({ value, maxVal, color }: { value: number; maxVal: number; color: string }) {
  const pct = Math.min(Math.abs(value) / maxVal, 1);
  return (
    <div className="flex items-center gap-2 w-full">
      <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
        <div
          className="h-full rounded-full transition-all duration-75"
          style={{ width: `${pct * 100}%`, background: color }}
        />
      </div>
      <span className="w-10 text-right font-mono text-[10px]" style={{ color }}>
        {value.toFixed(1)}
      </span>
    </div>
  );
}

function CalDot({ level, label }: { level: number; label: string }) {
  const colors = ['var(--text-muted)', '#ff3b5c', '#ffb800', 'var(--success)'];
  return (
    <div className="flex items-center gap-1.5">
      <span
        className="w-2.5 h-2.5 rounded-full"
        style={{ background: colors[level] ?? 'var(--text-muted)' }}
      />
      <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
        {label}
      </span>
    </div>
  );
}

function StatRow({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="flex items-center justify-between px-1 py-0.5">
      <span className="text-[9px] font-mono" style={{ color: 'var(--text-muted)', letterSpacing: '0.08em' }}>
        {label}
      </span>
      <span className="text-[11px] font-mono font-bold" style={{ color }}>
        {value}
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main page component
// ─────────────────────────────────────────────────────────────────────────────

export default function TrajectoryPage() {
  const { notification } = App.useApp();

  // ── Connection state ──
  const [wsStatus, setWsStatus] = useState<'connecting' | 'connected' | 'mock' | 'disconnected'>('mock');
  const [isRecording, setIsRecording] = useState(true);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef(1000);

  // ── IMU state ──
  const latestSample = useRef<ImuSample | null>(null);
  const smoothQuatRef = useRef<THREE.Quaternion>(new THREE.Quaternion());
  const smoothQuatPrev = useRef<Quaternion>([1, 0, 0, 0]);
  const accelHighPass = useRef<HighPass3>(new HighPass3(HP_CUTOFF, SAMPLE_RATE));
  const velocityHighPass = useRef<HighPass3>(new HighPass3(HP_CUTOFF, SAMPLE_RATE));
  const velocityRef = useRef<Vec3>([0, 0, 0]);
  const positionRef = useRef<Vec3>([0, 0, 0]);
  const stationaryDetector = useRef(makeStationaryDetector());
  const lastTimestampRef = useRef<number | null>(null);
  const acceptedQuatRef = useRef<Quaternion | null>(null);
  const heldQuatRef = useRef<Quaternion>([1, 0, 0, 0]);

  // ── Trail ──
  const trailRef = useRef<TrailPoint[]>([]);
  const robotPosRef = useRef<THREE.Vector3>(new THREE.Vector3(0, 0.03, 0));

  // ── React state (rendered at lower rate) ──
  const [displayState, setDisplayState] = useState({
    heading: 0,
    accel: [0, 0, 0] as Vec3,
    gyro: [0, 0, 0] as Vec3,
    cal: { sys: 0, gyro: 0, accel: 0, mag: 0 },
    position: [0, 0, 0] as Vec3,
    sampleCount: 0,
    trailSnapshot: [] as TrailPoint[],
    robotQuat: new THREE.Quaternion(),
    robotPos: new THREE.Vector3(0, 0.03, 0),
    stationary: false,
  });

  const displayUpdateCounter = useRef(0);
  const sampleCountRef = useRef(0);

  // ── Process one IMU sample ──
  const processSample = useCallback((s: ImuSample) => {
    if (!isRecording) return;

    const quat = normalizeQuat(s.quat);
    if (s.quatValid === false || !quat || !s.accel.every(Number.isFinite) || !s.gyro.every(Number.isFinite)) return;

    const previousTimestamp = lastTimestampRef.current;
    let dt = previousTimestamp === null ? INTEGRATION_DT : (s.ts - previousTimestamp) / 1000;
    lastTimestampRef.current = s.ts;
    if (!Number.isFinite(dt) || dt <= 0 || dt > 0.25) {
      accelHighPass.current.reset();
      velocityHighPass.current.reset();
      stationaryDetector.current.reset();
      velocityRef.current = [0, 0, 0];
      dt = INTEGRATION_DT;
    }

    sampleCountRef.current++;
    latestSample.current = s;

    const stationary = stationaryDetector.current.update(s.accel, s.gyro, dt);
    let renderQuat: Quaternion;
    if (acceptedQuatRef.current === null) {
      acceptedQuatRef.current = quat;
      smoothQuatPrev.current = quat;
      heldQuatRef.current = quat;
    }

    if (stationary) {
      velocityRef.current = [0, 0, 0];
      accelHighPass.current.reset();
      velocityHighPass.current.reset();
      renderQuat = heldQuatRef.current;
    } else {
      const smoothed = quatSlerp(smoothQuatPrev.current, quat, QUAT_SMOOTH_ALPHA);
      smoothQuatPrev.current = smoothed;
      acceptedQuatRef.current = smoothed;
      heldQuatRef.current = smoothed;
      renderQuat = smoothed;

      // The type-134 contract is body-to-world: q * accel_body * q^-1.
      const filteredAccel = accelHighPass.current.filter(bodyToWorld(smoothed, s.accel));
      velocityRef.current = [
        velocityRef.current[0] + filteredAccel[0] * dt,
        velocityRef.current[1] + filteredAccel[1] * dt,
        velocityRef.current[2] + filteredAccel[2] * dt,
      ];
      const filteredVelocity = velocityHighPass.current.filter(velocityRef.current);
      positionRef.current = [
        positionRef.current[0] + filteredVelocity[0] * dt,
        positionRef.current[1] + filteredVelocity[1] * dt,
        positionRef.current[2] + filteredVelocity[2] * dt,
      ];
      // The physical Z axis is vertical; keep the flat-floor display bounded.
      positionRef.current[2] = Math.max(-0.05, Math.min(0.1, positionRef.current[2]));
    }

    // Three.js is Y-up: IMU X/Y/Z becomes rendered X/Z/Y.
    smoothQuatRef.current.set(renderQuat[1], renderQuat[2], renderQuat[3], renderQuat[0]);
    const pos3 = new THREE.Vector3(positionRef.current[0], positionRef.current[2], positionRef.current[1]);
    robotPosRef.current.copy(pos3);

    const hue = (0.53 + sampleCountRef.current * 0.001) % 1;
    trailRef.current.push({
      position: pos3.clone(),
      quat: renderQuat,
      heading: s.heading,
      color: new THREE.Color().setHSL(hue, 0.9, 0.5),
    });
    if (trailRef.current.length > MAX_TRAIL) {
      trailRef.current = trailRef.current.slice(-MAX_TRAIL);
    }

    displayUpdateCounter.current++;
    if (displayUpdateCounter.current % 2 === 0) {
      setDisplayState({
        heading: s.heading,
        accel: [...s.accel],
        gyro: [...s.gyro],
        cal: { ...s.cal },
        position: [...positionRef.current],
        sampleCount: sampleCountRef.current,
        trailSnapshot: [...trailRef.current],
        robotQuat: smoothQuatRef.current.clone(),
        robotPos: pos3.clone(),
        stationary,
      });
    }
  }, [isRecording]);

  // ── Mock data interval ──
  useEffect(() => {
    if (wsStatus !== 'mock') return;
    const id = setInterval(() => {
      processSample(generateMockSample());
    }, 1000 / SAMPLE_RATE);
    return () => clearInterval(id);
  }, [wsStatus, processSample]);

  // ── WebSocket connection ──
  const connectWs = useCallback(() => {
    if (typeof window === 'undefined') return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    // A reconnect may follow an ESP32 reboot or a switch from mock data;
    // never carry integration/filter state across that boundary.
    accelHighPass.current.reset();
    velocityHighPass.current.reset();
    stationaryDetector.current.reset();
    lastTimestampRef.current = null;
    acceptedQuatRef.current = null;
    velocityRef.current = [0, 0, 0];
    setWsStatus('connecting');
    try {
      const ws = new WebSocket(WS_URL);
      ws.onopen = () => {
        setWsStatus('connected');
        reconnectDelayRef.current = 1000;
      };
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string);
          if (msg.type === 'esp32_imu') {
            const d = msg.data;
            const sample: ImuSample = {
              ts: d.ts ?? Date.now(),
              quat: d.q ?? [1, 0, 0, 0],
              accel: d.accel ?? [0, 0, 0],
              gyro: d.gyro ?? [0, 0, 0],
              heading: d.heading ?? 0,
              quatValid: d.quat_valid,
              cal: d.cal ?? { sys: 0, gyro: 0, accel: 0, mag: 0 },
            };
            processSample(sample);
          }
        } catch { /* ignore malformed messages */ }
      };
      ws.onclose = () => {
        setWsStatus('mock');
        reconnectTimerRef.current = setTimeout(connectWs, reconnectDelayRef.current);
        reconnectDelayRef.current = Math.min(reconnectDelayRef.current * 2, 15000);
      };
      ws.onerror = () => { /* fallback to mock on error */ };
      wsRef.current = ws;
    } catch {
      setWsStatus('mock');
    }
  }, [processSample]);

  useEffect(() => {
    connectWs();
    return () => {
      wsRef.current?.close();
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    };
  }, [connectWs]);

  // ── Controls ──
  const handleClear = () => {
    trailRef.current = [];
    positionRef.current = [0, 0, 0];
    velocityRef.current = [0, 0, 0];
    accelHighPass.current.reset();
    velocityHighPass.current.reset();
    stationaryDetector.current.reset();
    lastTimestampRef.current = null;
    acceptedQuatRef.current = null;
    heldQuatRef.current = [1, 0, 0, 0];
    smoothQuatPrev.current = [1, 0, 0, 0];
    smoothQuatRef.current.identity();
    robotPosRef.current.set(0, 0.03, 0);
    sampleCountRef.current = 0;
    mockTick = 0;
    setDisplayState((prev) => ({
      ...prev,
      trailSnapshot: [],
      sampleCount: 0,
      position: [0, 0, 0],
      robotQuat: new THREE.Quaternion(),
      robotPos: new THREE.Vector3(0, 0.03, 0),
      stationary: false,
    }));
  };

  const handleExport = () => {
    const rows = trailRef.current.map((p, i) =>
      [i, p.position.x.toFixed(4), p.position.y.toFixed(4), p.position.z.toFixed(4), p.heading.toFixed(2)].join(','),
    );
    const csv = 'index,x_m,y_m,z_m,heading_deg\n' + rows.join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `trajectory_${Date.now()}.csv`; a.click();
    URL.revokeObjectURL(url);
    notification.success({ message: 'Đã export CSV', placement: 'topRight' });
  };

  const isOnline = wsStatus === 'connected';

  return (
    <div className="flex flex-col min-h-dvh overflow-hidden" style={{ background: 'var(--bg-void)' }}>
      {/* ── Header ───────────────────────────────────────────────── */}
      <div
        className="px-4 md:px-8 py-3 flex flex-wrap items-center justify-between gap-3 relative z-10"
        style={{
          background: 'linear-gradient(180deg, rgba(0,255,136,0.06) 0%, transparent 100%)',
          borderBottom: '1px solid var(--border-dim)',
        }}
      >
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 px-3 py-2 rounded-xl"
            style={{ background: 'rgba(0,255,136,0.08)', border: '1px solid rgba(0,255,136,0.25)' }}>
            <Activity size={14} style={{ color: 'var(--success)' }} />
            <span className="text-[12px] font-bold" style={{ color: 'var(--text-primary)', fontFamily: "'JetBrains Mono', monospace" }}>
              TRAJECTORY<span style={{ color: 'var(--success)' }}>_</span>3D
            </span>
          </div>
          <div className="h-7 w-px" style={{ background: 'var(--border-dim)' }} />
          <div className="flex items-center gap-3">
            <StatChip label="POINTS" value={displayState.sampleCount.toString()} color="var(--accent)" />
            <StatChip label="X" value={`${displayState.position[0].toFixed(2)}m`} color="#ff6666" />
            <StatChip label="Y" value={`${displayState.position[1].toFixed(2)}m`} color="#66ff66" />
            <StatChip label="Z" value={`${displayState.position[2].toFixed(2)}m`} color="#6688ff" />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Tooltip title={isRecording ? 'Tạm dừng ghi' : 'Bắt đầu ghi'}>
            <Button
              size="small"
              icon={isRecording ? <Pause size={14} /> : <Play size={14} />}
              onClick={() => setIsRecording(!isRecording)}
              style={{
                borderRadius: 8, fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, fontSize: 11,
                background: isRecording ? 'rgba(255,184,0,0.12)' : 'rgba(0,255,136,0.12)',
                border: `1px solid ${isRecording ? 'rgba(255,184,0,0.3)' : 'rgba(0,255,136,0.3)'}`,
                color: isRecording ? 'var(--warning)' : 'var(--success)',
              }}
            >
              {isRecording ? 'PAUSE' : 'REC'}
            </Button>
          </Tooltip>
          <Tooltip title="Xóa toàn bộ quỹ đạo">
            <Button size="small" icon={<Trash2 size={14} />} onClick={handleClear}
              style={{
                borderRadius: 8, fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, fontSize: 11,
                background: 'rgba(255,59,92,0.1)', border: '1px solid rgba(255,59,92,0.3)', color: 'var(--danger)',
              }}
            >
              CLEAR
            </Button>
          </Tooltip>
          <Tooltip title="Export CSV">
            <Button size="small" icon={<Download size={14} />} onClick={handleExport}
              style={{
                borderRadius: 8, fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, fontSize: 11,
                background: 'rgba(0,212,255,0.08)', border: '1px solid rgba(0,212,255,0.2)', color: 'var(--accent)',
              }}
            >
              CSV
            </Button>
          </Tooltip>
        </div>
      </div>

      {/* ── Main: 3D canvas + sidebar ────────────────────────────── */}
      <div className="flex-1 flex min-h-0">
        {/* 3D Viewer */}
        <div className="flex-1 relative">
          <Canvas
            camera={{ position: [2, 2, 2], fov: 50, near: 0.01, far: 100 }}
            style={{ background: '#0c1220' }}
          >
            <Scene3D
              trail={displayState.trailSnapshot}
              robotQuat={displayState.robotQuat}
              robotPos={displayState.robotPos}
            />
          </Canvas>

          {/* Status badge */}
          <div className="absolute top-3 left-3 z-10 flex items-center gap-2 px-3 py-1.5 rounded-lg"
            style={{ background: 'rgba(8,11,16,0.88)', border: '1px solid var(--border-mid)' }}>
            <span className="w-2 h-2 rounded-full"
              style={{
                background: isOnline ? 'var(--success)' : wsStatus === 'mock' ? 'var(--warning)' : 'var(--danger)',
                boxShadow: isOnline ? '0 0 6px var(--success)' : 'none',
              }} />
            <span className="text-[10px] font-bold font-mono" style={{ color: 'var(--text-secondary)', letterSpacing: '0.08em' }}>
              {isOnline ? 'LIVE' : wsStatus === 'mock' ? 'MOCK' : wsStatus === 'connecting' ? 'CONN...' : 'OFFLINE'}
            </span>
          </div>

          {/* Axes legend */}
          <div className="absolute bottom-3 left-3 z-10 flex gap-3 px-3 py-2 rounded-lg"
            style={{ background: 'rgba(8,11,16,0.88)', border: '1px solid var(--border-mid)' }}>
            {[{ color: '#ff4444', label: 'X' }, { color: '#44ff44', label: 'Y' }, { color: '#4488ff', label: 'Z' }].map(({ color, label }) => (
              <div key={label} className="flex items-center gap-1">
                <span className="w-3 h-0.5 rounded" style={{ background: color }} />
                <span className="text-[9px] font-mono font-bold" style={{ color }}>{label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Sidebar telemetry */}
        <div
          className="w-[280px] flex-shrink-0 flex flex-col gap-3 p-3 overflow-y-auto"
          style={{ background: 'rgba(8,11,16,0.95)', borderLeft: '1px solid var(--border-dim)' }}
        >
          {/* Compass */}
          <PanelCard title="HEADING">
            <div className="flex items-center gap-4">
              <CompassRing heading={displayState.heading} />
              <div>
                <span className="text-2xl font-bold font-mono" style={{ color: 'var(--success)' }}>
                  {displayState.heading.toFixed(1)}°
                </span>
                <div className="text-[10px] font-mono mt-1" style={{ color: 'var(--text-muted)' }}>
                  {displayState.heading < 45 || displayState.heading >= 315 ? 'N' :
                    displayState.heading < 135 ? 'E' : displayState.heading < 225 ? 'S' : 'W'}
                </div>
              </div>
            </div>
          </PanelCard>

          {/* Acceleration */}
          <PanelCard title="ACCEL (m/s²)">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="w-3 text-[10px] font-bold" style={{ color: '#ff6666' }}>X</span>
                <div className="flex-1"><AccelBar value={displayState.accel[0]} maxVal={5} color="#ff6666" /></div>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-3 text-[10px] font-bold" style={{ color: '#66ff66' }}>Y</span>
                <div className="flex-1"><AccelBar value={displayState.accel[1]} maxVal={5} color="#66ff66" /></div>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-3 text-[10px] font-bold" style={{ color: '#6688ff' }}>Z</span>
                <div className="flex-1"><AccelBar value={displayState.accel[2]} maxVal={5} color="#6688ff" /></div>
              </div>
            </div>
          </PanelCard>

          {/* Gyro */}
          <PanelCard title="GYRO (°/s)">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="w-3 text-[10px] font-bold" style={{ color: '#ff6666' }}>X</span>
                <div className="flex-1"><AccelBar value={displayState.gyro[0]} maxVal={50} color="#ff6666" /></div>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-3 text-[10px] font-bold" style={{ color: '#66ff66' }}>Y</span>
                <div className="flex-1"><AccelBar value={displayState.gyro[1]} maxVal={50} color="#66ff66" /></div>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-3 text-[10px] font-bold" style={{ color: '#6688ff' }}>Z</span>
                <div className="flex-1"><AccelBar value={displayState.gyro[2]} maxVal={50} color="#6688ff" /></div>
              </div>
            </div>
          </PanelCard>

          {/* Calibration */}
          <PanelCard title="CALIBRATION">
            <div className="grid grid-cols-2 gap-y-1.5 gap-x-4">
              <CalDot level={displayState.cal.sys} label="SYS" />
              <CalDot level={displayState.cal.gyro} label="GYRO" />
              <CalDot level={displayState.cal.accel} label="ACCEL" />
              <CalDot level={displayState.cal.mag} label="MAG" />
            </div>
          </PanelCard>

          {/* Position + Status */}
          <PanelCard title="STATUS">
            <div className="space-y-0.5">
              <StatRow label="POS X" value={`${displayState.position[0].toFixed(3)} m`} color="#ff6666" />
              <StatRow label="POS Y" value={`${displayState.position[1].toFixed(3)} m`} color="#66ff66" />
              <StatRow label="POS Z" value={`${displayState.position[2].toFixed(3)} m`} color="#6688ff" />
              <StatRow label="ZUPT" value={displayState.stationary ? 'STOPPED' : 'MOVING'} color={displayState.stationary ? 'var(--warning)' : 'var(--success)'} />
              <StatRow label="TRAIL" value={`${displayState.trailSnapshot.length} pts`} color="var(--accent)" />
              <StatRow label="MODE" value={wsStatus === 'mock' ? 'SIMULATION' : isOnline ? 'LIVE' : 'OFFLINE'} color="var(--accent)" />
            </div>
          </PanelCard>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Reusable small components
// ─────────────────────────────────────────────────────────────────────────────

function PanelCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      className="rounded-xl p-3"
      style={{
        background: 'rgba(17,24,39,0.6)',
        border: '1px solid var(--border-dim)',
      }}
    >
      <p className="text-[9px] font-bold mb-2" style={{ color: 'var(--text-muted)', letterSpacing: '0.12em', fontFamily: "'JetBrains Mono', monospace" }}>
        {title}
      </p>
      {children}
    </div>
  );
}

function StatChip({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg" style={{ background: 'rgba(17,24,39,0.6)', border: '1px solid var(--border-dim)' }}>
      <span className="text-[8px] font-bold" style={{ color: 'var(--text-muted)', letterSpacing: '0.1em' }}>{label}</span>
      <span className="text-[11px] font-mono font-bold" style={{ color }}>{value}</span>
    </div>
  );
}
