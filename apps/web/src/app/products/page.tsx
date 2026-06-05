'use client';

import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  Layout,
  Button,
  Input,
  Modal,
  Form,
App,
  Empty,
  Popconfirm,
  Badge,
  Table,
  Tag,
  Tooltip,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  Plus,
  Search,
  Trash2,
  Edit3,
  QrCode,
  Layers,
  MapPin,
} from 'lucide-react';
import {
  useGetPackagesQuery,
  useCreatePackageMutation,
  useDeletePackageMutation,
  useAssignPackageToSlotMutation,
} from '@/store/services/inventoryApi';
import { useGetAllSlotsQuery } from '@/store/services/inventoryApi';
import type { PackageItem, Package } from '@/types/inventory';
import { parseSlotCode, toSlotCode } from '@/types/inventory';

const { Content } = Layout;

export default function ProductsPage() {
  const { notification } = App.useApp();
  const router = useRouter();
  const [searchTerm, setSearchTerm] = useState('');
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [form] = Form.useForm();

  const { data: packages = [], isLoading } = useGetPackagesQuery();
  const { data: slots = [] } = useGetAllSlotsQuery();
  const [createPackage, { isLoading: isCreating }] = useCreatePackageMutation();
  const [deletePackage, { isLoading: isDeleting }] = useDeletePackageMutation();
  const [assignToSlot, { isLoading: isAssigning }] = useAssignPackageToSlotMutation();

  const [assignModal, setAssignModal] = useState<{ pkg: Package; shelfId: number | null; cell: string | null } | null>(null);

  const openAssignModal = (pkg: Package) => setAssignModal({ pkg, shelfId: null, cell: null });
  const closeAssignModal = () => setAssignModal(null);

  const handleAssign = async () => {
    if (!assignModal?.shelfId || !assignModal?.cell || !assignModal?.pkg) {
      notification.warning({ title: 'Chưa chọn vị trí', description: 'Vui lòng chọn kệ và ô.', placement: 'topRight' });
      return;
    }
    try {
      const slotCode = toSlotCode(assignModal.shelfId, assignModal.cell);
      await assignToSlot({ slotCode, packageId: assignModal.pkg._id }).unwrap();
      notification.success({ title: 'Thành công', description: 'Xếp kiện hàng vào kệ thành công!', placement: 'topRight' });
      closeAssignModal();
    } catch (err: unknown) {
      const errMsg = (err as { data?: { message?: string } })?.data?.message || (err as { error?: string })?.error || 'Xếp kiện hàng thất bại!';
      notification.error({ title: 'Thất bại', description: errMsg, placement: 'topRight' });
    }
  };

  const occupiedSet = useMemo(() => {
    const set = new Set<string>();
    slots.forEach((s) => {
      if (s.packageId) {
        const { shelfId, cell } = parseSlotCode(s.code);
        set.add(`${shelfId}-${cell}`);
      }
    });
    return set;
  }, [slots]);

  const packageMap = useMemo(() => {
    const map: Record<string, PackageItem> = {};
    packages.forEach((pkg) => {
      const slot = slots.find((s) => s.packageId === pkg._id);
      if (slot) {
        const { shelfId, cell } = parseSlotCode(slot.code);
        map[pkg._id] = { ...pkg, shelfId, cell, importedAt: pkg.createdAt ?? new Date().toISOString() };
      } else {
        map[pkg._id] = { _id: pkg._id, packageName: pkg.packageName, shelfId: 0, cell: '', importedAt: pkg.createdAt ?? new Date().toISOString() };
      }
    });
    return map;
  }, [packages, slots]);

  const filteredPackages = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return packages;
    return packages.filter((pkg) => {
      if (pkg.packageName.toLowerCase().includes(term)) return true;
      if (pkg._id.toLowerCase().includes(term)) return true;
      if (pkg.tagId !== null && pkg.tagId !== undefined && String(pkg.tagId) === term) {
        return true;
      }
      return false;
    });
  }, [packages, searchTerm]);

  const handleAdd = async (values: { packageName: string }) => {
    try {
      await createPackage(values).unwrap();
      notification.success({ title: 'Thành công', description: 'Thêm kiện hàng thành công!', placement: 'topRight' });
      form.resetFields();
      setIsAddModalOpen(false);
    } catch (err: unknown) {
      const errMsg = (err as { data?: { message?: string } })?.data?.message || (err as { error?: string })?.error || 'Thêm kiện hàng thất bại!';
      notification.error({ title: 'Thất bại', description: errMsg, placement: 'topRight' });
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deletePackage(id).unwrap();
      notification.success({ title: 'Thành công', description: 'Xóa kiện hàng thành công!', placement: 'topRight' });
    } catch (err: unknown) {
      const errMsg = (err as { data?: { message?: string } })?.data?.message || (err as { error?: string })?.error || 'Xóa kiện hàng thất bại!';
      notification.error({ title: 'Thất bại', description: errMsg, placement: 'topRight' });
    }
  };

  const columns: ColumnsType<Package> = [
    {
      title: 'STT',
      key: 'index',
      width: 64,
      responsive: ['md'],
      render: (_: unknown, _record: Package, index: number) => (
        <span style={{ color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, fontSize: '12px' }}>
          {String(index + 1).padStart(2, '0')}
        </span>
      ),
    },
    {
      title: 'Tên kiện hàng',
      dataIndex: 'packageName',
      key: 'packageName',
      sorter: (a, b) => a.packageName.localeCompare(b.packageName),
      render: (name: string) => (
        <span style={{ fontWeight: 700, color: 'var(--text-primary)', fontFamily: "'JetBrains Mono', monospace", fontSize: '14px' }}>{name}</span>
      ),
    },
    {
      title: 'Trạng thái',
      key: 'status',
      width: 150,
      render: (_: unknown, record: Package) => {
        const palette: Record<Package['status'], { bg: string; border: string; text: string; label: string }> = {
          CREATED: { bg: 'rgba(0,212,255,0.10)', border: 'rgba(0,212,255,0.30)', text: 'var(--accent)', label: 'Đã tạo' },
          IN_PROGRESS: { bg: 'rgba(255,184,0,0.10)', border: 'rgba(255,184,0,0.30)', text: 'var(--warning)', label: 'Đang xử lý' },
          FINISHED: { bg: 'rgba(0,255,170,0.08)', border: 'rgba(0,255,170,0.25)', text: 'var(--success)', label: 'Hoàn thành' },
        };
        const c = palette[record.status] ?? palette.CREATED;
        return (
          <Tag style={{ borderRadius: '8px', background: c.bg, border: `1px solid ${c.border}`, color: c.text, fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, fontSize: '11px' }}>
            {c.label}
          </Tag>
        );
      },
    },
    {
      title: 'Mã AprilTag',
      key: 'tagId',
      width: 140,
      responsive: ['md'],
      render: (_: unknown, record: Package) => {
        if (record.tagId === null || record.tagId === undefined) {
          return (
            <span style={{ color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace", fontSize: '12px' }}>—</span>
          );
        }
        return (
          <span style={{ color: 'var(--text-primary)', fontFamily: "'JetBrains Mono', monospace", fontSize: '13px', fontWeight: 700 }}>
            #{record.tagId}
          </span>
        );
      },
    },
    {
      title: 'Kệ',
      responsive: ['md'],
      key: 'shelf',
      width: 150,
      render: (_: unknown, record: Package) => {
        const item = packageMap[record._id];
        if (item?.shelfId > 0) {
          return (
            <Tag style={{ borderRadius: '8px', background: 'rgba(0,212,255,0.1)', border: '1px solid rgba(0,212,255,0.25)', color: 'var(--accent)', fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, fontSize: '11px' }}>
              Kệ {item.shelfId} · Ô {item.cell}
            </Tag>
          );
        }
        return (
          <Tag style={{ borderRadius: '8px', background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border-dim)', color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace", fontSize: '11px' }}>
            Chưa xếp kệ
          </Tag>
        );
      },
    },
    {
      title: 'Ngày tạo',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 170,
      sorter: (a, b) => {
        const da = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const db = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return da - db;
      },
      render: (date: string) =>
        date ? (
          <span style={{ color: 'var(--text-secondary)', fontSize: '12px', fontFamily: "'JetBrains Mono', monospace" }}>
            {new Date(date).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
          </span>
        ) : (
          <span style={{ color: 'var(--text-muted)' }}>—</span>
        ),
    },
    {
      title: 'Thao tác',
      key: 'actions',
      width: 280,
      fixed: 'right',
      render: (_: unknown, record: Package) => {
        const item = packageMap[record._id];
        const notOnShelf = !item || item.shelfId === 0;
        return (
          <div style={{ display: 'flex', gap: '6px' }}>
            {notOnShelf && (
              <Tooltip title="Xếp vào kệ">
                <Button
                  size="small"
                  icon={<MapPin size={12} />}
                  onClick={() => openAssignModal(record)}
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
                  Xếp kệ
                </Button>
              </Tooltip>
            )}
            <Button
              size="small"
              icon={<Edit3 size={12} />}
              onClick={() => router.push(`/products/${record._id}`)}
              style={{
                borderRadius: '8px',
                background: 'var(--bg-raised)',
                border: '1px solid var(--border-mid)',
                color: 'var(--text-secondary)',
                fontFamily: "'JetBrains Mono', monospace",
                fontWeight: 600,
                fontSize: '12px',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
              }}
            >
              Sửa
            </Button>
            <Button
              size="small"
              icon={<QrCode size={12} />}
              onClick={() => router.push(`/products/${record._id}?action=print`)}
              style={{
                borderRadius: '8px',
                background: 'var(--bg-raised)',
                border: '1px solid var(--border-mid)',
                color: 'var(--text-secondary)',
                fontFamily: "'JetBrains Mono', monospace",
                fontWeight: 600,
                fontSize: '12px',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
              }}
            >
              In QR
            </Button>
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

  return (
    <div className="flex-1 min-h-0" style={{ background: 'var(--bg-void)' }}>
      {/* ─── Page Header ─────────────────────────────────── */}
      <div
        className="relative overflow-hidden px-4 md:px-8 pt-8 pb-6"
        style={{ borderBottom: '1px solid var(--border-dim)' }}
      >
        {/* Background accents */}
        <div className="absolute inset-0 pointer-events-none" style={{ background: 'linear-gradient(180deg, rgba(0,212,255,0.03) 0%, transparent 100%)' }} />
        <span className="absolute right-8 top-4 w-48 h-48 opacity-5 pointer-events-none" style={{ background: 'radial-gradient(circle, rgba(0,212,255,0.4), transparent 70%)' }} />

        <div className="flex flex-col md:flex-row md:justify-between md:items-start relative z-10 flex-wrap gap-4">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <Layers size={24} style={{ color: 'var(--accent)' }} />
              <h1
                className="text-display text-2xl"
                style={{ fontFamily: "'JetBrains Mono', monospace", color: 'var(--text-primary)', letterSpacing: '-0.02em' }}
              >
                QUẢN LÝ KIỆN HÀNG
              </h1>
              <Badge
                count={packages.length}
                style={{
                  backgroundColor: 'rgba(0,212,255,0.15)',
                  color: 'var(--accent)',
                  border: '1px solid rgba(0,212,255,0.3)',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontWeight: 700,
                  fontSize: '11px',
                  boxShadow: 'none',
                }}
              />
            </div>
            <p
              className="text-xs"
              style={{ color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.04em' }}
            >
              Thêm, sửa, xóa và in mã QR cho từng kiện hàng trong kho
            </p>
          </div>

          <div className="flex flex-col md:flex-row md:items-center gap-3 w-full md:w-auto">
            {/* Stats */}
            <div
              className="flex items-center gap-3 px-4 py-2.5 rounded-xl"
              style={{
                background: 'var(--bg-surface)',
                border: '1px solid var(--border-dim)',
              }}
            >
              <div className="text-center">
                <p
                  className="text-lg font-black"
                  style={{ color: 'var(--accent)', fontFamily: "'JetBrains Mono', monospace", letterSpacing: '-0.02em' }}
                >
                  {packages.length}
                </p>
                <p className="text-[9px]" style={{ color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.1em' }}>
                  TỔNG KIỆN
                </p>
              </div>
              <div
                className="w-px h-8"
                style={{ background: 'var(--border-dim)' }}
              />
              <div className="text-center">
                <p
                  className="text-lg font-black"
                  style={{ color: 'var(--success)', fontFamily: "'JetBrains Mono', monospace", letterSpacing: '-0.02em' }}
                >
                  {packages.filter(p => packageMap[p._id]?.shelfId > 0).length}
                </p>
                <p className="text-[9px]" style={{ color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.1em' }}>
                  ĐÃ XẾP
                </p>
              </div>
              <div
                className="w-px h-8"
                style={{ background: 'var(--border-dim)' }}
              />
              <div className="text-center">
                <p
                  className="text-lg font-black"
                  style={{ color: 'var(--warning)', fontFamily: "'JetBrains Mono', monospace", letterSpacing: '-0.02em' }}
                >
                  {packages.filter(p => !packageMap[p._id] || packageMap[p._id].shelfId === 0).length}
                </p>
                <p className="text-[9px]" style={{ color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.1em' }}>
                  CHƯA XẾP
                </p>
              </div>
            </div>

            <Button
              type="primary"
              icon={<Plus size={16} />}
              size="large"
              onClick={() => setIsAddModalOpen(true)}
              className="w-full md:w-auto"
              style={{
                background: 'linear-gradient(135deg, #00d4ff, #00b8e6)',
                border: 'none',
                color: '#080b10',
                borderRadius: '12px',
                fontFamily: "'JetBrains Mono', monospace",
                fontWeight: 700,
                fontSize: '14px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                boxShadow: '0 4px 20px rgba(0,212,255,0.3)',
                height: '48px',
                paddingInline: '24px',
              }}
            >
              Thêm kiện hàng
            </Button>
          </div>
        </div>
      </div>

      {/* ─── Content area ────────────────────────────────── */}
      <Content
          style={{ padding: '1rem', maxWidth: 1100, margin: '0 auto', width: '100%' }}
          className="md:!p-8"
        >

        {/* Search bar */}
        <div className="mb-5">
          <Input
            size="large"
            placeholder="Tìm theo tên, mã AprilTag hoặc _id..."
            prefix={<Search size={18} style={{ color: 'var(--text-muted)' }} />}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            allowClear
            className="w-full"
            style={{
              borderRadius: '12px',
              maxWidth: 400,
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-mid)',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '14px',
            }}
          />
        </div>

        {/* Table */}
        {!isLoading && filteredPackages.length === 0 ? (
          <Empty
            description={
              <span style={{ color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace", fontSize: '12px' }}>
                {searchTerm ? 'Không tìm thấy kiện hàng nào phù hợp.' : 'Chưa có kiện hàng nào trong kho.'}
              </span>
            }
            style={{ marginTop: '3rem' }}
          />
        ) : (
          <Table<Package>
            columns={columns}
            dataSource={filteredPackages}
            rowKey="_id"
            loading={isLoading}
            pagination={{
              pageSize: 10,
              showSizeChanger: false,
              showTotal: (total) => (
                <span style={{ color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace", fontSize: '11px' }}>
                  Tổng cộng <strong style={{ color: 'var(--text-primary)' }}>{total}</strong> kiện hàng
                </span>
              ),
            }}
            scroll={{ x: 640 }}
            style={{ borderRadius: '12px', overflow: 'hidden' }}
          />
        )}
      </Content>

      {/* ─── Assign to Shelf Modal ─────────────────────── */}
      <Modal
        title={
          <div className="flex items-center gap-2 font-bold" style={{ fontFamily: "'JetBrains Mono', monospace", color: 'var(--text-primary)' }}>
            <MapPin size={18} style={{ color: 'var(--accent)' }} />
            Xếp kiện hàng vào kệ
          </div>
        }
        open={!!assignModal}
        onCancel={closeAssignModal}
        centered
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-mid)', borderRadius: '16px', margin: 0 }}
        styles={{ body: { padding: '24px' } }}
        footer={
          <div className="flex gap-3 justify-end pt-2">
            <Button
              size="large"
              onClick={closeAssignModal}
              style={{ borderRadius: '10px', fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, background: 'var(--bg-raised)', border: '1px solid var(--border-mid)', color: 'var(--text-secondary)' }}
            >
              Hủy
            </Button>
            <Button
              type="primary"
              size="large"
              loading={isAssigning}
              onClick={handleAssign}
              disabled={!assignModal?.shelfId || !assignModal?.cell}
              style={{
                background: 'linear-gradient(135deg, #00d4ff, #00b8e6)',
                border: 'none',
                color: '#080b10',
                borderRadius: '10px',
                fontFamily: "'JetBrains Mono', monospace",
                fontWeight: 700,
                boxShadow: '0 4px 16px rgba(0,212,255,0.3)',
              }}
            >
              Xếp vào kệ
            </Button>
          </div>
        }
      >
        {assignModal && (
          <div>
            <p className="mb-5 text-sm" style={{ color: 'var(--text-secondary)', fontFamily: "'JetBrains Mono', monospace" }}>
              Chọn vị trí cho kiện hàng:{' '}
              <strong style={{ color: 'var(--accent)', fontFamily: "'JetBrains Mono', monospace" }}>{assignModal.pkg.packageName}</strong>
            </p>

            {/* Shelf selector */}
            <div className="mb-4">
              <p className="text-[11px] font-bold mb-2" style={{ color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                1 — Chọn kệ
              </p>
              <div className="grid grid-cols-4 gap-2">
                {[1, 2, 3, 4].map((shelfId) => (
                  <button
                    key={shelfId}
                    onClick={() => setAssignModal((prev) => (prev ? { ...prev, shelfId, cell: null } : null))}
                    style={{
                      flex: 1,
                      padding: '10px',
                      borderRadius: '10px',
                      border: `2px solid ${assignModal?.shelfId === shelfId ? 'var(--accent)' : 'var(--border-mid)'}`,
                      background: assignModal?.shelfId === shelfId ? 'rgba(0,212,255,0.1)' : 'var(--bg-raised)',
                      color: assignModal?.shelfId === shelfId ? 'var(--accent)' : 'var(--text-secondary)',
                      fontWeight: 700,
                      fontSize: '14px',
                      fontFamily: "'JetBrains Mono', monospace",
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                      boxShadow: assignModal?.shelfId === shelfId ? '0 0 16px rgba(0,212,255,0.15)' : 'none',
                    }}
                  >
                    Kệ {shelfId}
                  </button>
                ))}
              </div>
            </div>

            {/* Cell selector */}
            {assignModal?.shelfId && (
              <div>
                <p className="text-[11px] font-bold mb-2" style={{ color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                  2 — Chọn ô
                </p>
                <div className="grid grid-cols-4 gap-2">
                  {['A', 'B', 'C', 'D'].flatMap((row) =>
                    [1, 2, 3, 4].map((col) => {
                      const cell = `${row}${col}`;
                      const key = `${assignModal.shelfId}-${cell}`;
                      const isOccupied = occupiedSet.has(key);
                      const isSelected = assignModal.cell === cell;
                      return (
                        <button
                          key={cell}
                          onClick={() => !isOccupied && setAssignModal((prev) => (prev ? { ...prev, cell } : null))}
                          disabled={isOccupied}
                          style={{
                            padding: '8px 4px',
                            borderRadius: '8px',
                            border: `2px solid ${isSelected ? 'var(--accent)' : isOccupied ? 'var(--border-dim)' : 'var(--border-mid)'}`,
                            background: isSelected ? 'rgba(0,212,255,0.15)' : isOccupied ? 'rgba(255,255,255,0.02)' : 'var(--bg-raised)',
                            color: isSelected ? 'var(--accent)' : isOccupied ? 'var(--text-muted)' : 'var(--text-primary)',
                            fontWeight: 700,
                            fontSize: '13px',
                            fontFamily: "'JetBrains Mono', monospace",
                            cursor: isOccupied ? 'not-allowed' : 'pointer',
                            textDecoration: isOccupied ? 'line-through' : 'none',
                            transition: 'all 0.15s ease',
                            boxShadow: isSelected ? '0 0 12px rgba(0,212,255,0.15)' : 'none',
                          }}
                        >
                          {cell}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* Add Package Modal */}
      <Modal
        title={
          <div className="flex items-center gap-2 font-bold" style={{ fontFamily: "'JetBrains Mono', monospace", color: 'var(--text-primary)' }}>
            <Plus size={18} style={{ color: 'var(--accent)' }} />
            Thêm kiện hàng mới
          </div>
        }
        open={isAddModalOpen}
        onCancel={() => { setIsAddModalOpen(false); form.resetFields(); }}
        footer={null}
        centered
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-mid)', borderRadius: '16px', margin: 0 }}
        styles={{ body: { padding: '24px' } }}
      >
        <Form
          form={isAddModalOpen ? form : undefined}
          layout="vertical"
          onFinish={handleAdd}
          style={{ marginTop: '0.5rem' }}
        >
          <Form.Item
            name="packageName"
            label={<span style={{ color: 'var(--text-secondary)', fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>Tên kiện hàng</span>}
            rules={[{ required: true, message: 'Vui lòng nhập tên kiện hàng' }]}
          >
            <Input
              placeholder="Ví dụ: Kiện hàng #001"
              size="large"
              style={{ borderRadius: '10px', background: 'var(--bg-raised)', border: '1px solid var(--border-mid)', color: 'var(--text-primary)', fontFamily: "'JetBrains Mono', monospace" }}
            />
          </Form.Item>

          <div className="flex gap-3 justify-end pt-2">
            <Button
              size="large"
              onClick={() => { setIsAddModalOpen(false); form.resetFields(); }}
              style={{ borderRadius: '10px', fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, background: 'var(--bg-raised)', border: '1px solid var(--border-mid)', color: 'var(--text-secondary)' }}
            >
              Hủy
            </Button>
            <Button
              type="primary"
              size="large"
              htmlType="submit"
              loading={isCreating}
              style={{
                background: 'linear-gradient(135deg, #00d4ff, #00b8e6)',
                border: 'none',
                color: '#080b10',
                borderRadius: '10px',
                fontFamily: "'JetBrains Mono', monospace",
                fontWeight: 700,
                boxShadow: '0 4px 16px rgba(0,212,255,0.3)',
              }}
            >
              Thêm kiện hàng
            </Button>
          </div>
        </Form>
      </Modal>
    </div>
  );
}
