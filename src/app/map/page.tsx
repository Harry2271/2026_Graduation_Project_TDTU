'use client';

import { MapPin } from 'lucide-react';

export default function MapPage() {
  return (
    <div className="p-8 h-screen flex flex-col">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
          <MapPin size={20} className="text-blue-600" />
          Bản đồ khu vực
        </h1>
        <p className="text-sm text-gray-500 mt-0.5">Dữ liệu quét từ cảm biến Lidar</p>
      </div>

      <div className="flex-1 bg-white rounded-xl border-2 border-gray-200 flex items-center justify-center relative overflow-hidden shadow-sm">
        {/* Subtle grid background */}
        <div
          className="absolute inset-0 opacity-[0.04]"
          style={{
            backgroundImage:
              'linear-gradient(#1d4ed8 1px, transparent 1px), linear-gradient(90deg, #1d4ed8 1px, transparent 1px)',
            backgroundSize: '40px 40px',
          }}
        />
        <div className="text-center relative z-10">
          <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <MapPin size={28} className="text-gray-400" />
          </div>
          <p className="text-2xl font-semibold text-gray-700">Bản đồ từ Lidar</p>
          <p className="text-sm text-gray-400 mt-1">Đang chờ dữ liệu từ cảm biến...</p>
        </div>
      </div>
    </div>
  );
}
