# Technical Reports Frontend Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three maintainable, responsive NEXUS frontend routes for robot specifications, encoder pipeline documentation, and an interactive PID/LiDAR simulation lab.

**Architecture:** Convert the three standalone HTML reports into typed React content and focused UI components rather than rendering the documents in an iframe. Shared technical-report primitives provide consistent NEXUS surfaces and responsive tables; static documentation uses JSX SVG and Ant Design tables/cards, while the simulation lab isolates deterministic modelling from canvas rendering and UI controls.

**Tech Stack:** Next.js 16 App Router, React 19 client components, TypeScript strict mode, Ant Design v6, Tailwind CSS v4, Lucide React, Canvas 2D, inline SVG.

---

## File Structure

- Modify: `apps/web/src/components/Sidebar.tsx` — add technical-report links to desktop and drawer navigation.
- Modify: `apps/web/src/components/BottomTabBar.tsx` — expose the technical area on mobile without overcrowding the bottom bar.
- Create: `apps/web/src/components/technical/TechnicalPageShell.tsx` — shared page header, section, panel, metric, diagram and responsive table wrappers.
- Create: `apps/web/src/app/specifications/page.tsx` — robot technical report page built from typed static data.
- Create: `apps/web/src/app/specifications/SystemArchitectureDiagram.tsx` — accessible architecture SVG.
- Create: `apps/web/src/app/encoder-pipeline/page.tsx` — encoder documentation page and tables.
- Create: `apps/web/src/app/encoder-pipeline/EncoderDiagrams.tsx` — accessible encoder flow, quadrature, overflow, PID, chassis, timing and telemetry SVGs.
- Create: `apps/web/src/app/encoder-pipeline/EmaResponseChart.tsx` — responsive EMA canvas chart with tooltip and fallback table.
- Create: `apps/web/src/app/signal-lab/simulation.ts` — pure PID and LiDAR simulation utilities/types.
- Create: `apps/web/src/app/signal-lab/CanvasCharts.tsx` — reusable responsive canvas chart and LiDAR renderers.
- Create: `apps/web/src/app/signal-lab/page.tsx` — interactive PID/LiDAR lab orchestration and controls.

## Task 1: Add Technical Navigation

**Files:**
- Modify: `apps/web/src/components/Sidebar.tsx`
- Modify: `apps/web/src/components/BottomTabBar.tsx`

- [ ] **Step 1: Extend the sidebar menu configuration with three technical routes.**

Import `Cpu`, `Gauge`, and `Radar` from `lucide-react`; append these entries after the camera route:

```tsx
{ name: 'Thông số kỹ thuật', path: '/specifications', icon: Cpu },
{ name: 'Encoder pipeline', path: '/encoder-pipeline', icon: Gauge },
{ name: 'PID & LiDAR lab', path: '/signal-lab', icon: Radar },
```

Render a small “Phân tích kỹ thuật” label before the first technical link. Determine active state with `pathname === path || pathname.startsWith(`${path}/`)`.

- [ ] **Step 2: Add a mobile bottom-bar entry for the technical overview.**

Add an entry below camera in `BottomTabBar.tsx`:

```tsx
{ path: '/specifications', label: 'Kỹ thuật', icon: Cpu },
```

Import `Cpu` from `lucide-react` and update the active predicate to support nested route paths. The drawer automatically receives all sidebar links through `SidebarContent`.

- [ ] **Step 3: Run the frontend linter.**

Run: `yarn --cwd apps/web lint`

Expected: exits with code 0, or reports only pre-existing lint issues unrelated to these two files.

- [ ] **Step 4: Commit navigation work.**

```bash
git add apps/web/src/components/Sidebar.tsx apps/web/src/components/BottomTabBar.tsx
git commit -m "feat(web): add technical report navigation"
```

## Task 2: Create Shared Technical UI Primitives

**Files:**
- Create: `apps/web/src/components/technical/TechnicalPageShell.tsx`

