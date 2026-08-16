# Floating Control Dock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three `/map` robot-control cards with a persistent, collapsible floating HUD while preserving the current command and teleoperation behavior.

**Architecture:** Extract the map-control visual surface into a focused `FloatingControlDock` client component. `MapPage` retains all robot connection, telemetry, modal, and keyboard-control behavior, passing typed data and callbacks into the dock. The dock owns only presentation state, safely persists it in `localStorage`, and uses CSS transitions rather than an animation dependency.

**Tech Stack:** Next.js 16 App Router, React, TypeScript strict mode, Tailwind CSS v4, Ant Design v6, Lucide React, browser `localStorage`, Playwright MCP.

---

## File Structure

- **Create:** `apps/web/src/components/FloatingControlDock.tsx` — isolated HUD layout, persisted tab/collapse state, and all three visual tab bodies.
- **Modify:** `apps/web/src/app/map/page.tsx` — import the component, adapt existing callbacks to typed props, render the overlay inside the map viewport, and remove only the old three-card section.
- **Do not modify:** `apps/web/src/components/TelemetryPanel.tsx` — it serves the application-wide telemetry sidebar and is not part of the current map panel.

The component remains intentionally self-contained because the data and callbacks are only consumed on `/map`. No Redux slice, cookie, new API, robot protocol, or test framework is needed.

### Task 1: Create the typed floating dock shell and persisted display state

**Files:**
- Create: `apps/web/src/components/FloatingControlDock.tsx`

- [ ] **Step 1: Create the component file with explicit display and command types**

