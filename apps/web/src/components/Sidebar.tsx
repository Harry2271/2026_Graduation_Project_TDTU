'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Package, Map as MapIcon, Camera, Layers, Activity, Box, Clock } from 'lucide-react';

const menuItems = [
  { name: 'Kho hàng',          path: '/inventory', icon: Package  },
  { name: 'Lịch sử vận chuyển', path: '/jobs',     icon: Clock    },
  { name: 'Quản lý kiện hàng', path: '/products',  icon: Layers   },
  { name: 'Bản đồ',            path: '/map',       icon: MapIcon  },
  { name: 'Quỹ đạo 3D',        path: '/trajectory', icon: Box     },
  { name: 'Camera',             path: '/camera',     icon: Camera   },
];

function BrandHeader() {
  const [host, setHost] = useState('');

  useEffect(() => {
    // Hiển thị hostname/ip mà từ đó đang truy cập trang web
    setHost(window.location.hostname || window.location.host);
  }, []);

  return (
    <div
      className="px-5 py-5"
      style={{
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        background: 'linear-gradient(135deg, rgba(0,212,255,0.04) 0%, transparent 60%)',
      }}
    >
      <div className="flex items-center gap-3">
        <div
          className="w-11 h-11 rounded-xl flex-shrink-0 flex items-center justify-center overflow-hidden relative"
          style={{
            background: 'linear-gradient(135deg, #111827, #1a2035)',
            border: '1px solid rgba(0,212,255,0.2)',
            boxShadow: '0 0 16px rgba(0,212,255,0.12), inset 0 1px 0 rgba(255,255,255,0.06)',
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/LOGO.png" alt="Logo TDTU" className="w-full h-full object-contain" />
          <span
            className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full"
            style={{
              background: 'var(--success)',
              boxShadow: '0 0 8px var(--success-glow)',
            }}
          />
        </div>
        <div className="min-w-0">
          <p
            className="text-[13px] font-bold leading-tight truncate"
            style={{ fontFamily: "'JetBrains Mono', monospace", color: 'var(--text-primary)', letterSpacing: '-0.01em' }}
          >
            NEXUS Control
          </p>
          <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.05em' }}>
            TDTU CAPSTONE 2025
          </p>
          {/* Hiển thị IP/hostname Raspberry Pi */}
          {host && (
            <div className="mt-1.5 flex items-center gap-1.5">
              <span
                className="w-1.5 h-1.5 rounded-full"
                style={{ background: '#facc15', boxShadow: '0 0 6px rgba(250,204,21,0.3)' }}
              />
              <span
                className="text-[9px] select-all"
                style={{ color: '#facc15', fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.05em' }}
                title="Click to copy — paste this URL to open on other devices"
              >
                {host}
              </span>
            </div>
          )}
          <div className="flex items-center gap-1.5 mt-1.5">
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{ background: 'var(--success)', boxShadow: '0 0 6px var(--success-glow)' }}
            />
            <span className="text-[9px]" style={{ color: 'var(--success)', fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.08em' }}>
              SYSTEM ONLINE
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusPanel() {
  return (
    <div
      className="mt-6 px-3"
      style={{ borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '1.25rem' }}
    >
      <p
        className="text-[9px] font-semibold px-3 mb-3"
        style={{
          color: 'var(--text-muted)',
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          fontFamily: "'JetBrains Mono', monospace",
        }}
      >
        Trạng thái hệ thống
      </p>
      <div className="space-y-2">
        <StatusRow label="API Server" value="Active" color="var(--success)" />
        <StatusRow label="WebSocket" value="Connected" color="var(--success)" />
        <StatusRow label="Robot Link" value="Online" color="var(--accent)" />
        <StatusRow label="LIDAR" value="Streaming" color="var(--accent)" />
      </div>
    </div>
  );
}

export function SidebarContent({ onNavigate }: { onNavigate?: () => void } = {}) {
  const pathname = usePathname();

  return (
    <div className="flex flex-col h-full">
      <BrandHeader />
      <nav className="flex-1 px-3 py-4 flex flex-col gap-1 overflow-y-auto">
        <p
          className="text-[9px] font-semibold px-3 mb-2"
          style={{
            color: 'var(--text-muted)',
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          Điều hướng chính
        </p>
        {menuItems.map(({ name, path, icon: Icon }) => {
          const isActive = pathname === path || (pathname === '/' && path === '/inventory');
          return (
            <Link
              key={path}
              href={path}
              onClick={onNavigate}
              className="group relative flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-semibold transition-all duration-200 overflow-hidden"
              style={
                isActive
                  ? {
                      background: 'linear-gradient(90deg, rgba(0,212,255,0.12) 0%, rgba(0,212,255,0.06) 100%)',
                      border: '1px solid rgba(0,212,255,0.2)',
                      color: 'var(--accent)',
                      boxShadow: '0 0 16px rgba(0,212,255,0.08)',
                    }
                  : {
                      background: 'transparent',
                      border: '1px solid transparent',
                      color: 'var(--text-secondary)',
                    }
              }
            >
              {isActive && (
                <span
                  className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-6 rounded-r"
                  style={{ background: 'var(--accent)', boxShadow: '0 0 8px var(--accent-glow)' }}
                />
              )}
              <div
                className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 transition-all duration-200"
                style={
                  isActive
                    ? { background: 'rgba(0,212,255,0.15)', color: 'var(--accent)' }
                    : { background: 'rgba(255,255,255,0.04)', color: 'var(--text-muted)' }
                }
              >
                <Icon size={16} />
              </div>
              {name}
              {!isActive && (
                <span
                  className="ml-auto opacity-0 group-hover:opacity-60 transition-opacity text-[10px]"
                  style={{ color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}
                >
                  →
                </span>
              )}
            </Link>
          );
        })}
        <StatusPanel />
      </nav>
      <div
        className="px-5 py-4"
        style={{
          borderTop: '1px solid rgba(255,255,255,0.05)',
          background: 'linear-gradient(0deg, rgba(0,212,255,0.02) 0%, transparent 100%)',
        }}
      >
        <div className="flex items-center gap-2">
          <Activity size={12} style={{ color: 'var(--success)' }} />
          <span
            className="text-[10px]"
            style={{ color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.05em' }}
          >
            Tôn Đức Thắng University &mdash; Đồ án Tốt nghiệp
          </span>
        </div>
      </div>
    </div>
  );
}

export default function Sidebar() {
  return (
    <aside
      className="w-[260px] h-full flex-shrink-0 flex flex-col z-20"
      style={{
        background: 'linear-gradient(180deg, #0c0f14 0%, #080b10 100%)',
        borderRight: '1px solid rgba(255,255,255,0.06)',
        boxShadow: '4px 0 32px rgba(0,0,0,0.4), inset -1px 0 0 rgba(255,255,255,0.03)',
      }}
    >
      <SidebarContent />
    </aside>
  );
}

function StatusRow({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="flex items-center justify-between px-3 py-2 rounded-lg" style={{ background: 'rgba(255,255,255,0.02)' }}>
      <span className="text-[11px]" style={{ color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.04em' }}>
        {label}
      </span>
      <div className="flex items-center gap-1.5">
        <span
          className="w-1.5 h-1.5 rounded-full"
          style={{ background: color, boxShadow: `0 0 6px ${color}` }}
        />
        <span className="text-[10px] font-semibold" style={{ color, fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.06em' }}>
          {value}
        </span>
      </div>
    </div>
  );
}
