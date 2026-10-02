'use client';

import { useEffect, useState, useMemo } from 'react';
import { Activity, AlertTriangle, XCircle, Clock } from 'lucide-react';
import { getRobotSocket } from '@/lib/robotSocket';

// ── Types ──────────────────────────────────────────────────────────────────

interface MotorHealthData {
  motor_id: number;
  stress_level: number; // 0-100
  warning_count: number;
  stall_count: number;
  hours_run: number;
}

interface Type143Telemetry {
  type: 143;
  data: {
    uptime_ms: number;
    battery: {
      voltage_v: number;
      current_a: number;
      power_w: number;
      battery_pct: number;
    };
    robot: {
      mode: string;
      nav: [number, number, number];
      e_stop: boolean;
    };
    modules: Array<{
      name: string;
      status: string;
      motor_health?: MotorHealthData[];
    }>;
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function getStressColor(stress: number): string {
  if (stress >= 80) return '#ef4444'; // red
  if (stress >= 60) return '#f97316'; // orange
  if (stress >= 40) return '#eab308'; // yellow
  if (stress >= 20) return '#84cc16'; // lime
  return '#22c55e'; // green
}

function formatHours(hours: number): string {
  if (hours < 1) return `${(hours * 60).toFixed(0)}m`;
  if (hours < 10) return `${hours.toFixed(1)}h`;
  return `${hours.toFixed(0)}h`;
}

const MOTOR_LABELS = ['FL', 'FR', 'RL', 'RR'];

// ── Component ──────────────────────────────────────────────────────────────

export function MotorHealthHeatmap() {
  const [motorHealth, setMotorHealth] = useState<MotorHealthData[]>([]);
  const [wsStatus, setWsStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [lastUpdate, setLastUpdate] = useState<number>(0);

  useEffect(() => {
    const socket = getRobotSocket();

    const onType143 = (payload: unknown) => {
      const msg = payload as Type143Telemetry;
      if (msg.type !== 143 || !msg.data?.modules) return;

      // Extract motor_health from modules (likely in MecanumDrive or MotorController module)
      for (const mod of msg.data.modules) {
        if (mod.motor_health && Array.isArray(mod.motor_health)) {
          setMotorHealth(mod.motor_health);
          setLastUpdate(Date.now());
          break;
        }
      }
    };

    const onConnected = () => setWsStatus('connected');
    const onDisconnected = () => setWsStatus('disconnected');

    socket.on('esp32_telemetry_143', onType143);
    socket.on('connected', onConnected);
    socket.on('disconnected', onDisconnected);
    setWsStatus(socket.isConnected() ? 'connected' : 'connecting');

    return () => {
      socket.off('esp32_telemetry_143', onType143);
      socket.off('connected', onConnected);
      socket.off('disconnected', onDisconnected);
    };
  }, []);

  const isOffline = wsStatus !== 'connected' || motorHealth.length === 0;

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
        className="flex items-center justify-between px-3 py-2 rounded-lg"
        style={{
          background: 'rgba(139,92,246,0.06)',
          border: '1px solid rgba(139,92,246,0.3)',
        }}
      >
        <div className="flex items-center gap-2">
          <Activity size={16} style={{ color: 'rgb(139,92,246)' }} />
          <span
            className="text-sm font-bold tracking-widest"
            style={{ color: 'rgb(139,92,246)' }}
          >
            MOTOR HEALTH MONITOR
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span
            className="text-[9px] tracking-wider"
            style={{ color: 'var(--text-muted)' }}
          >
            {wsStatus === 'connected' ? 'CONNECTED' : 'OFFLINE'}
          </span>
          <div
            className="w-2 h-2 rounded-full"
            style={{
              background: wsStatus === 'connected' ? '#22c55e' : '#ef4444',
              boxShadow: wsStatus === 'connected' ? '0 0 8px #22c55e' : 'none',
            }}
          />
        </div>
      </div>

      {/* 4×4 Grid */}
      <div className="grid grid-cols-2 gap-3 flex-1">
        {[0, 1, 2, 3].map((motorId) => {
          const motor = motorHealth.find((m) => m.motor_id === motorId);
          const stress = motor?.stress_level ?? 0;
          const warnings = motor?.warning_count ?? 0;
          const stalls = motor?.stall_count ?? 0;
          const hours = motor?.hours_run ?? 0;
          const stressColor = getStressColor(stress);

          return (
            <div
              key={motorId}
              className="flex flex-col gap-2 p-3 rounded-lg"
              style={{
                background: 'rgba(17,24,39,0.6)',
                border: `2px solid ${isOffline ? 'var(--border-dim)' : stressColor}`,
                opacity: isOffline ? 0.5 : 1,
                transition: 'border-color 0.3s ease',
              }}
            >
              {/* Motor Label */}
              <div className="flex items-center justify-between">
                <span
                  className="text-xs font-bold tracking-widest"
                  style={{ color: 'var(--text-primary)' }}
                >
                  {MOTOR_LABELS[motorId]}
                </span>
                <span
                  className="text-[9px] font-mono"
                  style={{ color: 'var(--text-muted)' }}
                >
                  ID {motorId}
                </span>
              </div>

              {/* Stress Level Heatmap */}
              <div
                className="flex items-center justify-center rounded-md py-4"
                style={{
                  background: `linear-gradient(135deg, ${stressColor}22, ${stressColor}11)`,
                  border: `1px solid ${stressColor}`,
                }}
              >
                <div className="text-center">
                  <div
                    className="text-3xl font-bold"
                    style={{
                      color: stressColor,
                      textShadow: isOffline ? 'none' : `0 0 12px ${stressColor}`,
                    }}
                  >
                    {stress}
                  </div>
                  <div
                    className="text-[9px] tracking-widest mt-1"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    STRESS LEVEL
                  </div>
                </div>
              </div>

              {/* Metrics Row */}
              <div className="grid grid-cols-3 gap-1.5">
                <MetricBadge
                  icon={<AlertTriangle size={10} />}
                  value={warnings}
                  color="#eab308"
                  label="WARN"
                  offline={isOffline}
                />
                <MetricBadge
                  icon={<XCircle size={10} />}
                  value={stalls}
                  color="#ef4444"
                  label="STALL"
                  offline={isOffline}
                />
                <MetricBadge
                  icon={<Clock size={10} />}
                  value={formatHours(hours)}
                  color="#22c55e"
                  label="RUN"
                  offline={isOffline}
                  isText
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer Info */}
      <div
        className="px-3 py-2 rounded-lg text-center"
        style={{
          background: 'rgba(17,24,39,0.6)',
          border: '1px solid var(--border-dim)',
        }}
      >
        <span
          className="text-[9px] tracking-wider"
          style={{ color: 'var(--text-muted)' }}
        >
          {isOffline
            ? 'Chờ dữ liệu từ ESP32 type 143...'
            : `Cập nhật lần cuối: ${new Date(lastUpdate).toLocaleTimeString('vi-VN')}`}
        </span>
      </div>
    </div>
  );
}

// ── Subcomponents ──────────────────────────────────────────────────────────

function MetricBadge({
  icon,
  value,
  color,
  label,
  offline,
  isText = false,
}: {
  icon: React.ReactNode;
  value: number | string;
  color: string;
  label: string;
  offline: boolean;
  isText?: boolean;
}) {
  return (
    <div
      className="flex flex-col items-center gap-0.5 p-1.5 rounded"
      style={{
        background: 'rgba(8,11,16,0.6)',
        border: '1px solid var(--border-dim)',
      }}
    >
      <div style={{ color: offline ? 'var(--text-muted)' : color }}>
        {icon}
      </div>
      <span
        className="text-xs font-bold"
        style={{
          color: offline ? 'var(--text-muted)' : color,
          textShadow: offline ? 'none' : `0 0 6px ${color}`,
        }}
      >
        {value}
      </span>
      <span
        className="text-[8px] tracking-wider"
        style={{ color: 'var(--text-muted)' }}
      >
        {label}
      </span>
    </div>
  );
}
