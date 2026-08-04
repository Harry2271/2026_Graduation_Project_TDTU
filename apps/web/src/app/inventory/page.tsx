'use client';

import { useState, useMemo, useCallback } from 'react';
import {
  Table,
  Button,
  Input,
  Popconfirm,
  Badge,
  Tag,
  Modal,
  Popover,
  App,
  Empty,
  Spin,
  ConfigProvider,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  Search,
  Edit3,
  Trash2,
  Hexagon,
  Box,
  AlertTriangle,
} from 'lucide-react';
import {
  useGetPackagesQuery,
  useGetPackageStatsQuery,
  usePatchPackageStatusMutation,
  useDeletePackageMutation,
  useAssignToZoneMutation,
} from '@/store/services/inventoryApi';
import type { Package, ZoneCode } from '@/types/inventory';

const ZONE_CODES: ZoneCode[] = ['S1', 'S2', 'S3', 'S4'];

const ZONE_COLORS: Record<ZoneCode, { bg: string; border: string; text: string; glow: string }> = {
  S1: { bg: 'rgba(0,212,255,0.08)', border: 'rgba(0,212,255,0.25)', text: 'var(--accent)', glow: 'rgba(0,212,255,0.3)' },
  S2: { bg: 'rgba(0,255,136,0.08)', border: 'rgba(0,255,136,0.25)', text: 'var(--success)', glow: 'rgba(0,255,136,0.3)' },
  S3: { bg: 'rgba(255,184,0,0.08)', border: 'rgba(255,184,0,0.25)', text: 'var(--warning)', glow: 'rgba(255,184,0,0.3)' },
  S4: { bg: 'rgba(168,85,247,0.08)', border: 'rgba(168,85,247,0.25)', text: '#a855f7', glow: 'rgba(168,85,247,0.3)' },
};

const STATUS_COLORS: Record<string, { bg: string; border: string; text: string; label: string }> = {
  CREATED: { bg: 'rgba(0,212,255,0.10)', border: 'rgba(0,212,255,0.30)', text: 'var(--accent)', label: 'Đã tạo' },
  IN_PROGRESS: { bg: 'rgba(255,184,0,0.10)', border: 'rgba(255,184,0,0.30)', text: 'var(--warning)', label: 'Đang xử lý' },
  FINISHED: { bg: 'rgba(0,255,170,0.08)', border: 'rgba(0,255,170,0.25)', text: 'var(--success)', label: 'Hoàn thành' },
};

function getZoneStyle(code: ZoneCode) {
  return ZONE_COLORS[code];
}

function getStatusStyle(code: string) {
  return STATUS_COLORS[code] ?? STATUS_COLORS.CREATED;
}

/* ════════════════════════════════════════════════════════════════════ */
/* Main Page                                                           */
/* ════════════════════════════════════════════════════════════════════ */

