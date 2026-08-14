'use client';

import { useMemo, useState } from 'react';
import { Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { Clock, Timer, Truck } from 'lucide-react';
import { useGetJobsQuery } from '@/store/services/inventoryApi';
import type { Job, JobStatus } from '@/types/inventory';

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

const STATUS_LABELS: Record<JobStatus, string> = {
  QUEUED: 'Trong hàng đợi',
  DISPATCHED: 'Chờ xử lý',
  IN_PROGRESS: 'Đang di chuyển',
  COMPLETED: 'Hoàn thành',
  FAILED: 'Thất bại',
  CANCELLED: 'Đã huỷ',
};

function completedTime(job: Job): number {
  return job.completedAt ? new Date(job.completedAt).getTime() : 0;
}

function compareHistory(a: Job, b: Job): number {
  return completedTime(b) - completedTime(a)
    || new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime();
}

/* ─── Page ───────────────────────────────────────────────────────── */

export default function JobsPage() {
  const { data: jobs = [], isLoading } = useGetJobsQuery();
  const [filterStatus, setFilterStatus] = useState<JobStatus | null>(null);

  const filteredJobs = useMemo(() => {
    const visibleJobs = filterStatus ? jobs.filter((job) => job.status === filterStatus) : jobs;
    return [...visibleJobs].sort(compareHistory);
  }, [jobs, filterStatus]);

  /* ── Stats ──────────────────────────────────────────────────────── */

  const stats = useMemo(() => {
    const completed = jobs.filter((job) => job.status === 'COMPLETED' && job.fullCycleDurationMs);
    if (completed.length === 0) return null;
    const durations = completed.map((job) => job.fullCycleDurationMs!);
    const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
    const min = Math.min(...durations);
    const max = Math.max(...durations);
    return { count: completed.length, avg, min, max };
  }, [jobs]);

  /* ── Table columns ─────────────────────────────────────────────── */

  const columns: ColumnsType<Job> = [
    {
      title: 'STT',
      key: 'idx',
      width: 64,
      render: (_: unknown, __: Job, idx: number) => (
        <span style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}>
          {idx + 1}
        </span>
      ),
    },
    {
      title: 'Home',
      key: 'home',
      width: 140,
      render: () => (
        <div className="flex items-center gap-2">
          <Truck size={14} style={{ color: 'var(--accent)', flexShrink: 0 }} />
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', fontFamily: "'JetBrains Mono', monospace" }}>
            Home
          </span>
        </div>
      ),
    },
    {
      title: 'Place',
      dataIndex: 'toSlotCode',
      key: 'place',
      width: 160,
      render: (place: string) => (
        <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--accent)', fontFamily: "'JetBrains Mono', monospace" }}>
          {place}
        </span>
      ),
    },
    {
      title: <div className="flex items-center gap-1"><Clock size={12} />Thời gian hoàn thành</div>,
      dataIndex: 'completedAt',
      key: 'completedAt',
      width: 190,
      render: (date?: string) => date
        ? <span style={{ color: 'var(--text-secondary)', fontSize: 12, fontFamily: "'JetBrains Mono', monospace" }}>
            {new Date(date).toLocaleString('vi-VN', {
              day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
            })}
          </span>
        : <span style={{ color: 'var(--text-muted)' }}>—</span>,
    },
    {
      title: <div className="flex items-center gap-1"><Timer size={12} />Tổng thời gian (t1 → tf)</div>,
      key: 'fullCycleDuration',
      width: 190,
      render: (_: unknown, record: Job) => (
        <span style={{
          fontSize: 13,
          fontWeight: 800,
          color: record.status === 'COMPLETED' ? 'var(--success)' : 'var(--text-muted)',
          fontFamily: "'JetBrains Mono', monospace",
        }}>
          {formatMs(record.fullCycleDurationMs)}
        </span>
      ),
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
          Theo dõi từng chuyến từ Home đến Place và quay về Home
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
        {Object.entries(STATUS_LABELS).map(([key, label]) => (
          <FilterChip
            key={key}
            label={label}
            active={filterStatus === key}
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
