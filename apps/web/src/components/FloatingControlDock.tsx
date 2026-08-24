'use client'

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CircleStop,
  Gamepad2,
  GripHorizontal,
  MapPin,
  Minimize2,
  OctagonAlert,
  Route,
  ShieldAlert,
  Square,
  Wifi,
  Wrench,
} from 'lucide-react'
import { Tooltip } from 'antd'

export type DockTab = 'control' | 'action' | 'safety'
export type ControlMode = 'AUTO' | 'MANUAL'
export type CylinderAction = 'extend' | 'retract' | 'stop'
export type ManualMotionKey = 'w' | 'a' | 's' | 'd'

export interface Esp32StatusSnapshot {
  estop?: boolean
  mode?: string
  st?: {
    obs?: boolean
    tof_mm?: number
    cyl?: string
  }
}

export interface DemoStatus {
  state?: string
  action?: string
}

export interface ControlModeStatus {
  reason?: string
}

export interface FloatingControlDockProps {
  controlMode: ControlMode
  esp32Status: Esp32StatusSnapshot | null
  isOnline: boolean
  demoStatus: DemoStatus
  controlModeStatus: ControlModeStatus
  onEmergencyStop: () => void
  onControlModeChange: (mode: ControlMode) => void
  onStartManualMotion: (key: ManualMotionKey, event: ReactPointerEvent<HTMLButtonElement>) => void
  onStopManualMotion: (key?: ManualMotionKey) => void
  onZoneSelect: (zone: string) => void
  onRouteStart: () => void
  onAutoStop: () => void
  onCylinderAction: (action: CylinderAction) => void
  onKeyboardTeleopAvailabilityChange: (isAvailable: boolean) => void
}

const TABS: readonly { id: DockTab; label: string; icon: typeof Gamepad2 }[] = [
  { id: 'control', label: 'ĐIỀU KHIỂN', icon: Gamepad2 },
  { id: 'action', label: 'TÁC VỤ', icon: Wrench },
  { id: 'safety', label: 'AN TOÀN', icon: ShieldAlert },
]

const TAB_BASE_ID = 'map-hud-tab'
const PANEL_ID = 'map-hud-panel'
const TAB_STORAGE_KEY = 'map-hud-tab'
const COLLAPSED_STORAGE_KEY = 'map-hud-collapsed'
const PREFERENCE_CHANGE_EVENT = 'map-hud-preference-change'
const POSITION_STORAGE_KEY = 'map-hud-position'
const DOCK_VIEWPORT_MARGIN = 12

type DockPosition = { left: number; top: number }
type DragPointerEvent = ReactPointerEvent<HTMLElement>

function isDockTab(value: string | null): value is DockTab {
  return value === 'control' || value === 'action' || value === 'safety'
}

function createStoredPreference<T>(
  key: string,
  fallback: T,
  parse: (value: string | null) => T,
  serialize: (value: T) => string = String
) {
  let serverSnapshot = fallback
  let snapshot = fallback
  let snapshotRaw: string | null = null

  const getSnapshot = () => {
    const raw = window.localStorage.getItem(key)
    if (raw !== snapshotRaw) {
      snapshotRaw = raw
      snapshot = parse(raw)
    }
    return snapshot
  }
  const getServerSnapshot = () => serverSnapshot
  const subscribe = (listener: () => void) => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === key && event.storageArea === window.localStorage) listener()
    }
    const handlePreferenceChange = (event: Event) => {
      if ((event as CustomEvent<string>).detail === key) listener()
    }

    window.addEventListener('storage', handleStorage)
    window.addEventListener(PREFERENCE_CHANGE_EVENT, handlePreferenceChange)
    return () => {
      window.removeEventListener('storage', handleStorage)
      window.removeEventListener(PREFERENCE_CHANGE_EVENT, handlePreferenceChange)
    }
  }
  const set = (value: T) => {
    serverSnapshot = value
    snapshot = value
    snapshotRaw = null
    window.localStorage.setItem(key, serialize(value))
    window.dispatchEvent(new CustomEvent<string>(PREFERENCE_CHANGE_EVENT, { detail: key }))
  }

  return { getSnapshot, getServerSnapshot, set, subscribe }
}

