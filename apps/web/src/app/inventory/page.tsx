'use client';

import { useState, useMemo } from 'react';
import {
  Button,
  Input,
  App,
  Badge,
  Table,
  Tag,
  Modal,
  Popconfirm,
  ConfigProvider,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  Search,
  Trash2,
  Hexagon,
  Box,
  Check,
  ChevronUp,
  ChevronDown,
} from 'lucide-react';
import {
  useGetPackagesQuery,
  useGetPackageStatsQuery,
  usePatchPackageStatusMutation,
  useDeletePackageMutation,
  useAssignToZoneMutation,
} from '@/store/services/inventoryApi';
import SlotDispatchPanel from '@/components/SlotDispatchPanel';
import type { Package, ZoneCode } from '@/types/inventory';

/* ─── Constants ────────────────────────────────────────────────────── */

const ZONE_CODES: ZoneCode[] = ['S1', 'S2', 'S3', 'S4'];

const ZONE_META: Record<ZoneCode, { label: string; accent: string; cubeBase: string; cubeLight: string; cubeDark: string }> = {
  S1: { label: 'Khu S1', accent: '#00d4ff', cubeBase: '#00b8e6', cubeLight: '#33e0ff', cubeDark: '#0090b3' },
  S2: { label: 'Khu S2', accent: '#00ff88', cubeBase: '#00cc6a', cubeLight: '#33ff99', cubeDark: '#009950' },
  S3: { label: 'Khu S3', accent: '#ffb800', cubeBase: '#e6a500', cubeLight: '#ffd24d', cubeDark: '#b38200' },
  S4: { label: 'Khu S4', accent: '#a855f7', cubeBase: '#9333ea', cubeLight: '#c084fc', cubeDark: '#7e22ce' },
};

const STATUS_LABELS: Record<string, string> = {
  CREATED: 'Đã tạo',
  IN_PROGRESS: 'Đang xử lý',
  FINISHED: 'Hoàn thành',
};

/* ─── Isometric cube (pure CSS) ───────────────────────────────────── */

function Cube3D({ size, colorBase, colorLight, colorDark }: {
  size: number;
  colorBase: string;
  colorLight: string;
  colorDark: string;
}) {
  const half = size / 2;
  // Front-right-down view: parent rotateX(30deg) rotateY(45deg) shows top + right + front
  // Individual face transforms: top face → translateZ; left face → rotateX(-90deg); right face → rotateY(90deg)
  return (
    <div style={{ flexShrink: 0, position: 'relative', width: size, height: size }}>
      {/* top face */}
      <div style={{
        position: 'absolute', width: size, height: size,
        transform: `translateZ(${half}px)`,
        background: `linear-gradient(135deg, ${colorLight}, ${colorBase})`,
        borderRadius: 2,
      }} />
      {/* left face */}
      <div style={{
        position: 'absolute', width: size, height: size,
        transform: `rotateX(-90deg) translateZ(${half}px)`,
        background: `linear-gradient(180deg, ${colorBase}, ${colorDark})`,
        borderRadius: 2,
      }} />
      {/* right face */}
      <div style={{
        position: 'absolute', width: size, height: size,
        transform: `rotateY(90deg) translateZ(${half}px)`,
        background: `linear-gradient(180deg, ${colorDark}, ${colorBase}dd)`,
        borderRadius: 2,
      }} />
    </div>
  );
}

/* ─── Zone card (corner position + 3D blocks) ─────────────────────── */

