'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { Spin, message } from 'antd';

import {
  useGetAllSlotsQuery,
  useAssignCoordinatesMutation,
  useAssignAprilTagMutation,
} from '@/store/services/inventoryApi';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import {
  setSelectedCalibrateSlot,
  selectSelectedCalibrateSlot,
} from '@/store/calibrateSlice';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:5000';
const MAPS_URL = `${API_BASE}/api/robot/map-image`;

// SLAM map image dimensions: 40 m × 40 m at 5 cm/cell → 800×800 px.
const MAP_METERS = 40;
const MAP_PADDING_M = 20;

export default function CalibratePage() {
  const dispatch = useAppDispatch();
  const selectedCode = useAppSelector(selectSelectedCalibrateSlot);
  const { data: slots = [], isLoading, isError, error, refetch } = useGetAllSlotsQuery();
  const [assignCoordinates, { isLoading: isSaving }] = useAssignCoordinatesMutation();
  const [assignAprilTag] = useAssignAprilTagMutation();

  const [imageSize, setImageSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    if (isError) {
      message.error(
        (error as { data?: { message?: string } })?.data?.message ??
          'Không thể tải danh sách vị trí. Vui lòng thử lại.',
      );
    }
  }, [isError, error]);

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
      const meterScale = MAP_METERS / imageSize.w;
      const slotX = px * meterScale - MAP_PADDING_M;
      const slotY = MAP_PADDING_M - py * meterScale;

      try {
        await assignCoordinates({ slotCode: selectedCode, slotX, slotY }).unwrap();
        message.success(`Đã lưu tọa độ cho ${selectedCode}`);
      } catch (err) {
        const e2 = err as { data?: { message?: string } };
        message.error(e2.data?.message ?? 'Lỗi khi lưu tọa độ');
      }
    },
    [selectedCode, imageSize, assignCoordinates],
  );

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spin size="large" tip="Đang tải danh sách vị trí..." />
      </div>
    );
  }

  return (
    <div className="flex h-screen">
      <aside className="w-80 overflow-auto border-r border-gray-200 p-3">
        <h2 className="text-lg font-semibold">Hiệu chỉnh kệ (Calibrate)</h2>
        <p className="text-sm text-gray-600 mt-2">
          Chọn một vị trí, sau đó click lên bản đồ để đặt tọa độ.
        </p>
        <ul className="mt-3">
          {slots.map((s) => (
            <li
              key={s.code}
              onClick={() => dispatch(setSelectedCalibrateSlot(s.code))}
              className={`cursor-pointer px-2 py-1 rounded ${
                s.code === selectedCode ? 'bg-yellow-200' : 'hover:bg-gray-100'
              }`}
            >
              {s.code} —{' '}
              {s.slotX != null && s.slotY != null ? `(${s.slotX.toFixed(2)}, ${s.slotY.toFixed(2)})` : 'chưa đặt'}
              {s.aprilTagId != null ? ` · tag ${s.aprilTagId}` : ''}
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="mt-4 text-sm text-blue-600 hover:underline"
          onClick={() => refetch()}
        >
          ↻ Tải lại
        </button>
      </aside>

      <main className="flex-1 relative overflow-auto">
        <img
          ref={imgRef}
          src={MAPS_URL}
          alt="SLAM map"
          onLoad={onImageLoad}
          onClick={onMapClick}
          className={`max-w-full ${selectedCode ? 'cursor-crosshair' : 'cursor-default'}`}
        />
        {slots
          .filter((s) => s.slotX != null && s.slotY != null && imageSize.w > 0)
          .map((s) => {
            const meterScale = MAP_METERS / imageSize.w;
            const px = ((s.slotX ?? 0) + MAP_PADDING_M) / meterScale;
            const py = (MAP_PADDING_M - (s.slotY ?? 0)) / meterScale;
            return (
              <div
                key={s.code}
                style={{ left: px - 8, top: py - 8 }}
                className={`absolute w-4 h-4 rounded-full border-2 border-white pointer-events-none ${
                  s.code === selectedCode ? 'bg-yellow-400' : 'bg-green-500'
                }`}
                title={s.code}
              />
            );
          })}
        {isSaving && (
          <div className="absolute top-2 right-2">
            <Spin size="small" tip="Đang lưu..." />
          </div>
        )}
      </main>
    </div>
  );
}
