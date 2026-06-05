'use client';

import { useEffect } from 'react';
import { X } from 'lucide-react';
import { SidebarContent } from './Sidebar';

export default function NavDrawer({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <div
      aria-hidden={!open}
      className={`fixed inset-0 z-40 md:hidden ${open ? '' : 'pointer-events-none'}`}
    >
      {/* Backdrop */}
      <div
        onClick={onClose}
        className={`absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity duration-200 ${
          open ? 'opacity-100' : 'opacity-0'
        }`}
      />
      {/* Panel */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Menu điều hướng"
        className={`absolute top-0 left-0 h-full w-[280px] max-w-[85vw] flex flex-col transition-transform duration-200 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
        style={{
          background: 'linear-gradient(180deg, #0c0f14 0%, #080b10 100%)',
          borderRight: '1px solid rgba(255,255,255,0.06)',
          boxShadow: '4px 0 32px rgba(0,0,0,0.4)',
        }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Đóng menu"
          className="absolute top-3 right-3 w-9 h-9 flex items-center justify-center rounded-lg z-10"
          style={{ color: 'var(--text-muted)' }}
        >
          <X size={18} />
        </button>
        <SidebarContent onNavigate={onClose} />
      </aside>
    </div>
  );
}