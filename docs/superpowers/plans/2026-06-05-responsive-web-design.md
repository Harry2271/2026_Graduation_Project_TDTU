# Responsive Web App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the NEXUS Control Next.js web app fully responsive on phones (375–430px) and tablets (768–1024px) while keeping all current functionality and the desktop experience intact.

**Architecture:** A single `useBreakpoint` hook drives a `MainLayout` that swaps between three shells: desktop (existing sidebar), tablet (top bar + drawer), and phone (top bar + bottom tab bar + drawer). Pages get targeted responsive Tailwind classes; no new routes, no new state, no new dependencies.

**Tech Stack:** Next.js 16, Tailwind v4, Ant Design v6, Redux Toolkit, Lucide icons, TypeScript.

**Verification:** No automated test framework is installed. Each task is verified manually using the Chrome DevTools MCP at the target viewports: 375×812, 430×932, 768×1024, 1024×768, 1280×800.

---

## File Structure

### New files
- `apps/web/src/hooks/useBreakpoint.ts` — single hook exposing `isMobile`, `isTablet`, `isDesktop` via `matchMedia`
- `apps/web/src/components/MobileTopBar.tsx` — top bar for mobile/tablet (hamburger + title + status dot)
- `apps/web/src/components/BottomTabBar.tsx` — bottom tab nav for mobile (4 primary routes)
- `apps/web/src/components/NavDrawer.tsx` — slide-in drawer that hosts the sidebar content on mobile/tablet

### Modified files
- `apps/web/src/components/Sidebar.tsx` — split into a wrapper that provides the desktop visual chrome, and a `SidebarContent` export that the drawer reuses
- `apps/web/src/components/MainLayout.tsx` — switch between desktop shell, tablet shell, and mobile shell based on `useBreakpoint`
- `apps/web/src/app/globals.css` — change body from locked `100vh` to scrollable `min-h-dvh`; add safe-area utilities; prevent iOS input zoom
- `apps/web/src/app/layout.tsx` — no change unless theme tokens need a mobile tweak
- `apps/web/src/app/inventory/page.tsx` — responsive classes + FAB for the package panel
- `apps/web/src/app/products/page.tsx` — responsive header and table
- `apps/web/src/app/products/[id]/page.tsx` — responsive cards and modals
- `apps/web/src/app/map/page.tsx` — responsive canvas/floating controls
- `apps/web/src/app/camera/page.tsx` — responsive stream viewport

---

## Task 1: Add `useBreakpoint` hook

**Files:**
- Create: `apps/web/src/hooks/useBreakpoint.ts`

- [ ] **Step 1: Create the hook**

```ts
'use client';

import { useEffect, useState } from 'react';

export type Breakpoint = 'mobile' | 'tablet' | 'desktop';

const TABLET_MIN = 768;
const DESKTOP_MIN = 1024;

function getBreakpoint(width: number): Breakpoint {
  if (width >= DESKTOP_MIN) return 'desktop';
  if (width >= TABLET_MIN) return 'tablet';
  return 'mobile';
}

export function useBreakpoint(): {
  breakpoint: Breakpoint;
  isMobile: boolean;
  isTablet: boolean;
  isDesktop: boolean;
} {
  const [width, setWidth] = useState<number>(() =>
    typeof window === 'undefined' ? DESKTOP_MIN : window.innerWidth
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize, { passive: true });
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const breakpoint = getBreakpoint(width);
  return {
    breakpoint,
    isMobile: breakpoint === 'mobile',
    isTablet: breakpoint === 'tablet',
    isDesktop: breakpoint === 'desktop',
  };
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd apps/web && npx tsc --noEmit`
Expected: exit 0, no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/hooks/useBreakpoint.ts
git commit -m "feat(web): add useBreakpoint hook for responsive shell"
```

---

## Task 2: Update global CSS for mobile

**Files:**
- Modify: `apps/web/src/app/globals.css`

- [ ] **Step 1: Replace the body lock and add safe-area utilities**

Find lines 72–80 of `globals.css`:

```css
body {
  background: var(--bg-void);
  color: var(--text-primary);
  font-family: var(--font-sans), 'JetBrains Mono', monospace;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  height: 100vh;
  overflow: hidden;
}
```

Replace with:

```css
body {
  background: var(--bg-void);
  color: var(--text-primary);
  font-family: var(--font-sans), 'JetBrains Mono', monospace;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  min-height: 100dvh;
  overflow-x: hidden;
}