```tsx
'use client';

import { useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleStop,
  Cpu,
  Gamepad2,
  OctagonAlert,
  Radio,
  Route,
  ShieldAlert,
  Square,
  Wrench,
} from 'lucide-react';
import { Tooltip } from 'antd';

export type DockTab = 'control' | 'action' | 'safety';
export type ControlMode = 'AUTO' | 'MANUAL';
export type CylinderAction = 'extend' | 'retract' | 'stop';

export interface FloatingControlDockProps {
  controlMode: ControlMode;
  controlModeReason?: string;
  demoState?: string;
  demoAction?: string;
  esp32Status: {
    estop?: boolean;
    mode?: string;
    st?: { obs?: boolean; tof_mm?: number; cyl?: string };
  } | null;
  isOnline: boolean;
  onControlModeChange: (mode: ControlMode) => void;
  onStartManualMotion: (key: string, event: ReactPointerEvent<HTMLButtonElement>) => void;
  onStopManualMotion: (key?: string) => void;
  onEmergencyStop: () => void;
  onZoneSelect: (zone: string) => void;
  onRouteStart: () => void;
  onAutoStop: () => void;
  onCylinderAction: (action: CylinderAction) => void;
}

const TAB_STORAGE_KEY = 'map-hud-tab';
const COLLAPSED_STORAGE_KEY = 'map-hud-collapsed';

function isDockTab(value: string | null): value is DockTab {
  return value === 'control' || value === 'action' || value === 'safety';
}

export function FloatingControlDock({ controlMode, isOnline, onEmergencyStop }: FloatingControlDockProps) {
  const [activeTab, setActiveTab] = useState<DockTab>('control');
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isHydrated, setIsHydrated] = useState(false);

  useEffect(() => {
    const savedTab = window.localStorage.getItem(TAB_STORAGE_KEY);
    const savedCollapsed = window.localStorage.getItem(COLLAPSED_STORAGE_KEY);
    if (isDockTab(savedTab)) setActiveTab(savedTab);
    if (savedCollapsed === 'true') setIsCollapsed(true);
    setIsHydrated(true);
  }, []);

  useEffect(() => {
    if (!isHydrated) return;
    window.localStorage.setItem(TAB_STORAGE_KEY, activeTab);
  }, [activeTab, isHydrated]);

  useEffect(() => {
    if (!isHydrated) return;
    window.localStorage.setItem(COLLAPSED_STORAGE_KEY, String(isCollapsed));
  }, [isCollapsed, isHydrated]);

  useEffect(() => {
    if (controlMode !== 'AUTO') return;
    setIsCollapsed(false);
    setActiveTab('safety');
  }, [controlMode]);

  if (isCollapsed) {
    return (
      <button
        type="button"
        onClick={() => setIsCollapsed(false)}
        className="fixed bottom-4 right-4 z-50 flex min-h-12 items-center gap-2 rounded-full border border-cyan-400/35 bg-[#0a0f1d]/90 px-4 text-cyan-200 shadow-[0_0_24px_rgba(0,212,255,0.18)] backdrop-blur-md transition hover:border-cyan-300 hover:bg-[#10192b]/95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
        aria-label="Mở bảng điều khiển robot"
      >
        <span className={`h-2 w-2 rounded-full ${isOnline ? 'bg-emerald-400 shadow-[0_0_8px_#00ff88]' : 'bg-rose-400'}`} />
        <Gamepad2 size={18} />
        <span className="text-[10px] font-bold tracking-[0.16em]">CTRL</span>
        <ChevronUp size={16} />
      </button>
    );
  }

  return (
    <aside
      className="fixed bottom-4 right-4 z-50 flex w-80 max-h-[calc(100dvh-2rem)] flex-col overflow-hidden rounded-2xl border border-cyan-400/30 bg-[#0a0f1d]/85 font-mono shadow-[0_0_36px_rgba(0,212,255,0.16),inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-md transition-all duration-200 sm:w-96"
      aria-label="Bảng điều khiển robot"
    >
      <div className="flex items-center justify-between gap-2 border-b border-cyan-400/20 bg-cyan-400/[0.04] px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`h-2 w-2 shrink-0 rounded-full ${isOnline ? 'bg-emerald-400 shadow-[0_0_8px_#00ff88]' : 'bg-rose-400'}`} />
          <span className="truncate text-[10px] font-bold tracking-[0.16em] text-cyan-100">ROBOT_CTRL</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Tooltip title="Dừng khẩn cấp">
            <button type="button" onClick={onEmergencyStop} className="flex min-h-9 items-center gap-1 rounded-lg border border-rose-400/70 bg-rose-500/20 px-2.5 text-[10px] font-bold tracking-wider text-rose-200 shadow-[0_0_14px_rgba(255,59,92,0.4)] transition hover:bg-rose-500/35" aria-label="Dừng khẩn cấp E-STOP">
              <OctagonAlert size={15} />E-STOP
            </button>
          </Tooltip>
          <Tooltip title="Thu gọn bảng điều khiển">
            <button type="button" onClick={() => setIsCollapsed(true)} className="grid min-h-9 min-w-9 place-items-center rounded-lg border border-cyan-400/20 text-cyan-100 transition hover:bg-cyan-400/10" aria-label="Thu gọn bảng điều khiển">
              <ChevronDown size={17} />
            </button>
          </Tooltip>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {/* Tab control and tab bodies are added in Tasks 2 and 3. */}
      </div>
    </aside>
  );
}
```

- [ ] **Step 2: Run the web lint command and confirm the temporary incomplete props surface is type-checked**

Run: `yarn --cwd apps/web lint`

Expected: the command completes successfully after temporarily removing unused icon imports from the skeleton if ESLint reports them. Do not suppress lint rules.

- [ ] **Step 3: Commit the component shell**

```bash
git add apps/web/src/components/FloatingControlDock.tsx
git commit -m "feat(web): add floating control dock shell"
```

### Task 2: Implement Control and Action tab bodies

**Files:**
- Modify: `apps/web/src/components/FloatingControlDock.tsx`

- [ ] **Step 1: Add segmented tabs and the manual/auto control body**

Add this immediately inside the scrollable content container, replacing the Task 1 placeholder:

