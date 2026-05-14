'use client';

import { useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { Modal, Button, message, Tag } from 'antd';
import { ArrowRight, PackageOpen, Send } from 'lucide-react';
import { RootState } from '@/store/store';
import { setSource, setDest, resetInventory, SelectedCell } from '@/store/inventorySlice';
import { useSubmitMoveCommandMutation } from '@/store/apiSlice';

const ROWS = ['A', 'B', 'C', 'D'];
const COLS = ['1', '2', '3', '4'];

type ShelfId = 1 | 2 | 3 | 4;

const SHELF_POSITIONS = [
  { id: 1 as ShelfId, label: 'Kệ 1', corner: 'Góc Tây Bắc' },
  { id: 2 as ShelfId, label: 'Kệ 2', corner: 'Góc Đông Bắc' },
  { id: 3 as ShelfId, label: 'Kệ 3', corner: 'Góc Tây Nam' },
  { id: 4 as ShelfId, label: 'Kệ 4', corner: 'Góc Đông Nam' },
];

export default function InventoryPage() {
  const dispatch = useDispatch();
  const source = useSelector((state: RootState) => state.inventory.source);
  const dest = useSelector((state: RootState) => state.inventory.dest);
  const [submitMoveCommand, { isLoading }] = useSubmitMoveCommandMutation();

  const [activeShelf, setActiveShelf] = useState<ShelfId | null>(null);
  const [pendingCell, setPendingCell] = useState<SelectedCell | null>(null);
  const [isConfirmDestOpen, setIsConfirmDestOpen] = useState(false);
  const [isRemoveSourceConfirmOpen, setIsRemoveSourceConfirmOpen] = useState(false);

  const selectedCount = (source ? 1 : 0) + (dest ? 1 : 0);

  // Kiểm tra trạng thái của một ô bất kỳ
  const getCellStatus = (shelfId: number, cell: string): 'source' | 'dest' | 'none' => {
    if (source?.shelfId === shelfId && source?.cell === cell) return 'source';
    if (dest?.shelfId === shelfId && dest?.cell === cell) return 'dest';
    return 'none';
  };

  const handleCellClick = (shelfId: ShelfId, cell: string) => {
    const status = getCellStatus(shelfId, cell);

    if (status === 'source') {
      // Bỏ chọn ô nguồn (mở modal hỏi)
      handleRemoveSource();
      return;
    }
    if (status === 'dest') {
      // Bỏ chọn ô đích ngay
      dispatch(setDest(null));
      return;
    }

    if (!source) {
      // Chưa có ô nguồn → chọn làm ô NGUỒN ngay
      dispatch(setSource({ shelfId, cell }));
    } else if (!dest) {
      // Có ô nguồn, chưa có ô đích → hỏi xác nhận
      setPendingCell({ shelfId, cell });
      setIsConfirmDestOpen(true);
    } else {
      // Đã đủ 2 ô
      message.warning('Chỉ được chọn tối đa 2 ô. Hãy huỷ ô đã chọn để chọn lại.');
    }
  };

  // Xác nhận chọn ô đích
  const handleConfirmDest = () => {
    if (pendingCell) dispatch(setDest(pendingCell));
    setIsConfirmDestOpen(false);
    setPendingCell(null);
  };

  const handleCancelConfirmDest = () => {
    setIsConfirmDestOpen(false);
    setPendingCell(null);
  };

  // Xóa ô đích: đơn giản, dest về null, source giữ nguyên
  const handleRemoveDest = () => {
    dispatch(setDest(null));
  };

  // Mở modal hỏi khi xóa ô nguồn
  const handleRemoveSource = () => {
    setIsRemoveSourceConfirmOpen(true);
  };

  // Promote: ô đích trở thành ô nguồn, ô đích bị xóa
  const handlePromoteDestToSource = () => {
    dispatch(setSource(dest));
    dispatch(setDest(null));
    setIsRemoveSourceConfirmOpen(false);
  };

  // Chỉ xóa ô nguồn, ô đích GIỮ NGUYÊN ở vị trí đích
  const handleRemoveSourceOnly = () => {
    dispatch(setSource(null));
    // dest KHÔNG thay đổi — vẫn là ô đích
    setIsRemoveSourceConfirmOpen(false);
  };

  const handleSubmit = async () => {
    if (!source || !dest) {
      message.warning('Vui lòng chọn đủ ô nguồn và ô đích trước khi gửi lệnh.');
      return;
    }
    try {
      await submitMoveCommand({ from: source, to: dest }).unwrap();
      message.success('Gửi lệnh di chuyển thành công!');
      dispatch(resetInventory());
    } catch {
      message.error('Gửi lệnh thất bại!');
    }
  };

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <div className="px-8 py-5 bg-white border-b border-gray-200">
        <h1 className="text-xl font-bold text-gray-900">Quản lý kho hàng</h1>
        <p className="text-sm text-gray-500 mt-0.5">Chọn ô nguồn và ô đích để gửi lệnh di chuyển</p>
      </div>

      {/* Status bar */}
      <div className="px-8 py-3 bg-blue-50 border-b border-blue-100 flex items-center gap-6">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-gray-500">Ô nguồn:</span>
          {source ? (
            <Tag
              color="blue"
              className="m-0 cursor-default select-none"
              closable
              onClose={(e) => { e.preventDefault(); handleRemoveSource(); }}
            >
              Kệ {source.shelfId} – {source.cell}
            </Tag>
          ) : (
            <span className="text-gray-400 italic">Chưa chọn</span>
          )}
        </div>
        <ArrowRight size={16} className="text-gray-400" />
        <div className="flex items-center gap-2 text-sm">
          <span className="text-gray-500">Ô đích:</span>
          {dest ? (
            <Tag
              color="green"
              className="m-0 cursor-default select-none"
              closable
              onClose={(e) => { e.preventDefault(); handleRemoveDest(); }}
            >
              Kệ {dest.shelfId} – {dest.cell}
            </Tag>
          ) : (
            <span className="text-gray-400 italic">Chưa chọn</span>
          )}
        </div>
      </div>

      {/* Shelf grid */}
      <div className="flex-1 relative p-8">
        <div className="flex justify-between mb-auto absolute top-8 left-8 right-8">
          <ShelfCard shelf={SHELF_POSITIONS[0]} source={source} dest={dest} onClick={() => setActiveShelf(1)} />
          <ShelfCard shelf={SHELF_POSITIONS[1]} source={source} dest={dest} onClick={() => setActiveShelf(2)} />
        </div>

        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="text-center">
            <PackageOpen size={40} className="text-gray-200 mx-auto mb-2" />
            <p className="text-sm text-gray-300 font-medium">Khu vực kho</p>
          </div>
        </div>

        <div className="flex justify-between absolute bottom-8 left-8 right-8">
          <ShelfCard shelf={SHELF_POSITIONS[2]} source={source} dest={dest} onClick={() => setActiveShelf(3)} />
          <ShelfCard shelf={SHELF_POSITIONS[3]} source={source} dest={dest} onClick={() => setActiveShelf(4)} />
        </div>
      </div>

      {/* Footer action */}
      <div className="px-8 py-4 bg-white border-t border-gray-200 flex items-center justify-between">
        <p className="text-sm text-gray-500">
          {selectedCount === 2 ? 'Sẵn sàng gửi lệnh di chuyển.' : `Đã chọn ${selectedCount}/2 ô.`}
        </p>
        <div className="flex gap-3">
          <Button onClick={() => dispatch(resetInventory())} disabled={selectedCount === 0 || isLoading}>
            Huỷ chọn
          </Button>
          <Button
            type="primary"
            icon={<Send size={14} />}
            loading={isLoading}
            disabled={selectedCount < 2}
            onClick={handleSubmit}
            className="bg-blue-600"
          >
            Gửi lệnh di chuyển
          </Button>
        </div>
      </div>

      {/* Modal chọn ô trong kệ */}
      {activeShelf && (
        <Modal
          open={activeShelf !== null}
          onCancel={() => setActiveShelf(null)}
          footer={null}
          title={
            <div className="flex items-center gap-2">
              <PackageOpen size={18} className="text-blue-600" />
              <span className="font-bold text-gray-800">Kệ {activeShelf} — Chọn ô</span>
            </div>
          }
          width={440}
          centered
        >
          <p className="text-xs text-gray-400 mb-4">Click vào ô để chọn. Click lần nữa để bỏ chọn.</p>
          <div className="grid grid-cols-4 gap-2">
            {ROWS.map((row) =>
              COLS.map((col) => {
                const cell = `${row}${col}`;
                const status = getCellStatus(activeShelf, cell);
                return (
                  <button
                    key={cell}
                    onClick={() => handleCellClick(activeShelf, cell)}
                    className={`h-16 rounded-lg border-2 text-sm font-bold transition-all ${
                      status === 'source'
                        ? 'bg-blue-600 border-blue-700 text-white shadow-md scale-105'
                        : status === 'dest'
                        ? 'bg-green-500 border-green-600 text-white shadow-md scale-105'
                        : 'bg-white border-gray-200 text-gray-600 hover:border-blue-300 hover:text-blue-600 hover:bg-blue-50'
                    }`}
                  >
                    {cell}
                  </button>
                );
              })
            )}
          </div>
          <div className="mt-4 flex gap-4 text-xs text-gray-500">
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-sm bg-blue-600 inline-block" /> Ô nguồn
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-sm bg-green-500 inline-block" /> Ô đích
            </span>
          </div>
        </Modal>
      )}

      {/* Modal xác nhận ô đích */}
      <Modal
        open={isConfirmDestOpen}
        title="Xác nhận ô đích"
        onOk={handleConfirmDest}
        onCancel={handleCancelConfirmDest}
        okText="Xác nhận"
        cancelText="Huỷ"
        centered
        zIndex={1100}
        okButtonProps={{ className: 'bg-blue-600' }}
      >
        {source && pendingCell && (
          <p className="text-gray-700">
            Bạn có xác nhận di chuyển từ{' '}
            <strong className="text-blue-700">Kệ {source.shelfId} – Ô {source.cell}</strong>{' '}
            đến{' '}
            <strong className="text-green-700">Kệ {pendingCell.shelfId} – Ô {pendingCell.cell}</strong>{' '}
            không?
          </p>
        )}
      </Modal>

      {/* Modal xác nhận khi xóa ô nguồn */}
      <Modal
        open={isRemoveSourceConfirmOpen}
        title="Xoá ô nguồn"
        centered
        zIndex={1100}
        onCancel={() => setIsRemoveSourceConfirmOpen(false)}
        footer={
          <div className="flex justify-end gap-2">
            <Button onClick={() => setIsRemoveSourceConfirmOpen(false)}>Đóng</Button>
            <Button danger onClick={handleRemoveSourceOnly}>Chỉ xoá ô nguồn</Button>
            {dest && (
              <Button type="primary" className="bg-blue-600" onClick={handlePromoteDestToSource}>
                Chuyển ô đích thành ô nguồn
              </Button>
            )}
          </div>
        }
      >
        {dest ? (
          <p className="text-gray-700">
            Bạn đang xoá <strong className="text-blue-700">Kệ {source?.shelfId} – Ô {source?.cell}</strong>.
            <br /><br />
            Bạn có muốn chuyển ô đích{' '}
            <strong className="text-green-700">Kệ {dest.shelfId} – Ô {dest.cell}</strong>{' '}
            thành ô nguồn mới không?
          </p>
        ) : (
          <p className="text-gray-700">
            Xác nhận xoá ô nguồn{' '}
            <strong className="text-blue-700">Kệ {source?.shelfId} – Ô {source?.cell}</strong>?
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
  onClick,
}: {
  shelf: { id: ShelfId; label: string; corner: string };
  source: SelectedCell | null;
  dest: SelectedCell | null;
  onClick: () => void;
}) {
  const hasSource = source?.shelfId === shelf.id;
  const hasDest = dest?.shelfId === shelf.id;
  const hasAny = hasSource || hasDest;

  return (
    <button
      onClick={onClick}
      className="w-52 h-44 bg-white border-2 border-gray-200 rounded-xl flex flex-col items-center justify-center gap-3 hover:border-blue-400 hover:shadow-md transition-all group"
    >
      <div className="text-center">
        <p className="text-lg font-bold text-gray-800 group-hover:text-blue-700">{shelf.label}</p>
        <p className="text-xs text-gray-400">{shelf.corner}</p>
      </div>
      <div className="flex gap-1.5">
        {hasSource && <Tag color="blue" className="m-0 text-xs">Nguồn</Tag>}
        {hasDest && <Tag color="green" className="m-0 text-xs">Đích</Tag>}
        {!hasAny && <span className="text-xs text-gray-400">Chưa chọn ô nào</span>}
      </div>
    </button>
  );
}
