'use client';

import { useState, useMemo } from 'react';
import {
  Modal,
  Button,
  notification,
  Tag,
  Badge,
  Input,
  Collapse,
  Spin,
  Tooltip,
  Empty,
} from 'antd';
import {
  PackageOpen,
  Send,
  Search,
  Package,
  Info,
  CheckCircle,
  ArrowLeftRight,
  Hexagon,
  Wifi,
} from 'lucide-react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { setSource, setDest, resetInventory, SelectedCell } from '@/store/inventorySlice';
import { useGetAllSlotsQuery, useGetPackagesQuery, useMovePackageMutation } from '@/store/services/inventoryApi';
import { parseSlotCode, toSlotCode, PackageItem, ShelfSlot } from '@/types/inventory';

const ROWS = ['A', 'B', 'C', 'D'];
const COLS = ['1', '2', '3', '4'];

type ShelfId = 1 | 2 | 3 | 4;

const SHELF_POSITIONS = [
  { id: 1 as ShelfId, label: 'Kệ 01', zone: 'Tây Bắc' },
  { id: 2 as ShelfId, label: 'Kệ 02', zone: 'Đông Bắc' },
  { id: 3 as ShelfId, label: 'Kệ 03', zone: 'Tây Nam' },
  { id: 4 as ShelfId, label: 'Kệ 04', zone: 'Đông Nam' },
];