```tsx
<div className="mb-3 grid grid-cols-3 rounded-xl border border-cyan-400/20 bg-black/20 p-1" role="tablist" aria-label="Chế độ bảng điều khiển">
  {[
    { id: 'control' as const, label: 'ĐIỀU KHIỂN', icon: <Gamepad2 size={13} /> },
    { id: 'action' as const, label: 'TÁC VỤ', icon: <Wrench size={13} /> },
    { id: 'safety' as const, label: 'AN TOÀN', icon: <ShieldAlert size={13} /> },
  ].map((tab) => (
    <button
      key={tab.id}
      type="button"
      role="tab"
      aria-selected={activeTab === tab.id}
      onClick={() => setActiveTab(tab.id)}
      className={`flex min-h-10 items-center justify-center gap-1 rounded-lg px-1 text-[9px] font-bold tracking-wide transition ${activeTab === tab.id ? 'bg-cyan-400/15 text-cyan-100 shadow-[inset_0_0_0_1px_rgba(34,211,238,0.35)]' : 'text-slate-500 hover:text-slate-200'}`}
    >
      {tab.icon}<span className="hidden sm:inline">{tab.label}</span>
    </button>
  ))}
</div>

{activeTab === 'control' && (
  <ControlTab
    controlMode={controlMode}
    onControlModeChange={onControlModeChange}
    onStartManualMotion={onStartManualMotion}
    onStopManualMotion={onStopManualMotion}
    onZoneSelect={onZoneSelect}
    onRouteStart={onRouteStart}
    onAutoStop={onAutoStop}
  />
)}
{activeTab === 'action' && <ActionTab onCylinderAction={onCylinderAction} />}
{activeTab === 'safety' && <SafetyTab {...safetyProps} />}
```

Pass all currently destructured props into `FloatingControlDock`, then define `const safetyProps = { esp32Status, isOnline, controlMode, controlModeReason, demoState, demoAction };` immediately before the JSX return. Define `ControlTab` below the main component. Its Manual body must retain the existing pointer lifecycle exactly:

```tsx
<Tooltip title="Tiến, giữ để chạy">
  <button
    type="button"
    aria-label="Di chuyển tiến, giữ để chạy"
    className="dock-motion-button"
    onPointerDown={(event) => onStartManualMotion('w', event)}
    onPointerUp={() => onStopManualMotion('w')}
    onPointerCancel={() => onStopManualMotion('w')}
    onLostPointerCapture={() => onStopManualMotion('w')}
  >
    <ChevronUp size={22} />
  </button>
</Tooltip>
```

Use equivalent `a`, `d`, and `s` handlers for left/right/reverse. The center button must call `onStopManualMotion()` and keep the red visual treatment. In Auto mode, render zone A-D buttons calling `onZoneSelect(zone)`, a route button calling `onRouteStart`, and a stop button calling `onAutoStop`.

- [ ] **Step 2: Add the focused cylinder action body**

Define the `ActionTab` below `ControlTab`:

```tsx
function ActionTab({ onCylinderAction }: Pick<FloatingControlDockProps, 'onCylinderAction'>) {
  return (
    <div className="grid grid-cols-3 gap-2" role="group" aria-label="Điều khiển xylanh">
      <button type="button" onClick={() => onCylinderAction('extend')} className={`${DOCK_CYLINDER_BUTTON} text-amber-300`}>
        <ArrowUp size={18} />NÂNG
      </button>
      <button type="button" onClick={() => onCylinderAction('stop')} className={`${DOCK_CYLINDER_BUTTON} border-rose-400/35 text-rose-200`}>
        <Square size={15} fill="currentColor" />DỪNG
      </button>
      <button type="button" onClick={() => onCylinderAction('retract')} className={`${DOCK_CYLINDER_BUTTON} border-cyan-400/25 text-cyan-200`}>
        <ArrowDown size={18} />HẠ
      </button>
    </div>
  );
}
```

Import `ArrowUp`, `ArrowDown`, `ChevronLeft`, `ChevronRight`, `Route`, `CircleStop`, `Keyboard`, and `Rocket` from `lucide-react`. Define these constants near the storage keys and apply them to every matching button instead of adding global CSS:

```tsx
const DOCK_MOTION_BUTTON = 'grid min-h-12 min-w-12 place-items-center rounded-xl border border-cyan-400/20 bg-cyan-400/[0.06] text-cyan-100 transition hover:border-cyan-300/60 hover:bg-cyan-400/15 active:scale-95';
const DOCK_STOP_BUTTON = 'grid min-h-12 min-w-12 place-items-center rounded-xl border border-rose-400/50 bg-rose-500/15 text-rose-200 transition hover:bg-rose-500/25 active:scale-95';
const DOCK_CYLINDER_BUTTON = 'flex min-h-12 items-center justify-center gap-1.5 rounded-xl border border-amber-300/20 bg-amber-300/[0.06] text-[10px] font-bold tracking-wider transition hover:bg-amber-300/15 active:scale-95';
```

