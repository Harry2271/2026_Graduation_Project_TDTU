# Responsive Web App Design

Date: 2026-06-05
Topic: Make the Next.js web app responsive for phones and tablets while keeping all current functionality intact.

## Goal

Adapt the existing NEXUS Control web app so it works well on:
- phones: 375–430px
- tablets: 768–1024px
- desktop: 1024px+

The scope is responsive behavior only. No functionality is removed. Existing routes, data flow, Redux/RTK Query behavior, and business logic stay unchanged.

## Constraints

- Keep all current features.
- Preserve the current desktop experience as much as possible.
- Do not add new dependencies.
- Follow the existing stack: Next.js 16, Tailwind v4, Ant Design v6, Redux Toolkit.
- Keep user-facing text in Vietnamese.
- Reuse existing components where practical instead of creating parallel mobile pages.

## Existing State

The app currently assumes a desktop-only shell:
- `src/components/MainLayout.tsx` uses a fixed full-screen horizontal layout.
- `src/components/Sidebar.tsx` is a fixed-width desktop sidebar.
- `src/app/globals.css` locks the body to `height: 100vh` and `overflow: hidden`.
- Major pages use wide layouts and large fixed paddings.
- Inventory includes a right-side package panel that does not fit on phones.
- Products relies on a wide Ant Design table.

## Recommended Approach

Use a breakpoint-driven responsive shell with layout swaps at the app-shell level and targeted responsive adjustments inside pages.

This avoids route duplication, keeps the current app architecture intact, and minimizes risk to business logic.

## Alternatives Considered

### 1. Breakpoint-driven shell swap with page-level responsive changes
Recommended.

Pros:
- Minimal architectural change.
- Preserves current routes and state.
- Lets desktop remain largely unchanged.
- Easy to verify incrementally.

Cons:
- Some page files need careful responsive cleanup.
- A few large pages will still be structurally complex.

### 2. CSS-only responsive rewrite
Not recommended.

Pros:
- Less React state.
- Simpler shell switching in theory.

Cons:
- Ant Design table behavior and responsive page state still need JS decisions.
- Harder to coordinate drawer, floating actions, and route-aware mobile navigation.

### 3. Separate mobile route tree
Not recommended.

Pros:
- Strong isolation between desktop and mobile layouts.

Cons:
- Duplicates route UI.
- Increases maintenance cost.
- Risks inconsistency between platforms.
- Unnecessary for this scope.

## Breakpoints

Use Tailwind defaults:
- mobile default: `<768px`
- tablet: `md` = `768px`
- desktop: `lg` = `1024px`

Behavior by range:
- `<768px`: phone layout
- `768px–1023px`: tablet layout
- `>=1024px`: desktop layout

## Architecture

### Responsive shell

`MainLayout.tsx` becomes the single shell decision point.

It will switch between:
- desktop shell: existing sidebar + main content
- tablet shell: top bar + left drawer navigation + content
- mobile shell: top bar + content + bottom tab bar + drawer navigation

### New UI pieces

Create small shell-specific components:
- `src/components/MobileTopBar.tsx`
- `src/components/BottomTabBar.tsx`
- `src/components/NavDrawer.tsx`
- `src/hooks/useBreakpoint.ts`

These components only manage layout/navigation presentation. They must not own business state.

### Responsive strategy

- Use Tailwind responsive utilities first.
- Use `useBreakpoint()` only where route-aware shell decisions or mobile-only interactive behavior are needed.
- Keep page logic in existing page files.
- Extract only when a responsive UI concern becomes too large to keep inline.

## Shell Design

### Desktop (`>=1024px`)

Keep the current layout behavior:
- fixed left sidebar
- full-height content area
- existing desktop navigation and styling

Desktop should look almost identical after the change.

### Tablet (`768px–1023px`)

Use:
- top bar with page title and menu button
- left drawer opened from menu button
- main content fills available space
- no bottom tab bar

The drawer reuses existing sidebar navigation content rather than duplicating menu logic.

### Mobile (`<768px`)

Use:
- top bar with hamburger, route title, and compact status indicator
- bottom tab bar with 4 primary routes:
  - Kho hàng
  - Quản lý kiện hàng
  - Bản đồ
  - Camera
- left drawer for full sidebar content including branding and system status
- content area scrollable between top and bottom navigation

The bottom tab bar is optimized for thumb navigation and only covers top-level routes.

## Navigation Rules

### Top bar

Responsibilities:
- show current page title from pathname
- open the drawer
- show a compact online status indicator

This replaces the desktop-only visual hierarchy on smaller screens.

### Drawer

Drawer behavior:
- open from the left
- close on backdrop tap
- close after route navigation
- reuse sidebar content and route highlighting

The drawer should feel like the mobile/tablet form of the current sidebar, not a new navigation system.

### Bottom tab bar

Only visible on phones.

Requirements:
- 4 items with icon + label
- active state clearly highlighted
- touch targets at least 44px
- safe-area bottom padding
- fixed at the bottom

The bottom tab bar must not be used for nested routes like product detail.

## Global CSS Changes

Update `src/app/globals.css` to support scrolling and safe mobile layout.

### Required changes

1. Replace body locking:
- from `height: 100vh; overflow: hidden;`
- to `min-height: 100dvh; overflow-x: hidden;`

2. Ensure shell containers use `min-h-dvh` or equivalent mobile-safe viewport sizing.

3. Keep horizontal overflow disabled globally.