- [ ] **Step 1: Create a focused client-compatible shared component module.**

Export these typed components:

```tsx
export function TechnicalPageShell({ eyebrow, title, description, icon, children }: TechnicalPageShellProps): JSX.Element
export function TechnicalSection({ title, description, children }: TechnicalSectionProps): JSX.Element
export function TechnicalPanel({ className, children }: TechnicalPanelProps): JSX.Element
export function MetricCard({ label, value, detail, color = 'var(--accent)' }: MetricCardProps): JSX.Element
export function DiagramPanel({ label, caption, children }: DiagramPanelProps): JSX.Element
export function TechnicalTable({ columns, rows, ariaLabel }: TechnicalTableProps): JSX.Element
```

Use Tailwind for responsive page padding (`px-4 md:px-8`), grid layouts and overflow; use `var(--bg-surface)`, `var(--border-dim)`, `var(--text-primary)`, `var(--text-secondary)` and the existing NEXUS labels/cards patterns. `TechnicalTable` must wrap a semantic `<table>` in `overflow-x-auto`, use a `<caption className="sr-only">`, and use string values only so static report content stays typed and simple.

- [ ] **Step 2: Verify strict type compatibility.**

Run: `yarn --cwd apps/web build`

Expected: Next.js completes compilation and type checking without a failure in the new component module.

- [ ] **Step 3: Commit shared technical primitives.**

```bash
git add apps/web/src/components/technical/TechnicalPageShell.tsx
git commit -m "feat(web): add technical report UI primitives"
```

## Task 3: Implement Specifications Route

**Files:**
- Create: `apps/web/src/app/specifications/page.tsx`
- Create: `apps/web/src/app/specifications/SystemArchitectureDiagram.tsx`

- [ ] **Step 1: Implement the accessible architecture diagram.**

Build `SystemArchitectureDiagram.tsx` as an inline SVG with `viewBox="0 0 900 520"`, `role="img"`, `aria-labelledby`, a `<title>` and a text description. Recreate the report’s four layers: sensing, gateway, ESP32 control and hardware. Use NEXUS cyan/amber/green/warning surfaces with readable `var(--text-primary)`-equivalent SVG colors; SVG text must remain readable at mobile widths through `min-w-[720px]` inside the shared `DiagramPanel` scroll surface.

- [ ] **Step 2: Create typed static data in the page module.**

Define `const` arrays for hardware, sensors, GPIO map, software stack, serial protocol, PID settings, dock states, progress, performance, comparisons and references. Each row uses the `TechnicalTable` row shape. Preserve the source report’s Vietnamese labels and specification values, while normalizing accidental non-Vietnamese/corrupted text into clear Vietnamese labels.

- [ ] **Step 3: Build the route UI using Ant Design and shared primitives.**

Use `TechnicalPageShell` with a `Cpu` icon. Render:

```tsx
<TechnicalSection title="Tổng quan hệ thống">...</TechnicalSection>
<TechnicalSection title="Thông số phần cứng">...</TechnicalSection>
<TechnicalSection title="Thông số phần mềm">...</TechnicalSection>
<TechnicalSection title="Kiến trúc hệ thống"><SystemArchitectureDiagram /></TechnicalSection>
<TechnicalSection title="Hiệu năng và năng lượng">...</TechnicalSection>
<TechnicalSection title="Tiến độ triển khai">...</TechnicalSection>
<TechnicalSection title="Đánh giá và tham khảo">...</TechnicalSection>
```

Use Ant Design `Card`, `Tag`, `Progress`, `Collapse` and `Table` only where they improve scanning or progressive disclosure. Use a simple CSS/SVG donut with a four-entry text legend for power allocation; it must not be color-only. Use `Tag` for status labels with textual states.

- [ ] **Step 4: Build and inspect the page.**

Run: `yarn --cwd apps/web build`

