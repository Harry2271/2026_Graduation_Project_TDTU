'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Package, Layers, Map as MapIcon, Camera } from 'lucide-react';

const ITEMS = [
  { path: '/inventory', label: 'Kho hàng', icon: Package },
  { path: '/products', label: 'Kiện hàng', icon: Layers },
  { path: '/map', label: 'Bản đồ', icon: MapIcon },
  { path: '/camera', label: 'Camera', icon: Camera },
] as const;

export default function BottomTabBar() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Điều hướng chính"
      className="md:hidden fixed bottom-0 inset-x-0 z-30 safe-bottom"
      style={{
        background: 'var(--bg-base)',
        borderTop: '1px solid var(--border-dim)',
        boxShadow: '0 -2px 12px rgba(0,0,0,0.4)',
      }}
    >
      <ul className="flex items-stretch justify-around h-16">
        {ITEMS.map(({ path, label, icon: Icon }) => {
          const isActive = pathname === path || (pathname === '/' && path === '/inventory');
          return (
            <li key={path} className="flex-1">
              <Link
                href={path}
                aria-current={isActive ? 'page' : undefined}
                className="relative flex flex-col items-center justify-center gap-0.5 h-full min-w-[44px]"
                style={{
                  color: isActive ? 'var(--accent)' : 'var(--text-muted)',
                }}
              >
                {isActive && (
                  <span
                    aria-hidden
                    className="absolute top-0 left-1/2 -translate-x-1/2 h-0.5 w-8 rounded-b"
                    style={{ background: 'var(--accent)', boxShadow: '0 0 8px var(--accent-glow)' }}
                  />
                )}
                <Icon size={20} />
                <span
                  className="text-[10px] font-semibold"
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    letterSpacing: '0.04em',
                  }}
                >
                  {label}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