4. Add safe-area helpers for bottom navigation.

5. Ensure Ant Design inputs use at least `16px` font size on small screens to prevent iOS zoom.

6. Preserve dark theme and current token usage.

## Page-Level Design

### Inventory page

Current issue:
- desktop-centric 2-column shell with large fixed panel widths and a large center visualization.

Responsive behavior:

#### Phone
- main content becomes vertically scrollable
- header stacks into multiple rows
- SRC/DST command bar wraps instead of forcing one row
- warehouse shelf grid becomes a stacked layout suitable for narrow screens
- center hub visual is hidden to preserve space
- package list sidebar becomes a floating action button that opens a bottom sheet or drawer-like panel
- bottom action bar remains reachable above the bottom tab bar

#### Tablet
- keep the warehouse visual emphasis
- package list becomes a right-side drawer or collapsible panel
- grid remains 2x2 where space allows

#### Desktop
- keep current layout

Important rule:
The inventory workflow stays the same: select source, select destination, review status, send command.

### Products page

Current issue:
- wide toolbar and wide table are not phone-friendly.

Responsive behavior:

#### Phone
- page header stacks vertically
- stats blocks wrap under the title
- add button becomes full-width or prominent in stacked header
- search input becomes full-width
- table uses horizontal scroll as a fallback, but should also hide lower-priority columns where practical
- action controls stay reachable without tiny tap targets

Priority on phone:
1. package name
2. status
3. location summary
4. actions

Lower-priority metadata like some wide columns can collapse first.

#### Tablet
- keep table layout with moderate horizontal flexibility
- header remains two-row if needed

#### Desktop
- keep current layout

### Product detail page

Responsive behavior:
- stack major cards vertically on phone
- action buttons become full-width stacked controls
- QR / AprilTag preview becomes full-width
- modal dialogs expand appropriately on smaller screens
- maintain all actions: edit, print, navigation, metadata display

### Map page

Responsive behavior:
- map canvas or viewer fills the available viewport area between top and bottom bars
- secondary controls collapse into overlays or grouped floating controls
- text-heavy status blocks compress before removing functionality
- preserve real-time map visibility as the main priority

### Camera page

Responsive behavior:
- camera feed fills available space cleanly
- controls and labels overlay or stack as needed
- preserve stream visibility as the primary content

## Component Responsibilities

### `useBreakpoint.ts`

Responsibilities:
- expose booleans such as `isMobile`, `isTablet`, `isDesktop`
- use `matchMedia`
- remain presentation-only

It must not contain route logic or page-specific behavior.

### `MobileTopBar.tsx`

Responsibilities:
- render route title
- render menu trigger
- render compact connection/status indicator

### `BottomTabBar.tsx`

Responsibilities:
- render mobile primary navigation
- highlight current route
- navigate between top-level sections

### `NavDrawer.tsx`

Responsibilities:
- host sidebar content in overlay form for mobile/tablet
- coordinate open/close state
- close on navigation

### `Sidebar.tsx`

Change needed:
- refactor so its content can render both as desktop sidebar and drawer content without duplicated navigation markup

The visual presentation may vary by container, but route definitions should stay centralized.

## Interaction and Accessibility

Requirements:
- all touch targets >= 44px
- no hover-only interactions on mobile
- focus states remain visible
- active navigation state remains obvious
- drawer can be dismissed easily
- modals remain usable on small screens
- no horizontal viewport overflow on phone layouts

## Error Handling

No business-logic error handling changes are required.

UI-specific expectations:
- drawers and mobile panels should fail gracefully if content is long by allowing vertical scroll
- loading overlays must still cover the intended area on smaller screens
- fixed bars must not hide critical controls

## Verification Plan

Manual verification is required in the browser because this is a UI/layout change.

At minimum verify:
- inventory page on phone, tablet, desktop
- products page on phone, tablet, desktop
- product detail page on phone and desktop
- map page on phone and desktop
- camera page on phone and desktop
- drawer open/close behavior
- bottom tab navigation on phone
- no horizontal scrolling on phone except intentional table overflow fallback
- modals and forms remain usable on phone

Target viewports:
- 375x812
- 430x932
- 768x1024
- 1024x768
- desktop wide

## Files Expected to Change

Likely modified:
- `apps/web/src/components/MainLayout.tsx`
- `apps/web/src/components/Sidebar.tsx`
- `apps/web/src/app/layout.tsx`
- `apps/web/src/app/globals.css`
- `apps/web/src/app/inventory/page.tsx`
- `apps/web/src/app/products/page.tsx`
- `apps/web/src/app/products/[id]/page.tsx`
- `apps/web/src/app/map/page.tsx`
- `apps/web/src/app/camera/page.tsx`

Likely new:
- `apps/web/src/hooks/useBreakpoint.ts`
- `apps/web/src/components/MobileTopBar.tsx`
- `apps/web/src/components/BottomTabBar.tsx`
- `apps/web/src/components/NavDrawer.tsx`

## Out of Scope

- redesigning product flows
- changing API contracts
- changing Redux state shape
- adding new routes
- adding tests
- changing the desktop visual identity beyond what responsive support requires

## Recommendation

Implement the responsive shell first, then update pages in this order:
1. global CSS and shell
2. sidebar/drawer/tab bar
3. inventory page
4. products page
5. product detail page
6. map page
7. camera page

This order reduces layout risk and keeps the most structurally complex screens near the front of the work.
