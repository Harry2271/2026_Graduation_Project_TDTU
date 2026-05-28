'use client';

import Sidebar from '@/components/Sidebar';

export default function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex h-screen overflow-hidden"
      style={{ background: 'var(--bg-void)' }}
    >
      <Sidebar />
      <main
        className="flex-1 h-screen overflow-auto relative"
        style={{ background: 'var(--bg-void)' }}
      >
        {/* Subtle radial gradient at top */}
        <div
          className="absolute top-0 inset-x-0 h-64 pointer-events-none"
          style={{
            background: 'radial-gradient(ellipse 80% 40% at 50% 0%, rgba(0,212,255,0.03) 0%, transparent 70%)',
          }}
        />
        {children}
      </main>
    </div>
  );
}