Expected: `/specifications` is emitted successfully without SVG JSX or Ant Design SSR errors.

- [ ] **Step 5: Commit the specifications route.**

```bash
git add apps/web/src/app/specifications
git commit -m "feat(web): add robot specifications report"
```

## Task 4: Implement Encoder Pipeline Documentation

**Files:**
- Create: `apps/web/src/app/encoder-pipeline/EncoderDiagrams.tsx`
- Create: `apps/web/src/app/encoder-pipeline/EmaResponseChart.tsx`
- Create: `apps/web/src/app/encoder-pipeline/page.tsx`

- [ ] **Step 1: Create the SVG diagram module.**

Export separately named components:

```tsx
export function EncoderArchitectureDiagram(): JSX.Element
export function QuadratureDiagram(): JSX.Element
export function OverflowDiagram(): JSX.Element
export function RpmPipelineDiagram(): JSX.Element
export function PidLoopDiagram(): JSX.Element
export function WheelLayoutDiagram(): JSX.Element
export function TimingAndTelemetryDiagram(): JSX.Element
```

Each returns an accessible `svg` with a descriptive `<title>`, a fixed `viewBox`, and diagram-specific marker IDs prefixed with `encoder-` to avoid collisions. Wrap each diagram at usage sites in `DiagramPanel`. Preserve the report’s information hierarchy rather than every presentational pixel: hardware → PCNT → encoder → PID/telemetry/odometry; A/B phase and x2 counting; 16-bit wrap; RPM pipeline; PID feedback; four-wheel pin map; timing and type-130 telemetry.

- [ ] **Step 2: Implement a responsive EMA canvas chart.**

`EmaResponseChart` is a client component. Use `useRef<HTMLCanvasElement>`, `ResizeObserver`, and DPR scaling. Generate 0–600 ms samples at 20 ms with `alpha = 0.3`, target 300 RPM beginning at 60 ms. Draw a cyan solid filtered line and amber dashed target/raw step line, labeled grid, threshold annotations and a focusable transparent hover target. On pointer move, display an HTML tooltip with time/raw/EMA values. Include a semantic compact table below the canvas for 0, 60, 120, 180 and 240 ms. Disconnect `ResizeObserver` and remove listeners in `useEffect` cleanup.

- [ ] **Step 3: Build the encoder route.**

Use `TechnicalPageShell` with `Gauge`. Build the page in six ordered sections matching the source material:

1. architecture plus motor/PCNT tables;
2. quadrature and overflow explanation plus alert;
3. RPM pipeline and EMA chart/formula;
4. PID loop and chassis layout;
5. timing, telemetry payload and summary table;
6. FR 200 RPM numerical example, convergence table and end-to-end pipeline summary.

Use Ant Design `Alert` for the overflow caveat, `Tag` for type-130 metadata, `Descriptions`/`Table` for JSON and motor/PCNT summary, while keeping formulae in readable `<code>`/`pre` panels.

- [ ] **Step 4: Run build and lint.**

Run: `yarn --cwd apps/web lint && yarn --cwd apps/web build`

Expected: both commands exit successfully; no unguarded browser API is evaluated during SSR.

- [ ] **Step 5: Commit encoder documentation.**

```bash
git add apps/web/src/app/encoder-pipeline
git commit -m "feat(web): add encoder pipeline report"
```

## Task 5: Add Pure Signal Lab Simulation

**Files:**
- Create: `apps/web/src/app/signal-lab/simulation.ts`

- [ ] **Step 1: Define explicit model types and fixed color-independent data shapes.**

Declare:

```ts
export type PidScene = 'step' | 'tracking' | 'compare';
export type LidarScene = 'room' | 'corridor' | 'cluttered';
export interface PidGains { kp: number; ki: number; kd: number; }
export interface PidSeries { time: number[]; target: number[]; actual: number[]; error: number[]; pwm: number[]; }
export interface PidStats { overshootPct: number; riseMs: number; settlingMs: number; steadyStateError: number; }
export interface LidarPoint { degree: number; distance: number; }
export interface LidarZones { front: number; left: number; right: number; rear: number; }
```