const activeTabPreference = createStoredPreference<DockTab>(TAB_STORAGE_KEY, 'control', (value) =>
  isDockTab(value) ? value : 'control'
)
const collapsedPreference = createStoredPreference<boolean>(
  COLLAPSED_STORAGE_KEY,
  false,
  (value) => value === 'true'
)
const positionPreference = createStoredPreference<DockPosition | null>(
  POSITION_STORAGE_KEY,
  null,
  (value) => {
    if (!value) return null
    try {
      const parsed: unknown = JSON.parse(value)
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as { left?: unknown }).left === 'number' &&
        typeof (parsed as { top?: unknown }).top === 'number'
      ) {
        return { left: (parsed as { left: number }).left, top: (parsed as { top: number }).top }
      }
    } catch {
      // Ignore malformed persisted positions.
    }
    return null
  },
  (value) => JSON.stringify(value)
)

function clampDockPosition(
  position: DockPosition,
  size: { width: number; height: number }
): DockPosition {
  const maxLeft = Math.max(
    DOCK_VIEWPORT_MARGIN,
    window.innerWidth - size.width - DOCK_VIEWPORT_MARGIN
  )
  const maxTop = Math.max(
    DOCK_VIEWPORT_MARGIN,
    window.innerHeight - size.height - DOCK_VIEWPORT_MARGIN
  )
  return {
    left: Math.min(Math.max(position.left, DOCK_VIEWPORT_MARGIN), maxLeft),
    top: Math.min(Math.max(position.top, DOCK_VIEWPORT_MARGIN), maxTop),
  }
}

const MOTION_BUTTONS: readonly {
  key: ManualMotionKey
  label: string
  icon: typeof ArrowUp
  className: string
}[] = [
  { key: 'w', label: 'Tiến', icon: ArrowUp, className: 'col-start-2 row-start-1' },
  { key: 'a', label: 'Trái', icon: ArrowLeft, className: 'col-start-1 row-start-2' },
  { key: 's', label: 'Lùi', icon: ArrowDown, className: 'col-start-2 row-start-3' },
  { key: 'd', label: 'Phải', icon: ArrowRight, className: 'col-start-3 row-start-2' },
]

function ManualControlBody({
  onStartManualMotion,
  onStopManualMotion,
}: Pick<FloatingControlDockProps, 'onStartManualMotion' | 'onStopManualMotion'>) {
  const handlePointerDown = (key: ManualMotionKey, event: ReactPointerEvent<HTMLButtonElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    onStartManualMotion(key, event)
  }

  const handlePointerStop = (key: ManualMotionKey) => {
    onStopManualMotion(key)
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 grid-rows-3 gap-1.5" aria-label="Bàn điều khiển hướng">
        {MOTION_BUTTONS.map(({ key, label, icon: Icon, className }) => (
          <Tooltip key={key} title={`${label}, giữ để chạy`}>
            <button
              type="button"
              aria-label={`${label} (${key.toUpperCase()})`}
              className={`flex min-h-12 items-center justify-center rounded-lg border border-cyan-400/30 bg-slate-900/80 text-cyan-300 transition hover:border-cyan-300 hover:bg-cyan-400/15 active:bg-cyan-400/25 ${className}`}
              onPointerDown={(event) => handlePointerDown(key, event)}
              onPointerUp={() => handlePointerStop(key)}
              onPointerCancel={() => handlePointerStop(key)}
              onLostPointerCapture={() => handlePointerStop(key)}
            >
              <Icon size={20} aria-hidden="true" />
            </button>
          </Tooltip>
        ))}
        <Tooltip title="Dừng di chuyển">
          <button
            type="button"
            aria-label="Dừng di chuyển"
            className="col-start-2 row-start-2 flex min-h-12 items-center justify-center rounded-lg border border-red-400/60 bg-red-500/15 text-red-300 transition hover:bg-red-500/25"
            onClick={() => onStopManualMotion()}
          >
            <CircleStop size={20} aria-hidden="true" />
          </button>
        </Tooltip>
      </div>
      <p className="text-center font-mono text-[10px] tracking-wide text-slate-400">
        WASD / Q E / phím mũi tên
      </p>
    </div>
  )
}

