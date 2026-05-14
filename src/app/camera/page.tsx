'use client';

import { Camera } from 'lucide-react';

export default function CameraPage() {
  return (
    <div className="p-8 h-screen flex flex-col">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
          <Camera size={20} className="text-blue-600" />
          Giám sát Camera
        </h1>
        <p className="text-sm text-gray-500 mt-0.5">Luồng hình ảnh từ camera gắn trên tay robot</p>
      </div>

      {/* 16:9 container */}
      <div className="w-full aspect-video bg-white rounded-xl border-2 border-dashed border-gray-300 flex items-center justify-center relative overflow-hidden shadow-sm">
        {/* Corner brackets */}
        <div className="absolute top-4 left-4 w-6 h-6 border-t-2 border-l-2 border-gray-400 rounded-tl" />
        <div className="absolute top-4 right-4 w-6 h-6 border-t-2 border-r-2 border-gray-400 rounded-tr" />
        <div className="absolute bottom-4 left-4 w-6 h-6 border-b-2 border-l-2 border-gray-400 rounded-bl" />
        <div className="absolute bottom-4 right-4 w-6 h-6 border-b-2 border-r-2 border-gray-400 rounded-br" />

        {/* Status badge */}
        <div className="absolute top-4 right-14 flex items-center gap-2 bg-gray-100 px-3 py-1 rounded-full">
          <span className="w-2 h-2 rounded-full bg-gray-400" />
          <span className="text-xs text-gray-500 font-medium">Offline</span>
        </div>

        {/* Center content */}
        <div className="text-center">
          <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <Camera size={28} className="text-gray-400" />
          </div>
          <p className="text-2xl font-semibold text-gray-700">Camera của tay robot</p>
          <p className="text-sm text-gray-400 mt-1">Chưa có kết nối luồng video</p>
        </div>
      </div>
    </div>
  );
}
