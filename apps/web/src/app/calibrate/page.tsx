'use client';

import { useEffect, useState, useRef, useCallback } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:5000';
const MAPS_URL = `${API_BASE}/api/robot/map-image`;

interface ShelfSlot {
  _id: string;
  code: string;
  shelf: string;
  row: string;
  column: number;
  status: string;
  packageId: string | null;
  slotX?: number;
  slotY?: number;
  aprilTagId?: number;
  facingTheta?: number;
}

export default function CalibratePage() {
  const [slots, setSlots] = useState<ShelfSlot[]>([]);
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [imageSize, setImageSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    fetch(`${API_BASE}/shelves/slots`)
      .then((r) => r.json())
      .then((data) => setSlots(data));
  }, []);

  const onImageLoad = useCallback(() => {
    if (imgRef.current) {
      setImageSize({ w: imgRef.current.naturalWidth, h: imgRef.current.naturalHeight });
    }
  }, []);

  const onMapClick = useCallback(
    async (e: React.MouseEvent<HTMLImageElement>) => {
      if (!selectedCode || !imgRef.current) return;
      const rect = imgRef.current.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const METER_SCALE = 40 / imageSize.w;
      const slotX = px * METER_SCALE - 20;
      const slotY = 20 - py * METER_SCALE;

      const res = await fetch(`${API_BASE}/shelves/${selectedCode}/coordinates`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slotX, slotY }),
      });
      if (res.ok) {
        const updated: ShelfSlot = await res.json();
        setSlots((prev) => prev.map((s) => (s.code === selectedCode ? updated : s)));
      } else {
        const err = await res.json();
        alert(err.message ?? 'Lỗi khi lưu tọa độ');
      }
    },
    [selectedCode, imageSize],
  );

  return (
    <div style={{ display: 'flex', height: '100vh' }}>
      <aside style={{ width: 320, overflow: 'auto', borderRight: '1px solid #ccc', padding: 12 }}>
        <h2>Hiệu chỉnh kệ (Calibrate)</h2>
        <p>Chọn một vị trí, sau đó click lên bản đồ để đặt tọa độ.</p>
        <ul>
          {slots.map((s) => (
            <li
              key={s.code}
              onClick={() => setSelectedCode(s.code)}
              style={{
                cursor: 'pointer',
                padding: 4,
                background: s.code === selectedCode ? '#ffeb3b' : 'transparent',
              }}
            >
              {s.code} — {s.slotX != null && s.slotY != null ? `(${s.slotX.toFixed(2)}, ${s.slotY.toFixed(2)})` : 'chưa đặt'}
              {s.aprilTagId != null ? ` · tag ${s.aprilTagId}` : ''}
            </li>
          ))}
        </ul>
      </aside>
      <main style={{ flex: 1, position: 'relative', overflow: 'auto' }}>
        <img
          ref={imgRef}
          src={MAPS_URL}
          alt="SLAM map"
          onLoad={onImageLoad}
          onClick={onMapClick}
          style={{ maxWidth: '100%', cursor: selectedCode ? 'crosshair' : 'default' }}
        />
        {slots
          .filter((s) => s.slotX != null && s.slotY != null && imageSize.w > 0)
          .map((s) => {
            const METER_SCALE = 40 / imageSize.w;
            const px = (s.slotX! + 20) / METER_SCALE;
            const py = (20 - s.slotY!) / METER_SCALE;
            return (
              <div
                key={s.code}
                style={{
                  position: 'absolute',
                  left: px - 8,
                  top: py - 8,
                  width: 16,
                  height: 16,
                  background: s.code === selectedCode ? '#ffeb3b' : '#4caf50',
                  border: '2px solid white',
                  borderRadius: '50%',
                  pointerEvents: 'none',
                }}
                title={s.code}
              />
            );
          })}
      </main>
    </div>
  );
}