function ZoneCard({
  zone,
  count,
  isActive,
  isHighlight,
  isTarget,
  isSource,
  onSelect,
}: {
  zone: ZoneCode;
  count: number;
  isActive: boolean;
  isHighlight: boolean;
  isTarget: boolean;
  isSource: boolean;
  onSelect: () => void;
}) {
  const m = ZONE_META[zone];
  const cubeSize = 22;
  const blockCount = Math.min(count, 100);

  return (
    <button
      type="button"
      onClick={onSelect}
      className="relative overflow-hidden group"
      style={{
        background: isTarget
          ? `linear-gradient(135deg, ${m.accent}20, var(--bg-raised))`
          : isActive
            ? `linear-gradient(135deg, ${m.accent}15, var(--bg-raised))`
            : 'linear-gradient(135deg, var(--bg-raised), var(--bg-surface))',
        border: `1px solid ${isTarget ? m.accent + 'cc' : isActive ? m.accent + '55' : isHighlight ? m.accent + '40' : 'var(--border-dim)'}`,
        borderRadius: 16,
        cursor: isHighlight ? 'pointer' : 'default',
        transition: 'all 0.2s ease',
        boxShadow: isTarget
          ? `0 0 40px ${m.accent}30, 0 4px 24px rgba(0,0,0,0.4)`
          : isActive
            ? `0 0 30px ${m.accent}20, 0 4px 24px rgba(0,0,0,0.4)`
            : '0 4px 24px rgba(0,0,0,0.3)',
        textAlign: 'left',
        width: '100%',
        height: '100%',
        aspectRatio: '1 / 1',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Zone header */}
      <div className="px-5 pt-4 pb-3 flex items-center justify-between" style={{ borderBottom: `1px solid ${m.accent}20` }}>
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span style={{ fontSize: 13, fontWeight: 900, color: m.accent, fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.06em' }}>
              {m.label}
            </span>
          </div>
          <span style={{ fontSize: 28, fontWeight: 900, color: 'var(--text-primary)', fontFamily: "'JetBrains Mono', monospace", letterSpacing: '-0.03em' }}>
            {count}
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 6, fontFamily: "'JetBrains Mono', monospace" }}>
            kiện
          </span>
        </div>

        {/* Source zone badge — current location of the selected package */}
        {isSource && (
          <div className="px-3 py-1.5 rounded-xl text-[10px] font-bold"
            style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border-mid)', color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}>
            Hiện đang ở đây
          </div>
        )}
        {/* Target zone badge — staging before Xác nhận */}
        {isTarget && (
          <div className="px-3 py-1.5 rounded-xl text-[10px] font-bold"
            style={{
              background: `${m.accent}25`,
              border: `1px solid ${m.accent}`,
              color: m.accent,
              fontFamily: "'JetBrains Mono', monospace",
              boxShadow: `0 0 12px ${m.accent}35`,
              animation: 'pulse-assign 1.5s ease-in-out infinite',
            }}>
            Khu đích ← bấm (Xác nhận ở trên)
          </div>
        )}
        {/* Other zone — selectable target */}
        {isHighlight && !isTarget && !isSource && (
          <div className="px-3 py-1.5 rounded-xl text-[10px] font-bold"
            style={{
              background: `${m.accent}10`,
              border: `1px solid ${m.accent}40`,
              color: m.accent,
              fontFamily: "'JetBrains Mono', monospace",
            }}>
            Chọn làm khu đích
          </div>
        )}
      </div>

      {/* 3D block field */}
      <div
        className="flex-1 relative px-4 pt-6 pb-4 flex items-center justify-center"
        style={{
          perspective: 700,
          perspectiveOrigin: '55% 30%',
          overflow: 'hidden',
        }}
      >
        <div
          className="flex flex-wrap gap-1 items-end content-start"
          style={{
            transformStyle: 'preserve-3d',
            transform: 'rotateX(30deg) rotateY(45deg)',
            maxWidth: '90%',
          }}
        >
          {Array.from({ length: blockCount }).map((_, i) => (
            <Cube3D
              key={i}
              size={cubeSize}
              colorBase={m.cubeBase}
              colorLight={m.cubeLight}
              colorDark={m.cubeDark}
            />
          ))}
        </div>

        {/* Glow overlay when active */}
        {isActive && (
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background: `radial-gradient(ellipse at 50% 100%, ${m.accent}08 0%, transparent 60%)`,
            }}
          />
        )}
      </div>
    </button>
  );
}

/* ─── Main page ───────────────────────────────────────────────────── */

