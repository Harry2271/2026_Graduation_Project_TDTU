'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Grid, Line, OrbitControls, Text } from '@react-three/drei';
import * as THREE from 'three';
import { Activity, Download, Pause, Play, Trash2 } from 'lucide-react';
import { App, Button, Tooltip } from 'antd';
import { Vec3 } from '@/lib/imuTransform';

// ── Types ──────────────────────────────────────────────────────────────────

interface ImuTelemetry {
  heading: number;
  accel: Vec3;
  gyro: Vec3;
  cal: { sys: number; gyro: number; accel: number; mag: number };
}

interface PoseData {
  x: number;
  y: number;
  theta: number;
}

interface TrailPoint {
  mapX: number;
  mapY: number;
  theta: number;
  receivedAt: number;
  position: THREE.Vector3;
}

interface DisplayState extends ImuTelemetry {
  pose: PoseData | null;
  sampleCount: number;
  trailSnapshot: TrailPoint[];
  robotQuat: THREE.Quaternion;
  robotPos: THREE.Vector3;
}

// ── Config ─────────────────────────────────────────────────────────────────

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'wss://map.nguyen-robot.io.vn';
const WS_AUTH_TOKEN = process.env.NEXT_PUBLIC_WS_AUTH_TOKEN;
const MAX_TRAIL = 800;
const UP_AXIS = new THREE.Vector3(0, 1, 0);
const ZERO_VEC3: Vec3 = [0, 0, 0];
const EMPTY_CAL = { sys: 0, gyro: 0, accel: 0, mag: 0 };

// ── Helpers ────────────────────────────────────────────────────────────────

function authenticatedWsUrl(url: string): string {
  if (!WS_AUTH_TOKEN) return url;
  const wsUrl = new URL(url);
  wsUrl.searchParams.set('token', WS_AUTH_TOKEN);
  return wsUrl.toString();
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function parseVec3(v: unknown): Vec3 | null {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(isFiniteNumber)) return null;
  return [v[0], v[1], v[2]];
}

function parsePose(v: unknown): PoseData | null {
  if (!isRecord(v) || !isFiniteNumber(v.x) || !isFiniteNumber(v.y) || !isFiniteNumber(v.theta)) return null;
  return { x: v.x, y: v.y, theta: v.theta };
}

function parseImu(d: unknown): ImuTelemetry | null {
  if (!isRecord(d)) return null;
  const accel = parseVec3(d.accel);
  const gyro = parseVec3(d.gyro);
  if (!accel || !gyro) return null;
  const heading = isFiniteNumber(d.heading) ? d.heading : 0;
  const rawCal = isRecord(d.cal) ? d.cal : {};
  const cal = {
    sys: isFiniteNumber(rawCal.sys) ? rawCal.sys : 0,
    gyro: isFiniteNumber(rawCal.gyro) ? rawCal.gyro : 0,
    accel: isFiniteNumber(rawCal.accel) ? rawCal.accel : 0,
    mag: isFiniteNumber(rawCal.mag) ? rawCal.mag : 0,
  };
  return { heading, accel, gyro, cal };
}

// ── 3D sub-components ──────────────────────────────────────────────────────

function RobotBody({ quaternion }: { quaternion: THREE.Quaternion }) {
  const ref = useRef<THREE.Group>(null);
  useFrame(() => {
    if (ref.current) ref.current.quaternion.slerp(quaternion, 0.25);
  });
  return (
    <group ref={ref}>
      <mesh position={[0, 0.03, 0]}>
        <boxGeometry args={[0.30, 0.04, 0.45]} />
        <meshStandardMaterial color="#1a3a2a" transparent opacity={0.7} />
      </mesh>
      <mesh position={[0.24, 0.03, 0]} rotation={[0, 0, -Math.PI / 2]}>
        <coneGeometry args={[0.025, 0.07, 8]} />
        <meshStandardMaterial color="#ff3b5c" emissive="#ff3b5c" emissiveIntensity={0.4} />
      </mesh>
      {[[-0.15, -0.20], [-0.15, 0.20], [0.15, -0.20], [0.15, 0.20]].map(([x, z], i) => (
        <mesh key={i} position={[x, 0, z]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.048, 0.048, 0.025, 16]} />
          <meshStandardMaterial color="#222" />
        </mesh>
      ))}
      <Text position={[0, 0.15, 0]} fontSize={0.06} color="#00d4ff" anchorX="center" anchorY="bottom">
        ROBOT
      </Text>
    </group>
  );
}

