# Floating Control Dock Design

**Date:** 2026-08-16

## Goal

Replace the three horizontal robot-control cards on `/map` with one compact floating HUD overlay. The dock must preserve every existing robot command and teleoperation safety behavior while returning the full vertical map viewport to the operator.

## Scope

Create `apps/web/src/components/FloatingControlDock.tsx` and replace the existing Robot Control Panel section in `apps/web/src/app/map/page.tsx`.

The component owns only display state:

- `activeTab`: `'control' | 'action' | 'safety'`
- `isCollapsed`: boolean

The map page remains the sole owner of WebSocket connectivity, command serialization, confirmation modal, keyboard event handling, and teleoperation state.

## Persistence

Persist the widget preference in browser `localStorage`:

- `map-hud-tab`: selected tab
- `map-hud-collapsed`: collapsed state

Read both values only after mount to prevent a server/client rendering mismatch. Default to an expanded dock with the Control tab active when no valid saved value is present. Write each preference whenever it changes.

When the control mode changes to `AUTO`, force the dock open and select the Safety tab so the operator first sees the active safety telemetry. A later manual tab selection remains the persisted user preference.

`localStorage` is intentionally used instead of cookies because these non-sensitive, browser-local UI preferences do not need to accompany API, WebSocket, or static-resource requests.

## Layout And Visual System

The expanded dock is a map overlay positioned at `fixed bottom-4 right-4 z-50`, with `w-80 sm:w-96`, constrained height, and a scrollable content region for short viewports. It must not participate in document layout or change canvas dimensions.

Use the existing dark HUD token family, with a translucent `#0a0f1d` surface, `backdrop-blur-md`, cyan border and restrained cyan glow. Existing CSS variables and JetBrains Mono styling remain the primary visual language.

The header contains:

- Dock identity and compact link status.
- Always-visible red-neon `E-STOP` command button, which invokes the existing confirmation callback.
- An accessible icon-only minimize button with AntD tooltip.

The expanded body begins with a three-item segmented tab control. Each option is icon-led and exposes an accessible selected state.

The collapsed state is a small fixed capsule at the same screen corner. It displays online/offline indication, a control icon, and an accessible expand action. It provides no hidden control commands, preserving unobstructed map visibility while making recovery immediate.

Use CSS transitions for opacity, transform, and dimensions. Do not add a motion-library dependency.

## Tabs

### Control

Show the Manual/Auto segmented mode switch.

In Manual mode, show the existing pointer-hold D-pad commands for forward, left, stop, right, and reverse. The center stop remains red. Show the existing WASD, Q/E, and arrow-key hint.

In Auto mode, show the existing zone A-D controls, route control, and stop action. Their callbacks and enabled behavior remain unchanged.

### Action

Show cylinder buttons for extend (`NÂNG`), stop (`DỪNG`), and retract (`HẠ`). Preserve existing callbacks and colors: amber for motion actions and neutral/danger treatment for stop.

### Safety

Show the current ESP32 mode/E-stop status plus compact values for:

- TOF distance
- Cylinder state
- Obstacle state
- Robot WebSocket link state
- Current demo task, or control-mode reason when available

Use existing `esp32Status`, `demoStatus`, `controlModeStatus`, and WebSocket state passed from `MapPage`; no new protocol messages or telemetry fields are introduced.

## Interface Boundary

`FloatingControlDock` receives typed props for the display state and all command callbacks it needs. It must not access the map WebSocket, AntD app context, or robot refs itself.

Expected command props are:

- `onControlModeChange`
- `onStartManualMotion`
- `onStopManualMotion`
- `onEmergencyStop`
- `onZoneSelect`
- `onRouteStart`
- `onAutoStop`
- `onCylinderAction`

The parent continues to pass the exact current handler functions so pointer capture, repeated keyboard teleop cadence, command confirmation, and error notification behavior are unchanged.

## Accessibility And Safety

All icon-only controls must have `aria-label` and AntD `Tooltip`. D-pad actions retain existing labels and pointer-capture release handling. The E-stop remains visible in every expanded tab and retains its confirmation step.

Keyboard teleoperation remains in `MapPage`. It continues to operate when the dock is expanded on the Control tab, only when the robot is in Manual mode, and continues to stop motion on window blur, document hidden, pointer release, and component cleanup.

## Verification

1. Run `yarn lint` from `apps/web`.
2. Start the web development server with the repository's Yarn workflow.
3. Use the Playwright MCP server to verify `/map` at desktop and mobile viewport sizes:
   - The dock overlays the map instead of reserving a page section.
   - All three tabs render their intended content.
   - E-stop is visible after each tab switch.
   - Collapse and expansion work; collapse leaves only the compact capsule.
   - Tab and collapsed preferences survive a browser reload.
   - Switching to Auto opens the dock on Safety.
   - Pointer D-pad press/release and keyboard controls retain the existing Manual-mode behavior.
4. Capture a screenshot and inspect browser console errors through the MCP server.

No testing framework is added because the project does not currently include one and the change is a focused visual refactor.