Use `DOCK_MOTION_BUTTON` for directional buttons, `DOCK_STOP_BUTTON` for the D-pad center and Auto stop, and `DOCK_CYLINDER_BUTTON` for the three cylinder actions; append per-action color/border classes where needed.

- [ ] **Step 3: Run lint**

Run: `yarn --cwd apps/web lint`

Expected: exits with code 0 and reports no unused imports, `any`, or hook dependency violations.

- [ ] **Step 4: Commit Control and Action tabs**

```bash
git add apps/web/src/components/FloatingControlDock.tsx
git commit -m "feat(web): add control dock command tabs"
```

### Task 3: Implement the compact Safety tab

**Files:**
- Modify: `apps/web/src/components/FloatingControlDock.tsx`

- [ ] **Step 1: Define a compact reusable metric presentation unit**

Add the following below `ActionTab`:

```tsx
function SafetyMetric({ label, value, tone = 'text-slate-100' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-white/[0.07] bg-white/[0.035] px-2.5 py-2">
      <p className="text-[8px] font-bold tracking-[0.14em] text-slate-500">{label}</p>
      <p className={`mt-1 truncate text-[11px] font-bold ${tone}`}>{value}</p>
    </div>
  );
}
```

- [ ] **Step 2: Define `SafetyTab` using only the existing telemetry props**

```tsx
function SafetyTab({
  esp32Status,
  isOnline,
  controlMode,
  controlModeReason,
  demoState,
  demoAction,
}: Pick<FloatingControlDockProps, 'esp32Status' | 'isOnline' | 'controlMode' | 'controlModeReason' | 'demoState' | 'demoAction'>) {
  const st = esp32Status?.st;
  const statusLabel = esp32Status?.estop ? 'E-STOP ĐANG BẬT' : esp32Status?.mode?.toUpperCase() || 'CHỜ TELEMETRY';
  const statusTone = esp32Status?.estop ? 'text-rose-300' : esp32Status ? 'text-emerald-300' : 'text-slate-500';
  const taskLabel = demoState && demoState !== 'idle'
    ? `TÁC VỤ: ${demoAction?.toUpperCase() || demoState.toUpperCase()}`
    : controlModeReason
      ? `${controlMode}: ${controlModeReason}`
      : `Tín hiệu: ${isOnline ? 'đã kết nối' : 'đang kết nối lại'}`;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between rounded-xl border border-cyan-400/15 bg-cyan-400/[0.045] px-3 py-2.5">
        <span className="flex items-center gap-2 text-[9px] font-bold tracking-[0.14em] text-slate-400"><Cpu size={14} />ESP32</span>
        <span className={`text-[10px] font-bold tracking-wide ${statusTone}`}>{statusLabel}</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <SafetyMetric label="TOF" value={`${st?.tof_mm ?? '--'} mm`} tone="text-cyan-100" />
        <SafetyMetric label="XYLANH" value={st?.cyl ?? '--'} tone="text-amber-200" />
        <SafetyMetric label="VẬT CẢN" value={st?.obs ? 'CÓ' : 'KHÔNG'} tone={st?.obs ? 'text-amber-300' : 'text-emerald-300'} />
        <SafetyMetric label="TÍN HIỆU" value={isOnline ? 'TRỰC TUYẾN' : 'MẤT KẾT NỐI'} tone={isOnline ? 'text-emerald-300' : 'text-rose-300'} />
      </div>
      <p className="min-h-10 rounded-lg border border-white/[0.07] bg-black/15 px-3 py-2 text-[10px] leading-5 text-slate-400">{taskLabel}</p>
    </div>
  );
}
```

- [ ] **Step 3: Run lint**

Run: `yarn --cwd apps/web lint`

Expected: exits with code 0.

- [ ] **Step 4: Commit the Safety tab**

```bash
git add apps/web/src/components/FloatingControlDock.tsx
git commit -m "feat(web): add control dock safety telemetry"
```

### Task 4: Integrate the dock into the map viewport without changing robot behavior

**Files:**
- Modify: `apps/web/src/app/map/page.tsx:3-5`
- Modify: `apps/web/src/app/map/page.tsx:1234-1296`

