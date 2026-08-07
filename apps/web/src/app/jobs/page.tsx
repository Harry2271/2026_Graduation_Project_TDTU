'use client';

import { useMemo, useState } from 'react';
import { App, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { Clock, Timer, Truck } from 'lucide-react';
import { useGetJobsQuery } from '@/store/services/inventoryApi';
import type { Job, JobPhase, JobStatus } from '@/types/inventory';

/* ─── Helpers ────────────────────────────────────────────────────── */

function formatMs(ms: number | undefined): string {
  if (ms === undefined || ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const rem = (sec % 60).toFixed(0);
  return `${min}p ${rem}s`;
}

const STATUS_CONFIG: Record<JobStatus, { label: string; color: string; bg: string }> = {
  QUEUED:      { label: 'Trong hàng đợi', color: '#a855f7', bg: 'rgba(168,85,247,0.12)' },
  DISPATCHED:  { label: 'Chờ xử lý',  color: '#ffb800', bg: 'rgba(255,184,0,0.12)' },
  IN_PROGRESS: { label: 'Đang di chuyển', color: '#00d4ff', bg: 'rgba(0,212,255,0.12)' },
  COMPLETED:   { label: 'Hoàn thành',  color: '#00ff88', bg: 'rgba(0,255,136,0.12)' },
  FAILED:      { label: 'Thất bại',    color: '#ff4444', bg: 'rgba(255,68,68,0.12)' },
  CANCELLED:   { label: 'Đã huỷ',     color: '#888', bg: 'rgba(255,255,255,0.08)' },
};

const PHASE_CONFIG: Record<JobPhase, { label: string; color: string }> = {
  NONE:              { label: '—',          color: '#888' },
  NAVIGATE_DROPOFF:  { label: 'Đến đổ',     color: '#00d4ff' },
  AT_DOCK:           { label: 'Căn AprilTag', color: '#ffb800' },
  UNLOADING:         { label: 'Đang đổ',    color: '#a855f7' },
  RETURNING:         { label: 'Về nhà',     color: '#00ff88' },
};

/* ─── Page ───────────────────────────────────────────────────────── */

export default function JobsPage() {
  const { data: jobs = [], isLoading } = useGetJobsQuery();
  const [filterStatus, setFilterStatus] = useState<JobStatus | null>(null);

  const filteredJobs = useMemo(() => {
    if (!filterStatus) return jobs;
    return jobs.filter((j) => j.status === filterStatus);
  }, [jobs, filterStatus]);

  /* ── Stats ──────────────────────────────────────────────────────── */

  const stats = useMemo(() => {
    const completed = jobs.filter((j) => j.status === 'COMPLETED' && j.totalDurationMs);
    if (completed.length === 0) return null;
    const durations = completed.map((j) => j.totalDurationMs!);
    const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
    const min = Math.min(...durations);
    const max = Math.max(...durations);
    return { count: completed.length, avg, min, max };
  }, [jobs]);

  /* ── Table columns ─────────────────────────────────────────────── */

  const columns: ColumnsType<Job> = [
    {
      title: '',
      key: 'idx',
      width: 36,
      render: (_: unknown, __: Job, idx: number) => (
        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}>
          {idx + 1}
        </span>
      ),
    },
    {
      title: 'Tuyến đường',
      key: 'route',
      render: (_: unknown, record: Job) => (
        <div className="flex items-center gap-2">
          <Truck size={13} style={{ color: 'var(--accent)', flexShrink: 0 }} />
          <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}>
            Home
          </span>
          <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>→</span>
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--accent)', fontFamily: "'JetBrains Mono', monospace" }}>
            {record.toSlotCode}
          </span>
        </div>
      ),
    },
    {
      title: 'Trạng thái',
      key: 'status',
      width: 120,
      render: (_: unknown, record: Job) => {
        const cfg = STATUS_CONFIG[record.status];
        return (
          <Tag style={{ borderRadius: 6, background: cfg.bg, border: `1px solid ${cfg.color}40`, color: cfg.color, fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, fontSize: 10 }}>
            {cfg.label}
          </Tag>
        );
      },
    },
    {
      title: 'Pha',
      key: 'phase',
      width: 100,
      render: (_: unknown, record: Job) => {
        const phase = record.phase ?? 'NONE';
        const cfg = PHASE_CONFIG[phase];
        const isLive = record.status === 'IN_PROGRESS' && phase !== 'NONE';
        return (
          <span style={{
            fontSize: 10,
            fontWeight: 700,
            color: cfg.color,
            fontFamily: "'JetBrains Mono', monospace",
            animation: isLive ? 'pulse 1.5s ease-in-out infinite' : undefined,
          }}>
            {cfg.label}
          </span>
        );
      },
    },
    {
      title: <div className="flex items-center gap-1"><Timer size={12} />Đến đổ hàng</div>,
      key: 'travelToDropoff',
      width: 110,
      render: (_: unknown, record: Job) => (
        <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontFamily: "'JetBrains Mono', monospace" }}>
          {formatMs(record.travelToDropoffMs)}
        </span>
      ),
    },
    {
      title: <div className="flex items-center gap-1"><Timer size={12} />Đổ hàng</div>,
      key: 'unload',
      width: 90,
      render: (_: unknown, record: Job) => (
        <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontFamily: "'JetBrains Mono', monospace" }}>
          {formatMs(record.unloadDurationMs)}
        </span>
      ),
    },
    {
      title: <div className="flex items-center gap-1"><Clock size={12} />Tổng cộng</div>,
      key: 'total',
      width: 110,
      render: (_: unknown, record: Job) => {
        const ms = record.totalDurationMs;
        if (!ms) return <span style={{ color: 'var(--text-muted)' }}>—</span>;
        const isComplete = record.status === 'COMPLETED';
        return (
          <span style={{
            fontSize: 13,
            fontWeight: 800,
            color: isComplete ? 'var(--success)' : 'var(--accent)',
            fontFamily: "'JetBrains Mono', monospace",
          }}>
            {formatMs(ms)}
          </span>
        );
      },
    },
    {
      title: 'Thời gian tạo',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 130,
      render: (date: string) => date
        ? <span style={{ color: 'var(--text-muted)', fontSize: 10, fontFamily: "'JetBrains Mono', monospace" }}>
            {new Date(date).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
          </span>
        : '—',
    },
  ];

  /* ── Render ─────────────────────────────────────────────────────── */

  return (
    <div className="flex-1 flex flex-col h-full overflow-auto" style={{ background: 'var(--bg-void)' }}>
      {/* Header */}
      <div className="px-4 md:px-8 py-4" style={{ borderBottom: '1px solid var(--border-dim)' }}>
        <div className="flex items-center gap-3">
          <Clock size={20} style={{ color: 'var(--accent)' }} />
          <h1 style={{ fontSize: 18, fontFamily: "'JetBrains Mono', monospace", color: 'var(--text-primary)', fontWeight: 900, letterSpacing: '-0.02em' }}>
            LỊCH SỬ VẬN CHUYỂN
          </h1>
          <span className="badge badge-cyan" style={{ fontSize: 8, letterSpacing: '0.12em' }}>LIVE</span>
        </div>
        <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}>
          Theo dõi thời gian di chuyển từ điểm lấy hàng đến khu vực đổ hàng
        </p>
      </div>

      {/* Stats banner */}
      {stats && (
        <div className="px-4 md:px-8 py-3 flex gap-6 flex-wrap" style={{ borderBottom: '1px solid var(--border-dim)', background: 'var(--bg-surface)' }}>
          <StatItem label="Hoàn thành" value={`${stats.count}`} unit="chuyến" accent="var(--accent)" />
          <StatItem label="TB thời gian" value={formatMs(stats.avg)} accent="var(--success)" />
          <StatItem label="Nhanh nhất" value={formatMs(stats.min)} accent="#00ff88" />
          <StatItem label="Chậm nhất" value={formatMs(stats.max)} accent="#ffb800" />
        </div>
      )}

      {/* Status filter chips */}
      <div className="px-4 md:px-8 py-2 flex gap-2 flex-wrap" style={{ borderBottom: '1px solid var(--border-dim)' }}>
        <FilterChip label="Tất cả" active={!filterStatus} onClick={() => setFilterStatus(null)} />
        {Object.entries(STATUS_CONFIG).map(([key, cfg]) => (
          <FilterChip
            key={key}
            label={cfg.label}
            active={filterStatus === key}
            color={cfg.color}
            onClick={() => setFilterStatus(filterStatus === key ? null : key as JobStatus)}
          />
        ))}
      </div>

      {/* Table */}
      <div className="flex-1 px-4 md:px-8 py-4">
        <Table<Job>
          columns={columns}
          dataSource={filteredJobs}
          rowKey="_id"
          size="small"
          loading={isLoading}
          pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (total) => `${total} chuyến` }}
          scroll={{ x: 900 }}
          locale={{ emptyText: 'Chưa có lịch sử vận chuyển' }}
          rowClassName={(record) => record.status === 'IN_PROGRESS' ? 'animate-pulse' : ''}
        />
      </div>
    </div>
  );
}

/* ─── Sub-components ────────────────────────────────────────────── */

function StatItem({ label, value, unit, accent }: { label: string; value: string; unit?: string; accent: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {label}
      </span>
      <span style={{ fontSize: 16, fontWeight: 900, color: accent, fontFamily: "'JetBrains Mono', monospace" }}>
        {value}
      </span>
      {unit && (
        <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}>
          {unit}
        </span>
      )}
    </div>
  );
}

function FilterChip({ label, active, color, onClick }: { label: string; active: boolean; color?: string; onClick: () => void }) {
  const c = color || 'var(--accent)';
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-3 py-1 rounded-full text-[10px] font-bold transition-all"
      style={{
        background: active ? `${c}20` : 'transparent',
        border: `1px solid ${active ? c : 'var(--border-dim)'}`,
        color: active ? c : 'var(--text-muted)',
        cursor: 'pointer',
        fontFamily: "'JetBrains Mono', monospace",
        letterSpacing: '0.04em',
      }}
    >
      {label}
    </button>
  );
}
