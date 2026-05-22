'use client';

import { useState, useMemo } from 'react';
import { Modal, Button, notification, Tag, Badge, Input, Collapse, Spin, Tooltip, Empty } from 'antd';
import { ArrowRight, PackageOpen, Send, Search, Package, Layers, Info, CheckCircle, ArrowLeftRight } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { setSource, setDest, resetInventory, SelectedCell } from '@/store/inventorySlice';
import { useGetAllSlotsQuery, useGetPackagesQuery, useMovePackageMutation } from '@/store/services/inventoryApi';
import { parseSlotCode, toSlotCode, PackageItem, ShelfSlot } from '@/types/inventory';

const ROWS = ['A', 'B', 'C', 'D'];
const COLS = ['1', '2', '3', '4'];

type ShelfId = 1 | 2 | 3 | 4;

const SHELF_POSITIONS = [
  { id: 1 as ShelfId, label: 'Kệ số 1', corner: 'Khu vực Tây Bắc - A' },
  { id: 2 as ShelfId, label: 'Kệ số 2', corner: 'Khu vực Đông Bắc - B' },
  { id: 3 as ShelfId, label: 'Kệ số 3', corner: 'Khu vực Tây Nam - C' },
  { id: 4 as ShelfId, label: 'Kệ số 4', corner: 'Khu vực Đông Nam - D' },
];