- [ ] **Step 2: Implement deterministic PID simulation.**

Export `simulatePid(gains, scene): PidSeries`, `getPidStats(series): PidStats`, and `clamp(value, min, max)`. Simulate 2 seconds at `0.02` seconds; clamp integral to ±400 and output to ±511. Use a deterministic sinusoidal perturbation instead of `Math.random()` so slider changes are reproducible and visual comparisons do not flicker. Support step at 0.3s, tracking wave and compare baseline data.

- [ ] **Step 3: Implement deterministic LiDAR generation and zone calculation.**

Export `generateLidar(scene): LidarPoint[]` and `getLidarZones(points): LidarZones`. Generate exactly 360 samples. Clamp every sample to 0.15–12 m. Encode the room/corridor/cluttered geometry from the mockup using deterministic sine variation, then calculate Front [315°,45°], Left (45°,135°], Rear (135°,225°], Right otherwise.

- [ ] **Step 4: Build-check pure simulation module.**

Run: `yarn --cwd apps/web build`

Expected: TypeScript checks the utilities successfully with no DOM dependency.

- [ ] **Step 5: Commit simulation utilities.**

```bash
git add apps/web/src/app/signal-lab/simulation.ts
git commit -m "feat(web): add PID and LiDAR simulation utilities"
```

## Task 6: Implement Canvas Chart Renderers

**Files:**
- Create: `apps/web/src/app/signal-lab/CanvasCharts.tsx`

- [ ] **Step 1: Add a reusable canvas sizing hook.**

Create a private `useCanvasSize` hook based on `ResizeObserver`. It returns a ref and CSS-pixel dimensions, caps non-positive size at zero, scales the backing bitmap by `window.devicePixelRatio`, and disconnects in cleanup. It must only access `window` in `useEffect`.

- [ ] **Step 2: Implement PID line chart components with hover data.**

Export `PidLineChart` and `PwmChart`. Props must include `PidSeries`, title and scene. Render a canvas with a real HTML tooltip on pointer move. Draw one y axis per chart only: RPM chart carries target/actual/error series, PWM chart carries PWM only. Add text legends outside canvas, threshold labels and a short accessible data summary. Fixed series identities are cyan target, blue actual, amber error and green PWM; text labels remain NEXUS ink colors rather than inheriting series hues.

- [ ] **Step 3: Implement LiDAR canvas components.**

Export `PolarScanChart` and `ZoneBarChart`. `PolarScanChart` receives points plus a sweep degree and renders rings, axes, 1.5m threshold, obstacle dots and a sweep ray. `ZoneBarChart` receives zones and renders four fixed-order bars. Mark any zone below 1.5m with a status label in accompanying HTML, not color alone. Canvas `aria-label`s identify each visualization.

- [ ] **Step 4: Run lint.**

Run: `yarn --cwd apps/web lint`

Expected: no leaked listeners, implicit `any`, or hook dependency lint errors in `CanvasCharts.tsx`.

- [ ] **Step 5: Commit canvas components.**

```bash
git add apps/web/src/app/signal-lab/CanvasCharts.tsx
git commit -m "feat(web): add responsive signal lab charts"
```

## Task 7: Implement Interactive PID and LiDAR Lab Route

**Files:**
- Create: `apps/web/src/app/signal-lab/page.tsx`

- [ ] **Step 1: Compose PID controls and data.**

Declare the page as a client component. Use `useState<PidScene>('step')` and `useState<PidGains>({ kp: 2.5, ki: 0.2, kd: 0.05 })`, then derive data and stats using `useMemo`. Use Ant Design `Segmented` for scene selection and three `Slider`s for gains. Sliders use the source ranges: Kp 0.5–8 step 0.1, Ki 0–2 step 0.02, Kd 0–1 step 0.01. Show the formatted value beside each control.