export default function InventoryPage() {
  const dispatch = useAppDispatch();
  const source = useAppSelector((state) => state.inventory.source);
  const dest = useAppSelector((state) => state.inventory.dest);

  const { data: slots = [], isLoading: isSlotsLoading } = useGetAllSlotsQuery();
  const { data: packages = [], isLoading: isPackagesLoading } = useGetPackagesQuery();
  const [movePackage, { isLoading: isMoving }] = useMovePackageMutation();

  const [activeShelf, setActiveShelf] = useState<ShelfId | null>(null);
  const [pendingCell, setPendingCell] = useState<SelectedCell | null>(null);
  const [isConfirmDestOpen, setIsConfirmDestOpen] = useState(false);
  const [isRemoveSourceConfirmOpen, setIsRemoveSourceConfirmOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');

  const selectedCount = (source ? 1 : 0) + (dest ? 1 : 0);

  const packageMap = useMemo(() => {
    const map: Record<string, PackageItem> = {};
    packages.forEach((pkg) => {
      const slot = slots.find((s) => s.packageId === pkg._id);
      if (slot) {
        const { shelfId, cell } = parseSlotCode(slot.code);
        map[pkg._id] = { ...pkg, shelfId, cell, importedAt: pkg.createdAt ?? new Date().toISOString() };
      }
    });
    return map;
  }, [packages, slots]);

  const positionSlotMap = useMemo(() => {
    const map: Record<string, ShelfSlot> = {};
    slots.forEach((slot) => {
      const { shelfId, cell } = parseSlotCode(slot.code);
      map[`${shelfId}-${cell}`] = slot;
    });
    return map;
  }, [slots]);

  const packagesByShelf = useMemo(() => {
    const groups: Record<number, PackageItem[]> = { 1: [], 2: [], 3: [], 4: [] };
    packages.forEach((pkg) => {
      const slot = slots.find((s) => s.packageId === pkg._id);
      if (!slot) return;
      const { shelfId, cell } = parseSlotCode(slot.code);
      if (!groups[shelfId]) return;
      const item: PackageItem = { ...pkg, shelfId, cell, importedAt: pkg.createdAt ?? new Date().toISOString() };
      if (!searchTerm || item.packageName.toLowerCase().includes(searchTerm.toLowerCase()) || item._id.toLowerCase().includes(searchTerm.toLowerCase())) {
        groups[shelfId].push(item);
      }
    });
    return groups;
  }, [packages, slots, searchTerm]);

  const getCellStatus = (shelfId: number, cell: string): 'source' | 'dest' | 'none' => {
    if (source?.shelfId === shelfId && source?.cell === cell) return 'source';
    if (dest?.shelfId === shelfId && dest?.cell === cell) return 'dest';
    return 'none';
  };

  const handleCellClick = (shelfId: ShelfId, cell: string) => {
    const status = getCellStatus(shelfId, cell);
    if (status === 'source') { handleRemoveSource(); return; }
    if (status === 'dest') { dispatch(setDest(null)); return; }

    if (!source) {
      dispatch(setSource({ shelfId, cell }));
    } else if (!dest) {
      const slotKey = `${shelfId}-${cell}`;
      const slot = positionSlotMap[slotKey];
      if (slot?.packageId) {
        notification.warning({ title: 'Ô đích đã có kiện hàng', description: 'Vui lòng chọn một ô trống để di chuyển.', placement: 'topRight' });
        return;
      }
      setPendingCell({ shelfId, cell });
      setIsConfirmDestOpen(true);
    } else {
      notification.warning({ title: 'Chỉ được chọn tối đa 2 ô', description: 'Hãy hủy ô đã chọn để chọn lại.', placement: 'topRight' });
    }
  };

  const handleConfirmDest = () => {
    if (pendingCell) dispatch(setDest(pendingCell));
    setIsConfirmDestOpen(false);
    setPendingCell(null);
  };

  const handleCancelConfirmDest = () => {
    setIsConfirmDestOpen(false);
    setPendingCell(null);
  };

  const handleRemoveDest = () => { dispatch(setDest(null)); };
  const handleRemoveSource = () => { setIsRemoveSourceConfirmOpen(true); };

  const handlePromoteDestToSource = () => {
    dispatch(setSource(dest));
    dispatch(setDest(null));
    setIsRemoveSourceConfirmOpen(false);
  };

  const handleRemoveSourceOnly = () => {
    dispatch(setSource(null));
    setIsRemoveSourceConfirmOpen(false);
  };

  const handleSubmit = async () => {
    if (!source || !dest) {
      notification.warning({ title: 'Chưa chọn đủ vị trí', description: 'Vui lòng chọn đủ ô nguồn và ô đích trước khi gửi lệnh.', placement: 'topRight' });
      return;
    }
    try {
      const sourceSlotCode = toSlotCode(source.shelfId, source.cell);
      const targetSlotCode = toSlotCode(dest.shelfId, dest.cell);
      await movePackage({ sourceSlotCode, targetSlotCode }).unwrap();
      notification.success({ title: 'Thành công', description: 'Gửi lệnh di chuyển thành công!', placement: 'topRight' });
      dispatch(resetInventory());
    } catch (err: unknown) {
      const errMsg = (err as { data?: { message?: string } })?.data?.message || (err as { error?: string })?.error || 'Gửi lệnh thất bại!';
      notification.error({ title: 'Thất bại', description: errMsg, placement: 'topRight' });
    }
  };

  const selectFromList = (shelfId: number, cell: string) => handleCellClick(shelfId as ShelfId, cell);

  const totalPackages = packages.length;
  const isLoading = isSlotsLoading || isPackagesLoading;

  const getPackageForCell = (shelfId: number, cell: string) => {
    const slot = positionSlotMap[`${shelfId}-${cell}`];
    if (!slot || !slot.packageId) return null;
    return packageMap[slot.packageId] ?? null;
  };

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden" style={{ background: 'var(--bg-void)' }}>

      {/* ─── Main Area ─────────────────────────────────────── */}
      <div className="flex-1 flex flex-col h-full overflow-hidden relative">

        {/* Header */}
        <div
          className="px-8 py-5 relative overflow-hidden"
          style={{
            background: 'linear-gradient(180deg, rgba(0,212,255,0.03) 0%, transparent 100%)',
            borderBottom: '1px solid var(--border-dim)',
            boxShadow: '0 4px 24px rgba(0,0,0,0.3)',
          }}
        >
          <div className="flex justify-between items-start relative z-10">
            <div>
              <div className="flex items-center gap-3 mb-1">
                <Hexagon size={22} style={{ color: 'var(--accent)' }} />
                <h1
                  className="text-display text-2xl"
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

        {/* Status command bar */}
        <div
          className="px-8 py-3.5 flex items-center gap-4 relative z-10"
          style={{
            background: 'linear-gradient(90deg, #0c0f14, #111827)',
            borderBottom: '1px solid var(--border-dim)',
            boxShadow: '0 2px 12px rgba(0,0,0,0.4)',
          }}
        >
          {/* Source */}
          <div className="flex items-center gap-2.5">
            <span
              className="text-[9px] font-bold px-2 py-1 rounded-md"
              style={{
                background: 'rgba(0,212,255,0.1)',
                border: '1px solid rgba(0,212,255,0.2)',
                color: 'var(--accent)',
                fontFamily: "'JetBrains Mono', monospace",
                letterSpacing: '0.1em',
              }}
            >
              SRC
            </span>
            {source ? (
              <Tag
                closable
                onClose={(e) => { e.preventDefault(); handleRemoveSource(); }}
                style={{
                  background: 'rgba(0,212,255,0.1)',
                  border: '1px solid rgba(0,212,255,0.3)',
                  color: 'var(--accent)',
                  borderRadius: '8px',
                  fontWeight: 700,
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: '12px',
                  boxShadow: '0 0 12px rgba(0,212,255,0.1)',
                }}
              >
                Kệ {source.shelfId} · Ô {source.cell}
                {getPackageForCell(source.shelfId, source.cell) && (
                  <span className="opacity-70 ml-1">({getPackageForCell(source.shelfId, source.cell)?.packageName})</span>
                )}
              </Tag>
            ) : (
              <span className="text-xs italic" style={{ color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}>
                — Chọn ô nguồn
              </span>
            )}
          </div>

          <ArrowLeftRight size={16} style={{ color: 'var(--text-muted)' }} />

          {/* Dest */}
          <div className="flex items-center gap-2.5">
            <span
              className="text-[9px] font-bold px-2 py-1 rounded-md"
              style={{
                background: 'rgba(0,255,136,0.1)',
                border: '1px solid rgba(0,255,136,0.2)',
                color: 'var(--success)',
                fontFamily: "'JetBrains Mono', monospace",
                letterSpacing: '0.1em',
              }}
            >
              DST
            </span>
            {dest ? (
              <Tag
                closable
                onClose={(e) => { e.preventDefault(); handleRemoveDest(); }}
                style={{
                  background: 'rgba(0,255,136,0.1)',
                  border: '1px solid rgba(0,255,136,0.3)',
                  color: 'var(--success)',
                  borderRadius: '8px',
                  fontWeight: 700,
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: '12px',
                  boxShadow: '0 0 12px rgba(0,255,136,0.1)',
                }}
              >
                Kệ {dest.shelfId} · Ô {dest.cell}
                {getPackageForCell(dest.shelfId, dest.cell) && (
                  <span className="opacity-70 ml-1">({getPackageForCell(dest.shelfId, dest.cell)?.packageName})</span>
                )}
              </Tag>
            ) : (
              <span className="text-xs italic" style={{ color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}>
                — Chọn ô đích
              </span>
            )}
          </div>

          <div className="ml-auto flex items-center gap-3">
            <div
              className="flex items-center gap-2 text-xs"
              style={{
                color: selectedCount === 2 ? 'var(--success)' : 'var(--text-muted)',
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              {selectedCount === 2 ? (
                <><CheckCircle size={14} style={{ color: 'var(--success)' }} /> Sẵn sàng phát lệnh</>
              ) : (
                <><Info size={14} /> {selectedCount}/2 vị trí đã chọn</>
              )}
            </div>
          </div>
        </div>

        {/* Warehouse Grid Area */}
        <div
          className="flex-1 relative overflow-hidden flex items-center justify-center"
          style={{
            background: 'var(--bg-base)',
            backgroundImage: `
              radial-gradient(ellipse 80% 60% at 50% 50%, rgba(0,212,255,0.03) 0%, transparent 70%),
              linear-gradient(rgba(255,255,255,0.015) 1px, transparent 1px),
              linear-gradient(90deg, rgba(255,255,255,0.015) 1px, transparent 1px)
            `,
            backgroundSize: '100% 100%, 40px 40px, 40px 40px',
          }}
        >
          {/* Shelf grid using CSS grid — avoids the flex+absolute height-collapse issue */}
          <div
            className="relative w-full max-w-5xl mx-auto h-full px-6"
            style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gridTemplateRows: '1fr auto 1fr', alignItems: 'center' }}
          >
            {/* Top-left shelf */}
            <div style={{ gridColumn: '1', gridRow: '1', justifySelf: 'start' }}>
              <ShelfCard shelf={SHELF_POSITIONS[0]} source={source} dest={dest} packageCount={packagesByShelf[1]?.length || 0} onClick={() => setActiveShelf(1)} />
            </div>
            {/* Top-right shelf */}
            <div style={{ gridColumn: '3', gridRow: '1', justifySelf: 'end' }}>
              <ShelfCard shelf={SHELF_POSITIONS[1]} source={source} dest={dest} packageCount={packagesByShelf[2]?.length || 0} onClick={() => setActiveShelf(2)} />
            </div>
            {/* Bottom-left shelf */}
            <div style={{ gridColumn: '1', gridRow: '3', justifySelf: 'start' }}>
              <ShelfCard shelf={SHELF_POSITIONS[2]} source={source} dest={dest} packageCount={packagesByShelf[3]?.length || 0} onClick={() => setActiveShelf(3)} />
            </div>
            {/* Bottom-right shelf */}
            <div style={{ gridColumn: '3', gridRow: '3', justifySelf: 'end' }}>
              <ShelfCard shelf={SHELF_POSITIONS[3]} source={source} dest={dest} packageCount={packagesByShelf[4]?.length || 0} onClick={() => setActiveShelf(4)} />
            </div>

            {/* Center hub — overlaid in the middle column/row */}
            <div
              style={{ gridColumn: '2', gridRow: '2', justifySelf: 'center', alignSelf: 'center', pointerEvents: 'none' }}
            >
              <div
                className="text-center px-10 py-8 relative"
                style={{
                  background: 'rgba(17,24,39,0.7)',
                  backdropFilter: 'blur(20px)',
                  border: '1px solid var(--border-mid)',
                  borderRadius: '24px',
                  boxShadow: '0 0 60px rgba(0,0,0,0.5), 0 0 30px rgba(0,212,255,0.05), inset 0 1px 0 rgba(255,255,255,0.06)',
                }}
              >
                {/* Corner accents */}
                <span className="absolute top-3 left-3 w-5 h-5 border-l-2 border-t-2 rounded-tl" style={{ borderColor: 'rgba(0,212,255,0.3)' }} />
                <span className="absolute top-3 right-3 w-5 h-5 border-r-2 border-t-2 rounded-tr" style={{ borderColor: 'rgba(0,212,255,0.3)' }} />
                <span className="absolute bottom-3 left-3 w-5 h-5 border-l-2 border-b-2 rounded-bl" style={{ borderColor: 'rgba(0,212,255,0.3)' }} />
                <span className="absolute bottom-3 right-3 w-5 h-5 border-r-2 border-b-2 rounded-br" style={{ borderColor: 'rgba(0,212,255,0.3)' }} />

                <div
                  className="w-20 h-20 rounded-2xl mx-auto mb-4 flex items-center justify-center"
                  style={{
                    background: 'linear-gradient(135deg, rgba(0,212,255,0.1), rgba(0,255,136,0.05))',
                    border: '1px solid rgba(0,212,255,0.2)',
                    boxShadow: '0 0 30px rgba(0,212,255,0.15), inset 0 1px 0 rgba(255,255,255,0.05)',
                    animation: 'pulse-subtle 4s ease-in-out infinite',
                  }}
                >
                  <PackageOpen size={40} style={{ color: 'var(--accent)' }} />
                </div>
                <p
                  className="text-sm font-bold tracking-widest uppercase"
                  style={{ color: 'var(--accent)', fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.12em', fontSize: '11px' }}
                >
                  AGV Transfer Zone
                </p>
                <p className="text-xs mt-2" style={{ color: 'var(--text-muted)', maxWidth: '240px', lineHeight: 1.5 }}>
                  Robot tự động tiếp cận kệ và di chuyển hàng hóa
                </p>
                {/* Pulse ring around hub */}
                <span
                  className="absolute inset-0 rounded-3xl pointer-events-none"
                  style={{
                    boxShadow: '0 0 0 0 rgba(0,212,255,0.2)',
                    animation: 'pulse-ring-cyan 3s ease-out infinite',
                  }}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Footer action bar */}
        <div
          className="px-8 py-4 flex items-center justify-between"
          style={{
            background: 'var(--bg-surface)',
            borderTop: '1px solid var(--border-dim)',
            boxShadow: '0 -4px 24px rgba(0,0,0,0.3)',
          }}
        >
          <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)', fontFamily: "'JetBrains Mono', monospace", fontSize: '11px' }}>
            <Wifi size={14} style={{ color: 'var(--accent)' }} />
            <span style={{ color: 'var(--text-muted)' }}>Robot endpoint:</span>
            <span>192.168.1.100</span>
            <span style={{ color: 'var(--border-mid)' }}>|</span>
            <span style={{ color: 'var(--text-muted)' }}>Mode:</span>
            <span style={{ color: 'var(--accent)' }}>STANDBY</span>
          </div>

          <div className="flex gap-3">
            <Button
              size="large"
              onClick={() => dispatch(resetInventory())}
              disabled={selectedCount === 0 || isMoving}
              style={{
                borderRadius: '10px',
                fontFamily: "'JetBrains Mono', monospace",
                fontWeight: 600,
                background: 'var(--bg-raised)',
                border: '1px solid var(--border-mid)',
                color: 'var(--text-secondary)',
              }}
            >
              Huỷ chọn
            </Button>
            <Button
              size="large"
              type="primary"
              icon={<Send size={16} />}
              loading={isMoving}
              disabled={selectedCount < 2}
              onClick={handleSubmit}
              style={{
                borderRadius: '10px',
                fontFamily: "'JetBrains Mono', monospace",
                fontWeight: 700,
                fontSize: '14px',
                background: selectedCount < 2
                  ? 'rgba(0,212,255,0.2)'
                  : 'linear-gradient(135deg, #00d4ff, #00b8e6)',
                border: 'none',
                color: selectedCount < 2 ? 'rgba(0,212,255,0.5)' : '#080b10',
                boxShadow: selectedCount < 2
                  ? 'none'
                  : '0 4px 20px rgba(0,212,255,0.3)',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                paddingInline: '24px',
                transition: 'all 0.2s ease',
              }}
            >
              PHÁT LỆNH AGV
            </Button>
          </div>
        </div>
      </div>

      {/* ─── Shelf detail modal ───────────────────────────── */}
      {activeShelf && (
        <Modal
          open={activeShelf !== null}
          onCancel={() => setActiveShelf(null)}
          footer={null}
          title={null}
          width={640}
          centered
          className="dark-modal"
          style={{
            background: 'var(--bg-surface)',
          }}
          styles={{
            mask: { background: 'rgba(8, 11, 16, 0.85)', backdropFilter: 'blur(4px)', },
            body: { padding: '0px', background: 'var(--bg-surface)' },
            header: { display: 'none' },
          }}
        >
          {/* Modal header */}
          <div
            className="px-6 py-5 relative overflow-hidden"
            style={{
              background: 'linear-gradient(135deg, rgba(0,212,255,0.06) 0%, transparent 60%)',
              borderBottom: '1px solid var(--border-dim)',
            }}
          >
            <div className="flex items-center gap-4 relative z-10">
              <div
                className="w-14 h-14 rounded-2xl flex items-center justify-center font-black text-2xl"
                style={{
                  background: 'linear-gradient(135deg, rgba(0,212,255,0.15), rgba(0,212,255,0.05))',
                  border: '1px solid rgba(0,212,255,0.25)',
                  color: 'var(--accent)',
                  fontFamily: "'JetBrains Mono', monospace",
                  boxShadow: '0 0 20px rgba(0,212,255,0.15)',
                }}  
              >
                {activeShelf}
              </div>
              <div>
                <h3
                  className="text-xl font-black"
                  style={{ fontFamily: "'JetBrains Mono', monospace", color: 'var(--text-primary)', letterSpacing: '-0.02em' }}
                >
                  {SHELF_POSITIONS.find(s => s.id === activeShelf)?.label}
                </h3>
                <p
                  className="text-xs mt-0.5"
                  style={{ color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.04em' }}
                >
                  {SHELF_POSITIONS.find(s => s.id === activeShelf)?.zone} &mdash; 16 ô chứa (4×4)
                </p>
              </div>
            </div>
            {/* Corner decoration */}
            <span className="absolute top-0 right-0 w-20 h-20 opacity-20 pointer-events-none" style={{ background: 'radial-gradient(circle at 100% 0%, rgba(0,212,255,0.3), transparent 70%)' }} />
          </div>

          {/* Cell grid */}
          <div className="grid grid-cols-4 gap-3">
            {ROWS.map((row) =>
              COLS.map((col) => {
                const cell = `${row}${col}`;
                const status = getCellStatus(activeShelf, cell);
                const item = getPackageForCell(activeShelf, cell);

                return (
                  <Tooltip key={cell} title={item ? `${item.packageName} — #${item._id.slice(-8).toUpperCase()}` : `Ô ${cell} (Trống)`} placement="top">
                    <button
                      onClick={() => handleCellClick(activeShelf, cell)}
                      className="h-28 rounded-2xl p-3 text-left transition-all relative flex flex-col justify-between overflow-hidden group"
                      style={
                        status === 'source'
                          ? {
                              background: 'linear-gradient(135deg, rgba(0,212,255,0.2), rgba(0,212,255,0.08))',
                              border: '2px solid rgba(0,212,255,0.5)',
                              boxShadow: '0 0 20px rgba(0,212,255,0.2)',
                              color: 'var(--accent)',
                            }
                          : status === 'dest'
                          ? {
                              background: 'linear-gradient(135deg, rgba(0,255,136,0.2), rgba(0,255,136,0.08))',
                              border: '2px solid rgba(0,255,136,0.5)',
                              boxShadow: '0 0 20px rgba(0,255,136,0.2)',
                              color: 'var(--success)',
                            }
                          : item
                          ? {
                              background: 'var(--bg-raised)',
                              border: '1px solid var(--border-mid)',
                              color: 'var(--text-primary)',
                            }
                          : {
                              background: 'var(--bg-base)',
                              border: '1px solid var(--border-dim)',
                              color: 'var(--text-muted)',
                            }
                      }
                    >
                      {/* Cell badge */}
                      <span
                        className="text-[10px] font-bold px-1.5 py-0.5 rounded-md self-start"
                        style={{
                          background: status !== 'none'
                            ? 'rgba(255,255,255,0.15)'
                            : item
                            ? 'rgba(0,212,255,0.1)'
                            : 'rgba(255,255,255,0.04)',
                          color: status === 'source' ? 'var(--accent)' : status === 'dest' ? 'var(--success)' : 'inherit',
                          fontFamily: "'JetBrains Mono', monospace",
                          letterSpacing: '0.06em',
                        }}
                      >
                        {cell}
                      </span>

                      {/* Content */}
                      <div className="mt-1 w-full">
                        {item ? (
                          <div>
                            <p
                              className="text-[11px] font-bold leading-tight line-clamp-2"
                              style={{ fontFamily: "'JetBrains Mono', monospace" }}
                            >
                              {item.packageName}
                            </p>
                            <p
                              className="text-[9px] mt-1 opacity-60 font-mono"
                              style={{ fontFamily: "'JetBrains Mono', monospace" }}
                            >
                              #{item._id.slice(-6).toUpperCase()}
                            </p>
                          </div>
                        ) : (
                          <p
                            className="text-[10px] italic opacity-50"
                            style={{ fontFamily: "'JetBrains Mono', monospace" }}
                          >
                            Trống
                          </p>
                        )}
                      </div>

                      {/* Active status overlay */}
                      {status !== 'none' && (
                        <span
                          className="absolute bottom-2 right-2 text-[8px] font-bold"
                          style={{ fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.1em', opacity: 0.7 }}
                        >
                          {status === 'source' ? 'SRC' : 'DST'}
                        </span>
                      )}
                    </button>
                  </Tooltip>
                );
              })
            )}
          </div>

          {/* Legend */}
          <div
            className="mt-4 pt-4 flex items-center justify-center gap-6"
            style={{ borderTop: '1px solid var(--border-dim)' }}
          >
            {[
              { color: 'var(--accent)', label: 'Nguồn', bg: 'rgba(0,212,255,0.1)', border: 'rgba(0,212,255,0.2)' },
              { color: 'var(--success)', label: 'Đích', bg: 'rgba(0,255,136,0.1)', border: 'rgba(0,255,136,0.2)' },
              { color: 'var(--text-secondary)', label: 'Có hàng', bg: 'var(--bg-raised)', border: 'var(--border-mid)' },
              { color: 'var(--text-muted)', label: 'Trống', bg: 'var(--bg-base)', border: 'var(--border-dim)' },
            ].map(({ label, color, bg, border }) => (
              <div key={label} className="flex items-center gap-2 text-[11px]" style={{ color, fontFamily: "'JetBrains Mono', monospace" }}>
                <span className="w-4 h-4 rounded-md" style={{ background: bg, border: `1px solid ${border}` }} />
                {label}
              </div>
            ))}
          </div>
        </Modal>
      )}

      {/* Confirm dest modal */}
      <Modal
        open={isConfirmDestOpen}
        onOk={handleConfirmDest}
        onCancel={handleCancelConfirmDest}
        okText="Xác nhận"
        cancelText="Huỷ"
        centered
        zIndex={1100}
        className="dark-modal"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-mid)', borderRadius: '16px' }}
        title={
          <div className="flex items-center gap-2 font-bold text-base" style={{ fontFamily: "'JetBrains Mono', monospace", color: 'var(--text-primary)' }}>
            <ArrowLeftRight size={18} style={{ color: 'var(--accent)' }} />
            Xác nhận điều phối robot
          </div>
        }
        okButtonProps={{
          style: {
            background: 'var(--accent)',
            border: 'none',
            color: '#080b10',
            fontWeight: 700,
            borderRadius: '10px',
            fontFamily: "'JetBrains Mono', monospace",
          },
        }}
        cancelButtonProps={{
          style: {
            background: 'var(--bg-raised)',
            border: '1px solid var(--border-mid)',
            color: 'var(--text-secondary)',
            borderRadius: '10px',
            fontFamily: "'JetBrains Mono', monospace",
          },
        }}
      >
        {source && pendingCell && (
          <div className="py-2 text-sm" style={{ color: 'var(--text-secondary)', fontFamily: "'JetBrains Mono', monospace" }}>
            <p>Robot sẽ nhận lệnh di chuyển giữa 2 vị trí:</p>
            <div
              className="mt-3 p-4 rounded-xl space-y-2"
              style={{ background: 'var(--bg-raised)', border: '1px solid var(--border-dim)' }}
            >
              <div className="flex items-center gap-3">
                <span
                  className="text-[9px] font-bold px-2 py-1 rounded-md w-12 text-center"
                  style={{ background: 'rgba(0,212,255,0.1)', border: '1px solid rgba(0,212,255,0.2)', color: 'var(--accent)', fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.1em' }}
                >
                  SRC
                </span>
                <strong style={{ color: 'var(--accent)' }}>
                  Kệ {source.shelfId} · Ô {source.cell}
                  {getPackageForCell(source.shelfId, source.cell) ? ` (${getPackageForCell(source.shelfId, source.cell)?.packageName})` : ' (Trống)'}
                </strong>
              </div>
              <div className="flex items-center gap-3">
                <span
                  className="text-[9px] font-bold px-2 py-1 rounded-md w-12 text-center"
                  style={{ background: 'rgba(0,255,136,0.1)', border: '1px solid rgba(0,255,136,0.2)', color: 'var(--success)', fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.1em' }}
                >
                  DST
                </span>
                <strong style={{ color: 'var(--success)' }}>
                  Kệ {pendingCell.shelfId} · Ô {pendingCell.cell}
                  {getPackageForCell(pendingCell.shelfId, pendingCell.cell) ? ` (${getPackageForCell(pendingCell.shelfId, pendingCell.cell)?.packageName})` : ' (Trống)'}
                </strong>
              </div>
            </div>
          </div>
        )}
      </Modal>

      {/* Remove source confirmation modal */}
      <Modal
        open={isRemoveSourceConfirmOpen}
        title={
          <span style={{ fontFamily: "'JetBrains Mono', monospace", color: 'var(--text-primary)', fontWeight: 700 }}>
            Cập nhật vị trí nguồn
          </span>
        }
        centered
        zIndex={1100}
        onCancel={() => setIsRemoveSourceConfirmOpen(false)}
        className="dark-modal"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-mid)', borderRadius: '16px' }}
        footer={
          <div className="flex justify-end gap-2.5">
            <Button
              onClick={() => setIsRemoveSourceConfirmOpen(false)}
              style={{ borderRadius: '10px', fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, background: 'var(--bg-raised)', border: '1px solid var(--border-mid)', color: 'var(--text-secondary)' }}
            >
              Đóng
            </Button>
            <Button
              danger
              onClick={handleRemoveSourceOnly}
              style={{ borderRadius: '10px', fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}
            >
              Xoá ô nguồn
            </Button>
            {dest && (
              <Button
                type="primary"
                onClick={handlePromoteDestToSource}
                style={{
                  background: 'var(--accent)',
                  border: 'none',
                  color: '#080b10',
                  borderRadius: '10px',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontWeight: 700,
                }}
              >
                Chuyển đích → nguồn
              </Button>
            )}
          </div>
        }
      >
        {dest ? (
          <p style={{ color: 'var(--text-secondary)', fontFamily: "'JetBrains Mono', monospace" }}>
            Xoá nguồn <strong style={{ color: 'var(--accent)' }}>Kệ {source?.shelfId} · Ô {source?.cell}</strong>?{' '}
            Chuyển đích <strong style={{ color: 'var(--success)' }}>Kệ {dest.shelfId} · Ô {dest.cell}</strong> thành nguồn mới?
          </p>
        ) : (
          <p style={{ color: 'var(--text-secondary)', fontFamily: "'JetBrains Mono', monospace" }}>
            Xác nhận xoá nguồn <strong style={{ color: 'var(--accent)' }}>Kệ {source?.shelfId} · Ô {source?.cell}</strong>?
          </p>
        )}
      </Modal>

      {/* Global keyframe animations */}
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

/* ─── Shelf card component ─────────────────────────────────────────── */
function ShelfCard({
  shelf,
  source,
  dest,
  packageCount,
  onClick,
}: {
  shelf: { id: ShelfId; label: string; zone: string };
  source: SelectedCell | null;
  dest: SelectedCell | null;
  packageCount: number;
  onClick: () => void;
}) {
  const hasSource = source?.shelfId === shelf.id;
  const hasDest = dest?.shelfId === shelf.id;
  const isActive = hasSource || hasDest;
  const activeColor = hasSource ? 'var(--accent)' : hasDest ? 'var(--success)' : 'var(--accent)';

  return (
    <button
      onClick={onClick}
      className="w-72 p-5 rounded-2xl flex flex-col justify-between transition-all group relative overflow-hidden cursor-pointer"
      style={
        isActive
          ? {
              background: `linear-gradient(135deg, ${hasSource ? 'rgba(0,212,255,0.08)' : 'rgba(0,255,136,0.08)'}, var(--bg-raised))`,
              border: `1px solid ${hasSource ? 'rgba(0,212,255,0.25)' : 'rgba(0,255,136,0.25)'}`,
              boxShadow: `0 0 30px ${hasSource ? 'rgba(0,212,255,0.1)' : 'rgba(0,255,136,0.1)'}, 0 8px 32px rgba(0,0,0,0.4)`,
            }
          : {
              background: 'linear-gradient(135deg, rgba(17,24,39,0.9), rgba(12,15,20,0.95))',
              border: '1px solid var(--border-dim)',
              boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
            }
      }
    >
      {/* Top line */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span
            className="text-[9px] font-bold px-2 py-1 rounded-md"
            style={{
              background: isActive ? `${activeColor}15` : 'rgba(255,255,255,0.04)',
              border: `1px solid ${isActive ? `${activeColor}30` : 'var(--border-dim)'}`,
              color: isActive ? activeColor : 'var(--text-muted)',
              fontFamily: "'JetBrains Mono', monospace",
              letterSpacing: '0.1em',
            }}
          >
            {shelf.id.toString().padStart(2, '0')}
          </span>
          <span
            className="text-xs"
            style={{
              color: isActive ? activeColor : 'var(--text-muted)',
              fontFamily: "'JetBrains Mono', monospace",
              letterSpacing: '0.08em',
              fontSize: '10px',
            }}
          >
            {shelf.zone}
          </span>
        </div>

        <div
          className="px-2.5 py-1 rounded-full text-[10px] font-bold"
          style={{
            background: packageCount > 0 ? `${activeColor}15` : 'rgba(255,255,255,0.04)',
            border: `1px solid ${packageCount > 0 ? `${activeColor}30` : 'var(--border-dim)'}`,
            color: packageCount > 0 ? activeColor : 'var(--text-muted)',
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          {packageCount > 0 ? `${packageCount} kiện` : 'Trống'}
        </div>
      </div>

      {/* Title */}
      <div className="mb-4">
        <h3
          className="text-xl font-black group-hover:scale-[1.02] transition-transform"
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            color: isActive ? activeColor : 'var(--text-primary)',
            letterSpacing: '-0.02em',
            transition: 'color 0.2s ease',
          }}
        >
          {shelf.label}
        </h3>
        <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}>
          Nhấn để quản lý 16 ô chứa
        </p>
      </div>

      {/* Status tags */}
      <div className="flex gap-2 pt-3" style={{ borderTop: '1px solid var(--border-dim)' }}>
        {hasSource && (
          <span
            className="text-[10px] font-bold px-2 py-1 rounded-md"
            style={{
              background: 'rgba(0,212,255,0.15)',
              border: '1px solid rgba(0,212,255,0.3)',
              color: 'var(--accent)',
              fontFamily: "'JetBrains Mono', monospace",
              letterSpacing: '0.06em',
            }}
          >
            SRC: Ô {source?.cell}
          </span>
        )}
        {hasDest && (
          <span
            className="text-[10px] font-bold px-2 py-1 rounded-md"
            style={{
              background: 'rgba(0,255,136,0.15)',
              border: '1px solid rgba(0,255,136,0.3)',
              color: 'var(--success)',
              fontFamily: "'JetBrains Mono', monospace",
              letterSpacing: '0.06em',
            }}
          >
            DST: Ô {dest?.cell}
          </span>
        )}
        {!isActive && (
          <span className="text-[10px] italic" style={{ color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace", alignSelf: 'center' }}>
            Chưa chọn vị trí AGV
          </span>
        )}
      </div>

      {/* Corner glow */}
      <span
        className="absolute -bottom-8 -right-8 w-24 h-24 rounded-full pointer-events-none transition-all duration-300"
        style={{
          background: `radial-gradient(circle, ${activeColor}08 0%, transparent 70%)`,
          boxShadow: isActive ? `0 0 40px ${activeColor}15` : 'none',
        }}
      />
    </button>
  );
}
