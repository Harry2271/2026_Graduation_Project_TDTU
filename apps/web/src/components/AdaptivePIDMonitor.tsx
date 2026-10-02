'use client';

import { useEffect, useState, useMemo } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { Activity, Gauge, Clock } from 'lucide-react';
import { useRobotTelemetry } from './RobotTelemetryProvider';

// ── Types ──────────────────────────────────────────────────────────────────

interface AdaptivePIDState {
  kp: number;
  ki: number;
  kd: number;
  battery_ff: number;  // battery feed-forward multiplier
  last_tune_ms: number;
  surface_type: 'NORMAL' | 'SLIPPERY' | 'ROUGH';
  load_compensation: number;
  oscillating: boolean;
}

interface PIDHistoryPoint {
  timestamp: number;
  kp: number;
  ki: number;
  kd: number;
}

// ── Constants ──────────────────────────────────────────────────────────────

const HISTORY_WINDOW_MS = 120_000; // 2 minutes
const BASE_KP = 2.5;
const BASE_KI = 0.2;
const BASE_KD = 0.05;

// ── Component ──────────────────────────────────────────────────────────────

export function AdaptivePIDMonitor() {
  const { wsStatus, lastMessage } = useRobotTelemetry();
  const [adaptiveState, setAdaptiveState] = useState<AdaptivePIDState | null>(null);
  const [pidHistory, setPidHistory] = useState<PIDHistoryPoint[]>([]);

  // ── Subscribe to type 149 (adaptive PID telemetry) ────────────────────
  useEffect(() => {
    if (!lastMessage || lastMessage.type !== 149) return;

    const data = lastMessage.data;
    if (!data) return;

    const newState: AdaptivePIDState = {
      kp: data.kp ?? BASE_KP,
      ki: data.ki ?? BASE_KI,
      kd: data.kd ?? BASE_KD,
      battery_ff: data.battery_ff ?? 1.0,
      last_tune_ms: data.last_tune_ms ?? 0,
      surface_type: data.surface_type ?? 'NORMAL',
      load_compensation: data.load_compensation ?? 1.0,
      oscillating: data.oscillating ?? false,
    };

    setAdaptiveState(newState);

    // Add to history
    const now = Date.now();
    setPidHistory((prev) => {
      const cutoff = now - HISTORY_WINDOW_MS;
      const filtered = prev.filter((p) => p.timestamp > cutoff);
      return [
        ...filtered,
        {
          timestamp: now,
          kp: newState.kp,
          ki: newState.ki,
          kd: newState.kd,
        },
      ];
    });
  }, [lastMessage]);

  // ── Chart data (last 2 minutes) ────────────────────────────────────────
  const chartData = useMemo(() => {
    return pidHistory.map((p) => ({
      time: new Date(p.timestamp).toLocaleTimeString('vi-VN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      }),
      Kp: Number(p.kp.toFixed(3)),
      Ki: Number(p.ki.toFixed(3)),
      Kd: Number(p.kd.toFixed(4)),
    }));
  }, [pidHistory]);

  // ── Render ─────────────────────────────────────────────────────────────

  const isOffline = wsStatus !== 'connected' || !adaptiveState;
  const timeSinceLastTune = adaptiveState?.last_tune_ms
    ? Math.floor((Date.now() - adaptiveState.last_tune_ms) / 1000)
    : null;

  const surfaceColor =
    adaptiveState?.surface_type === 'SLIPPERY' ? 'var(--warning)'
    : adaptiveState?.surface_type === 'ROUGH' ? 'var(--danger)'
    : 'var(--success)';

  return (
    <div
      className="flex flex-col h-full w-full gap-3 p-4"
      style={{
        background: 'var(--bg-void)',
        fontFamily: "'JetBrains Mono', monospace",
      }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2 px-3 py-2 rounded-lg"
        style={{
          background: 'rgba(147,51,234,0.06)',
          border: '1px solid rgba(147,51,234,0.3)',
        }}
      >
        <Activity size={16} style={{ color: 'rgb(147,51,234)' }} />
        <span
          className="text-sm font-bold tracking-widest"
          style={{ color: 'rgb(147,51,234)' }}
        >
          ADAPTIVE PID MONITOR
        </span>
      </div>

      {/* Top stats row */}
      <div className="grid grid-cols-4 gap-2">
        <StatTile
          label="Kp (HIỆN TẠI)"
          value={adaptiveState ? adaptiveState.kp.toFixed(3) : '—'}
          baseline={BASE_KP.toFixed(3)}
          color="rgb(34,197,94)"
          offline={isOffline}
        />
        <StatTile
          label="Ki (HIỆN TẠI)"
          value={adaptiveState ? adaptiveState.ki.toFixed(3) : '—'}
          baseline={BASE_KI.toFixed(3)}
          color="rgb(59,130,246)"
          offline={isOffline}
        />
        <StatTile
          label="Kd (HIỆN TẠI)"
          value={adaptiveState ? adaptiveState.kd.toFixed(4) : '—'}
          baseline={BASE_KD.toFixed(4)}
          color="rgb(251,146,60)"
          offline={isOffline}
        />
        <GaugeTile
          label="HỆ SỐ PIN"
          value={adaptiveState ? adaptiveState.battery_ff : 1.0}
          offline={isOffline}
        />
      </div>

      {/* PID gains chart (last 2 minutes) */}
      <div
        className="flex-1 flex flex-col rounded-lg overflow-hidden"
        style={{
          background: 'rgba(8,11,16,0.6)',
          border: '1px solid var(--border-dim)',
        }}
      >
        <div
          className="px-3 py-2 border-b"
          style={{
            borderColor: 'var(--border-dim)',
            background: 'rgba(147,51,234,0.04)',
          }}
        >
          <span
            className="text-xs font-bold tracking-widest"
            style={{ color: 'var(--text-muted)' }}
          >
            LỊCH SỬ THÔNG SỐ PID (2 PHÚT GẦN ĐÂY)
          </span>
        </div>
        <div className="flex-1 p-3">
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData}>
                <XAxis
                  dataKey="time"
                  stroke="var(--text-muted)"
                  style={{ fontSize: '10px' }}
                  tick={{ fill: 'var(--text-muted)' }}
                />
                <YAxis
                  stroke="var(--text-muted)"
                  style={{ fontSize: '10px' }}
                  tick={{ fill: 'var(--text-muted)' }}
                />
                <Tooltip
                  contentStyle={{
                    background: 'var(--bg-raised)',
                    border: '1px solid var(--border-mid)',
                    borderRadius: '6px',
                    fontSize: '11px',
                    color: 'var(--text-primary)',
                  }}
                  labelStyle={{ color: 'var(--text-muted)' }}
                />
                <Legend
                  wrapperStyle={{ fontSize: '11px', color: 'var(--text-muted)' }}
                />
                <Line
                  type="monotone"
                  dataKey="Kp"
                  stroke="rgb(34,197,94)"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="Ki"
                  stroke="rgb(59,130,246)"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="Kd"
                  stroke="rgb(251,146,60)"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-full flex items-center justify-center">
              <span
                className="text-xs"
                style={{ color: 'var(--text-muted)' }}
              >
                {isOffline ? 'Chờ kết nối...' : 'Đang thu thập dữ liệu...'}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Bottom row: Surface + Load + Last Tune */}
      <div className="grid grid-cols-3 gap-2">
        <MetricCard
          label="BỀ MẶT"
          value={adaptiveState?.surface_type ?? '—'}
          subtext={adaptiveState?.oscillating ? '⚠ Dao động phát hiện' : 'Ổn định'}
          color={surfaceColor}
          offline={isOffline}
        />
        <MetricCard
          label="BÙ TẢI"
          value={adaptiveState ? `${(adaptiveState.load_compensation * 100).toFixed(0)}%` : '—'}
          subtext={adaptiveState && adaptiveState.load_compensation > 1.0 ? 'Có hàng hóa' : 'Không tải'}
          color="var(--accent)"
          offline={isOffline}
        />
        <MetricCard
          label="LẦN ĐIỀU CHỈNH CUỐI"
          value={timeSinceLastTune != null ? `${timeSinceLastTune}s trước` : '—'}
          subtext="Interval: 5s"
          color="var(--text-muted)"
          offline={isOffline}
        />
      </div>
    </div>
  );
}