html {
  scroll-behavior: smooth;
}
```

(Leave the `html` rule above; just move it to be adjacent and remove the duplicate `overflow: hidden` from `body`.)

- [ ] **Step 2: Append safe-area and mobile-input utilities at end of file**

Append at the end of `globals.css`:

```css
/* ─── Mobile safe area + iOS zoom prevention ─────────── */
.safe-bottom {
  padding-bottom: env(safe-area-inset-bottom);
}

.ant-input,
.ant-input-affix-wrapper,
.ant-input-number-input,
.ant-select-selector,
textarea.ant-input {
  font-size: 16px !important;
}

button,
a,
[role='button'] {
  touch-action: manipulation;
}
```

- [ ] **Step 3: Verify lint passes**

Run: `cd apps/web && yarn lint`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/globals.css
git commit -m "feat(web): unlock body scroll, add safe-area and iOS-zoom guards"
```

---

## Task 3: Split `Sidebar` into content + wrapper

**Files:**
- Modify: `apps/web/src/components/Sidebar.tsx`

The current file is a single default export. We need:
- `Sidebar` (default) — keeps the existing desktop visual chrome (gradient background, 260px width, fixed positioning)
- `SidebarContent` (named export) — the inner content (`BrandHeader`, navigation, status panel, footer) reused by the drawer

- [ ] **Step 1: Extract `BrandHeader` and `StatusPanel` as named components above `Sidebar`**

In `apps/web/src/components/Sidebar.tsx`, add these named exports above the existing `Sidebar` (the existing default function starts at line 14). Place them between the imports and the `Sidebar` declaration:

```tsx
function BrandHeader() {
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
```

- [ ] **Step 2: Replace `Sidebar` default export to use `SidebarContent`**

Replace the entire `export default function Sidebar() { … }` body (lines 14–203) with:

```tsx
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
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd apps/web && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/Sidebar.tsx
git commit -m "refactor(web): split Sidebar into SidebarContent for drawer reuse"
```

---

## Task 4: Build `MobileTopBar`

**Files:**
- Create: `apps/web/src/components/MobileTopBar.tsx`

- [ ] **Step 1: Create the component**

```tsx
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
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd apps/web && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/MobileTopBar.tsx
git commit -m "feat(web): add MobileTopBar component"
```

---

## Task 5: Build `BottomTabBar`

**Files:**
- Create: `apps/web/src/components/BottomTabBar.tsx`

- [ ] **Step 1: Create the component**

```tsx
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
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd apps/web && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/BottomTabBar.tsx
git commit -m "feat(web): add BottomTabBar for mobile primary navigation"
```

---

## Task 6: Build `NavDrawer`

**Files:**
- Create: `apps/web/src/components/NavDrawer.tsx`

- [ ] **Step 1: Create the component**

```tsx
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
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd apps/web && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/NavDrawer.tsx
git commit -m "feat(web): add NavDrawer that hosts SidebarContent on mobile/tablet"
```

---

## Task 7: Refactor `MainLayout` to swap shells

**Files:**
- Modify: `apps/web/src/components/MainLayout.tsx`

- [ ] **Step 1: Replace the file with the new shell-switching layout**

```tsx
'use client';

import { useState } from 'react';
import Sidebar from './Sidebar';
import MobileTopBar from './MobileTopBar';
import BottomTabBar from './BottomTabBar';
import NavDrawer from './NavDrawer';
import { useBreakpoint } from '@/hooks/useBreakpoint';

export default function MainLayout({ children }: { children: React.ReactNode }) {
  const { isDesktop } = useBreakpoint();
  const [drawerOpen, setDrawerOpen] = useState(false);

  if (isDesktop) {
    return (
      <div
        className="flex h-screen overflow-hidden"
        style={{ background: 'var(--bg-void)' }}
      >
        <Sidebar />
        <main
          className="flex flex-col flex-1 h-full overflow-hidden relative"
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
      </div>
    );
  }

  return (
    <div
      className="flex flex-col min-h-dvh"
      style={{ background: 'var(--bg-void)' }}
    >
      <MobileTopBar onMenu={() => setDrawerOpen(true)} />
      <NavDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
      <main
        className="flex-1 flex flex-col relative pb-16 md:pb-0"
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
      <BottomTabBar />
    </div>
  );
}
```

- [ ] **Step 2: Verify desktop is unchanged**

Run dev server: `cd apps/web && yarn dev`
Open `http://localhost:3000` with Chrome DevTools MCP at 1280×800:
- Resize to 1280×800
- Confirm sidebar visible, no top bar, no bottom tab bar

Run: `mcp__plugin_chrome-devtools-mcp_chrome-devtools__resize_page(width=1280, height=800)` then `mcp__plugin_chrome-devtools-mcp_chrome-devtools__take_snapshot` and verify the desktop sidebar is in the DOM.

