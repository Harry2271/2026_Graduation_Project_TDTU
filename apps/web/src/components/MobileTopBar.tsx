'use client';

import { Menu, Wifi } from 'lucide-react';
import { usePathname } from 'next/navigation';

const TITLES: Record<string, string> = {
  '/inventory': 'Kho hàng',
  '/products': 'Quản lý kiện hàng',
  '/map': 'Bản đồ',
  '/camera': 'Camera',
};

function titleFor(pathname: string): string {
  if (pathname.startsWith('/products/')) return 'Chi tiết kiện hàng';
  return TITLES[pathname] ?? 'NEXUS Control';
}

export default function MobileTopBar({ onMenu }: { onMenu: () => void }) {
  const pathname = usePathname();
  const title = titleFor(pathname);

  return (
    <header
      className="md:hidden sticky top-0 z-30 flex items-center justify-between px-4 h-12"
      style={{
        background: 'var(--bg-base)',
        borderBottom: '1px solid var(--border-dim)',
        boxShadow: '0 2px 12px rgba(0,0,0,0.4)',
      }}
    >
      <button
        type="button"
        onClick={onMenu}
        aria-label="Mở menu điều hướng"
        className="w-10 h-10 -ml-2 flex items-center justify-center rounded-lg"
        style={{ color: 'var(--text-secondary)' }}
      >
        <Menu size={20} />
      </button>
      <h1
        className="text-sm font-bold truncate mx-2"
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          color: 'var(--text-primary)',
          letterSpacing: '0.04em',
        }}
      >
        {title}
      </h1>
      <div
        className="flex items-center gap-1.5"
        aria-label="Trạng thái hệ thống"
        title="Hệ thống online"
      >
        <span
          className="w-2 h-2 rounded-full"
          style={{ background: 'var(--success)', boxShadow: '0 0 6px var(--success-glow)' }}
        />
        <Wifi size={14} style={{ color: 'var(--success)' }} />
      </div>
    </header>
  );
}