export default function InventoryPage() {
  const { notification } = App.useApp();

  const [searchTerm, setSearchTerm] = useState('');
  const [zoneFilter, setZoneFilter] = useState<ZoneCode | null>(null);
  const [assigningPkgId, setAssigningPkgId] = useState<string | null>(null);
  const [finishPkg, setFinishPkg] = useState<Package | null>(null);
  const [isFinishOpen, setIsFinishOpen] = useState(false);

  const { data: packages = [], isLoading: isPackagesLoading } = useGetPackagesQuery();
  const { data: stats, isLoading: isStatsLoading } = useGetPackageStatsQuery();
  const [patchStatus, { isLoading: isFinishing }] = usePatchPackageStatusMutation();
  const [deletePackage, { isLoading: isDeleting }] = useDeletePackageMutation();
  const [assignToZone, { isLoading: isAssigning }] = useAssignToZoneMutation();

  const activeCount = useMemo(
    () => packages.filter((p) => p.status !== 'FINISHED').length,
    [packages],
  );

  const isLoading = isPackagesLoading || isStatsLoading;

  const filteredPackages = useMemo(() => {
    let list = packages;
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      list = list.filter(
        (p) =>
          p.packageName.toLowerCase().includes(term) ||
          p._id.toLowerCase().includes(term) ||
          (p.tagId !== null && String(p.tagId).includes(term)),
      );
    }
    if (zoneFilter) {
      list = list.filter((p) => p.zoneCode === zoneFilter);
    }
    return list;
  }, [packages, searchTerm, zoneFilter]);

  /* ── Actions ────────────────────────────────────────────────────── */

  const handleZoneAssign = useCallback(
    async (pkgId: string, zoneCode: ZoneCode | null) => {
      try {
        await assignToZone({ id: pkgId, zoneCode }).unwrap();
        notification.success({
          message: 'Thành công',
          description: zoneCode
            ? `Đã đưa kiện hàng vào khu ${zoneCode}`
            : 'Đã đưa kiện hàng ra khỏi khu',
          placement: 'topRight',
        });
        setAssigningPkgId(null);
      } catch {
        notification.error({
          message: 'Thất bại',
          description: 'Không thể cập nhật khu.',
          placement: 'topRight',
        });
      }
    },
    [assignToZone, notification],
  );

  const handleFinish = useCallback(async () => {
    if (!finishPkg) return;
    try {
      await patchStatus({ id: finishPkg._id, status: 'FINISHED' }).unwrap();
      notification.success({
        message: 'Thành công',
        description: `${finishPkg.packageName} đã hoàn thành.`,
        placement: 'topRight',
      });
      setIsFinishOpen(false);
      setFinishPkg(null);
    } catch {
      notification.error({
        message: 'Thất bại',
        description: 'Không thể cập nhật trạng thái.',
        placement: 'topRight',
      });
    }
  }, [finishPkg, patchStatus, notification]);

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await deletePackage(id).unwrap();
        notification.success({
          message: 'Thành công',
          description: 'Đã xóa kiện hàng.',
          placement: 'topRight',
        });
      } catch {
        notification.error({
          message: 'Thất bại',
          description: 'Không thể xóa kiện hàng.',
          placement: 'topRight',
        });
      }
    },
    [deletePackage, notification],
  );

  /* ── Table columns ──────────────────────────────────────────────── */

  const columns: ColumnsType<Package> = [
    {
      title: 'Tên kiện hàng',
      dataIndex: 'packageName',
      key: 'packageName',
      sorter: (a, b) => a.packageName.localeCompare(b.packageName),
      render: (name: string, record: Package) => (
        <div className="flex items-center gap-3">
          <div
            className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
            style={{
              background: 'rgba(0,212,255,0.08)',
              border: '1px solid rgba(0,212,255,0.15)',
            }}
          >
            <Box size={16} style={{ color: 'var(--accent)' }} />
          </div>
          <div className="min-w-0">
            <p
              className="text-[13px] font-bold leading-tight truncate"
              style={{ color: 'var(--text-primary)', fontFamily: "'JetBrains Mono', monospace" }}
            >
              {name}
            </p>
            <p
              className="text-[10px] mt-0.5"
              style={{ color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace", opacity: 0.6 }}
            >
              #{record._id.slice(-8).toUpperCase()}
            </p>
          </div>
        </div>
      ),
    },
    {
      title: 'Trạng thái',
      key: 'status',
      width: 140,
      responsive: ['sm' as const],
      render: (_: unknown, record: Package) => {
        const c = getStatusStyle(record.status);
        return (
          <Tag
            style={{
              borderRadius: '8px',
              background: c.bg,
              border: `1px solid ${c.border}`,
              color: c.text,
              fontFamily: "'JetBrains Mono', monospace",
              fontWeight: 700,
              fontSize: '11px',
            }}
          >
            {c.label}
          </Tag>
        );
      },
    },
    {
      title: 'Khu',
      key: 'zone',
      width: 120,
      render: (_: unknown, record: Package) => {
        if (record.zoneCode) {
          const c = getZoneStyle(record.zoneCode);
          return (
            <Tag
              style={{
                borderRadius: '8px',
                background: c.bg,
                border: `1px solid ${c.border}`,
                color: c.text,
                fontFamily: "'JetBrains Mono', monospace",
                fontWeight: 700,
                fontSize: '11px',
              }}
            >
              {record.zoneCode}
            </Tag>
          );
        }
        return (
          <span
            className="text-[11px]"
            style={{ color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}
          >
            Chưa xếp
          </span>
        );
      },
    },
    {
      title: 'Ngày tạo',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 170,
      responsive: ['md' as const],
      sorter: (a, b) => {
        const da = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const db = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return da - db;
      },
      render: (date: string) =>
        date ? (
          <span style={{ color: 'var(--text-secondary)', fontSize: '12px', fontFamily: "'JetBrains Mono', monospace" }}>
            {new Date(date).toLocaleDateString('vi-VN', {
              day: '2-digit',
              month: '2-digit',
              year: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
        ) : (
          <span style={{ color: 'var(--text-muted)' }}>—</span>
        ),
    },
    {
      title: 'Thao tác',
      key: 'actions',
      width: 220,
      fixed: 'right' as const,
      render: (_: unknown, record: Package) => {
        const isFinished = record.status === 'FINISHED';
        return (
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'nowrap' }}>
            {/* Zone picker */}
            {!isFinished && (
              <Popover
                content={
                  <div style={{ padding: '4px 0' }}>
                    <p
                      style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: '11px',
                        fontWeight: 700,
                        color: 'var(--text-muted)',
                        marginBottom: '8px',
                        letterSpacing: '0.06em',
                        textTransform: 'uppercase',
                      }}
                    >
                      Chọn khu tập kết
                    </p>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '6px' }}>
                      {ZONE_CODES.map((z) => {
                        const active = record.zoneCode === z;
                        const c = getZoneStyle(z);
                        return (
                          <button
                            key={z}
                            type="button"
                            disabled={isAssigning}
                            onClick={() => handleZoneAssign(record._id, z)}
                            style={{
                              padding: '8px 16px',
                              borderRadius: '8px',
                              border: `1px solid ${active ? c.border : 'var(--border-mid)'}`,
                              background: active ? c.bg : 'var(--bg-raised)',
                              color: active ? c.text : 'var(--text-secondary)',
                              fontWeight: 700,
                              fontSize: '13px',
                              fontFamily: "'JetBrains Mono', monospace",
                              cursor: isAssigning ? 'not-allowed' : 'pointer',
                              opacity: isAssigning ? 0.5 : 1,
                              transition: 'all 0.15s ease',
                            }}
                          >
                            {z}
                          </button>
                        );
                      })}
                    </div>
                    {record.zoneCode && (
                      <button
                        type="button"
                        disabled={isAssigning}
                        onClick={() => handleZoneAssign(record._id, null)}
                        style={{
                          display: 'block',
                          width: '100%',
                          marginTop: '6px',
                          padding: '6px',
                          borderRadius: '8px',
                          border: '1px solid var(--border-dim)',
                          background: 'transparent',
                          color: 'var(--text-muted)',
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: '11px',
                          cursor: isAssigning ? 'not-allowed' : 'pointer',
                          opacity: isAssigning ? 0.5 : 1,
                        }}
                      >
                        Bỏ xếp
                      </button>
                    )}
                  </div>
                }
                trigger="click"
                open={assigningPkgId === record._id}
                onOpenChange={(open) => setAssigningPkgId(open ? record._id : null)}
                placement="bottomRight"
              >
                <Button
                  size="small"
                  disabled={isFinished}
                  style={{
                    borderRadius: '8px',
                    background: 'rgba(0,212,255,0.08)',
                    border: '1px solid rgba(0,212,255,0.2)',
                    color: 'var(--accent)',
                    fontFamily: "'JetBrains Mono', monospace",
                    fontWeight: 600,
                    fontSize: '12px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                  }}
                >
                  {record.zoneCode ? 'Chuyển khu' : 'Đưa vào khu'}
                </Button>
              </Popover>
            )}

            {/* Finish */}
            {!isFinished && (
              <Button
                size="small"
                onClick={() => { setFinishPkg(record); setIsFinishOpen(true); }}
                style={{
                  borderRadius: '8px',
                  background: 'rgba(0,255,136,0.08)',
                  border: '1px solid rgba(0,255,136,0.2)',
                  color: 'var(--success)',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontWeight: 600,
                  fontSize: '12px',
                }}
              >
                Hoàn tất
              </Button>
            )}

            {/* Delete */}
            <Popconfirm
              title="Xóa kiện hàng?"
              description="Thao tác này không thể hoàn tác."
              okText="Xóa"
              cancelText="Hủy"
              okButtonProps={{ danger: true, loading: isDeleting }}
              onConfirm={() => handleDelete(record._id)}
            >
              <Button
                size="small"
                danger
                icon={<Trash2 size={12} />}
                style={{ borderRadius: '8px' }}
              />
            </Popconfirm>
          </div>
        );
      },
    },
  ];

  /* ── Render ─────────────────────────────────────────────────────── */

  return (
    <div className="flex-1 min-h-0" style={{ background: 'var(--bg-void)' }}>

      {/* Loading overlay */}
      {isLoading && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(8,11,16,0.7)', backdropFilter: 'blur(4px)' }}
        >
          <div className="flex flex-col items-center gap-3">
            <Spin size="large" />
            <span
              className="text-xs"
              style={{ color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.06em' }}
            >
              Đang tải dữ liệu kho...
            </span>
          </div>
        </div>
      )}

      {/* ── Header ─────────────────────────────────────────────── */}
      <div
        className="relative overflow-hidden px-4 md:px-8 py-5"
        style={{
          background: 'linear-gradient(180deg, rgba(0,212,255,0.03) 0%, transparent 100%)',
          borderBottom: '1px solid var(--border-dim)',
          boxShadow: '0 4px 24px rgba(0,0,0,0.3)',
        }}
      >
        <div className="flex flex-wrap gap-3 justify-between items-start relative z-10">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <Hexagon size={22} style={{ color: 'var(--accent)' }} />
              <h1
                className="text-display text-xl md:text-2xl"
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  color: 'var(--text-primary)',
                  letterSpacing: '-0.02em',
                }}
              >
                KHO HÀNG
              </h1>
              <span className="badge badge-cyan" style={{ fontSize: '9px', letterSpacing: '0.12em' }}>
                LIVE
              </span>
              <Badge
                count={activeCount}
                style={{
                  backgroundColor: 'rgba(0,212,255,0.15)',
                  color: 'var(--accent)',
                  border: '1px solid rgba(0,212,255,0.25)',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: '10px',
                  fontWeight: 700,
                  boxShadow: 'none',
                }}
                showZero
                overflowCount={999}
              />
            </div>
            <p className="text-xs" style={{ color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.04em' }}>
              Đồ án Tốt nghiệp — Tôn Đức Thắng University &nbsp;|&nbsp; NEXUS Control System
            </p>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <span
              className="flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold"
              style={{
                background: 'rgba(0,255,136,0.08)',
                border: '1px solid rgba(0,255,136,0.2)',
                color: 'var(--success)',
                fontFamily: "'JetBrains Mono', monospace",
                letterSpacing: '0.06em',
              }}
            >
              <span
                className="w-2 h-2 rounded-full"
                style={{ background: 'var(--success)', boxShadow: '0 0 8px var(--success-glow)' }}
              />
              HỆ THỐNG ONLINE
            </span>
          </div>
        </div>
      </div>

      {/* ── Content ────────────────────────────────────────────── */}
      <div className="px-4 md:px-8 py-6" style={{ maxWidth: 1200, margin: '0 auto', width: '100%' }}>

        {/* ── Stats Widget ─────────────────────────────────────── */}
        {stats && (
          <div className="grid grid-cols-3 md:grid-cols-6 gap-3 mb-6">
            {/* Total */}
            <StatsCard
              icon={<Box size={18} />}
              label="TỔNG KIỆN"
              value={stats.total}
              bg="rgba(0,212,255,0.06)"
              border="rgba(0,212,255,0.2)"
              text="var(--accent)"
              onClick={() => setZoneFilter(null)}
              active={zoneFilter === null}
            />

            {/* S1–S4 */}
            {ZONE_CODES.map((z) => {
              const c = getZoneStyle(z);
              return (
                <StatsCard
                  key={z}
                  icon={
                    <span style={{ fontSize: '16px', fontWeight: 900, fontFamily: "'JetBrains Mono', monospace" }}>
                      {z}
                    </span>
                  }
                  label={`${z} ZONE`}
                  value={stats.zones[z]}
                  bg={c.bg}
                  border={c.border}
                  text={c.text}
                  glow={c.glow}
                  onClick={() => setZoneFilter(zoneFilter === z ? null : z)}
                  active={zoneFilter === z}
                />
              );
            })}

            {/* Unplaced */}
            <StatsCard
              icon={<AlertTriangle size={18} />}
              label="CHƯA XẾP"
              value={stats.unplaced}
              bg="rgba(255,184,0,0.06)"
              border="rgba(255,184,0,0.2)"
              text="var(--warning)"
              onClick={() => setZoneFilter(null)}
              active={zoneFilter === null && stats.unplaced > 0}
            />
          </div>
        )}

        {/* ── Filter Bar ───────────────────────────────────────── */}
        <div className="flex flex-col md:flex-row md:items-center gap-3 mb-5">
          <Input
            prefix={<Search size={16} style={{ color: 'var(--text-muted)' }} />}
            placeholder="Tìm theo tên, mã tag, hoặc _id..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            allowClear
            className="w-full md:max-w-sm"
            style={{
              borderRadius: '12px',
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-mid)',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '13px',
              color: 'var(--text-primary)',
            }}
          />
          <div className="flex gap-2 flex-wrap">
            {ZONE_CODES.map((z) => {
              const c = getZoneStyle(z);
              const active = zoneFilter === z;
              return (
                <button
                  key={z}
                  type="button"
                  onClick={() => setZoneFilter(active ? null : z)}
                  className="px-3 py-1.5 rounded-lg text-xs font-bold transition-all"
                  style={{
                    background: active ? c.bg : 'var(--bg-surface)',
                    border: `1px solid ${active ? c.border : 'var(--border-dim)'}`,
                    color: active ? c.text : 'var(--text-muted)',
                    fontFamily: "'JetBrains Mono', monospace",
                    boxShadow: active ? `0 0 12px ${c.glow}` : 'none',
                    cursor: 'pointer',
                  }}
                >
                  {z}
                </button>
              );
            })}
          </div>
        </div>

        {/* ── Package Table ────────────────────────────────────── */}
        {!isLoading && filteredPackages.length === 0 ? (
          <Empty
            description={
              <span style={{ color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace", fontSize: '12px' }}>
                {searchTerm || zoneFilter ? 'Không tìm thấy kiện hàng phù hợp.' : 'Chưa có kiện hàng nào.'}
              </span>
            }
            style={{ marginTop: '3rem' }}
          />
        ) : (
          <ConfigProvider
            theme={{
              token: {
                colorBgContainer: 'var(--bg-surface)',
                colorBorderSecondary: 'var(--border-dim)',
                colorText: 'var(--text-primary)',
                fontFamily: "'JetBrains Mono', monospace",
              },
            }}
          >
            <Table<Package>
              columns={columns}
              dataSource={filteredPackages}
              rowKey="_id"
              loading={isLoading}
              pagination={{
                pageSize: 12,
                showSizeChanger: false,
                showTotal: (total) => (
                  <span style={{ color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace", fontSize: '11px' }}>
                    Tổng cộng <strong style={{ color: 'var(--text-primary)' }}>{total}</strong> kiện hàng
                  </span>
                ),
                style: { marginTop: '16px' },
              }}
              scroll={{ x: 640 }}
              style={{ borderRadius: '12px', overflow: 'hidden' }}
            />
          </ConfigProvider>
        )}
      </div>

      {/* ── Finish Confirmation Modal ──────────────────────────── */}
      <Modal
        title={
          <div className="flex items-center gap-2 font-bold" style={{ fontFamily: "'JetBrains Mono', monospace", color: 'var(--text-primary)' }}>
            <AlertTriangle size={18} style={{ color: 'var(--warning)' }} />
            Xác nhận hoàn tất
          </div>
        }
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
            <p>
              Xác nhận hoàn tất kiện hàng{' '}
              <strong style={{ color: 'var(--accent)' }}>{finishPkg.packageName}</strong>?
            </p>
            <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
              Kiện hàng sẽ được đánh dấu hoàn thành. Mã tag sẽ được giải phóng.
            </p>
          </div>
        )}
      </Modal>

      {/* ── Keyframes ──────────────────────────────────────────── */}
      <style>{`
        @keyframes pulse-subtle {
          0%, 100% { box-shadow: 0 0 30px rgba(0,212,255,0.15), inset 0 1px 0 rgba(255,255,255,0.05); }
          50% { box-shadow: 0 0 50px rgba(0,212,255,0.25), inset 0 1px 0 rgba(255,255,255,0.08); }
        }
        @keyframes pulse-ring-cyan {
          0% { box-shadow: 0 0 0 0 rgba(0,212,255,0.2); opacity: 1; }
          100% { box-shadow: 0 0 0 20px rgba(0,212,255,0); opacity: 0; }
        }
      `}</style>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════ */
/* StatsCard sub-component                                             */
/* ════════════════════════════════════════════════════════════════════ */

function StatsCard({
  icon,
  label,
  value,
  bg,
  border,
  text,
  glow,
  onClick,
  active,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  bg: string;
  border: string;
  text: string;
  glow?: string;
  onClick?: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-xl p-3 text-center transition-all cursor-pointer"
      style={{
        background: active ? bg : 'var(--bg-surface)',
        border: `1px solid ${active ? border : 'var(--border-dim)'}`,
        boxShadow: active && glow ? `0 0 16px ${glow}` : 'none',
      }}
    >
      <div className="flex items-center justify-center gap-1.5 mb-1.5" style={{ color: text }}>
        {icon}
      </div>
      <p
        className="text-xl font-black leading-none"
        style={{ color: text, fontFamily: "'JetBrains Mono', monospace", letterSpacing: '-0.02em' }}
      >
        {value}
      </p>
      <p
        className="text-[8px] mt-1.5 tracking-widest uppercase font-bold"
        style={{ color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.1em' }}
      >
        {label}
      </p>
    </button>
  );
}
