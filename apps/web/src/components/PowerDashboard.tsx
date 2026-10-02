'use client';

import { useEffect, useState, useMemo } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { Battery, Zap, TrendingUp } from 'lucide-react';
import { useRobotTelemetry } from './RobotTelemetryProvider';

// ── Types ──────────────────────────────────────────────────────────────────

interface PowerDataPoint {
  timestamp: number;
  power_w: number;
  voltage_v: number;
  current_a: number;
}

interface OdomData {
  distance_m: number;
  timestamp: number;
}

// ── Constants ──────────────────────────────────────────────────────────────

const HISTORY_WINDOW_MS = 60_000; // 60 seconds
const BATTERY_CAPACITY_WH = 100; // 3S Li-ion ~11.1V nominal × 9Ah = ~100Wh (adjust to actual battery)

// ── Helpers ────────────────────────────────────────────────────────────────

function voltageToPct(mv: number): number {
  const v = mv / 1000;
  if (v >= 12.6) return 100;
  if (v <= 9.0) return 0;
  if (v >= 11.1) return 50 + ((v - 11.1) / (12.6 - 11.1)) * 50;
  return ((v - 9.0) / (11.1 - 9.0)) * 50;
}

function formatRuntime(minutes: number): string {
  if (!isFinite(minutes) || minutes <= 0) return '—';
  const h = Math.floor(minutes / 60);
  const m = Math.floor(minutes % 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ── Component ──────────────────────────────────────────────────────────────

export function PowerDashboard() {
  const { power, wsStatus } = useRobotTelemetry();
  const [powerHistory, setPowerHistory] = useState<PowerDataPoint[]>([]);
  const [odomHistory, setOdomHistory] = useState<OdomData[]>([]);

  // ── Update power history (2Hz from ESP32) ──────────────────────────────
  useEffect(() => {
    if (!power) return;

    const now = Date.now();
    const voltage_v = power.voltage_mv !== undefined
      ? power.voltage_mv / 1000
      : power.bus_v ?? 0;
    const current_a = power.current_a ?? (power.current_ma !== undefined ? power.current_ma / 1000 : 0);
    const power_w = power.power_w ?? (power.power_mw !== undefined ? power.power_mw / 1000 : 0);

    setPowerHistory((prev) => {
      const cutoff = now - HISTORY_WINDOW_MS;
      const filtered = prev.filter((p) => p.timestamp > cutoff);
      return [
        ...filtered,
        { timestamp: now, power_w, voltage_v, current_a },
      ];
    });
  }, [power]);

  // ── Computed metrics ───────────────────────────────────────────────────
  const latestPower = useMemo(() => {
    if (powerHistory.length === 0) return null;
    return powerHistory[powerHistory.length - 1];
  }, [powerHistory]);

  const avgPower = useMemo(() => {
    if (powerHistory.length === 0) return 0;
    const sum = powerHistory.reduce((acc, p) => acc + p.power_w, 0);
    return sum / powerHistory.length;
  }, [powerHistory]);

  const efficiency = useMemo(() => {
    // W/m requires odometry data from /odom topic
    // For now, return placeholder (will integrate with ROS /odom later)
    return null;
  }, [odomHistory]);

  const batteryPct = useMemo(() => {
    if (!latestPower || latestPower.voltage_v <= 0) return null;
    return voltageToPct(latestPower.voltage_v * 1000);
  }, [latestPower]);

  const runtimeMinutes = useMemo(() => {
    if (!batteryPct || !avgPower || avgPower <= 0) return null;
    const remainingWh = BATTERY_CAPACITY_WH * (batteryPct / 100);
    return (remainingWh / avgPower) * 60;
  }, [batteryPct, avgPower]);

  // ── Chart data (last 60s) ──────────────────────────────────────────────
  const chartData = useMemo(() => {
    return powerHistory.map((p) => ({
      time: new Date(p.timestamp).toLocaleTimeString('vi-VN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      }),
      power: Number(p.power_w.toFixed(2)),
    }));
  }, [powerHistory]);

  // ── Render ─────────────────────────────────────────────────────────────

  const isOffline = wsStatus !== 'connected' || !latestPower;
  const batteryColor =
    batteryPct == null ? 'var(--text-muted)'
    : batteryPct < 20 ? 'var(--danger)'
    : batteryPct < 40 ? 'var(--warning)'
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
          background: 'rgba(0,212,255,0.06)',
          border: '1px solid var(--accent-border)',
        }}
      >
        <Zap size={16} style={{ color: 'var(--accent)' }} />
        <span
          className="text-sm font-bold tracking-widest"
          style={{ color: 'var(--accent)' }}
        >
          POWER MONITOR
        </span>
      </div>

      {/* Top stats row */}
      <div className="grid grid-cols-3 gap-2">
        <StatTile
          icon={<Zap size={14} />}
          label="CÔNG SUẤT HIỆN TẠI"
          value={latestPower ? `${latestPower.power_w.toFixed(1)} W` : '—'}
          color="var(--accent)"
          offline={isOffline}
        />
        <StatTile
          icon={<Battery size={14} />}
          label="PIN"
          value={batteryPct != null ? `${batteryPct.toFixed(0)}%` : '—'}
          color={batteryColor}
          offline={isOffline}
        />
        <StatTile
          icon={<TrendingUp size={14} />}
          label="TRUNG BÌNH (60s)"
          value={avgPower > 0 ? `${avgPower.toFixed(1)} W` : '—'}
          color="var(--warning)"
          offline={isOffline}
        />
      </div>

      {/* Power chart (last 60s) */}
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
            background: 'rgba(0,212,255,0.04)',
          }}
        >
          <span
            className="text-xs font-bold tracking-widest"
            style={{ color: 'var(--text-muted)' }}
          >
            CÔNG SUẤT THỜI GIAN THỰC (60 GIÂY GẦN ĐÂY)
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
                  label={{
                    value: 'W',
                    angle: -90,
                    position: 'insideLeft',
                    style: { fill: 'var(--text-muted)', fontSize: '11px' }
                  }}
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
                <Line
                  type="monotone"
                  dataKey="power"
                  stroke="var(--accent)"
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

      {/* Bottom row: Runtime + Efficiency */}
      <div className="grid grid-cols-2 gap-2">
        <MetricCard
          label="THỜI GIAN HOẠT ĐỘNG CÒN LẠI"
          value={runtimeMinutes != null ? formatRuntime(runtimeMinutes) : '—'}
          subtext={
            runtimeMinutes != null && batteryPct != null
              ? `${batteryPct.toFixed(0)}% pin × ${avgPower.toFixed(1)}W TB`
              : 'Dựa trên BatteryPredictor'
          }
          color="var(--success)"
          offline={isOffline}
        />
        <MetricCard
          label="HIỆU SUẤT"
          value={efficiency != null ? `${efficiency.toFixed(2)} W/m` : '—'}
          subtext="Cần dữ liệu /odom"
          color="var(--warning)"
          offline={isOffline}
        />
      </div>
    </div>
  );
}

// ── Subcomponents ──────────────────────────────────────────────────────────

function StatTile({
  icon,
  label,
  value,
  color,
  offline,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
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
      <div className="flex items-center gap-1">
        <span style={{ color }}>{icon}</span>
        <span
          className="text-[9px] font-bold tracking-widest"
          style={{ color: 'var(--text-muted)' }}
        >
          {label}
        </span>
      </div>
      <span
        className="text-xl font-bold"
        style={{
          color,
          textShadow: offline ? 'none' : `0 0 8px ${color}`,
        }}
      >
        {value}
      </span>
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
        {subtext}
      </span>
    </div>
  );
}