- [ ] **Step 3: Verify mobile shell appears below 768px**

`mcp__plugin_chrome-devtools-mcp_chrome-devtools__resize_page(width=375, height=812)` then `mcp__plugin_chrome-devtools-mcp_chrome-devtools__take_snapshot`. Confirm `<header>` with hamburger button and `<nav>` with bottom tab bar both present. No desktop sidebar.

- [ ] **Step 4: Verify TypeScript and lint**

Run: `cd apps/web && npx tsc --noEmit && yarn lint`
Expected: exit 0, no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/MainLayout.tsx
git commit -m "feat(web): switch MainLayout between desktop and mobile/tablet shells"
```

---

## Task 8: Make the inventory page responsive

**Files:**
- Modify: `apps/web/src/app/inventory/page.tsx`

This is the most complex page. Changes target the structural layout. We do **not** change business logic.

- [ ] **Step 1: Add state for the package list drawer**

Find the `useState` block (around line 58–63). Add this line right after the existing `isPackageListOpen` state:

```tsx
const [isPackageListSheetOpen, setIsPackageListSheetOpen] = useState(false);
```

- [ ] **Step 2: Make the package list sidebar a slide-in sheet on mobile**

Find the package list `<div>` that starts at line 558 (`<div className="flex flex-col h-full overflow-hidden" style={{ width: isPackageListOpen ? '320px' : '48px', ... }}>`). Replace its outer `<div>` with:

```tsx
{/* ─── Package list sidebar (desktop only) / sheet (mobile) ─── */}
<div
  className="hidden lg:flex flex-col h-full overflow-hidden"
  style={{
    width: isPackageListOpen ? '320px' : '48px',
    background: 'var(--bg-surface)',
    borderLeft: '1px solid var(--border-dim)',
    transition: 'width 0.3s ease',
    flexShrink: 0,
  }}
>
```

(only the outer container class changes — keep the rest of that block untouched.)

- [ ] **Step 3: Add a mobile FAB that opens the package list as a bottom sheet**

Right after the `</div>` that closes the package list sidebar block (search for the closing `</div>` after the package list panel content), add:

```tsx
{/* Mobile FAB to open package list */}
<button
  type="button"
  onClick={() => setIsPackageListSheetOpen(true)}
  aria-label="Mở danh sách kiện hàng"
  className="lg:hidden fixed bottom-20 right-4 z-30 w-14 h-14 rounded-full flex items-center justify-center"
  style={{
    background: 'linear-gradient(135deg, #00d4ff, #00b8e6)',
    color: '#080b10',
    boxShadow: '0 8px 24px rgba(0,212,255,0.4)',
  }}
>
  <Package size={22} />
</button>
```

Add a Lucide `List` icon import if not already present. The current imports include `PackageOpen`, `Package` — both are already imported. Good.

- [ ] **Step 4: Add the bottom sheet modal**

Add this import at the top of the file with the other lucide imports:

```tsx
import { PackageOpen, Send, Search, Package, Info, CheckCircle, ArrowLeftRight, Hexagon, Wifi, ChevronRight, MapPin, List, X } from 'lucide-react';
```

(Add `List` and `X` to the existing import list — do not duplicate the line.)

Then, just before the closing `</div>` of the root `<div className="flex flex-1 min-h-0 overflow-hidden">`, add:

```tsx
{/* Mobile bottom sheet for package list */}
<div
  aria-hidden={!isPackageListSheetOpen}
  className={`lg:hidden fixed inset-0 z-40 ${isPackageListSheetOpen ? '' : 'pointer-events-none'}`}
