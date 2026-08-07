'use client';

import { useMemo, useState } from 'react';
import { Button, Modal, App } from 'antd';
import { Target, Check, X, Package } from 'lucide-react';

import {
  useGetAllSlotsQuery,
  useDispatchMoveMutation,
} from '@/store/services/inventoryApi';
import type { ShelfSlot, ZoneCode } from '@/types/inventory';

const SHELF_ROWS = ['A', 'B', 'C', 'D'] as const;
const SHELF_COLS = [1, 2, 3, 4] as const;

const ZONE_META: Record<ZoneCode, { label: string; accent: string }> = {
  S1: { label: 'S1', accent: '#00d4ff' },
  S2: { label: 'S2', accent: '#00ff88' },
  S3: { label: 'S3', accent: '#ffb800' },
  S4: { label: 'S4', accent: '#a855f7' },
};

function slotLabel(code: string): string {
  return code.slice(-2);
}

function buildSlotMatrix(slots: ShelfSlot[], shelfCode: string) {
  const byCode = new Map(slots.filter((s) => s.shelf === shelfCode).map((s) => [s.code, s]));
  return SHELF_ROWS.map((row) =>
    SHELF_COLS.map((col) => byCode.get(`${shelfCode}${row}${col}`) ?? null),
  );
}

function SlotCell({
  slot,
  isDest,
  isDisabled,
  onClick,
  accent,
}: {
  slot: ShelfSlot | null;
  isDest: boolean;
  isDisabled: boolean;
  onClick: () => void;
  accent: string;
}) {
  const status = slot?.status ?? 'UNKNOWN';
  const hasPkg = status === 'OCCUPIED';
  const available = status === 'AVAILABLE';

  return (
    <button
      type="button"
      disabled={isDisabled || !slot}
      onClick={onClick}
      className="relative w-10 h-10 rounded-lg flex flex-col items-center justify-center transition-all"
      style={{
        border: isDest ? '2px solid #ffb800' : '1px solid var(--border-dim)',
        background: isDest
          ? 'rgba(255,184,0,0.15)'
          : hasPkg
            ? 'rgba(0,212,255,0.08)'
            : available
              ? 'rgba(255,255,255,0.02)'
              : 'rgba(255,255,255,0.01)',
        cursor: isDisabled || !slot ? 'not-allowed' : 'pointer',
        opacity: isDisabled && !isDest ? 0.4 : 1,
        boxShadow: isDest ? '0 0 12px rgba(255,184,0,0.2)' : 'none',
      }}
    >
      <span
        className="text-[8px] font-bold"
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          color: isDest ? '#ffb800' : 'var(--text-muted)',
        }}
      >
        {slot ? slotLabel(slot.code) : '—'}
      </span>
      {isDest && <Target size={8} style={{ position: 'absolute', top: 2, right: 2, color: '#ffb800' }} />}
      {hasPkg && !isDest && (
        <Package size={8} style={{ position: 'absolute', bottom: 2, color: accent, opacity: 0.5 }} />
      )}
      {available && !isDest && (
        <span className="absolute bottom-1 w-1.5 h-1.5 rounded-full" style={{ background: 'rgba(255,255,255,0.08)' }} />
      )}
    </button>
  );
}

