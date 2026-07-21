'use client';

import { useEffect, useState } from 'react';
import { Activity, Cpu, Power, Radar, Wifi, WifiOff } from 'lucide-react';
import { useRobotTelemetry } from './RobotTelemetryProvider';

// ── Helpers ────────────────────────────────────────────────────────────────

function formatUptime(ts: number | undefined): string {
  if (!ts || ts <= 0) return '—';
  const total = Math.floor(ts / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m.toString().padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${s.toString().padStart(2, '0')}s`;
  return `${s}s`;
}

function formatRate(lastAt: number): string {
  if (!lastAt) return '—';
  const elapsed = (Date.now() - lastAt) / 1000;
  if (elapsed > 5) return '0.0 Hz';
  return '2.0 Hz';
}

const MOTOR_NAMES = ['FL', 'FR', 'RL', 'RR'] as const;

// ── Sub-components ─────────────────────────────────────────────────────────

function PanelHeader() {
  const { wsStatus, lastReceivedAt } = useRobotTelemetry();
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const linkOk = wsStatus === 'connected';
  const dataOk = lastReceivedAt > 0 && Date.now() - lastReceivedAt < 5000;

  return (
    <div
      className="flex items-center justify-between px-3 py-2.5 border-b"
      style={{ borderColor: 'var(--border-dim)', background: 'rgba(0,212,255,0.04)' }}
    >
      <div className="flex items-center gap-2">
        <div
          className="w-7 h-7 rounded-lg flex items-center justify-center"
          style={{
            background: 'linear-gradient(135deg, rgba(0,212,255,0.2), rgba(0,180,230,0.1))',
            border: '1px solid rgba(0,212,255,0.3)',
          }}
        >
          <Cpu size={14} style={{ color: 'var(--accent)' }} />
        </div>
        <div>
          <div
            className="text-[11px] font-bold tracking-widest"
            style={{ color: 'var(--text-primary)', fontFamily: "'JetBrains Mono', monospace" }}
          >
            ESP32
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span
              className="inline-block w-1.5 h-1.5 rounded-full"
              style={{
                background: linkOk ? 'var(--success)' : 'var(--danger)',
                boxShadow: linkOk ? '0 0 6px var(--success)' : 'none',
              }}
            />
            <span
              className="text-[9px] font-bold tracking-widest"
              style={{
                color: linkOk ? 'var(--success)' : 'var(--danger)',
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              {linkOk ? '● LIVE' : '○ OFFLINE'}
            </span>
          </div>
        </div>
      </div>
      <div className="text-right">
        <div
          className="text-[9px] tracking-widest"
          style={{ color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}
        >
          DATA
        </div>
        <div
          className="text-[10px] font-bold"
          style={{
            color: dataOk ? 'var(--accent)' : 'var(--text-muted)',
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          {dataOk ? formatRate(lastReceivedAt) : '— Hz'}
        </div>
      </div>
    </div>
  );
}

// ── Status tab ─────────────────────────────────────────────────────────────

function StatusTab() {
  const { status } = useRobotTelemetry();
  if (!status) {
    return <EmptyState icon={<WifiOff size={28} />} label="Chưa có dữ liệu ESP32" />;
  }

  const estopColor = status.estop ? 'var(--danger)' : 'var(--success)';
  const estopBg = status.estop ? 'rgba(255,59,92,0.15)' : 'rgba(0,255,136,0.1)';
  const isAutoRoam = status.mode === 'AUTO_ROAM';
  const modeColor = isAutoRoam ? 'var(--accent)' : status.estop ? 'var(--danger)' : 'var(--warning)';
  const modeBg = isAutoRoam ? 'rgba(0,212,255,0.15)' : status.estop ? 'rgba(255,59,92,0.15)' : 'rgba(255,184,0,0.1)';

  return (
    <div className="flex flex-col gap-2 p-3">
      {/* Mode badge */}
      <div
        className="flex items-center justify-between px-3 py-2 rounded-lg"
        style={{ background: 'rgba(17,24,39,0.6)', border: '1px solid var(--border-dim)' }}
      >
        <span className="text-[9px] font-bold tracking-widest" style={{ color: 'var(--text-muted)' }}>
          MODE
        </span>
        <span
          className="px-2.5 py-0.5 rounded-md font-bold text-[11px] tracking-wider"
          style={{ background: modeBg, color: modeColor, fontFamily: "'JetBrains Mono', monospace" }}
        >
          {status.mode || '—'}
        </span>
      </div>

      {/* E-stop */}
      <button
        type="button"
        disabled
        className="flex items-center justify-between px-3 py-2 rounded-lg cursor-default"
        style={{ background: estopBg, border: `1px solid ${estopColor}` }}
      >
        <span className="flex items-center gap-1.5">
          <Power size={12} style={{ color: estopColor }} />
          <span className="text-[9px] font-bold tracking-widest" style={{ color: estopColor }}>
            E-STOP
          </span>
        </span>
        <span
          className="font-bold text-[12px] tracking-widest"
          style={{ color: estopColor, fontFamily: "'JetBrains Mono', monospace" }}
        >
          {status.estop ? '● ON' : '○ OFF'}
        </span>
      </button>

      {/* Max% */}
      <Row label="MAX %" value={`${status.max_pct}%`} />
      {/* Uptime */}
      <Row label="UPTIME" value={formatUptime(status.ts)} mono />
      {/* Nav */}
      <Row
        label="NAV"
        value={`x=${status.nav[0]?.toFixed(2)} y=${status.nav[1]?.toFixed(2)} θ=${status.nav[2]?.toFixed(2)}`}
        mono
        small
      />
    </div>
  );
}

function Row({
  label,
  value,
  mono = false,
  small = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  small?: boolean;
}) {
  return (
    <div
      className="flex items-center justify-between px-3 py-1.5 rounded-lg"
      style={{ background: 'rgba(17,24,39,0.4)', border: '1px solid var(--border-dim)' }}
    >
      <span className="text-[9px] font-bold tracking-widest" style={{ color: 'var(--text-muted)' }}>
        {label}
      </span>
      <span
        className={small ? 'text-[10px]' : 'text-[11px]'}
        style={{
          color: 'var(--text-primary)',
          fontFamily: mono ? "'JetBrains Mono', monospace" : undefined,
        }}
      >
        {value}
      </span>
    </div>
  );
}

// ── Motors tab ─────────────────────────────────────────────────────────────

function MotorsTab() {
  const { status } = useRobotTelemetry();
  if (!status) {
    return <EmptyState icon={<WifiOff size={28} />} label="Chưa có dữ liệu ESP32" />;
  }

  return (
    <div className="grid grid-cols-2 gap-2 p-3">
      {status.motors.map((m, i) => (
        <MotorCard key={i} name={MOTOR_NAMES[i] ?? `M${i + 1}`} target={m.t} rpm={m.r} />
      ))}
    </div>
  );
}

function MotorCard({ name, target, rpm }: { name: string; target: number; rpm: number }) {
  const maxRpm = 333; // JGB37-520 rated RPM at 12V
  const pct = Math.min(100, Math.abs(rpm) / maxRpm * 100);
  const barColor =
    rpm === 0 ? 'var(--text-muted)' : Math.abs(rpm) >= 50 ? 'var(--success)' : 'var(--warning)';
  return (
    <div
      className="flex flex-col gap-1 p-2.5 rounded-lg"
      style={{ background: 'rgba(17,24,39,0.6)', border: '1px solid var(--border-dim)' }}
    >
      <div className="flex items-center justify-between">
        <span
          className="text-[9px] font-bold tracking-widest"
          style={{ color: 'var(--text-muted)' }}
        >
          {name}
        </span>
        <span
          className="text-[9px] tracking-widest"
          style={{ color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}
        >
          PWM {target}
        </span>
      </div>
      <div className="flex items-baseline gap-1">
        <span
          className="text-lg font-bold"
          style={{
            color: barColor,
            fontFamily: "'JetBrains Mono', monospace",
            textShadow: rpm > 0 ? `0 0 8px ${barColor}` : undefined,
          }}
        >
          {rpm}
        </span>
        <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
          rpm
        </span>
      </div>
      <div
        className="h-1 rounded-full overflow-hidden"
        style={{ background: 'var(--bg-raised)' }}
      >
        <div
          className="h-full transition-all duration-200"
          style={{ width: `${pct}%`, background: barColor, boxShadow: `0 0 4px ${barColor}` }}
        />
      </div>
    </div>
  );
}

// ── Sensors tab ────────────────────────────────────────────────────────────

function SensorsTab() {
  const { status } = useRobotTelemetry();
  if (!status) {
    return <EmptyState icon={<WifiOff size={28} />} label="Chưa có dữ liệu ESP32" />;
  }
  const st = status.st;
  const irLabels = ['L', 'F', 'R', 'B'];

  return (
    <div className="flex flex-col gap-2 p-3">
      {/* IR row */}
      <div
        className="flex flex-col gap-1.5 p-2.5 rounded-lg"
        style={{ background: 'rgba(17,24,39,0.6)', border: '1px solid var(--border-dim)' }}
      >
        <div className="flex items-center justify-between">
          <span className="text-[9px] font-bold tracking-widest" style={{ color: 'var(--text-muted)' }}>
            IR E18-D80NK
          </span>
          <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
            &lt;20cm = ●
          </span>
        </div>
        <div className="flex items-center justify-around gap-2 py-1">
          {status.ir.map((on, i) => (
            <div key={i} className="flex flex-col items-center gap-1">
              <span
                className="w-4 h-4 rounded-full"
                style={{
                  background: on ? 'var(--danger)' : 'var(--bg-raised)',
                  boxShadow: on ? '0 0 8px var(--danger)' : 'inset 0 0 4px rgba(0,0,0,0.4)',
                  border: `1px solid ${on ? 'var(--danger)' : 'var(--border-mid)'}`,
                }}
              />
              <span
                className="text-[9px] font-bold tracking-wider"
                style={{ color: on ? 'var(--danger)' : 'var(--text-muted)' }}
              >
                {irLabels[i]}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Distance */}
      <div className="grid grid-cols-2 gap-2">
        <DistanceCard label="SHARP" value={st.sharp} unit="cm" />
        <DistanceCard label="TOF" value={st.tof_mm} unit="mm" big />
      </div>

      {/* State chips */}
      <div
        className="flex flex-col gap-1 p-2.5 rounded-lg"
        style={{ background: 'rgba(17,24,39,0.6)', border: '1px solid var(--border-dim)' }}
      >
        <span className="text-[9px] font-bold tracking-widest mb-1" style={{ color: 'var(--text-muted)' }}>
          STATE
        </span>
        <StateChip label="IMU" on={st.imu} />
        <StateChip label="PWR" on={st.pwr} />
        <StateChip label="OBS" on={!st.obs} okLabel="clear" badLabel="blocked" />
        <StateChip label="CYL" text={st.cyl} />
      </div>
    </div>
  );
}

function DistanceCard({
  label,
  value,
  unit,
  big = false,
}: {
  label: string;
  value: number;
  unit: string;
  big?: boolean;
}) {
  const display = value >= 9999 ? '∞' : value.toString();
  return (
    <div
      className="flex flex-col gap-0.5 p-2.5 rounded-lg"
      style={{ background: 'rgba(17,24,39,0.6)', border: '1px solid var(--border-dim)' }}
    >
      <span className="text-[9px] font-bold tracking-widest" style={{ color: 'var(--text-muted)' }}>
        {label}
      </span>
      <div className="flex items-baseline gap-1">
        <span
          className={big ? 'text-base' : 'text-lg'}
          style={{
            color: 'var(--accent)',
            fontFamily: "'JetBrains Mono', monospace",
            fontWeight: 700,
          }}
        >
          {display}
        </span>
        <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
          {unit}
        </span>
      </div>
    </div>
  );
}

function StateChip({
  label,
  on,
  text,
  okLabel = 'on',
  badLabel = 'off',
}: {
  label: string;
  on?: boolean;
  text?: string;
  okLabel?: string;
  badLabel?: string;
}) {
  const color = text !== undefined ? 'var(--text-primary)' : on ? 'var(--success)' : 'var(--text-muted)';
  const display = text !== undefined ? text : on ? `● ${okLabel}` : `○ ${badLabel}`;
  return (
    <div className="flex items-center justify-between text-[10px]" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ color }}>{display}</span>
    </div>
  );
}

// ── Empty state + tabs ─────────────────────────────────────────────────────

function EmptyState({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-8 px-4 text-center">
      <div style={{ color: 'var(--text-muted)' }}>{icon}</div>
      <span
        className="text-[10px]"
        style={{ color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}
      >
        {label}
      </span>
    </div>
  );
}

type TabKey = 'status' | 'motors' | 'sensors';

const TABS: { key: TabKey; label: string; icon: React.ReactNode }[] = [
  { key: 'status', label: 'STATUS', icon: <Activity size={11} /> },
  { key: 'motors', label: 'MOTORS', icon: <Power size={11} /> },
  { key: 'sensors', label: 'SENSORS', icon: <Radar size={11} /> },
];

export function TelemetryPanel() {
  const [tab, setTab] = useState<TabKey>('status');
  return (
    <div
      className="flex flex-col h-full"
      style={{
        background: 'var(--bg-void)',
        borderLeft: '1px solid var(--border-dim)',
        fontFamily: "'JetBrains Mono', monospace",
      }}
    >
      <PanelHeader />
      <div
        className="flex items-center gap-1 px-2 py-1.5 border-b"
        style={{ borderColor: 'var(--border-dim)', background: 'rgba(8,11,16,0.6)' }}
      >
        {TABS.map((t) => {
          const active = t.key === tab;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className="flex items-center gap-1 px-2.5 py-1 rounded-md transition-all cursor-pointer flex-1 justify-center"
              style={
                active
                  ? {
                      background: 'rgba(0,212,255,0.15)',
                      color: 'var(--accent)',
                      border: '1px solid rgba(0,212,255,0.3)',
                      boxShadow: '0 0 10px rgba(0,212,255,0.1)',
                    }
                  : {
                      background: 'transparent',
                      color: 'var(--text-muted)',
                      border: '1px solid var(--border-dim)',
                    }
              }
            >
              {t.icon}
              <span className="text-[9px] font-bold tracking-widest">{t.label}</span>
            </button>
          );
        })}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
        {tab === 'status' && <StatusTab />}
        {tab === 'motors' && <MotorsTab />}
        {tab === 'sensors' && <SensorsTab />}
      </div>
      <div
        className="px-3 py-1.5 flex items-center gap-1.5 border-t"
        style={{ borderColor: 'var(--border-dim)', background: 'rgba(0,212,255,0.03)' }}
      >
        <Wifi size={9} style={{ color: 'var(--text-muted)' }} />
        <span className="text-[8px]" style={{ color: 'var(--text-muted)' }}>
          ws://robot:9091
        </span>
      </div>
    </div>
  );
}