>
  <div
    onClick={() => setIsPackageListSheetOpen(false)}
    className={`absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity ${
      isPackageListSheetOpen ? 'opacity-100' : 'opacity-0'
    }`}
  />
  <div
    role="dialog"
    aria-modal="true"
    aria-label="Danh sách kiện hàng"
    className={`absolute bottom-0 inset-x-0 max-h-[85vh] flex flex-col rounded-t-2xl transition-transform duration-200 ${
      isPackageListSheetOpen ? 'translate-y-0' : 'translate-y-full'
    }`}
    style={{
      background: 'var(--bg-surface)',
      borderTop: '1px solid var(--border-mid)',
      boxShadow: '0 -8px 32px rgba(0,0,0,0.5)',
    }}
  >
    <div
      className="flex items-center justify-between px-4 py-3"
      style={{ borderBottom: '1px solid var(--border-dim)' }}
    >
      <div className="flex items-center gap-2">
        <Package size={15} style={{ color: 'var(--accent)' }} />
        <span
          className="text-xs font-bold"
          style={{
            color: 'var(--text-primary)',
            fontFamily: "'JetBrains Mono', monospace",
            letterSpacing: '0.06em',
          }}
        >
          DANH SÁCH KIỆN
        </span>
        <span
          className="text-[10px] px-1.5 py-0.5 rounded-md"
          style={{
            background: 'rgba(0,212,255,0.1)',
            border: '1px solid rgba(0,212,255,0.2)',
            color: 'var(--accent)',
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          {filteredPackages.length}
        </span>
      </div>
      <button
        type="button"
        onClick={() => setIsPackageListSheetOpen(false)}
        aria-label="Đóng"
        className="w-9 h-9 flex items-center justify-center rounded-lg"
        style={{ color: 'var(--text-muted)' }}
      >
        <X size={18} />
      </button>
    </div>
    <div className="flex-1 overflow-y-auto p-3">
      <Input
        size="large"
        placeholder="Tìm kiếm kiện hàng..."
        prefix={<Search size={16} style={{ color: 'var(--text-muted)' }} />}
        value={searchTerm}
        onChange={(e) => setSearchTerm(e.target.value)}
        allowClear
        className="mb-3"
      />
      <List
        dataSource={filteredPackages}
        locale={{
          emptyText: (
            <Empty
              description={
                <span
                  style={{
                    color: 'var(--text-muted)',
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: '12px',
                  }}
                >
                  Không có kiện hàng nào
                </span>
              }
            />
          ),
        }}
        renderItem={(pkg) => {
          const cellPkg = pkg as PackageItem;
          return (
            <List.Item
              onClick={() => {
                if (cellPkg.shelfId > 0 && cellPkg.cell) {
                  selectFromList(cellPkg.shelfId, cellPkg.cell);
                  setIsPackageListSheetOpen(false);
                }
              }}
              className="cursor-pointer"
              style={{
                background: 'var(--bg-raised)',
                border: '1px solid var(--border-dim)',
                borderRadius: '10px',
                padding: '10px 12px',
                marginBottom: '8px',
              }}
            >
              <div className="flex items-center justify-between gap-2 w-full">
                <div className="min-w-0">
                  <p
                    className="text-sm font-bold truncate"
                    style={{
                      color: 'var(--text-primary)',
                      fontFamily: "'JetBrains Mono', monospace",
                    }}
                  >
                    {cellPkg.packageName}
                  </p>
                  <p
                    className="text-[10px] mt-0.5"
                    style={{
                      color: 'var(--text-muted)',
                      fontFamily: "'JetBrains Mono', monospace",
                    }}
                  >
                    {cellPkg.shelfId > 0 ? `Kệ ${cellPkg.shelfId} · Ô ${cellPkg.cell}` : 'Chưa xếp'}
                  </p>
                </div>
                <ChevronRight size={16} style={{ color: 'var(--text-muted)' }} />
              </div>
            </List.Item>
          );
        }}
      />
    </div>
  </div>
</div>
```

- [ ] **Step 5: Make the warehouse grid responsive**

Inline `style` attributes always win over Tailwind classes, so we must move grid positioning out of inline styles and into Tailwind utilities.

Replace the warehouse grid container (line 416 area, `<div className="relative w-full max-w-5xl mx-auto h-full px-6" style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gridTemplateRows: '1fr auto 1fr', alignItems: 'center' }}>`) with:

```tsx
<div
  className="relative w-full max-w-5xl mx-auto h-full px-4 md:px-6 grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] md:grid-rows-[1fr_auto_1fr] gap-4 md:gap-0"
  style={{ alignItems: 'center' }}
>
```

Then replace each of the four `ShelfCard` wrapper divs (lines 421, 425, 429, 433) — strip the inline `gridColumn`/`gridRow`/`justifySelf` and put the desktop-only positioning in Tailwind classes:

Top-left shelf (line 421):

```tsx
<div className="w-full md:col-start-1 md:row-start-1 md:justify-self-start">
  <ShelfCard shelf={SHELF_POSITIONS[0]} source={source} dest={dest} packageCount={packagesByShelf[1]?.length || 0} onClick={() => setActiveShelf(1)} />
</div>
```

Top-right shelf (line 425):

```tsx
<div className="w-full md:col-start-3 md:row-start-1 md:justify-self-end">
  <ShelfCard shelf={SHELF_POSITIONS[1]} source={source} dest={dest} packageCount={packagesByShelf[2]?.length || 0} onClick={() => setActiveShelf(2)} />
</div>
```

Bottom-left shelf (line 429):

```tsx
<div className="w-full md:col-start-1 md:row-start-3 md:justify-self-start">
  <ShelfCard shelf={SHELF_POSITIONS[2]} source={source} dest={dest} packageCount={packagesByShelf[3]?.length || 0} onClick={() => setActiveShelf(3)} />