export default function InventoryPage() {
  const { notification } = App.useApp();

  // UI state
  const [zoneFilter, setZoneFilter] = useState<ZoneCode | null>(null);
  const [selectedPkgId, setSelectedPkgId] = useState<string | null>(null);
  const [targetZone, setTargetZone] = useState<ZoneCode | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [listOpen, setListOpen] = useState(true);
  const [isFinishOpen, setIsFinishOpen] = useState(false);
  const [finishPkg, setFinishPkg] = useState<Package | null>(null);
  const [viewMode, setViewMode] = useState<'zone' | 'slot'>('zone');

  // Data
  const { data: packages = [], isLoading: isPackagesLoading } = useGetPackagesQuery();
  const { data: stats, isLoading: isStatsLoading } = useGetPackageStatsQuery();
  const [patchStatus, { isLoading: isFinishing }] = usePatchPackageStatusMutation();
  const [deletePackage, { isLoading: isDeleting }] = useDeletePackageMutation();
  const [assignToZone, { isLoading: isAssigning }] = useAssignToZoneMutation();

  const activeCount = useMemo(() => packages.filter((p) => p.status !== 'FINISHED').length, [packages]);
  const isLoading = isPackagesLoading || isStatsLoading;

  // Count packages per zone
  const zoneCounts = useMemo(() => {
    const counts: Record<ZoneCode, number> = { S1: 0, S2: 0, S3: 0, S4: 0 };
    packages.forEach((p) => { if (p.zoneCode && p.status !== 'FINISHED') counts[p.zoneCode]++; });
    return counts;
  }, [packages]);

  // Filtered package list
  const filteredPackages = useMemo(() => {
    let list = packages.filter((p) => p.status !== 'FINISHED');
    if (zoneFilter) list = list.filter((p) => p.zoneCode === zoneFilter);
    if (searchTerm) {
      const t = searchTerm.toLowerCase();
      list = list.filter((p) => p.packageName.toLowerCase().includes(t) || p._id.toLowerCase().includes(t));
    }
    return list;
  }, [packages, zoneFilter, searchTerm]);

  // Selected package info
  const selectedPkg = useMemo(() => packages.find((p) => p._id === selectedPkgId) ?? null, [packages, selectedPkgId]);

  /* ── Handlers ──────────────────────────────────────────────────── */

  const handleZoneSelect = (zone: ZoneCode) => {
    // With a pending package, clicking any zone stages it as target (not immediate)
    if (selectedPkg) {
      if (selectedPkg.zoneCode === zone) {
        // same zone as current → deselect target
        setTargetZone((prev) => (prev === zone ? null : zone));
      } else {
        setTargetZone(zone);
      }
      return;
    }
    // No package selected → toggle filter
    setZoneFilter((prev) => (prev === zone ? null : zone));
  };

  const handleConfirmMove = async () => {
    if (!selectedPkg || !targetZone) return;
    await handleAssignZone(selectedPkg._id, targetZone);
    setSelectedPkgId(null);
    setTargetZone(null);
  };

  const handleCancelMove = () => {
    setSelectedPkgId(null);
    setTargetZone(null);
  };

  const handleAssignZone = async (pkgId: string, zoneCode: ZoneCode) => {
    try {
      await assignToZone({ id: pkgId, zoneCode }).unwrap();
      const pkg = packages.find((p) => p._id === pkgId);
      notification.success({
        message: 'Thành công',
        description: `${pkg?.packageName ?? 'Kiện hàng'} đã chuyển vào ${zoneCode}`,
        placement: 'topRight',
      });
      setSelectedPkgId(null);
    } catch {
      notification.error({ message: 'Thất bại', description: 'Không thể cập nhật khu.', placement: 'topRight' });
    }
  };

  const handleSelectPkg = (pkg: Package) => {
    setSelectedPkgId((prev) => (prev === pkg._id ? null : pkg._id));
  };

  const handleFinish = async () => {
    if (!finishPkg) return;
    try {
      await patchStatus({ id: finishPkg._id, status: 'FINISHED' }).unwrap();
      notification.success({ message: 'Thành công', description: `${finishPkg.packageName} đã hoàn thành.`, placement: 'topRight' });
      setIsFinishOpen(false);
      setFinishPkg(null);
      if (selectedPkgId === finishPkg._id) setSelectedPkgId(null);
    } catch {
      notification.error({ message: 'Thất bại', description: 'Không thể cập nhật trạng thái.', placement: 'topRight' });
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deletePackage(id).unwrap();
      notification.success({ message: 'Thành công', description: 'Đã xóa kiện hàng.', placement: 'topRight' });
      if (selectedPkgId === id) setSelectedPkgId(null);
    } catch {
      notification.error({ message: 'Thất bại', description: 'Không thể xóa kiện hàng.', placement: 'topRight' });
    }
  };

  /* ── Table columns ─────────────────────────────────────────────── */

  const columns: ColumnsType<Package> = [
    {
      title: '',
      key: 'select',
      width: 40,
      render: (_: unknown, record: Package) => (
        <button
          type="button"
          onClick={() => handleSelectPkg(record)}
          className="w-5 h-5 rounded-md flex items-center justify-center transition-all"
          style={{
            border: `2px solid ${selectedPkgId === record._id ? 'var(--accent)' : 'var(--border-mid)'}`,
            background: selectedPkgId === record._id ? 'var(--accent)' : 'transparent',
            cursor: 'pointer',
          }}
        >
          {selectedPkgId === record._id && <Check size={12} style={{ color: '#080b10' }} />}
        </button>
      ),
    },
    {
      title: 'Tên kiện hàng',
      dataIndex: 'packageName',
      key: 'name',
      sorter: (a, b) => a.packageName.localeCompare(b.packageName),
      render: (name: string, record: Package) => (
        <div className="flex items-center gap-3">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
            style={{ background: 'rgba(0,212,255,0.08)', border: '1px solid rgba(0,212,255,0.15)' }}
          >
            <Box size={14} style={{ color: 'var(--accent)' }} />
          </div>
          <div className="min-w-0">
            <p className="text-[12px] font-bold truncate" style={{ color: 'var(--text-primary)', fontFamily: "'JetBrains Mono', monospace" }}>
              {name}
            </p>
            <p className="text-[9px]" style={{ color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace", opacity: 0.6 }}>
              #{record._id.slice(-8).toUpperCase()}
            </p>
          </div>
        </div>
      ),
    },
    {
      title: 'Khu',
      key: 'zone',
      width: 90,
      render: (_: unknown, record: Package) => {
        if (!record.zoneCode) return <span className="text-[11px]" style={{ color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}>—</span>;
        const c = ZONE_META[record.zoneCode];
        return (
          <Tag style={{ borderRadius: 6, background: `${c.accent}15`, border: `1px solid ${c.accent}35`, color: c.accent, fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, fontSize: 11 }}>
            {record.zoneCode}
          </Tag>
        );
      },
    },
    {
      title: 'Ngày tạo',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 140,
      responsive: ['md' as const],
      render: (date: string) => date
        ? <span style={{ color: 'var(--text-secondary)', fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>
            {new Date(date).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
          </span>
        : <span style={{ color: 'var(--text-muted)' }}>—</span>,
    },
    {
      title: '',
      key: 'actions',
      width: 130,
      render: (_: unknown, record: Package) => (
        <div className="flex gap-1.5">
          <Button size="small" onClick={() => { setFinishPkg(record); setIsFinishOpen(true); }}
            style={{ borderRadius: 8, background: 'rgba(0,255,136,0.08)', border: '1px solid rgba(0,255,136,0.2)', color: 'var(--success)', fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, fontSize: 11 }}>
            Hoàn tất
          </Button>
          <Popconfirm title="Xóa kiện hàng?" okText="Xóa" cancelText="Hủy" okButtonProps={{ danger: true, loading: isDeleting }} onConfirm={() => void handleDelete(record._id)}>
            <Button size="small" danger icon={<Trash2 size={11} />} style={{ borderRadius: 8 }} />
          </Popconfirm>
        </div>
      ),
    },
  ];

  /* ── Render ─────────────────────────────────────────────────────── */

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden" style={{ background: 'var(--bg-void)' }}>

      {/* Main area */}
      <div className="flex-1 flex flex-col h-full overflow-hidden">
        {/* Loading overlay */}
        {isLoading && (
          <div className="absolute inset-0 z-50 flex items-center justify-center"
            style={{ background: 'rgba(8,11,16,0.7)', backdropFilter: 'blur(4px)' }}>
            <span className="text-xs animate-pulse" style={{ color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}>
              Đang tải dữ liệu kho...
            </span>
          </div>
        )}

        {/* Header */}
        <div className="px-4 md:px-8 py-4" style={{ borderBottom: '1px solid var(--border-dim)', boxShadow: '0 4px 24px rgba(0,0,0,0.3)' }}>
          <div className="flex flex-wrap gap-3 justify-between items-center">
            <div className="flex items-center gap-3">
              <Hexagon size={20} style={{ color: 'var(--accent)' }} />
              <h1 className="text-lg md:text-xl" style={{ fontFamily: "'JetBrains Mono', monospace", color: 'var(--text-primary)', fontWeight: 900, letterSpacing: '-0.02em' }}>
                KHO HÀNG
              </h1>
              <span className="badge badge-cyan" style={{ fontSize: 8, letterSpacing: '0.12em' }}>LIVE</span>
              <Badge count={activeCount} style={{ backgroundColor: 'rgba(0,212,255,0.15)', color: 'var(--accent)', border: '1px solid rgba(0,212,255,0.25)', fontFamily: "'JetBrains Mono', monospace", fontSize: 10, fontWeight: 700, boxShadow: 'none' }} showZero />
            </div>
            <div className="flex items-center gap-1" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
              <button
                type="button"
                onClick={() => setViewMode('zone')}
                className="px-3 py-1.5 rounded-lg text-[10px] font-bold"
                style={{
                  background: viewMode === 'zone' ? 'var(--accent)' : 'transparent',
                  color: viewMode === 'zone' ? '#080b10' : 'var(--text-muted)',
                  border: `1px solid ${viewMode === 'zone' ? 'var(--accent)' : 'var(--border-mid)'}`,
                  cursor: 'pointer',
                }}
              >
                Khu
              </button>
              <button
                type="button"
                onClick={() => setViewMode('slot')}
                className="px-3 py-1.5 rounded-lg text-[10px] font-bold"
                style={{
                  background: viewMode === 'slot' ? 'var(--accent)' : 'transparent',
                  color: viewMode === 'slot' ? '#080b10' : 'var(--text-muted)',
                  border: `1px solid ${viewMode === 'slot' ? 'var(--accent)' : 'var(--border-mid)'}`,
                  cursor: 'pointer',
                }}
              >
                Điều xe
              </button>
            </div>
            {selectedPkg && (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl text-[11px]"
                style={{ background: 'var(--accent-dim)', border: '1px solid rgba(0,212,255,0.25)', color: 'var(--accent)', fontFamily: "'JetBrains Mono', monospace", fontWeight: 700 }}>
                <span className="w-2 h-2 rounded-full" style={{ background: 'var(--accent)' }} />
                {selectedPkg.packageName}
                <button type="button" onClick={() => { setSelectedPkgId(null); setTargetZone(null); }} className="ml-1 opacity-60 hover:opacity-100" style={{ cursor: 'pointer' }}>✕</button>
              </div>
            )}
          </div>
          {selectedPkg && !targetZone && (
            <p className="text-[10px] mt-2" style={{ color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}>
              Bấm vào khu đích bên dưới
            </p>
          )}
          {selectedPkg && targetZone && (
            <div className="mt-2 flex items-center gap-3 text-[11px] px-3 py-2 rounded-xl"
              style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-mid)', fontFamily: "'JetBrains Mono', monospace" }}>
              <span style={{ color: 'var(--text-muted)' }}>Chuyển</span>
              <span style={{ color: 'var(--accent)', fontWeight: 700 }}>{selectedPkg.packageName}</span>
              <span style={{ color: 'var(--text-muted)' }}>→</span>
              <span style={{ color: ZONE_META[targetZone].accent, fontWeight: 700 }}>{targetZone}</span>
              <button type="button" disabled={isAssigning}
                onClick={() => void handleConfirmMove()}
                className="ml-auto px-4 py-1.5 rounded-lg text-[11px] font-bold transition-all"
                style={{
                  background: isAssigning ? 'rgba(0,212,255,0.2)' : 'var(--accent)',
                  border: 'none', color: '#080b10',
                  cursor: isAssigning ? 'not-allowed' : 'pointer',
                  fontFamily: "'JetBrains Mono', monospace",
                }}>
                {isAssigning ? '...' : 'Xác nhận'}
              </button>
              <button type="button" onClick={handleCancelMove}
                className="px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all"
                style={{
                  background: 'transparent',
                  border: '1px solid var(--border-mid)',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                  fontFamily: "'JetBrains Mono', monospace",
                }}>
                Huỷ
              </button>
            </div>
          )}
        </div>

        {/* ── 4-Zone grid (2×2) or Slot dispatch panel ─────────────── */}
        {viewMode === 'slot' ? (
          <div className="flex-1 p-4 md:p-6 overflow-auto">
            <SlotDispatchPanel />
          </div>
        ) : (
          <>
            <div className="flex-1 p-4 md:p-6 grid grid-cols-1 md:grid-cols-2 gap-4 overflow-auto" style={{ alignContent: 'start' }}>
              {ZONE_CODES.map((z) => (
                <ZoneCard
                  key={z}
                  zone={z}
                  count={zoneCounts[z]}
                  isActive={zoneFilter === z}
                  isHighlight={!!selectedPkg}
                  isTarget={!!selectedPkg && targetZone === z}
                  isSource={!!selectedPkg && selectedPkg.zoneCode === z}
                  onSelect={() => handleZoneSelect(z)}
                />
              ))}
            </div>

        {/* ── Package list toggle bar ──────────────────────────── */}
        <button
          type="button"
          onClick={() => setListOpen((v) => !v)}
          className="w-full flex items-center justify-center gap-2 py-2 transition-all"
          style={{
            background: 'var(--bg-surface)',
            borderTop: '1px solid var(--border-dim)',
            color: 'var(--text-muted)',
            cursor: 'pointer',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 11,
            letterSpacing: '0.04em',
          }}
        >
          {listOpen ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          Danh sách kiện hàng ({filteredPackages.length})
        </button>

        {/* ── Package list panel ────────────────────────────────── */}
        {listOpen && (
          <div style={{ background: 'var(--bg-surface)', borderTop: '1px solid var(--border-dim)', height: 320, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            {/* Search */}
            <div className="px-4 py-2" style={{ borderBottom: '1px solid var(--border-dim)' }}>
              <Input
                prefix={<Search size={13} style={{ color: 'var(--text-muted)' }} />}
                placeholder="Tìm kiện hàng..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                allowClear
                size="small"
                style={{ background: 'var(--bg-base)', border: '1px solid var(--border-dim)', borderRadius: 8, fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: 'var(--text-primary)' }}
              />
            </div>
            {/* Table */}
            <div className="flex-1 overflow-auto">
              <ConfigProvider theme={{ token: { colorBgContainer: 'transparent', colorBorderSecondary: 'var(--border-dim)', colorText: 'var(--text-primary)', fontFamily: "'JetBrains Mono', monospace" } }}>
                <Table<Package>
                  columns={columns}
                  dataSource={filteredPackages}
                  rowKey="_id"
                  size="small"
                  pagination={false}
                  scroll={{ y: 240 }}
                  onRow={(record) => ({ onClick: () => handleSelectPkg(record), style: { cursor: 'pointer', background: selectedPkgId === record._id ? 'rgba(0,212,255,0.06)' : undefined } })}
                />
              </ConfigProvider>
            </div>
          </div>
        )}
          </>
        )}
      </div>

      {/* ── Finish Confirmation Modal ──────────────────────────── */}
      <Modal
        title={<div className="flex items-center gap-2 font-bold" style={{ fontFamily: "'JetBrains Mono', monospace", color: 'var(--text-primary)' }}>Xác nhận hoàn tất</div>}
        open={isFinishOpen}
        onOk={handleFinish}
        onCancel={() => { setIsFinishOpen(false); setFinishPkg(null); }}
        okText="Hoàn tất"
        cancelText="Huỷ"
        centered
        okButtonProps={{ danger: true, loading: isFinishing }}
      >
        {finishPkg && (
          <div className="py-2 text-sm" style={{ color: 'var(--text-secondary)', fontFamily: "'JetBrains Mono', monospace" }}>
            <p>Xác nhận hoàn tất <strong style={{ color: 'var(--accent)' }}>{finishPkg.packageName}</strong>?</p>
            <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>Mã tag sẽ được giải phóng. Kiện hàng rời khỏi thống kê khu.</p>
          </div>
        )}
      </Modal>

      {/* ── Keyframes ──────────────────────────────────────────── */}
      <style>{`
        @keyframes pulse-assign {
          0%, 100% { box-shadow: 0 0 12px currentColor; opacity: 0.8; }
          50% { box-shadow: 0 0 24px currentColor; opacity: 1; }
        }
      `}</style>
    </div>
  );
}