function BodyAxes({ quaternion }: { quaternion: THREE.Quaternion }) {
  const ref = useRef<THREE.Group>(null);
  const len = 0.18;
  useFrame(() => {
    if (ref.current) ref.current.quaternion.slerp(quaternion, 0.25);
  });
  return (
    <group ref={ref}>
      <mesh position={[len / 2, 0.05, 0]}>
        <boxGeometry args={[len, 0.004, 0.004]} />
        <meshBasicMaterial color="#ff4444" />
      </mesh>
      <group rotation={[0, 0, Math.PI / 2]}>
        <mesh position={[len / 2, 0.05, 0]}>
          <boxGeometry args={[len, 0.004, 0.004]} />
          <meshBasicMaterial color="#44ff44" />
        </mesh>
      </group>
      <group rotation={[Math.PI / 2, 0, 0]}>
        <mesh position={[len / 2, 0.05, 0]}>
          <boxGeometry args={[len, 0.004, 0.004]} />
          <meshBasicMaterial color="#4488ff" />
        </mesh>
      </group>
    </group>
  );
}

function TrajectoryTrail({ points }: { points: TrailPoint[] }) {
  const positions = useMemo(
    () => points.map((p) => [p.position.x, p.position.y, p.position.z] as [number, number, number]),
    [points],
  );
  const colors = useMemo(() => {
    if (points.length < 2) return undefined;
    return points.map((_, i) => {
      const t = i / Math.max(points.length - 1, 1);
      const col = new THREE.Color().setHSL(0.53, 1.0, 0.15 + t * 0.4);
      return [col.r, col.g, col.b] as [number, number, number];
    });
  }, [points]);
  if (points.length < 2) return null;
  return <Line points={positions} vertexColors={colors} lineWidth={2} transparent opacity={0.85} />;
}

function CameraRig({ target }: { target: THREE.Vector3 }) {
  const { camera } = useThree();
  const camTarget = useRef(new THREE.Vector3());
  useFrame(() => {
    camTarget.current.lerp(target, 0.03);
    camera.lookAt(camTarget.current);
  });
  return null;
}

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
        enableDamping dampingFactor={0.12}
        target={[robotPos.x, 0.1, robotPos.z]}
        minDistance={0.5} maxDistance={20}
      />
      <CameraRig target={robotPos} />
      <Grid
        infiniteGrid cellSize={1} cellThickness={0.6}
        cellColor="rgba(0,212,255,0.12)"
        sectionSize={5} sectionThickness={1.2}
        sectionColor="rgba(0,212,255,0.25)" fadeDistance={30}
        position={[0, 0, 0]}
      />
      <axesHelper args={[0.6]} />
      <TrajectoryTrail points={trail} />
      <group position={robotPos}>
        <RobotBody quaternion={robotQuat} />
        <BodyAxes quaternion={robotQuat} />
      </group>
    </>
  );
}

// ── Sidebar helpers ────────────────────────────────────────────────────────