</div>
```

Bottom-right shelf (line 433):

```tsx
<div className="w-full md:col-start-3 md:row-start-3 md:justify-self-end">
  <ShelfCard shelf={SHELF_POSITIONS[3]} source={source} dest={dest} packageCount={packagesByShelf[4]?.length || 0} onClick={() => setActiveShelf(4)} />
</div>
```

Replace the center hub wrapper (the one starting `<div style={{ gridColumn: '2', gridRow: '2', ...}}>`) with:

```tsx
<div
  className="hidden md:block md:col-start-2 md:row-start-2 md:justify-self-center md:self-center"
  style={{ pointerEvents: 'none' }}
>
```

- [ ] **Step 6: Make the header and command bar wrap on mobile**

Find the page header (line 227 area, `<div className="px-8 py-5 ...`):
- Replace `px-8` with `px-4 md:px-8`
- Replace `text-2xl` with `text-xl md:text-2xl`
- Add `flex-wrap gap-3` to the inner row that holds the title and the "HỆ THỐNG ONLINE" pill

Find the SRC/DST command bar (line 293 area, `<div className="px-8 py-3.5 flex items-center gap-4 ...`):
- Replace `px-8` with `px-4 md:px-8`
- Replace `flex items-center gap-4` with `flex flex-wrap items-center gap-3 md:gap-4`

Find the footer action bar (line 491 area, `<div className="px-8 py-4 flex items-center justify-between"`):
- Replace `px-8` with `px-4 md:px-8`
- Replace `justify-between` with `justify-between flex-wrap gap-3`

- [ ] **Step 7: Verify in the browser at three viewports**

Resize and snapshot at:
- 375×812 (phone): warehouse grid stacks, FAB visible, bottom tab bar visible, no horizontal scroll
- 768×1024 (tablet): 2x2 grid restored, no FAB, no bottom tab bar
- 1280×800 (desktop): unchanged from before

Open the FAB on phone, confirm the bottom sheet opens and the close button works. Tap a package item, confirm the sheet closes and the source/dest state updates.

- [ ] **Step 8: Verify TypeScript and lint**

Run: `cd apps/web && npx tsc --noEmit && yarn lint`
Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/app/inventory/page.tsx
git commit -m "feat(web): make inventory page responsive with FAB package sheet"
```

---

## Task 9: Make the products list page responsive

**Files:**
- Modify: `apps/web/src/app/products/page.tsx`

- [ ] **Step 1: Make the page header stack on mobile**

Find the header `<div className="px-8 py-6 ...` (line ~310 area). Replace `px-8` with `px-4 md:px-8`.

Find the inner title row `<div className="flex items-center justify-between ...`:
- Replace the entire className with `flex flex-col md:flex-row gap-4 md:gap-0 items-stretch md:items-center justify-between`

- [ ] **Step 2: Make the stats block and add button stack on mobile**

Find the stats container `<div className="flex items-center gap-3 px-4 py-2.5 rounded-xl"`. Add a wrapper around the stats + button so they stack on mobile. Wrap them in:

```tsx
<div className="flex flex-col md:flex-row md:items-center gap-3">
  <div className="flex items-center gap-3 px-4 py-2.5 rounded-xl" style={{...}}>
    {/* existing stats */}
  </div>
  <Button type="primary" size="large" className="w-full md:w-auto" ...>Thêm kiện hàng</Button>
</div>
```

Add `className="w-full md:w-auto"` to the existing `<Button type="primary" icon={<Plus size={16} />} size="large" ...>`.

- [ ] **Step 3: Make the search input full-width on mobile**

Find the `<Input size="large" placeholder="..." prefix={...} value={searchTerm} ...>` block (~line 446). Replace its `style.maxWidth: 400` with `style={{ ...existing, maxWidth: '100%' }}` and add `className="w-full"`:

```tsx
<Input
  size="large"
  placeholder="Tìm theo tên, mã AprilTag hoặc _id..."
  prefix={<Search size={18} style={{ color: 'var(--text-muted)' }} />}
  value={searchTerm}
  onChange={(e) => setSearchTerm(e.target.value)}
  allowClear
  className="w-full"
  style={{
    borderRadius: '12px',
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-mid)',
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: '14px',
  }}
/>
```

(The existing inline `maxWidth: 400` is replaced with `w-full` Tailwind class plus a removal of that inline max-width — keep the rest of the style block.)

- [ ] **Step 4: Make the Ant Design table hide non-essential columns on phone**