function ShelfGrid({
  shelfCode,
  slots,
  destCode,
  onSelect,
}: {
  shelfCode: string;
  slots: ShelfSlot[];
  destCode: string | null;
  onSelect: (code: string) => void;
}) {
  const matrix = useMemo(() => buildSlotMatrix(slots, shelfCode), [slots, shelfCode]);
  const zone = shelfCode as ZoneCode;
  const accent = ZONE_META[zone]?.accent ?? 'var(--accent)';

  return (
    <div className="flex flex-col items-center gap-1">
      <span className="text-[10px] font-bold mb-1" style={{ color: accent, fontFamily: "'JetBrains Mono', monospace" }}>
        {shelfCode}
      </span>
      {matrix.map((row, ri) => (
        <div key={ri} className="flex gap-1">
          {row.map((slot, ci) => (
            <SlotCell
              key={ci}
              slot={slot}
              isDest={slot?.code === destCode}
              isDisabled={slot?.status !== 'AVAILABLE' || Boolean(destCode && slot?.code !== destCode)}
              onClick={() => slot && onSelect(slot.code)}
              accent={accent}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export default function SlotDispatchPanel() {
  const { notification } = App.useApp();
  const { data: slots = [], isLoading } = useGetAllSlotsQuery();
  const [dispatchMove, { isLoading: isDispatching }] = useDispatchMoveMutation();
  const [destCode, setDestCode] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const destSlot = useMemo(() => slots.find((s) => s.code === destCode) ?? null, [slots, destCode]);

  const handleSlotSelect = (code: string) => {
    const slot = slots.find((s) => s.code === code);
    if (!slot || slot.status !== 'AVAILABLE') return;
    setDestCode(code);
  };

  const resetSelection = () => setDestCode(null);

  const handleDispatch = async () => {
    if (!destCode) return;
    try {
      const res = await dispatchMove({ toSlotCode: destCode }).unwrap();
      notification.success({
        message: 'Đã gửi lệnh AGV',
        description: `Job ${res.jobId.slice(-6).toUpperCase()} — đến ${destCode}`,
        placement: 'topRight',
      });
      resetSelection();
      setConfirmOpen(false);
    } catch (err) {
      const msg = (err as { data?: { message?: string } })?.data?.message ?? 'Không thể gửi lệnh AGV';
      notification.error({ message: 'Thất bại', description: msg, placement: 'topRight' });
    }
  };

  return (
    <div className="flex flex-col gap-4 h-full">
      <div className="flex items-center gap-3 px-3 py-2 rounded-xl" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-dim)' }}>
        <Target size={12} style={{ color: '#ffb800', flexShrink: 0 }} />
        <span className="text-[10px] truncate flex-1" style={{ color: destCode ? '#ffb800' : 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}>
          {destCode ? `Đích: ${destCode}${destSlot?.aprilTagId !== undefined ? ` · AprilTag #${destSlot.aprilTagId}` : ''}` : 'Chọn ô đích trống đã calibrate'}
        </span>
        {destCode && (
          <button type="button" onClick={resetSelection} className="p-1 rounded hover:bg-white/5 transition-colors" style={{ color: 'var(--text-muted)', cursor: 'pointer' }}>
            <X size={12} />
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="text-center text-xs" style={{ color: 'var(--text-muted)' }}>Đang tải sơ đồ ô...</div>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          {(['S1', 'S2', 'S3', 'S4'] as ZoneCode[]).map((zone) => (
            <ShelfGrid key={zone} shelfCode={zone} slots={slots} destCode={destCode} onSelect={handleSlotSelect} />
          ))}
        </div>
      )}

      {destCode && (
        <div className="mt-auto px-3 py-3 rounded-xl flex items-center gap-3" style={{ background: 'var(--bg-surface)', border: '1px solid rgba(0,212,255,0.25)', boxShadow: '0 0 24px rgba(0,212,255,0.1)' }}>
          <Target size={16} style={{ color: 'var(--accent)', flexShrink: 0 }} />
          <div className="flex-1 min-w-0">
            <p className="text-[11px] font-bold" style={{ color: 'var(--text-primary)', fontFamily: "'JetBrains Mono', monospace" }}>Home → {destCode}</p>
            <p className="text-[9px]" style={{ color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}>AGV đến AprilTag và tự động đổ hàng</p>
          </div>
          <Button type="primary" loading={isDispatching} onClick={() => setConfirmOpen(true)} icon={<Check size={12} />} style={{ borderRadius: 8, background: 'var(--accent)', border: 'none', color: '#080b10', fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, fontSize: 11 }}>
            Gửi AGV
          </Button>
        </div>
      )}

      <Modal
        title={<span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 900 }}>Xác nhận điều xe</span>}
        open={confirmOpen}
        onOk={handleDispatch}
        onCancel={() => setConfirmOpen(false)}
        okText="Gửi AGV"
        cancelText="Huỷ"
        centered
        okButtonProps={{ loading: isDispatching }}
      >
        <div className="py-2 text-sm" style={{ color: 'var(--text-secondary)', fontFamily: "'JetBrains Mono', monospace" }}>
          <p className="mb-2">Gửi AGV từ <strong style={{ color: 'var(--accent)' }}>Home</strong> đến ô <strong style={{ color: '#ffb800' }}>{destCode}</strong>?</p>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Robot sẽ đến vị trí AprilTag, căn chỉnh và tự động đổ hàng vào ô đích.</p>
        </div>
      </Modal>
    </div>
  );
}