function CompassRing({ heading }: { heading: number }) {
  const rad = (heading * Math.PI) / 180;
  const r = 32, cx = 40, cy = 40;
  return (
    <svg width={80} height={80} viewBox="0 0 80 80">
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(0,212,255,0.2)" strokeWidth={2} />
      {[0, 90, 180, 270].map((d) => {
        const a = ((d - 90) * Math.PI) / 180;
        return (
          <text key={d} x={cx + (r + 6) * Math.cos(a)} y={cy + (r + 6) * Math.sin(a)}
            textAnchor="middle" dominantBaseline="central"
            fill="rgba(255,255,255,0.4)" fontSize={7} fontFamily="'JetBrains Mono', monospace">
            {d === 0 ? 'N' : d === 90 ? 'E' : d === 180 ? 'S' : 'W'}
          </text>
        );
      })}
      <line x1={cx} y1={cy}
        x2={cx + r * 0.85 * Math.cos(rad - Math.PI / 2)}
        y2={cy + r * 0.85 * Math.sin(rad - Math.PI / 2)}
        stroke="#00ff88" strokeWidth={2.5} strokeLinecap="round" />
      <circle cx={cx} cy={cy} r={3} fill="#00ff88" />
    </svg>
  );
}

function AxisBar({ value, maxVal, color }: { value: number; maxVal: number; color: string }) {
  const pct = Math.min(Math.abs(value) / maxVal, 1);
  return (
    <div className="flex items-center gap-2 w-full">
      <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
        <div className="h-full rounded-full transition-all duration-75" style={{ width: `${pct * 100}%`, background: color }} />
      </div>
      <span className="w-10 text-right font-mono text-[10px]" style={{ color }}>{value.toFixed(1)}</span>
    </div>
  );
}

function CalDot({ level, label }: { level: number; label: string }) {
  const colors = ['var(--text-muted)', '#ff3b5c', '#ffb800', 'var(--success)'];
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-2.5 h-2.5 rounded-full" style={{ background: colors[level] ?? 'var(--text-muted)' }} />
      <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>{label}</span>
    </div>
  );
}

