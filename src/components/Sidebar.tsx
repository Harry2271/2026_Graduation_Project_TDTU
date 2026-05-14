'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Package, Map as MapIcon, Camera, Cpu } from 'lucide-react';

const menuItems = [
  { name: 'Kho hàng', path: '/inventory', icon: Package },
  { name: 'Bản đồ',   path: '/map',       icon: MapIcon  },
  { name: 'Camera',   path: '/camera',    icon: Camera   },
];

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-[240px] min-h-screen bg-white border-r border-gray-200 flex flex-col fixed left-0 top-0 bottom-0 z-10">
      {/* Brand */}
      <div className="px-6 py-5 border-b border-gray-100 flex items-center gap-3">
        <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
          <Cpu size={16} className="text-white" />
        </div>
        <div>
          <p className="font-bold text-gray-900 text-sm leading-tight">Robot Control</p>
          <p className="text-xs text-gray-400">Warehouse System</p>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 flex flex-col gap-1">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider px-3 mb-2">
          Điều hướng
        </p>
        {menuItems.map(({ name, path, icon: Icon }) => {
          const isActive = pathname === path || (pathname === '/' && path === '/inventory');
          return (
            <Link
              key={path}
              href={path}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
                isActive
                  ? 'bg-blue-50 text-blue-700'
                  : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
              }`}
            >
              <Icon
                size={18}
                className={isActive ? 'text-blue-600' : 'text-gray-400'}
              />
              {name}
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="px-6 py-4 border-t border-gray-100">
        <p className="text-xs text-gray-400">v1.0.0 — Park Smart</p>
      </div>
    </aside>
  );
}