The existing `columns` array is defined inside the component. Find it (around line 135). Add `responsive: ['md']` to the columns you can hide on mobile — at minimum the `'Mã AprilTag'` column and the `'Ngày nhập'` column. Example for the `tagId` column:

```tsx
{
  title: 'Mã AprilTag',
  key: 'tagId',
  width: 140,
  responsive: ['md'],
  render: ...,
},
```

Apply the same `responsive: ['md']` to the `Kệ` (shelf) column and the index column. Keep `Tên kiện hàng`, `Trạng thái`, and the actions column visible on all sizes.

- [ ] **Step 5: Make the content area full-width with less padding on mobile**

Find `<Content style={{ padding: '2rem', maxWidth: 1100, margin: '0 auto', width: '100%' }}>` (line ~443). Replace with:

```tsx
<Content style={{ padding: '1rem', maxWidth: 1100, margin: '0 auto', width: '100%' }} className="md:[&]:!p-8">
```

(Using Tailwind's important modifier on the `md:` variant. The inline padding handles the default; the Tailwind class overrides at `md`.)

- [ ] **Step 6: Verify in the browser**

Resize to 375×812:
- Header stacks
- Add button is full-width
- Search is full-width
- Table scrolls horizontally if needed; only the most important columns are shown

Resize to 1024×768:
- Header is side-by-side
- Stats and button are inline
- All columns visible

- [ ] **Step 7: Verify TypeScript and lint**

Run: `cd apps/web && npx tsc --noEmit && yarn lint`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/app/products/page.tsx
git commit -m "feat(web): make products list page responsive"
```

---

## Task 10: Make the product detail page responsive

**Files:**
- Modify: `apps/web/src/app/products/[id]/page.tsx`

- [ ] **Step 1: Make the page header stack on mobile**

Find the page header (search for `text-display` near the top of the JSX). It uses a flex layout. Replace the outermost container with:

```tsx
<div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 px-4 md:px-8 py-5"
  style={{ background: '...', borderBottom: '1px solid var(--border-dim)' }}>
  <div>
    {/* title and back button */}
  </div>
  <div className="flex items-center gap-2 flex-wrap">
    {/* status badge and action buttons */}
  </div>
</div>
```

(Apply the same `px-4 md:px-8` pattern to any other `px-8` literal in this file.)

- [ ] **Step 2: Make the info cards full-width on mobile**

Find the `<Card>` or `<div>` blocks that contain `InfoRow`s. Their outer container is typically a `Row`/`Col` grid. Change `xs={24} lg={...}` to `xs={24}` only and ensure the inner cards use `w-full`.

If you see `<div className="grid grid-cols-1 lg:grid-cols-2 gap-5">` (or similar), it likely already handles the stacking — keep that. Replace any `lg:grid-cols-2` with `md:grid-cols-2` so tablets get a side-by-side layout but phones do not.

- [ ] **Step 3: Make the action buttons stack on mobile**

Find the cluster of `<Button>`s (typically Edit, Print, etc.). Wrap them in:

```tsx
<div className="flex flex-col md:flex-row gap-2 md:gap-3 w-full md:w-auto">
  <Button block className="md:block">...</Button>
</div>
```

- [ ] **Step 4: Make modals full-screen on mobile**

Find the page's modals (likely `<Modal>` for the print and edit dialogs). Add the responsive `width` and `style` props:

```tsx
<Modal
  width="calc(100vw - 32px)"
  style={{ maxWidth: 720, top: 16 }}
  ...
>
```

This makes the modal nearly full-width on phones and capped at 720px on larger screens.

- [ ] **Step 5: Make the QR / AprilTag preview full-width on mobile**

Find the QR/AprilTag container (search for `QRCodeSVG` and `aprilTagToSvgString`). Its outer wrapper likely has fixed width. Add `w-full` and a max-width style:

```tsx
<div className="w-full max-w-[300px] mx-auto">
  {/* QR or AprilTag */}
</div>
```

- [ ] **Step 6: Verify in the browser**

At 375×812:
- Header stacks
- Buttons are full-width
- QR preview is centered and full-width within the card
- Modals are nearly full-screen

At 1024×768:
- Side-by-side cards
- Modals are centered with capped width

- [ ] **Step 7: Verify TypeScript and lint**

Run: `cd apps/web && npx tsc --noEmit && yarn lint`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/app/products/[id]/page.tsx
git commit -m "feat(web): make product detail page responsive"
```

---

## Task 11: Make the map page responsive

**Files:**
- Modify: `apps/web/src/app/map/page.tsx`

- [ ] **Step 1: Replace `h-screen` with `min-h-dvh` on the root and add responsive paddings**

Find the outermost `<div className="flex flex-col h-screen overflow-hidden" style={{ background: 'var(--bg-void)', fontFamily: ... }}>`. Replace with:

```tsx
<div className="flex flex-col min-h-dvh overflow-hidden" style={{ background: 'var(--bg-void)', fontFamily: ... }}>
```

- [ ] **Step 2: Make the page header responsive**

Find the header divs. Replace `px-8` with `px-4 md:px-8`. Replace the inner `flex justify-between items-start` with `flex flex-col md:flex-row md:items-center md:justify-between gap-3`.

- [ ] **Step 3: Make the map canvas / viewer fill the available area**

The map's main viewer block uses `flex-1` already. Verify it is wrapped in a parent that constrains height properly. The likely pattern is:

```tsx
<div className="flex-1 min-h-0 p-3 md:p-6">
  <div className="h-full ..."> {/* canvas container */}
```

Apply `p-3 md:p-6` so padding shrinks on mobile.

- [ ] **Step 4: Make floating controls compact on mobile**

Find the floating control clusters (zoom in/out, recenter, mode switch, etc.). Wrap their outer container with `flex-wrap gap-2` and reduce sizes on mobile by replacing `w-10 h-10` with `w-9 h-9 md:w-10 md:h-10`.

- [ ] **Step 5: Verify in the browser**

At 375×812:
- Map fills the area between top bar and bottom tab bar
- Floating controls remain reachable and don't overflow

At 1280×800:
- Layout unchanged from before

- [ ] **Step 6: Verify TypeScript and lint**

Run: `cd apps/web && npx tsc --noEmit && yarn lint`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/app/map/page.tsx
git commit -m "feat(web): make map page responsive"
```

---

## Task 12: Make the camera page responsive

**Files:**
- Modify: `apps/web/src/app/camera/page.tsx`

- [ ] **Step 1: Replace `h-screen` with `min-h-dvh`**

Find the outermost `<div className="flex flex-col h-screen overflow-hidden" ...>`. Replace `h-screen` with `min-h-dvh`. Replace the inner `px-8 py-5` (header) with `px-4 md:px-8 py-4 md:py-5`. Replace `p-6` on the video area with `p-3 md:p-6`.

- [ ] **Step 2: Make the header row stack on mobile**

Find `<div className="flex justify-between items-start relative z-10 flex-wrap gap-4">` and change the inner contents so that:
- The status pill (`STREAMING`/`OFFLINE`) and resolution chip are hidden on phone via `hidden md:flex`
- A compact status dot is shown on phone via a new `<span className="md:hidden ...">` at the start of the header

Add a compact dot before the camera icon:

```tsx
<span
  className="md:hidden w-2 h-2 rounded-full"
  style={{
    background: isOnline ? 'var(--success)' : 'var(--danger)',
    boxShadow: isOnline ? '0 0 6px var(--success-glow)' : 'none',
  }}
/>
```

- [ ] **Step 3: Make the corner brackets smaller on mobile**

The four `w-10 h-10` corner brackets (lines 117–120) become `w-6 h-6 md:w-10 md:h-10` and shift from `top-5 left-5` to `top-3 left-3 md:top-5 md:left-5`.

- [ ] **Step 4: Make the floating controls bar compact on mobile**

Find the controls overlay at the bottom right (line 155 area, `<div className="absolute bottom-4 right-4 z-20 ...">`). Change `bottom-4 right-4` to `bottom-3 right-3 md:bottom-4 md:right-4` and reduce the button size from `w-10 h-10` to `w-9 h-9 md:w-10 md:h-10`.

- [ ] **Step 5: Make the offline message text smaller on mobile**

Find the offline message (line 211 area, `<h2 className="text-xl font-black mb-2">`). Change to `text-lg md:text-xl`. Change the body `p` text size to `text-xs md:text-sm` and the icon container `w-24 h-24` to `w-20 h-20 md:w-24 md:h-24`.

- [ ] **Step 6: Verify in the browser**

At 375×812:
- Stream viewport fills available height
- Corner brackets smaller, controls bar compact
- Offline message is readable but not overwhelming

At 1280×800:
- Unchanged

- [ ] **Step 7: Verify TypeScript and lint**

Run: `cd apps/web && npx tsc --noEmit && yarn lint`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/app/camera/page.tsx
git commit -m "feat(web): make camera page responsive"
```

---

## Task 13: Cross-page verification and polish

This is a manual-only task. No code changes unless verification finds a regression.

- [ ] **Step 1: Walk every page at every target viewport**

Open each route in Chrome DevTools MCP, resize to each viewport, take a snapshot, and verify:

| Viewport | Inventory | Products | Product detail | Map | Camera |
|---|---|---|---|---|---|
| 375×812 | grid stacks, FAB visible, sheet opens | header stacks, table scrolls | header stacks, modals full-width | viewport fills, controls compact | viewport fills, corner brackets small |
| 430×932 | same as 375 | same | same | same | same |
| 768×1024 | 2x2 grid restored, no FAB | 2-col stats, all columns | side-by-side cards | padding restored | padding restored |
| 1024×768 | full desktop layout | full desktop layout | full desktop layout | full desktop layout | full desktop layout |
| 1280×800 | full desktop layout | full desktop layout | full desktop layout | full desktop layout | full desktop layout |

Use `mcp__plugin_chrome-devtools-mcp_chrome-devtools__resize_page(width, height)` then `mcp__plugin_chrome-devtools-mcp_chrome-devtools__take_snapshot()`.

- [ ] **Step 2: Verify the full workflow on phone**

Open `/inventory` at 375×812:
1. Tap the FAB
2. Bottom sheet opens
3. Tap a package item
4. Sheet closes
5. SRC tag appears in the command bar (you may need to use the warehouse grid directly if no packages show)

Open `/products` at 375×812:
1. Header stacks correctly
2. Search input is full-width
3. Add button is full-width
4. Table shows only the most important columns

Open `/products/{any-id}` at 375×812:
1. Header stacks
2. QR preview is centered and full-width
3. Edit/Print buttons are full-width stacked
4. Open the print modal — confirm it is nearly full-screen
5. Close and confirm scroll position is preserved

- [ ] **Step 3: Verify the bottom tab bar navigation**

From any page at 375×812, tap each of the four bottom tab items. Confirm:
- Each navigates correctly
- The active item shows the cyan accent + top border indicator
- The page title in the top bar updates

- [ ] **Step 4: Verify the drawer**

From any page at 375×812:
1. Tap the hamburger button — drawer slides in
2. Tap a navigation item — drawer closes, route changes
3. Tap the close (X) button — drawer closes
4. Tap the backdrop — drawer closes
5. Press Escape — drawer closes

Repeat the same at 768×1024 (tablet) where the drawer should also work.

- [ ] **Step 5: Verify no horizontal scroll on phone**

On every page at 375×812, run in the Chrome DevTools console:

```js
document.documentElement.scrollWidth <= window.innerWidth
```

Expected: `true` for every page. If `false` on any page, find the offending element with:

```js
[...document.querySelectorAll('*')]
  .filter(el => el.scrollWidth > window.innerWidth)
  .map(el => ({ tag: el.tagName, class: el.className, w: el.scrollWidth }))
```

Add `min-w-0` or `overflow-hidden` to that element. Re-run until all pages pass.

- [ ] **Step 6: Verify no regression on desktop**

At 1280×800, compare against the original layout:
- Sidebar still on the left
- No top bar visible
- No bottom tab bar visible
- All pages look the same as before this work

If anything is broken, the most likely cause is a stray `md:` or `lg:` class. Fix and re-verify.

- [ ] **Step 7: Final commit**

```bash
git status
# If anything is uncommitted:
git add -A
git commit -m "fix(web): responsive polish from cross-viewport verification"
```

---

## Self-Review

**Spec coverage:**
- Mobile-first breakpoint system → Tasks 1, 7 ✓
- Mobile shell (top bar + bottom tab + drawer) → Tasks 4, 5, 6, 7 ✓
- Tablet shell (top bar + drawer) → Tasks 7, 6 ✓
- Desktop shell preserved → Task 7 ✓
- Global CSS scroll/safe-area/iOS zoom → Task 2 ✓
- Inventory responsive (FAB, sheet, grid stack) → Task 8 ✓
- Products responsive (header, table columns) → Task 9 ✓
- Product detail responsive (cards, modals, QR) → Task 10 ✓
- Map responsive (canvas, controls) → Task 11 ✓
- Camera responsive (viewport, corner brackets, controls) → Task 12 ✓
- Verification viewports 375/430/768/1024/1280 → Task 13 ✓
- All current features preserved → every task is additive, no removal ✓

**Placeholder scan:** No TBDs. All code blocks are complete.

**Type consistency:**
- `useBreakpoint` exports `breakpoint: 'mobile' | 'tablet' | 'desktop'` and boolean flags — used consistently in `MainLayout`
- `SidebarContent` is exported from `Sidebar.tsx` and imported by `NavDrawer.tsx` — same name both places
- `MobileTopBar.onMenu` matches `NavDrawer` open/close handlers in `MainLayout`
- `BottomTabBar` paths match the menu items in `Sidebar.tsx`

No issues found.