- [ ] **Step 1: Import the new dock component**

Add this after the AntD import:

```tsx
import { FloatingControlDock } from '@/components/FloatingControlDock';
```

Remove now-unused direct-control icon imports only after the old card section has been removed: `Keyboard`, `Rocket`, `ChevronUp`, `ChevronDown`, `ChevronLeft`, `ChevronRight`, `ArrowUp`, `ArrowDown`, `Square`, `OctagonAlert`, `Route`, `CircleStop`, and `Radio`. Keep imports still used elsewhere in the page.

- [ ] **Step 2: Replace only the old Robot Control Panel section with the dock invocation**

Delete the `<section>` starting at the comment `/* ─── Robot Control Panel` through its closing `</section>`. Insert this in the same location:

```tsx
<FloatingControlDock
  controlMode={controlMode}
  controlModeReason={controlModeStatus.reason}
  demoState={demoStatus.state}
  demoAction={demoStatus.action}
  esp32Status={esp32Status}
  isOnline={isOnline}
  onControlModeChange={handleModeSwitch}
  onStartManualMotion={startManualMotion}
  onStopManualMotion={stopManualMotion}
  onEmergencyStop={handleEStop}
  onZoneSelect={sendDemo}
  onRouteStart={() => sendDemo('full')}
  onAutoStop={() => sendDemo('stop')}
  onCylinderAction={sendCylinder}
/>
```

Do not move or edit `sendKeyboardMotion`, `stopManualMotion`, the keyboard `useEffect`, `handleModeSwitch`, `sendWs`, `sendEsp32`, or `handleEStop`. The parent remains the source of all robot state and side effects.

- [ ] **Step 3: Run lint and production build**

Run: `yarn --cwd apps/web lint && yarn --cwd apps/web build`

Expected: both commands exit with code 0. The build output contains a successful `/map` route build.

- [ ] **Step 4: Commit integration**

```bash
git add apps/web/src/app/map/page.tsx apps/web/src/components/FloatingControlDock.tsx
git commit -m "feat(web): replace map controls with floating dock"
```

### Task 5: Verify the interaction in a running browser through Playwright MCP

**Files:**
- Modify: none unless verification exposes a defect

- [ ] **Step 1: Start the Next.js development server**

Run: `yarn --cwd apps/web dev`

Expected: Next.js reports that the application is ready on port 3000. Keep the process running while the following MCP steps execute.

- [ ] **Step 2: Inspect the default desktop HUD with Playwright MCP**

Use Playwright MCP to navigate to the local `/map` route, set a 1440×900 viewport, and capture both accessibility snapshot and screenshot.

Expected: the HUD appears at lower-right as an overlay, shows the Control tab, contains a visible E-STOP button, and no longer shows a three-card Robot Control Panel section that occupies document height.

- [ ] **Step 3: Verify tabs, E-stop persistence, and collapse behavior with Playwright MCP**

Using the accessibility snapshot references, click Tác vụ and An toàn in turn. After each click, confirm E-STOP remains visible. Click the minimize icon, confirm the compact CTRL capsule is the only dock element, then click the capsule and confirm the full dock returns.

Expected: correct tab bodies render, emergency stop is never absent from expanded HUD, and collapse does not move the map content.

- [ ] **Step 4: Verify preference persistence and Auto safety prioritization with Playwright MCP**

Select Tác vụ, minimize the dock, reload the page, and confirm the compact capsule remains. Re-open it and select Điều khiển, then use the Tự động button; confirm the dock is expanded and An toàn is the selected tab.

Expected: `localStorage` values survive reload, and the Auto transition overrides the selected view for immediate safety awareness.

- [ ] **Step 5: Verify responsive containment and browser health**

Set a 390×844 viewport. Confirm the dock remains fully on-screen, its content is usable, and the map remains visible behind it. Retrieve Playwright console messages at error level and take a final screenshot.

Expected: no console errors caused by the dock and no horizontal viewport overflow.

- [ ] **Step 6: Commit any verification-only fix, if one was required**

```bash
git add apps/web/src/app/map/page.tsx apps/web/src/components/FloatingControlDock.tsx
git commit -m "fix(web): refine floating dock verification"
```

Skip this commit when verification required no code changes.
