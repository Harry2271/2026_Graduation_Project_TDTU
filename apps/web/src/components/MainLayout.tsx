'use client';
import { useState } from 'react';
import Sidebar from './Sidebar';
import MobileTopBar from './MobileTopBar';
import BottomTabBar from './BottomTabBar';
import NavDrawer from './NavDrawer';
import { TelemetryPanel } from './TelemetryPanel';
import { RobotTelemetryProvider } from './RobotTelemetryProvider';
import { useBreakpoint } from '@/hooks/useBreakpoint';

export default function MainLayout({ children }: { children: React.ReactNode }) {
  const { isDesktop } = useBreakpoint();
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <RobotTelemetryProvider>
      {isDesktop ? (
        <div
          className="flex h-screen w-full overflow-hidden"
          style={{ background: 'var(--bg-void)' }}
        >
          <Sidebar />
          <main
            className="flex flex-col flex-1 min-w-0 h-full overflow-hidden relative"
            style={{ background: 'var(--bg-void)' }}
          >
            <div
              className="absolute top-0 inset-x-0 h-64 pointer-events-none"
              style={{
                background:
                  'radial-gradient(ellipse 80% 40% at 50% 0%, rgba(0,212,255,0.03) 0%, transparent 70%)',
              }}
            />
            {children}
          </main>
          <aside
            className="hidden xl:flex w-80 shrink-0 h-full overflow-hidden bg-[#080b10]"
          >
            <TelemetryPanel />
          </aside>
        </div>
      ) : (
        <div
          className="flex flex-col min-h-dvh w-full bg-[#080b10]"
        >
          <MobileTopBar onMenu={() => setDrawerOpen(true)} />
          <NavDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
          <main
            className="flex-1 flex flex-col relative w-full pb-16 md:pb-0 bg-[#080b10]"
          >
            <div
              className="absolute top-0 inset-x-0 h-64 pointer-events-none"
              style={{
                background:
                  'radial-gradient(ellipse 80% 40% at 50% 0%, rgba(0,212,255,0.03) 0%, transparent 70%)',
              }}
            />
            {children}
          </main>
          <BottomTabBar />
        </div>
      )}
    </RobotTelemetryProvider>
  );
}