// ── Subcomponents ──────────────────────────────────────────────────────────

function StatTile({
  label,
  value,
  baseline,
  color,
  offline,
}: {
  label: string;
  value: string;
  baseline: string;
  color: string;
  offline: boolean;
}) {
  return (
    <div
      className="flex flex-col gap-1.5 p-2.5 rounded-lg"
      style={{
        background: 'rgba(17,24,39,0.6)',
        border: '1px solid var(--border-dim)',
        opacity: offline ? 0.5 : 1,
      }}
    >
      <span
        className="text-[9px] font-bold tracking-widest"
        style={{ color: 'var(--text-muted)' }}
      >
        {label}
      </span>
      <span
        className="text-2xl font-bold"
        style={{
          color,
          textShadow: offline ? 'none' : `0 0 8px ${color}`,
        }}
      >
        {value}
      </span>
      <span
        className="text-[9px]"
        style={{ color: 'var(--text-muted)' }}
      >
        Base: {baseline}
      </span>
    </div>
  );
}

function GaugeTile({
  label,
  value,
  offline,
}: {
  label: string;
  value: number;
  offline: boolean;
}) {
  const pct = ((value - 1.0) / 0.15) * 100; // 1.0 → 0%, 1.15 → 100%
  const clampedPct = Math.max(0, Math.min(100, pct));
  const gaugeColor = pct > 50 ? 'var(--warning)' : 'var(--success)';

  return (
    <div
      className="flex flex-col gap-1.5 p-2.5 rounded-lg"
      style={{
        background: 'rgba(17,24,39,0.6)',
        border: '1px solid var(--border-dim)',
        opacity: offline ? 0.5 : 1,
      }}
    >
      <div className="flex items-center gap-1">
        <Gauge size={12} style={{ color: gaugeColor }} />
        <span
          className="text-[9px] font-bold tracking-widest"
          style={{ color: 'var(--text-muted)' }}
        >
          {label}
        </span>
      </div>
      <span
        className="text-2xl font-bold"
        style={{
          color: gaugeColor,
          textShadow: offline ? 'none' : `0 0 8px ${gaugeColor}`,
        }}
      >
        {value.toFixed(2)}×
      </span>
      {/* Gauge bar */}
      <div
        className="w-full h-1.5 rounded-full overflow-hidden"
        style={{ background: 'rgba(0,0,0,0.4)' }}
      >
        <div
          className="h-full transition-all duration-300"
          style={{
            width: `${clampedPct}%`,
            background: gaugeColor,
          }}
        />
      </div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  subtext,
  color,
  offline,
}: {
  label: string;
  value: string;
  subtext: string;
  color: string;
  offline: boolean;
}) {
  return (
    <div
      className="flex flex-col gap-1 p-3 rounded-lg"
      style={{
        background: 'rgba(17,24,39,0.6)',
        border: '1px solid var(--border-dim)',
        opacity: offline ? 0.5 : 1,
      }}
    >
      <span
        className="text-[9px] font-bold tracking-widest"
        style={{ color: 'var(--text-muted)' }}
      >
        {label}
      </span>
      <span
        className="text-xl font-bold"
        style={{
          color,
          textShadow: offline ? 'none' : `0 0 8px ${color}`,
        }}
      >
        {value}
      </span>
      <span
        className="text-[9px]"
        style={{ color: 'var(--text-muted)' }}
      >
        {subtext}
      </span>
    </div>
  );
}