function StatRow({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="flex items-center justify-between px-1 py-0.5">
      <span className="text-[9px] font-mono" style={{ color: 'var(--text-muted)', letterSpacing: '0.08em' }}>{label}</span>
      <span className="text-[11px] font-mono font-bold" style={{ color }}>{value}</span>
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

function PanelCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl p-3" style={{ background: 'rgba(17,24,39,0.6)', border: '1px solid var(--border-dim)' }}>
      <p className="text-[9px] font-bold mb-2" style={{ color: 'var(--text-muted)', letterSpacing: '0.12em', fontFamily: "'JetBrains Mono', monospace" }}>{title}</p>
      {children}
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────

export default function TrajectoryPage() {
  const { notification } = App.useApp();

  const [wsStatus, setWsStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [isRecording, setIsRecording] = useState(true);
  const isRecordingRef = useRef(true);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef(1000);

  // ── Live state (refs for fast updates without re-render) ──
  const trailRef = useRef<TrailPoint[]>([]);
  const sampleCountRef = useRef(0);
  const robotPosRef = useRef(new THREE.Vector3(0, 0.03, 0));
  const robotQuatRef = useRef(new THREE.Quaternion());
  const hasPoseRef = useRef(false);
  const lastPoseTimeRef = useRef(0);
  const imuTelemetryRef = useRef<ImuTelemetry>({ heading: 0, accel: ZERO_VEC3, gyro: ZERO_VEC3, cal: EMPTY_CAL });
  const displayUpdateCounter = useRef(0);

  const [displayState, setDisplayState] = useState<DisplayState>({
    heading: 0,
    accel: [0, 0, 0],
    gyro: [0, 0, 0],
    cal: EMPTY_CAL,
    pose: null,
    sampleCount: 0,
    trailSnapshot: [],
    robotQuat: new THREE.Quaternion(),
    robotPos: new THREE.Vector3(0, 0.03, 0),
  });

  // ── Apply SLAM pose to scene ──
  const applyPose = useCallback(
    (pose: PoseData) => {
      hasPoseRef.current = true;
      lastPoseTimeRef.current = Date.now();
      // SLAM X/Y → Three.js X/Z (Y-up).  Negate SLAM Y for correct handedness.
      const pos3 = new THREE.Vector3(pose.x, 0.03, -pose.y);
      const yawQuat = new THREE.Quaternion().setFromAxisAngle(UP_AXIS, pose.theta);
      robotPosRef.current.copy(pos3);
      robotQuatRef.current.copy(yawQuat);
      if (isRecordingRef.current) {
        trailRef.current.push({
          mapX: pose.x, mapY: pose.y, theta: pose.theta,
          receivedAt: lastPoseTimeRef.current, position: pos3.clone(),
        });
        if (trailRef.current.length > MAX_TRAIL) {
          trailRef.current = trailRef.current.slice(-MAX_TRAIL);
        }
        sampleCountRef.current++;
      }
      displayUpdateCounter.current++;
      if (displayUpdateCounter.current % 2 === 0) {
        const imu = imuTelemetryRef.current;
        setDisplayState({
          heading: imu.heading, accel: [...imu.accel], gyro: [...imu.gyro],
          cal: { ...imu.cal }, pose, sampleCount: sampleCountRef.current,
          trailSnapshot: [...trailRef.current],
          robotQuat: robotQuatRef.current.clone(), robotPos: pos3.clone(),
        });
      }
    },
    [],
  );

  // ── Apply IMU telemetry (sidebar only — never moves robot) ──
  const applyImu = useCallback(
    (imu: ImuTelemetry) => {
      // IMU is diagnostic telemetry only. It never changes map position,
      // recorded trail, or the yaw-only model quaternion.
      imuTelemetryRef.current = imu;
      setDisplayState((prev) => ({
        ...prev,
        heading: imu.heading,
        accel: [...imu.accel],
        gyro: [...imu.gyro],
        cal: { ...imu.cal },
      }));
    },
    [],
  );

  // ── WebSocket ──
  const connectWs = useCallback(() => {
    if (typeof window === 'undefined') return;
    if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) return;
    setWsStatus('connecting');
    try {
      const ws = new WebSocket(authenticatedWsUrl(WS_URL));
      ws.onopen = () => { setWsStatus('connected'); reconnectDelayRef.current = 1000; };
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string);
          if (!isRecord(msg)) return;
          if (msg.type === 'pose') {
            const p = parsePose(msg.data);
            if (p) applyPose(p);
          } else if (msg.type === 'esp32_imu') {
            const imu = parseImu(msg.data);
            if (imu) applyImu(imu);
          }
        } catch { /* ignore malformed */ }
      };
      ws.onclose = () => {
        setWsStatus('disconnected');
        reconnectTimerRef.current = setTimeout(connectWs, reconnectDelayRef.current);
        reconnectDelayRef.current = Math.min(reconnectDelayRef.current * 2, 15000);
      };
      ws.onerror = () => {};
      wsRef.current = ws;
    } catch {
      setWsStatus('disconnected');
    }
  }, [applyPose, applyImu]);

  useEffect(() => {
    connectWs();
    return () => {
      wsRef.current?.close();
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    };
  }, [connectWs]);

  // ── Clear ──
  const handleClear = useCallback(() => {
    trailRef.current = [];
    sampleCountRef.current = 0;
    if (!hasPoseRef.current) {
      robotPosRef.current.set(0, 0.03, 0);
      robotQuatRef.current.identity();
    }
    setDisplayState((prev) => ({
      ...prev,
      pose: hasPoseRef.current ? prev.pose : null,
      sampleCount: 0, trailSnapshot: [],
      robotPos: hasPoseRef.current ? prev.robotPos : new THREE.Vector3(0, 0.03, 0),
      robotQuat: hasPoseRef.current ? prev.robotQuat : new THREE.Quaternion(),
    }));
  }, []);

  // ── Export CSV ──
  const handleExport = useCallback(() => {
    if (trailRef.current.length === 0) {
      notification.info({ message: 'Chua co du lieu quyet dao de export', placement: 'topRight' });
      return;
    }
    const rows = trailRef.current.map((p, i) =>
      [i, p.receivedAt, p.mapX.toFixed(4), p.mapY.toFixed(4), '0', (p.theta * 180 / Math.PI).toFixed(2)].join(','),
    );
    const csv = 'index,received_at_ms,map_x_m,map_y_m,map_z_m,theta_deg\n' + rows.join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `trajectory_${Date.now()}.csv`; a.click();
    URL.revokeObjectURL(url);
    notification.success({ message: 'Da export CSV', placement: 'topRight' });
  }, [notification]);

  const isConnected = wsStatus === 'connected';
  const pose = displayState.pose;
  const poseAgeMs = lastPoseTimeRef.current ? Date.now() - lastPoseTimeRef.current : Infinity;
  const poseFresh = poseAgeMs < 500;

  return (
    <div className="flex flex-col min-h-dvh overflow-hidden" style={{ background: 'var(--bg-void)' }}>
      {/* Header */}
      <div className="px-4 md:px-8 py-3 flex flex-wrap items-center justify-between gap-3 relative z-10"
        style={{ background: 'linear-gradient(180deg, rgba(0,255,136,0.06) 0%, transparent 100%)', borderBottom: '1px solid var(--border-dim)' }}>
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
            <StatChip label="X" value={`${(pose?.x ?? 0).toFixed(2)}m`} color="#ff6666" />
            <StatChip label="Y" value={`${(pose?.y ?? 0).toFixed(2)}m`} color="#66ff66" />
            <StatChip label="Z" value="0.00m" color="#6688ff" />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Tooltip title={isRecording ? 'Tam dung ghi' : 'Bat dau ghi'}>
            <Button size="small" icon={isRecording ? <Pause size={14} /> : <Play size={14} />}
              onClick={() => {
                const next = !isRecordingRef.current;
                isRecordingRef.current = next;
                setIsRecording(next);
              }}
              style={{ borderRadius: 8, fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, fontSize: 11,
                background: isRecording ? 'rgba(255,184,0,0.12)' : 'rgba(0,255,136,0.12)',
                border: `1px solid ${isRecording ? 'rgba(255,184,0,0.3)' : 'rgba(0,255,136,0.3)'}`,
                color: isRecording ? 'var(--warning)' : 'var(--success)' }}>
              {isRecording ? 'PAUSE' : 'REC'}
            </Button>
          </Tooltip>
          <Tooltip title="Xoa toan bo quyet dao">
            <Button size="small" icon={<Trash2 size={14} />} onClick={handleClear}
              style={{ borderRadius: 8, fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, fontSize: 11,
                background: 'rgba(255,59,92,0.1)', border: '1px solid rgba(255,59,92,0.3)', color: 'var(--danger)' }}>
              CLEAR
            </Button>
          </Tooltip>
          <Tooltip title="Export CSV">
            <Button size="small" icon={<Download size={14} />} onClick={handleExport}
              style={{ borderRadius: 8, fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, fontSize: 11,
                background: 'rgba(0,212,255,0.08)', border: '1px solid rgba(0,212,255,0.2)', color: 'var(--accent)' }}>
              CSV
            </Button>
          </Tooltip>
        </div>
      </div>

      {/* Main */}
      <div className="flex-1 flex min-h-0">
        {/* 3D Viewer */}
        <div className="flex-1 relative">
          <Canvas camera={{ position: [2, 2, 2], fov: 50, near: 0.01, far: 100 }} style={{ background: '#0c1220' }}>
            <Scene3D trail={displayState.trailSnapshot} robotQuat={displayState.robotQuat} robotPos={displayState.robotPos} />
          </Canvas>
          {/* Status badge */}
          <div className="absolute top-3 left-3 z-10 flex items-center gap-2 px-3 py-1.5 rounded-lg"
            style={{ background: 'rgba(8,11,16,0.88)', border: '1px solid var(--border-mid)' }}>
            <span className="w-2 h-2 rounded-full"
              style={{ background: isConnected ? (poseFresh ? 'var(--success)' : 'var(--warning)') : 'var(--danger)',
                boxShadow: isConnected && poseFresh ? '0 0 6px var(--success)' : 'none' }} />
            <span className="text-[10px] font-bold font-mono" style={{ color: 'var(--text-secondary)', letterSpacing: '0.08em' }}>
              {isConnected ? (hasPoseRef.current ? (poseFresh ? 'LIVE' : 'POSE STALE') : 'CONN...') : 'OFFLINE'}
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

        {/* Sidebar */}
        <div className="w-[280px] flex-shrink-0 flex flex-col gap-3 p-3 overflow-y-auto"
          style={{ background: 'rgba(8,11,16,0.95)', borderLeft: '1px solid var(--border-dim)' }}>
          <PanelCard title="HEADING">
            <div className="flex items-center gap-4">
              <CompassRing heading={displayState.heading} />
              <div>
                <span className="text-2xl font-bold font-mono" style={{ color: 'var(--success)' }}>
                  {displayState.heading.toFixed(1)}{'°'}
                </span>
                <div className="text-[10px] font-mono mt-1" style={{ color: 'var(--text-muted)' }}>
                  {displayState.heading < 45 || displayState.heading >= 315 ? 'N' :
                    displayState.heading < 135 ? 'E' : displayState.heading < 225 ? 'S' : 'W'}
                </div>
              </div>
            </div>
          </PanelCard>

          <PanelCard title="ACCEL (m/s2)">
            <div className="space-y-1.5">
              {[{ l: 'X', c: '#ff6666', v: displayState.accel[0] },
                { l: 'Y', c: '#66ff66', v: displayState.accel[1] },
                { l: 'Z', c: '#6688ff', v: displayState.accel[2] }].map(({ l, c, v }) => (
                <div key={l} className="flex items-center gap-2">
                  <span className="w-3 text-[10px] font-bold" style={{ color: c }}>{l}</span>
                  <div className="flex-1"><AxisBar value={v} maxVal={5} color={c} /></div>
                </div>
              ))}
            </div>
          </PanelCard>

          <PanelCard title="GYRO (deg/s)">
            <div className="space-y-1.5">
              {[{ l: 'X', c: '#ff6666', v: displayState.gyro[0] },
                { l: 'Y', c: '#66ff66', v: displayState.gyro[1] },
                { l: 'Z', c: '#6688ff', v: displayState.gyro[2] }].map(({ l, c, v }) => (
                <div key={l} className="flex items-center gap-2">
                  <span className="w-3 text-[10px] font-bold" style={{ color: c }}>{l}</span>
                  <div className="flex-1"><AxisBar value={v} maxVal={50} color={c} /></div>
                </div>
              ))}
            </div>
          </PanelCard>

          <PanelCard title="CALIBRATION">
            <div className="grid grid-cols-2 gap-y-1.5 gap-x-4">
              <CalDot level={displayState.cal.sys} label="SYS" />
              <CalDot level={displayState.cal.gyro} label="GYRO" />
              <CalDot level={displayState.cal.accel} label="ACCEL" />
              <CalDot level={displayState.cal.mag} label="MAG" />
            </div>
          </PanelCard>

          <PanelCard title="STATUS">
            <div className="space-y-0.5">
              <StatRow label="POS X" value={`${(pose?.x ?? 0).toFixed(3)} m`} color="#ff6666" />
              <StatRow label="POS Y" value={`${(pose?.y ?? 0).toFixed(3)} m`} color="#66ff66" />
              <StatRow label="POS Z" value="0.000 m" color="#6688ff" />
              <StatRow label="POSE" value={hasPoseRef.current ? (poseFresh ? 'SLAM' : 'STALE') : 'WAITING'}
                color={hasPoseRef.current ? (poseFresh ? 'var(--success)' : 'var(--warning)') : 'var(--danger)'} />
              <StatRow label="TRAIL" value={`${displayState.trailSnapshot.length} pts`} color="var(--accent)" />
              <StatRow label="MODE" value={isConnected ? (hasPoseRef.current ? 'LIVE' : 'CONNECTED') : 'OFFLINE'} color="var(--accent)" />
            </div>
          </PanelCard>
        </div>
      </div>
    </div>
  );
}