- [ ] **Step 2: Render PID visualizations and technical documentation.**

Render `PidLineChart`, `PwmChart`, Ant Design `Statistic` cards for overshoot/rise/settling/SSE, a formula panel, and a semantic tuning trade-off table. In compare mode, show baseline/high-Kp/low-Kp traces and render a clear message in the PWM chart area explaining that comparison mode has no single output trace.

- [ ] **Step 3: Compose LiDAR selection and scan animation safely.**

Use `useState<LidarScene>('room')`; regenerate scan points using `useMemo`. Use Ant Design `Segmented` for room/corridor/cluttered. Advance sweep 4 degrees with one `requestAnimationFrame` loop only while `document.hidden === false` and reduced motion is not preferred. Listen to `visibilitychange`, cancel the animation frame in cleanup and use a static 0-degree sweep for `prefers-reduced-motion`. Derive zones and minimum distance with `useMemo`.

- [ ] **Step 4: Render LiDAR charts, readable status and source-derived details.**

Place polar scan and zone bars in a responsive `grid grid-cols-1 lg:grid-cols-2`. Use Ant Design `Badge`/`Tag` with text “Vật cản phát hiện” or “Không phát hiện vật cản” alongside numerical min distance, point count and range. Include the LiDAR specification table and the three-layer avoidance algorithm with clear Priority 1/2/3 text.

- [ ] **Step 5: Build and lint the full web app.**

Run: `yarn --cwd apps/web lint && yarn --cwd apps/web build`

Expected: app compiles, static route generation succeeds, and no client/SSR error occurs from canvas or document APIs.

- [ ] **Step 6: Commit interactive lab page.**

```bash
git add apps/web/src/app/signal-lab
git commit -m "feat(web): add PID and LiDAR signal lab"
```

## Task 8: Browser Verification and Final Review

**Files:**
- Verify: `apps/web/src/app/specifications/page.tsx`
- Verify: `apps/web/src/app/encoder-pipeline/page.tsx`
- Verify: `apps/web/src/app/signal-lab/page.tsx`
- Verify: `apps/web/src/components/Sidebar.tsx`
- Verify: `apps/web/src/components/BottomTabBar.tsx`

- [ ] **Step 1: Start the web development server.**

Run: `yarn --cwd apps/web dev`

Expected: Next.js reports a local URL and serves the app without compilation errors.

- [ ] **Step 2: Verify desktop routes and navigation with Playwright.**

At a desktop viewport, navigate directly to `/specifications`, `/encoder-pipeline`, and `/signal-lab`; refresh each. Confirm the matching sidebar item has active styling, diagrams/canvases have non-zero pixels, tables scroll when constrained, and browser console contains no runtime/hydration errors.

- [ ] **Step 3: Verify technical interactions.**

On `/encoder-pipeline`, resize the viewport and hover the EMA chart to see a tooltip. On `/signal-lab`, change PID scene and each gain slider; confirm charts/stats change. Change each LiDAR scene; confirm scan geometry and zone stats change. Navigate away and back; confirm there is no duplicated animation or console error.

- [ ] **Step 4: Verify mobile navigation and responsive overflow.**

At 390×844, open the drawer and confirm all three technical links are visible and route correctly. Confirm the bottom bar exposes “Kỹ thuật”; confirm charts have readable labels or an accompanying table/summary and no horizontal page overflow except intentional diagram/table scrollers.

- [ ] **Step 5: Perform final project verification.**

Run: `yarn lint && yarn build`

Expected: both root commands finish successfully, or any pre-existing unrelated failure is recorded precisely before completion.

- [ ] **Step 6: Commit final polish if changes were made during verification.**

```bash
git status --short
git add apps/web
git commit -m "fix(web): polish technical report views"
```

Only create this commit if verification required tracked source changes.