export default function InventoryPage() {
  const dispatch = useAppDispatch();
  const source = useAppSelector((state) => state.inventory.source);
  const dest = useAppSelector((state) => state.inventory.dest);

  // API hooks
  const { data: slots = [], isLoading: isSlotsLoading } = useGetAllSlotsQuery();
  const { data: packages = [], isLoading: isPackagesLoading } = useGetPackagesQuery();
  const [movePackage, { isLoading: isMoving }] = useMovePackageMutation();

  // Local state
  const [activeShelf, setActiveShelf] = useState<ShelfId | null>(null);
  const [pendingCell, setPendingCell] = useState<SelectedCell | null>(null);
  const [isConfirmDestOpen, setIsConfirmDestOpen] = useState(false);
  const [isRemoveSourceConfirmOpen, setIsRemoveSourceConfirmOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');

  const selectedCount = (source ? 1 : 0) + (dest ? 1 : 0);

  // _id → PackageItem
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

  // `${shelfId}-${cell}` → ShelfSlot
  const positionSlotMap = useMemo(() => {
    const map: Record<string, ShelfSlot> = {};
    slots.forEach((slot) => {
      const { shelfId, cell } = parseSlotCode(slot.code);
      map[`${shelfId}-${cell}`] = slot;
    });
    return map;
  }, [slots]);

  // Nhóm kiện hàng theo kệ
  const packagesByShelf = useMemo(() => {
    const groups: Record<number, PackageItem[]> = { 1: [], 2: [], 3: [], 4: [] };
    packages.forEach((pkg) => {
      const slot = slots.find((s) => s.packageId === pkg._id);
      if (!slot) return;
      const { shelfId, cell } = parseSlotCode(slot.code);
      if (!groups[shelfId]) return;
      const item: PackageItem = { ...pkg, shelfId, cell, importedAt: pkg.createdAt ?? new Date().toISOString() };
      if (
        !searchTerm ||
        item.packageName.toLowerCase().includes(searchTerm.toLowerCase()) ||
        item._id.toLowerCase().includes(searchTerm.toLowerCase())
      ) {
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

    if (status === 'source') {
      handleRemoveSource();
      return;
    }
    if (status === 'dest') {
      dispatch(setDest(null));
      return;
    }

    if (!source) {
      dispatch(setSource({ shelfId, cell }));
    } else if (!dest) {
      // Block occupied destination slot at selection time
      const slotKey = `${shelfId}-${cell}`;
      const slot = positionSlotMap[slotKey];
      if (slot?.packageId) {
        notification.warning({
          message: 'Ô đích đã có kiện hàng',
          description: 'Vui lòng chọn một ô trống để di chuyển.',
          placement: 'topRight',
        });
        return;
      }
      setPendingCell({ shelfId, cell });
      setIsConfirmDestOpen(true);
    } else {
      notification.warning({
        message: 'Chỉ được chọn tối đa 2 ô',
        description: 'Hãy huỷ ô đã chọn để chọn lại.',
        placement: 'topRight',
      });
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

  const handleRemoveDest = () => {
    dispatch(setDest(null));
  };

  const handleRemoveSource = () => {
    setIsRemoveSourceConfirmOpen(true);
  };

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
      notification.warning({
        message: 'Chưa chọn đủ vị trí',
        description: 'Vui lòng chọn đủ ô nguồn và ô đích trước khi gửi lệnh.',
        placement: 'topRight',
      });
      return;
    }

    try {
      const sourceSlotCode = toSlotCode(source.shelfId, source.cell);
      const targetSlotCode = toSlotCode(dest.shelfId, dest.cell);
      await movePackage({ sourceSlotCode, targetSlotCode }).unwrap();
      notification.success({
        message: 'Thành công',
        description: 'Gửi lệnh di chuyển thành công!',
        placement: 'topRight',
      });
      dispatch(resetInventory());
    } catch (err: unknown) {
      const errMsg =
        (err as { data?: { message?: string } })?.data?.message ||
        (err as { error?: string })?.error ||
        'Gửi lệnh thất bại!';
      notification.error({
        message: 'Thất bại',
        description: errMsg,
        placement: 'topRight',
      });
    }
  };

  const selectFromList = (shelfId: number, cell: string) => {
    handleCellClick(shelfId as ShelfId, cell);
  };

  const totalPackages = packages.length;
  const isLoading = isSlotsLoading || isPackagesLoading;

  const getPackageForCell = (shelfId: number, cell: string) => {
    const slot = positionSlotMap[`${shelfId}-${cell}`];
    if (!slot || !slot.packageId) return null;
    return packageMap[slot.packageId] ?? null;
  };

  return (
    <div className="flex h-screen bg-slate-100 overflow-hidden font-sans">
      {/* Main Area: Sơ đồ kho hàng */}
      <div className="flex-1 flex flex-col h-full overflow-hidden relative">
        {/* Header */}
        <div className="px-8 py-5 bg-white border-b border-slate-200 shadow-sm flex justify-between items-center z-10">
          <div>
            <h1 className="text-2xl font-black text-slate-800 tracking-tight flex items-center gap-2">
              <Layers className="text-blue-600" size={28} /> Robot Warehouse Control
            </h1>
            <p className="text-sm text-slate-500 mt-1">
              Đồ án tốt nghiệp — Tôn Đức Thắng University &nbsp;|&nbsp; Giám sát kho hàng tự động
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-50 text-emerald-700 text-xs font-semibold border border-emerald-200">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
              Hệ thống Online
            </span>
          </div>
        </div>

        {/* Status bar */}
        <div className="px-8 py-3.5 bg-gradient-to-r from-blue-900 to-indigo-900 text-white shadow-md flex items-center gap-6 z-10">
          <div className="flex items-center gap-3 text-sm font-medium">
            <span className="text-blue-200 uppercase text-xs tracking-wider font-semibold">Điểm đi (Nguồn):</span>
            {source ? (
              <Tag
                color="#2563eb"
                className="m-0 px-3 py-1 text-sm font-bold rounded-lg shadow-sm flex items-center gap-1 border-0"
                closable
                onClose={(e) => { e.preventDefault(); handleRemoveSource(); }}
              >
                Kệ {source.shelfId} – Ô {source.cell}
                {getPackageForCell(source.shelfId, source.cell) && (
                  <span className="font-normal opacity-90 ml-1">
                    ({getPackageForCell(source.shelfId, source.cell)?.packageName})
                  </span>
                )}
              </Tag>
            ) : (
              <span className="text-slate-400 italic font-light">Chưa chọn (Bấm vào kệ để chọn)</span>
            )}
          </div>
          <ArrowRight size={18} className="text-blue-400 animate-pulse" />
          <div className="flex items-center gap-3 text-sm font-medium">
            <span className="text-blue-200 uppercase text-xs tracking-wider font-semibold">Điểm đến (Đích):</span>
            {dest ? (
              <Tag
                color="#10b981"
                className="m-0 px-3 py-1 text-sm font-bold rounded-lg shadow-sm flex items-center gap-1 border-0"
                closable
                onClose={(e) => { e.preventDefault(); handleRemoveDest(); }}
              >
                Kệ {dest.shelfId} – Ô {dest.cell}
                {getPackageForCell(dest.shelfId, dest.cell) && (
                  <span className="font-normal opacity-90 ml-1">
                    ({getPackageForCell(dest.shelfId, dest.cell)?.packageName})
                  </span>
                )}
              </Tag>
            ) : (
              <span className="text-slate-400 italic font-light">Chưa chọn vị trí đích</span>
            )}
          </div>
        </div>

        {/* Shelf Grid 3D-like Area */}
        <div className="flex-1 relative p-10 bg-slate-900 overflow-hidden flex items-center justify-center shadow-inner">
          {/* Background grid pattern */}
          <div className="absolute inset-0 bg-[linear-gradient(to_right,#1e293b_1px,transparent_1px),linear-gradient(to_bottom,#1e293b_1px,transparent_1px)] bg-[size:4rem_4rem] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_50%,#000_70%,transparent_100%)] opacity-40" />

          {/* Sơ đồ 4 kệ */}
          <div className="absolute inset-12 flex flex-col justify-between max-w-5xl mx-auto my-auto h-[calc(100%-6rem)]">
            {/* Hàng kệ trên (1 & 2) */}
            <div className="flex justify-between w-full z-10">
              <ShelfCard
                shelf={SHELF_POSITIONS[0]}
                source={source}
                dest={dest}
                packageCount={packagesByShelf[1]?.length || 0}
                onClick={() => setActiveShelf(1)}
              />
              <ShelfCard
                shelf={SHELF_POSITIONS[1]}
                source={source}
                dest={dest}
                packageCount={packagesByShelf[2]?.length || 0}
                onClick={() => setActiveShelf(2)}
              />
            </div>

            {/* Center Robot / AGV Path graphic */}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="text-center p-8 rounded-3xl bg-slate-800/60 backdrop-blur-md border border-slate-700/50 shadow-2xl">
                <div className="w-20 h-20 rounded-2xl bg-blue-500/20 border border-blue-500/30 flex items-center justify-center mx-auto mb-3 shadow-[0_0_30px_rgba(59,130,246,0.3)] animate-bounce">
                  <PackageOpen size={44} className="text-blue-400" />
                </div>
                <p className="text-xs font-bold uppercase tracking-widest text-blue-300">Khu Vực Trung Chuyển AGV</p>
                <p className="text-xs text-slate-400 mt-1 max-w-xs">Robot tự động tiếp cận kệ và di chuyển hàng hóa theo lệnh điều phối</p>
              </div>
            </div>

            {/* Hàng kệ dưới (3 & 4) */}
            <div className="flex justify-between w-full z-10">
              <ShelfCard
                shelf={SHELF_POSITIONS[2]}
                source={source}
                dest={dest}
                packageCount={packagesByShelf[3]?.length || 0}
                onClick={() => setActiveShelf(3)}
              />
              <ShelfCard
                shelf={SHELF_POSITIONS[3]}
                source={source}
                dest={dest}
                packageCount={packagesByShelf[4]?.length || 0}
                onClick={() => setActiveShelf(4)}
              />
            </div>
          </div>
        </div>

        {/* Footer action */}
        <div className="px-8 py-4 bg-white border-t border-slate-200 flex items-center justify-between shadow-lg z-10">
          <div className="flex items-center gap-2">
            <Info size={18} className="text-blue-500" />
            <span className="text-sm font-medium text-slate-600">
              {selectedCount === 2 ? (
                <span className="text-emerald-600 font-bold flex items-center gap-1.5">
                  <CheckCircle size={16} /> Đã chọn đủ 2 vị trí. Hệ thống AGV sẵn sàng nhận lệnh.
                </span>
              ) : (
                `Vui lòng chọn đủ 2 vị trí (Nguồn và Đích). Đã chọn: ${selectedCount}/2`
              )}
            </span>
          </div>
          <div className="flex gap-3">
            <Button
              size="large"
              onClick={() => dispatch(resetInventory())}
              disabled={selectedCount === 0 || isMoving}
              className="rounded-xl font-medium"
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
              className="bg-blue-600 hover:bg-blue-700 shadow-md shadow-blue-500/20 rounded-xl font-semibold px-6 flex items-center gap-2"
            >
              Phát lệnh di chuyển AGV
            </Button>
          </div>
        </div>
      </div>

      {/* Panel bên phải: Danh sách kiện hàng trong kho */}
      <div className="w-[420px] bg-white border-l border-slate-200 flex flex-col h-full shadow-xl z-20">
        <div className="p-5 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
            <Package className="text-blue-600" size={22} /> Danh Sách Kiện Hàng
          </h2>
          <Badge count={totalPackages} style={{ backgroundColor: '#2563eb', fontWeight: 'bold' }} />
        </div>

        <div className="p-4 border-b border-slate-100 bg-white">
          <Input
            size="large"
            placeholder="Tìm theo tên hoặc mã đơn..."
            prefix={<Search size={18} className="text-slate-400 mr-2" />}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            allowClear
            className="rounded-xl border-slate-300 hover:border-blue-500 focus:border-blue-500"
          />
        </div>

        <div className="flex-1 overflow-y-auto p-4 bg-slate-50">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center h-64 gap-3">
              <Spin size="large" />
              <p className="text-sm text-slate-500 font-medium">Đang tải danh sách hàng hóa...</p>
            </div>
          ) : totalPackages === 0 ? (
            <Empty description="Kho hàng đang trống" className="mt-12" />
          ) : (
            <Collapse
              defaultActiveKey={['1', '2', '3', '4']}
              ghost
              items={SHELF_POSITIONS.map((shelf) => {
                const shelfPackages = packagesByShelf[shelf.id] || [];
                return {
                  key: String(shelf.id),
                  label: (
                    <div className="flex items-center justify-between py-1 font-bold text-slate-800 text-base">
                      <span>{shelf.label}</span>
                      <Tag color={shelfPackages.length > 0 ? "blue" : "default"} className="rounded-full px-2.5 py-0.5 m-0 font-bold">
                        {shelfPackages.length} đơn
                      </Tag>
                    </div>
                  ),
                  children: shelfPackages.length === 0 ? (
                    <p className="text-sm text-slate-400 italic py-2 px-3 bg-white/60 rounded-lg">Không có đơn hàng nào trên kệ này.</p>
                  ) : (
                    <div className="flex flex-col gap-2.5">
                      {shelfPackages.map((pkg) => {
                        const cellStatus = getCellStatus(pkg.shelfId, pkg.cell);
                        return (
                          <div
                            key={pkg._id}
                            className={`p-3.5 rounded-xl border bg-white shadow-xs transition-all hover:shadow-md ${
                              cellStatus === 'source'
                                ? 'border-blue-500 ring-2 ring-blue-500/20 bg-blue-50/50'
                                : cellStatus === 'dest'
                                ? 'border-emerald-500 ring-2 ring-emerald-500/20 bg-emerald-50/50'
                                : 'border-slate-200 hover:border-blue-300'
                            }`}
                          >
                            <div className="flex items-start justify-between gap-2 mb-2">
                              <div>
                                <h4 className="font-bold text-slate-800 text-sm leading-snug">{pkg.packageName}</h4>
                                <span className="text-xs font-mono text-slate-400 font-medium">{pkg._id.slice(-8).toUpperCase()}</span>
                              </div>
                              <span className="inline-flex items-center justify-center px-2 py-1 bg-slate-100 text-slate-700 font-bold text-xs rounded-lg border border-slate-200">
                                Ô {pkg.cell}
                              </span>
                            </div>

                            <div className="text-xs text-slate-500 flex items-center justify-between mt-2 pt-2 border-t border-slate-100">
                              <span>Ngày nhập: <strong className="text-slate-700">{new Date(pkg.importedAt).toLocaleDateString('vi-VN')}</strong></span>
                            </div>

                            <div className="mt-3 flex gap-2">
                              {cellStatus === 'none' ? (
                                <Button
                                  size="small"
                                  type="primary"
                                  ghost
                                  onClick={() => selectFromList(pkg.shelfId, pkg.cell)}
                                  className="w-full text-xs font-semibold rounded-lg hover:bg-blue-50"
                                >
                                  {source ? "Chọn làm ô Đích" : "Chọn làm ô Nguồn"}
                                </Button>
                              ) : (
                                <Tag color={cellStatus === 'source' ? 'blue' : 'green'} className="w-full text-center m-0 py-1 rounded-lg font-bold">
                                  {cellStatus === 'source' ? 'Đang chọn làm Nguồn' : 'Đang chọn làm Đích'}
                                </Tag>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )
                };
              })}
            />
          )}
        </div>
      </div>

      {/* Modal chọn ô trong kệ */}
      {activeShelf && (
        <Modal
          open={activeShelf !== null}
          onCancel={() => setActiveShelf(null)}
          footer={null}
          title={
            <div className="flex items-center gap-3 pb-2 border-b border-slate-100">
              <div className="w-10 h-10 rounded-xl bg-blue-100 text-blue-600 flex items-center justify-center font-black text-lg">
                {activeShelf}
              </div>
              <div>
                <h3 className="font-black text-slate-800 text-lg">Kệ số {activeShelf}</h3>
                <p className="text-xs font-normal text-slate-500">Bấm vào từng ô để chọn vị trí nguồn hoặc đích cho robot</p>
              </div>
            </div>
          }
          width={640}
          centered
          className="custom-inventory-modal"
        >
          <div className="grid grid-cols-4 gap-3 py-4">
            {ROWS.map((row) =>
              COLS.map((col) => {
                const cell = `${row}${col}`;
                const status = getCellStatus(activeShelf, cell);
                const item = getPackageForCell(activeShelf, cell);

                return (
                  <Tooltip
                    key={cell}
                    title={item ? `${item.packageName} - ${item._id.slice(-8).toUpperCase()}` : `Ô ${cell} (Trống)`}
                    placement="top"
                  >
                    <button
                      onClick={() => handleCellClick(activeShelf, cell)}
                      className={`h-28 rounded-2xl border-2 p-3 text-left transition-all relative flex flex-col justify-between overflow-hidden group ${
                        status === 'source'
                          ? 'bg-blue-600 border-blue-600 text-white shadow-lg shadow-blue-500/30 ring-4 ring-blue-500/20 scale-[1.02]'
                          : status === 'dest'
                          ? 'bg-emerald-500 border-emerald-500 text-white shadow-lg shadow-emerald-500/30 ring-4 ring-emerald-500/20 scale-[1.02]'
                          : item
                          ? 'bg-white border-blue-200 hover:border-blue-400 hover:shadow-md hover:bg-blue-50/40 text-slate-800'
                          : 'bg-slate-50/80 border-slate-200 text-slate-400 hover:bg-white hover:border-slate-300 hover:text-slate-600'
                      }`}
                    >
                      {/* Cell ID & Status Badge */}
                      <div className="flex items-center justify-between w-full">
                        <span className={`text-xs font-black px-2 py-0.5 rounded-md ${
                          status === 'source' || status === 'dest'
                            ? 'bg-white/20 text-white'
                            : item
                            ? 'bg-blue-100 text-blue-700'
                            : 'bg-slate-200 text-slate-600'
                        }`}>
                          {cell}
                        </span>
                        {item && (
                          <Package size={16} className={status !== 'none' ? 'text-white' : 'text-blue-500'} />
                        )}
                      </div>

                      {/* Package Name or Empty state */}
                      <div className="mt-2 w-full">
                        {item ? (
                          <div>
                            <p className={`text-xs font-bold leading-tight line-clamp-2 ${
                              status !== 'none' ? 'text-white' : 'text-slate-800 group-hover:text-blue-600'
                            }`}>
                              {item.packageName}
                            </p>
                            <p className={`text-[10px] mt-1 font-mono opacity-80 line-clamp-1 ${
                              status !== 'none' ? 'text-white/80' : 'text-slate-400'
                            }`}>
                              {item._id.slice(-8).toUpperCase()}
                            </p>
                          </div>
                        ) : (
                          <p className={`text-xs font-medium italic ${status !== 'none' ? 'text-white/80' : 'text-slate-400'}`}>
                            [Trống]
                          </p>
                        )}
                      </div>
                    </button>
                  </Tooltip>
                );
              })
            )}
          </div>
          <div className="mt-2 pt-4 border-t border-slate-100 flex gap-6 text-xs text-slate-600 font-semibold justify-center">
            <span className="flex items-center gap-2">
              <span className="w-3.5 h-3.5 rounded-md bg-blue-600 inline-block shadow-sm" /> Vị trí Nguồn
            </span>
            <span className="flex items-center gap-2">
              <span className="w-3.5 h-3.5 rounded-md bg-emerald-500 inline-block shadow-sm" /> Vị trí Đích
            </span>
            <span className="flex items-center gap-2">
              <span className="w-3.5 h-3.5 rounded-md bg-white border-2 border-blue-200 inline-block" /> Ô có hàng hóa
            </span>
            <span className="flex items-center gap-2">
              <span className="w-3.5 h-3.5 rounded-md bg-slate-100 border border-slate-200 inline-block" /> Ô trống
            </span>
          </div>
        </Modal>
      )}

      {/* Modal xác nhận ô đích */}
      <Modal
        open={isConfirmDestOpen}
        title={<span className="font-bold text-lg text-slate-800 flex items-center gap-2"><ArrowLeftRight className="text-blue-600" /> Xác nhận điều phối robot</span>}
        onOk={handleConfirmDest}
        onCancel={handleCancelConfirmDest}
        okText="Xác nhận"
        cancelText="Huỷ"
        centered
        zIndex={1100}
        okButtonProps={{ className: 'bg-blue-600 font-semibold rounded-lg shadow-md' }}
        cancelButtonProps={{ className: 'rounded-lg' }}
      >
        {source && pendingCell && (
          <div className="py-4 text-slate-700 text-base leading-relaxed">
            <p>Robot sẽ nhận lệnh di chuyển hàng hóa giữa 2 vị trí sau:</p>
            <div className="mt-3 p-4 bg-slate-50 rounded-xl border border-slate-200 flex flex-col gap-2">
              <div className="flex items-center gap-3">
                <span className="w-16 font-bold text-xs text-slate-500 uppercase tracking-wider">Từ (Nguồn):</span>
                <strong className="text-blue-600 bg-blue-50 px-3 py-1 rounded-lg border border-blue-200">
                  Kệ {source.shelfId} – Ô {source.cell}{' '}
                  {getPackageForCell(source.shelfId, source.cell)
                    ? `(${getPackageForCell(source.shelfId, source.cell)?.packageName})`
                    : '(Trống)'}
                </strong>
              </div>
              <div className="flex items-center gap-3">
                <span className="w-16 font-bold text-xs text-slate-500 uppercase tracking-wider">Đến (Đích):</span>
                <strong className="text-emerald-600 bg-emerald-50 px-3 py-1 rounded-lg border border-emerald-200">
                  Kệ {pendingCell.shelfId} – Ô {pendingCell.cell}{' '}
                  {getPackageForCell(pendingCell.shelfId, pendingCell.cell)
                    ? `(${getPackageForCell(pendingCell.shelfId, pendingCell.cell)?.packageName})`
                    : '(Trống)'}
                </strong>
              </div>
            </div>
          </div>
        )}
      </Modal>

      {/* Modal xác nhận khi xóa ô nguồn */}
      <Modal
        open={isRemoveSourceConfirmOpen}
        title={<span className="font-bold text-lg text-slate-800">Cập nhật vị trí nguồn</span>}
        centered
        zIndex={1100}
        onCancel={() => setIsRemoveSourceConfirmOpen(false)}
        footer={
          <div className="flex justify-end gap-2.5 mt-4">
            <Button className="rounded-lg font-medium" onClick={() => setIsRemoveSourceConfirmOpen(false)}>Đóng</Button>
            <Button danger className="rounded-lg font-semibold" onClick={handleRemoveSourceOnly}>Chỉ xoá ô nguồn</Button>
            {dest && (
              <Button type="primary" className="bg-blue-600 font-semibold rounded-lg shadow-md" onClick={handlePromoteDestToSource}>
                Chuyển ô đích thành ô nguồn
              </Button>
            )}
          </div>
        }
      >
        {dest ? (
          <div className="py-2 text-slate-700">
            <p className="mb-3">Bạn đang muốn xoá vị trí nguồn <strong className="text-blue-600">Kệ {source?.shelfId} – Ô {source?.cell}</strong>.</p>
            <p>Bạn có muốn chuyển vị trí đích hiện tại (<strong className="text-emerald-600">Kệ {dest.shelfId} – Ô {dest.cell}</strong>) thành vị trí nguồn mới không?</p>
          </div>
        ) : (
          <p className="py-3 text-slate-700">
            Bạn có chắc chắn muốn xoá vị trí nguồn <strong className="text-blue-600">Kệ {source?.shelfId} – Ô {source?.cell}</strong> không?
          </p>
        )}
      </Modal>
    </div>
  );
}

function ShelfCard({
  shelf,
  source,
  dest,
  packageCount,
  onClick,
}: {
  shelf: { id: ShelfId; label: string; corner: string };
  source: SelectedCell | null;
  dest: SelectedCell | null;
  packageCount: number;
  onClick: () => void;
}) {
  const hasSource = source?.shelfId === shelf.id;
  const hasDest = dest?.shelfId === shelf.id;
  const hasAny = hasSource || hasDest;

  return (
    <button
      onClick={onClick}
      className={`w-72 p-6 rounded-2xl flex flex-col justify-between transition-all group relative text-left border border-slate-700/80 backdrop-blur-md shadow-2xl overflow-hidden ${
        hasSource
          ? 'bg-gradient-to-br from-blue-900/90 to-slate-900 border-blue-500/80 ring-4 ring-blue-500/20 shadow-blue-500/20'
          : hasDest
          ? 'bg-gradient-to-br from-emerald-900/90 to-slate-900 border-emerald-500/80 ring-4 ring-emerald-500/20 shadow-emerald-500/20'
          : 'bg-slate-800/80 hover:bg-slate-800 hover:border-blue-500/60 hover:shadow-[0_0_30px_rgba(59,130,246,0.15)]'
      }`}
    >
      {/* Top line badge */}
      <div className="flex items-center justify-between w-full">
        <span className="text-xs font-mono font-bold tracking-widest text-slate-400 uppercase">
          {shelf.corner.split(' - ')[0]}
        </span>
        <Badge
          count={packageCount > 0 ? `${packageCount} kiện` : 'Trống'}
          style={{
            backgroundColor: packageCount > 0 ? '#3b82f6' : '#64748b',
            color: '#fff',
            fontWeight: 'bold',
            fontSize: '11px',
            boxShadow: 'none'
          }}
        />
      </div>

      {/* Main title */}
      <div className="my-6">
        <h3 className="text-2xl font-black text-white tracking-wide group-hover:text-blue-400 transition-colors flex items-center gap-2">
          {shelf.label}
        </h3>
        <p className="text-xs text-slate-400 mt-1 font-medium">Bấm để quản lý 16 ô chứa hàng</p>
      </div>

      {/* Status indicator */}
      <div className="flex gap-2 pt-3 border-t border-slate-700/60 w-full">
        {hasSource && <Tag color="#2563eb" className="m-0 font-bold px-2.5 py-0.5 rounded-md text-xs border-0">Nguồn: Ô {source?.cell}</Tag>}
        {hasDest && <Tag color="#10b981" className="m-0 font-bold px-2.5 py-0.5 rounded-md text-xs border-0">Đích: Ô {dest?.cell}</Tag>}
        {!hasAny && <span className="text-xs font-medium text-slate-500 italic">Chưa chọn vị trí AGV</span>}
      </div>

      {/* Accent glow corner */}
      <div className="absolute -bottom-10 -right-10 w-28 h-28 bg-blue-500/10 rounded-full blur-2xl group-hover:bg-blue-500/20 transition-all pointer-events-none" />
    </button>
  );
}