function AutoControlBody({
  onZoneSelect,
  onRouteStart,
  onAutoStop,
}: Pick<FloatingControlDockProps, 'onZoneSelect' | 'onRouteStart' | 'onAutoStop'>) {
  return (
    <div className="space-y-3">
      <div>
        <p className="mb-2 font-mono text-[10px] font-bold tracking-widest text-slate-400">
          CHỌN KHU VỰC
        </p>
        <div className="grid grid-cols-4 gap-1.5">
          {['A', 'B', 'C', 'D'].map((zone) => (
            <button
              key={zone}
              type="button"
              className="flex min-h-10 items-center justify-center gap-1 rounded-lg border border-cyan-400/30 bg-slate-900/80 font-mono text-xs font-bold text-cyan-300 transition hover:border-cyan-300 hover:bg-cyan-400/15"
              onClick={() => onZoneSelect(zone)}
            >
              <MapPin size={14} aria-hidden="true" />
              {zone}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <button
          type="button"
          className="flex min-h-10 items-center justify-center gap-1.5 rounded-lg border border-cyan-400/30 bg-cyan-400/10 font-mono text-[10px] font-bold text-cyan-300 transition hover:bg-cyan-400/20"
          onClick={onRouteStart}
        >
          <Route size={15} aria-hidden="true" />
          CHẠY TUYẾN
        </button>
        <button
          type="button"
          className="flex min-h-10 items-center justify-center gap-1.5 rounded-lg border border-red-400/50 bg-red-500/10 font-mono text-[10px] font-bold text-red-300 transition hover:bg-red-500/20"
          onClick={onAutoStop}
        >
          <Square size={14} aria-hidden="true" />
          DỪNG AUTO
        </button>
      </div>
    </div>
  )
}

function SafetyBody({
  esp32Status,
  isOnline,
  demoStatus,
  controlModeStatus,
}: Pick<
  FloatingControlDockProps,
  'esp32Status' | 'isOnline' | 'demoStatus' | 'controlModeStatus'
>) {
  const estopActive = esp32Status?.estop ?? false
  const mode = esp32Status?.mode?.toUpperCase() ?? '--'
  const tofMm = esp32Status?.st?.tof_mm ?? null
  const cyl = esp32Status?.st?.cyl ?? '--'
  const obs = esp32Status?.st?.obs ?? null
  const taskActive = demoStatus.state && demoStatus.state !== 'idle'
  const reason = controlModeStatus.reason ?? null

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-1.5">
        <div className="rounded-lg border border-slate-700/60 bg-black/30 px-2 py-2">
          <p className="mb-1 font-mono text-[9px] tracking-widest text-slate-500">ESP32</p>
          <p
            className="font-mono text-[11px] font-bold"
            style={{ color: estopActive ? 'var(--danger)' : 'var(--success)' }}
          >
            {estopActive ? 'E-STOP' : mode}
          </p>
        </div>
        <div className="rounded-lg border border-slate-700/60 bg-black/30 px-2 py-2">
          <p className="mb-1 font-mono text-[9px] tracking-widest text-slate-500">TOF</p>
          <p className="font-mono text-[11px] font-bold" style={{ color: 'var(--text-primary)' }}>
            {tofMm !== null ? `${tofMm} mm` : '--'}
          </p>
        </div>
        <div className="rounded-lg border border-slate-700/60 bg-black/30 px-2 py-2">
          <p className="mb-1 font-mono text-[9px] tracking-widest text-slate-500">XYLANH</p>
          <p className="font-mono text-[11px] font-bold" style={{ color: 'var(--text-primary)' }}>
            {cyl}
          </p>
        </div>
        <div className="rounded-lg border border-slate-700/60 bg-black/30 px-2 py-2">
          <p className="mb-1 font-mono text-[9px] tracking-widest text-slate-500">VẬT CẢN</p>
          <p
            className="font-mono text-[11px] font-bold"
            style={{
              color:
                obs === true
                  ? 'var(--warning)'
                  : obs === false
                    ? 'var(--success)'
                    : 'var(--text-primary)',
            }}
          >
            {obs === null ? '--' : obs ? 'CÓ' : 'KHÔNG'}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-1.5 rounded-lg border border-slate-700/60 bg-black/30 px-2 py-1.5">
        <Wifi
          size={12}
          style={{ color: isOnline ? 'var(--success)' : 'var(--danger)' }}
          aria-hidden="true"
        />
        <span className="font-mono text-[10px] text-slate-400">
          TÍN HIỆU: {isOnline ? 'đã kết nối' : 'đang kết nối lại'}
        </span>
      </div>
      {taskActive || reason ? (
        <p
          className="rounded-lg border border-slate-700/60 bg-black/30 px-2 py-1.5 font-mono text-[10px]"
          style={{ color: 'var(--text-muted)' }}
        >
          {taskActive
            ? `TÁC VỤ: ${demoStatus.action?.toUpperCase() ?? demoStatus.state?.toUpperCase()}`
            : `LÝ DO: ${reason}`}
        </p>
      ) : null}
    </div>
  )
}

function ActionBody({ onCylinderAction }: Pick<FloatingControlDockProps, 'onCylinderAction'>) {
  return (
    <div className="grid grid-cols-3 gap-1.5">
      <button
        type="button"
        className="flex min-h-14 flex-col items-center justify-center gap-1 rounded-lg border border-amber-400/50 bg-amber-400/10 font-mono text-[10px] font-bold text-amber-300 transition hover:bg-amber-400/20"
        onClick={() => onCylinderAction('extend')}
      >
        <ArrowUp size={18} aria-hidden="true" />
        NÂNG
      </button>
      <button
        type="button"
        className="flex min-h-14 flex-col items-center justify-center gap-1 rounded-lg border border-red-400/50 bg-red-500/10 font-mono text-[10px] font-bold text-red-300 transition hover:bg-red-500/20"
        onClick={() => onCylinderAction('stop')}
      >
        <Square size={16} aria-hidden="true" />
        DỪNG
      </button>
      <button
        type="button"
        className="flex min-h-14 flex-col items-center justify-center gap-1 rounded-lg border border-cyan-400/50 bg-cyan-400/10 font-mono text-[10px] font-bold text-cyan-300 transition hover:bg-cyan-400/20"
        onClick={() => onCylinderAction('retract')}
      >
        <ArrowDown size={18} aria-hidden="true" />
        HẠ
      </button>
    </div>
  )
}

export function FloatingControlDock({
  controlMode,
  esp32Status,
  isOnline,
  demoStatus,
  controlModeStatus,
  onEmergencyStop,
  onControlModeChange,
  onStartManualMotion,
  onStopManualMotion,
  onZoneSelect,
  onRouteStart,
  onAutoStop,
  onCylinderAction,
  onKeyboardTeleopAvailabilityChange,
}: FloatingControlDockProps) {
  const savedActiveTab = useSyncExternalStore(
    activeTabPreference.subscribe,
    activeTabPreference.getSnapshot,
    activeTabPreference.getServerSnapshot
  )
  const savedCollapsed = useSyncExternalStore(
    collapsedPreference.subscribe,
    collapsedPreference.getSnapshot,
    collapsedPreference.getServerSnapshot
  )
  const savedPosition = useSyncExternalStore(
    positionPreference.subscribe,
    positionPreference.getSnapshot,
    positionPreference.getServerSnapshot
  )
  const activeTab = savedActiveTab
  const isCollapsed = savedCollapsed
  const dockRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{
    pointerId: number
    offsetX: number
    offsetY: number
    startX: number
    startY: number
  } | null>(null)
  const didDragRef = useRef(false)
  const [isDragging, setIsDragging] = useState(false)

  const dockPositionStyle: CSSProperties = savedPosition
    ? { left: savedPosition.left, top: savedPosition.top, right: 'auto', bottom: 'auto' }
    : { right: 16, bottom: 16 }

  const handleDragStart = useCallback(
    (event: DragPointerEvent) => {
      if (event.button !== 0) return
      const target = event.target as HTMLElement
      if (target.closest('button') && !isCollapsed) return
      const dock = dockRef.current
      if (!dock) return
      const rect = dock.getBoundingClientRect()
      didDragRef.current = false
      dragRef.current = {
        pointerId: event.pointerId,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        startX: event.clientX,
        startY: event.clientY,
      }
      setIsDragging(true)
      event.currentTarget.setPointerCapture(event.pointerId)
      event.preventDefault()
    },
    [isCollapsed]
  )

  const handleDragMove = useCallback((event: DragPointerEvent) => {
    const drag = dragRef.current
    const dock = dockRef.current
    if (!drag || drag.pointerId !== event.pointerId || !dock) return
    const next = clampDockPosition(
      { left: event.clientX - drag.offsetX, top: event.clientY - drag.offsetY },
      { width: dock.offsetWidth, height: dock.offsetHeight }
    )
    if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 3) {
      didDragRef.current = true
    }
    positionPreference.set(next)
  }, [])

  const handleDragEnd = useCallback((event: DragPointerEvent) => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    dragRef.current = null
    setIsDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [])

  useEffect(() => {
    const handleResize = () => {
      const dock = dockRef.current
      if (!dock || !savedPosition) return
      const next = clampDockPosition(savedPosition, {
        width: dock.offsetWidth,
        height: dock.offsetHeight,
      })
      if (next.left !== savedPosition.left || next.top !== savedPosition.top)
        positionPreference.set(next)
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [savedPosition])

  useEffect(() => {
    onKeyboardTeleopAvailabilityChange(!isCollapsed && activeTab === 'control')
  }, [activeTab, isCollapsed, onKeyboardTeleopAvailabilityChange])

  useEffect(() => {
    if (controlMode !== 'AUTO') return
    const frame = window.requestAnimationFrame(() => {
      activeTabPreference.set('safety')
      collapsedPreference.set(false)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [controlMode])

  const handleControlModeChange = (mode: ControlMode) => {
    if (mode === 'AUTO') {
      activeTabPreference.set('safety')
      collapsedPreference.set(false)
    }
    onControlModeChange(mode)
  }

  if (isCollapsed) {
    return (
      <div
        ref={dockRef}
        className="fixed z-50 touch-none select-none"
        style={{
          ...dockPositionStyle,
          opacity: isDragging ? 0.9 : 1,
        }}
      >
        <button
          type="button"
          className="group relative flex cursor-grab items-center gap-3 rounded-full border px-4 py-2.5 transition-all duration-300 hover:scale-105 active:scale-95 active:cursor-grabbing touch-none"
          style={{
            background:
              'linear-gradient(135deg, rgba(15, 23, 42, 0.95) 0%, rgba(23, 32, 51, 0.98) 100%)',
            backdropFilter: 'blur(16px)',
            borderColor: 'rgba(0, 212, 255, 0.55)',
            boxShadow:
              '0 8px 32px -4px rgba(0, 212, 255, 0.35), 0 0 12px rgba(0, 212, 255, 0.25), inset 0 1px 1px rgba(255, 255, 255, 0.25), inset 0 0 10px rgba(0, 212, 255, 0.15)',
          }}
          aria-label="Mở bảng điều khiển"
          onPointerDown={handleDragStart}
          onPointerMove={handleDragMove}
          onPointerUp={handleDragEnd}
          onPointerCancel={handleDragEnd}
          onLostPointerCapture={handleDragEnd}
          onClick={(event) => {
            if (didDragRef.current) {
              event.preventDefault()
              event.stopPropagation()
              didDragRef.current = false
              return
            }
            collapsedPreference.set(false)
          }}
        >
          {/* Radar Pulse + Status Dot */}
          <span className="relative flex h-2.5 w-2.5 items-center justify-center">
            <span
              className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-75"
              style={{
                background: isOnline ? 'var(--success)' : 'var(--danger)',
              }}
            />
            <span
              className="relative inline-block h-2.5 w-2.5 rounded-full"
              style={{
                background: isOnline ? 'var(--success)' : 'var(--danger)',
                boxShadow: `0 0 10px ${isOnline ? 'var(--success)' : 'var(--danger)'}`,
              }}
            />
          </span>

          {/* Drag Icon */}
          <GripHorizontal
            size={18}
            className="transition-transform duration-200 group-hover:scale-110"
            style={{
              color: 'rgba(0, 212, 255, 1)',
              filter: 'drop-shadow(0 0 4px rgba(0, 212, 255, 0.6))',
            }}
          />

          {/* Label HUD */}
          <span
            className="font-mono text-xs font-extrabold tracking-widest uppercase"
            style={{
              color: '#ffffff',
              textShadow: '0 0 8px rgba(0, 212, 255, 0.8), 0 0 2px #ffffff',
            }}
          >
            HUD
          </span>
        </button>
      </div>
    )
  }

  return (
    <div
      ref={dockRef}
      className="fixed z-50 flex max-h-[calc(100vh-2rem)] w-[min(calc(100vw-2rem),24rem)] flex-col overflow-hidden rounded-xl border touch-none"
      style={{
        background: 'rgba(10,15,29,0.94)',
        backdropFilter: 'blur(16px)',
        borderColor: 'var(--accent-border)',
        boxShadow: '0 0 40px rgba(0,212,255,0.10), 0 8px 32px rgba(0,0,0,0.6)',
        ...dockPositionStyle,
        opacity: isDragging ? 0.85 : 1,
      }}
      onPointerDown={handleDragStart}
      onPointerMove={handleDragMove}
      onPointerUp={handleDragEnd}
      onPointerCancel={handleDragEnd}
      onLostPointerCapture={handleDragEnd}
    >
      <div
        className="flex cursor-grab items-center justify-between border-b px-3 py-2 active:cursor-grabbing touch-none select-none"
        style={{ borderColor: 'var(--accent-border)', background: 'rgba(0,212,255,0.04)' }}
      >
        <div className="flex items-center gap-2">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{
              background: isOnline ? 'var(--success)' : 'var(--danger)',
              boxShadow: isOnline ? '0 0 6px var(--success)' : undefined,
            }}
          />
          <span
            className="font-mono text-[10px] font-bold tracking-widest"
            style={{ color: 'var(--text-primary)' }}
          >
            CONTROL
          </span>
          <span className="text-[8px]" style={{ color: 'var(--text-muted)' }}>
            {isOnline ? '● LIVE' : '○ OFF'}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Tooltip title="Dừng khẩn cấp">
            <button
              type="button"
              onClick={onEmergencyStop}
              className="flex cursor-pointer items-center gap-1 rounded-lg border px-2.5 py-1.5 font-mono text-[10px] font-bold transition-all"
              style={{
                background: 'rgba(255,59,92,0.15)',
                borderColor: 'var(--danger)',
                color: 'var(--danger)',
                boxShadow: '0 0 12px rgba(255,59,92,0.3)',
              }}
              aria-label="Dừng khẩn cấp"
            >
              <OctagonAlert size={13} />
              E-STOP
            </button>
          </Tooltip>
          <Tooltip title="Thu gọn">
            <button
              type="button"
              onClick={() => collapsedPreference.set(true)}
              className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg border transition-all"
              style={{
                background: 'var(--bg-raised)',
                borderColor: 'var(--border-mid)',
                color: 'var(--text-muted)',
              }}
              aria-label="Thu gọn bảng điều khiển"
            >
              <Minimize2 size={13} />
            </button>
          </Tooltip>
        </div>
      </div>

      <div
        className="mx-2 mt-2 flex rounded-lg border p-0.5"
        style={{ background: 'rgba(0,0,0,0.3)', borderColor: 'var(--border-dim)' }}
        role="tablist"
        aria-label="Các mục điều khiển"
      >
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`${TAB_BASE_ID}-${id}`}
            aria-selected={activeTab === id}
            aria-controls={PANEL_ID}
            onClick={() => activeTabPreference.set(id)}
            className="flex min-h-8 flex-1 cursor-pointer items-center justify-center gap-1 rounded-md px-1 py-1.5 font-mono text-[10px] font-bold transition-all"
            style={
              activeTab === id
                ? {
                    background: 'rgba(0,212,255,0.12)',
                    color: 'var(--accent)',
                    boxShadow: 'inset 0 0 0 1px var(--accent-border)',
                  }
                : { color: 'var(--text-muted)' }
            }
          >
            <Icon size={13} aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id={PANEL_ID}
        aria-labelledby={`${TAB_BASE_ID}-${activeTab}`}
        className="min-h-16 flex-1 overflow-y-auto p-3"
        aria-live="polite"
      >
        {activeTab === 'control' && (
          <div className="space-y-3">
            <div
              className="grid grid-cols-2 gap-1 rounded-lg border border-slate-700/80 bg-black/30 p-1"
              role="radiogroup"
              aria-label="Chế độ điều khiển"
            >
              {(['MANUAL', 'AUTO'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={controlMode === mode}
                  className={`min-h-8 rounded-md font-mono text-[10px] font-bold transition ${controlMode === mode ? 'bg-cyan-400/15 text-cyan-300 shadow-[inset_0_0_0_1px_var(--accent-border)]' : 'text-slate-500 hover:text-slate-300'}`}
                  onClick={() => handleControlModeChange(mode)}
                >
                  {mode === 'MANUAL' ? 'THỦ CÔNG' : 'TỰ ĐỘNG'}
                </button>
              ))}
            </div>
            {controlMode === 'MANUAL' ? (
              <ManualControlBody
                onStartManualMotion={onStartManualMotion}
                onStopManualMotion={onStopManualMotion}
              />
            ) : (
              <AutoControlBody
                onZoneSelect={onZoneSelect}
                onRouteStart={onRouteStart}
                onAutoStop={onAutoStop}
              />
            )}
          </div>
        )}
        {activeTab === 'action' && <ActionBody onCylinderAction={onCylinderAction} />}
        {activeTab === 'safety' && (
          <SafetyBody
            esp32Status={esp32Status}
            isOnline={isOnline}
            demoStatus={demoStatus}
            controlModeStatus={controlModeStatus}
          />
        )}
      </div>
    </div>
  )
}
