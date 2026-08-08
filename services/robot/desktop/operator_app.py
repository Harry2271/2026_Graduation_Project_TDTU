#!/usr/bin/env python3
"""Robot operator — desktop fallback app for the AIoT logistics robot.

This is a single-file Python application that mirrors the operator-facing
features of the Next.js web UI in a native tkinter window. It connects to the
robot's WebSocket bridge (the same ``ws://<ip>:9091`` endpoint the browser uses)
and supports:

* Live SLAM map + LiDAR scan + pose overlay
* Auto / Manual mode toggle (same arbitration as the web UI)
* Keyboard teleop (WASD / arrow keys) — only enabled in MANUAL mode
* Cylinder extend / retract / stop (Space / R / S)
* Four-zone demo: A, B, C, D, FULL DEMO, STOP — only enabled in AUTO mode
* Start / Stop / Idle / Reset mapping controls
* ESP32 telemetry panel (mode, e-stop, bus voltage, motors, IR)
* Demo status stream
* Connection health + reconnect with exponential backoff
* Continuously coalesced keyboard teleop (latest-wins) so the desktop app
  can never starve the bridge, regardless of input rate

The app has no direct serial access and no ROS dependency on the host
machine. Every command goes through the WebSocket bridge exactly as the
browser UI does.

Install
-------
    pip install -r services/robot/desktop/requirements.txt

Run
---
    python services/robot/desktop/operator_app.py
    python services/robot/desktop/operator_app.py --url ws://192.168.1.42:9091
    python services/robot/desktop/operator_app.py --url wss://map.nguyen-robot.io.vn

Defaults to ``ws://127.0.0.1:9091`` if ``--url`` is omitted, which works when
the desktop app is run on the robot itself.

Keyboard layout
---------------
    W / Up        forward
    S / Down      backward
    A / Left      strafe left
    D / Right     strafe right
    Q             rotate CCW
    E             rotate CW
    Space         cylinder extend
    R             cylinder retract
    X             cylinder stop
    M             toggle Manual / Auto
    Esc           STOP (firmware brake)

The full key state is sent at ~20 Hz; the latest frame always wins.
"""

from __future__ import annotations

import argparse
import gzip
import json
import math
import queue
import sys
import threading
import time
import tkinter as tk
from tkinter import ttk
from typing import Any

try:
    import websockets
    import websockets.sync.client  # noqa: F401  (select sync API)
except ImportError:
    sys.stderr.write(
        'Missing dependency: websockets\n'
        'Install with: pip install services/robot/desktop/requirements.txt\n'
    )
    sys.exit(2)


# ── UDP Discovery Listener ────────────────────────────────────────────────────
import socket as _socket
import json as _json


class UDPDiscovery:
    """Broadcasts a find_pi ping on the LAN and listens for replies.

    Replies populate ``self.found_devices`` — a list of dicts each with at
    least ``ws_url`` and ``hostname``.  The callback ``on_found`` is invoked
    on the **main thread** (via the provided tkinter root ``after()``) every
    time a new device is discovered.
    """

    def __init__(self, root: tk.Tk, on_found) -> None:
        self.root = root
        self.on_found = on_found            # callable(device_dict)
        self.found_devices: list[dict] = []
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True,
                                        name='udp-discovery')

    def scan(self) -> None:
        """Send a broadcast ping and begin listening (idempotent)."""
        if not self._thread.is_alive():
            self._stop.clear()
            self._thread = threading.Thread(target=self._run, daemon=True,
                                            name='udp-discovery')
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    # ── background thread ───────────────────────────────────────────
    def _run(self) -> None:
        sock = _socket.socket(_socket.AF_INET, _socket.SOCK_DGRAM,
                              _socket.IPPROTO_UDP)
        sock.setsockopt(_socket.SOL_SOCKET, _socket.SO_REUSEADDR, 1)
        try:
            sock.setsockopt(_socket.SOL_SOCKET, _socket.SO_BROADCAST, 1)
        except Exception:
            pass
        sock.settimeout(UDP_SCAN_TIMEOUT)
        # Broadcast the find_pi ping
        ping = _json.dumps({'type': 'find_pi', 'from': 'operator_app'}).encode()
        try:
            sock.sendto(ping, ('255.255.255.255', UDP_DISCOVERY_PORT))
        except Exception:
            pass
        # Listen for replies
        deadline = time.time() + UDP_SCAN_TIMEOUT
        while not self._stop.is_set() and time.time() < deadline:
            try:
                data, addr = sock.recvfrom(1024)
                msg = _json.loads(data.decode('utf-8', errors='ignore'))
                if msg.get('type') != 'pi_info':
                    continue
                ws_url = msg.get('ws_url') or f'ws://{addr[0]}:{msg.get("ws_port", 9091)}'
                device = {
                    'ws_url': ws_url,
                    'ip': msg.get('ip', addr[0]),
                    'hostname': msg.get('hostname', 'unknown'),
                    'mode': msg.get('mode', ''),
                }
                with self._lock:
                    if not any(d['ip'] == device['ip'] for d in self.found_devices):
                        self.found_devices.append(device)
                self.root.after(0, self.on_found, device)
            except _socket.timeout:
                break
            except Exception:
                break
        sock.close()


# ── Constants ────────────────────────────────────────────────────────────────

TELEOP_HZ = 20.0           # how often we send a keyframe to the bridge
TELEOP_INTERVAL = 1.0 / TELEOP_HZ
TELEOP_MAX_VX = 120         # PWM units (matches web UI)
TELEOP_MAX_VY = 120
TELEOP_MAX_OMEGA = 120
RECONNECT_BACKOFF = (1.0, 2.0, 4.0, 8.0, 16.0)
PING_INTERVAL = 5.0
STALE_DATA_AFTER = 3.0      # seconds without pose / scan → dim the canvas

DEFAULT_URL = 'ws://127.0.0.1:9091'
UDP_DISCOVERY_PORT = 9090
UDP_SCAN_TIMEOUT = 3.0       # seconds to wait for UDP replies

MAP_VIEW_RANGE = 4.0        # metres visible around the robot (mini-map)
MINI_SIZE = 320

# ── Persistent data paths (same directory as the script) ────
import os as _os
_DESKTOP_DIR = _os.path.dirname(_os.path.abspath(__file__))
_GEOFENCE_PATH = _os.path.join(_DESKTOP_DIR, 'geofence.json')
_MAP_PATH = _os.path.join(_DESKTOP_DIR, 'custom_map.json')
_WAYPOINTS_PATH = _os.path.join(_DESKTOP_DIR, 'waypoints.json')
_SEQUENCE_PATH = _os.path.join(_DESKTOP_DIR, 'sequence.json')
_TRIP_LOG_PATH = _os.path.join(_DESKTOP_DIR, 'trip_log.json')
_HOME_PATH = _os.path.join(_DESKTOP_DIR, 'home_pose.json')
_WAREHOUSE_STATE_PATH = _os.path.join(_DESKTOP_DIR, 'warehouse_state.json')

# ── Geofence ──────────────────────────────────────────────
# Area the robot is allowed to operate in. Configured via geofence.json
# next to the executable, or edited from the Tools menu. The polygon is in
# the map frame (origin at SLAM's first pose). Behaviour:
#   * inside polygon                     → "OK"
#   * inside polygon, near edge (< soft) → "WARN: sắp ra khỏi vùng"
#   * outside polygon, near edge (< hard)→ "BLOCK: lệnh bị từ chối"
#   * outside polygon (>= hard)          → "BREACH: gửi E-STOP"
# This is a *client-side* safety net. The ESP32 still owns the
# hardware-level stop via IR / TOF, so the worst case is the operator
# cannot drive out of bounds even if the Wi-Fi is fine.
GEOFENCE_DEFAULT = {
    'enabled': True,
    'polygon': [[-2.5, -2.0], [2.5, -2.0], [2.5, 2.0], [-2.5, 2.0]],
    'soft_margin_m': 0.30,
    'hard_margin_m': 0.10,
    'description': 'Vùng demo nhà kho (5m x 4m)',
}


# ── Tiny helpers ─────────────────────────────────────────────────────────────

def clamp(v: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, v))


def safe_get(d: dict, *keys: str, default: Any = None) -> Any:
    cur: Any = d
    for k in keys:
        if not isinstance(cur, dict) or k not in cur:
            return default
        cur = cur[k]
    return cur


# ── Geofence geometry primitives ─────────────────────────────────────────────

def point_in_polygon(px: float, py: float, poly: list[list[float]]) -> bool:
    """Ray-cast point-in-polygon. ``poly`` is a list of [x, y] vertices."""
    if not poly or len(poly) < 3:
        return False
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i][0], poly[i][1]
        xj, yj = poly[j][0], poly[j][1]
        if ((yi > py) != (yj > py)) and \
           (px < (xj - xi) * (py - yi) / (yj - yi + 1e-12) + xi):
            inside = not inside
        j = i
    return inside


def distance_to_polygon_edge(px: float, py: float,
                             poly: list[list[float]]) -> float:
    """Signed distance: positive inside, negative outside. ``+∞`` if ``poly``
    is empty. Returns 0 if the polygon is degenerate."""
    if not poly or len(poly) < 3:
        return float('inf')
    inside = point_in_polygon(px, py, poly)
    # Closest distance to any edge
    best = float('inf')
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i][0], poly[i][1]
        x2, y2 = poly[(i + 1) % n][0], poly[(i + 1) % n][1]
        dx, dy = x2 - x1, y2 - y1
        # Project p onto the segment (clamped to [0, 1])
        denom = dx * dx + dy * dy
        if denom < 1e-12:
            continue
        t = max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / denom))
        cx, cy = x1 + t * dx, y1 + t * dy
        d = math.hypot(px - cx, py - cy)
        if d < best:
            best = d
    return best if inside else -best


def geofence_load(path: str) -> dict:
    """Load geofence config from JSON. Falls back to defaults on any error."""
    base = GEOFENCE_DEFAULT.copy()
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        for k in ('enabled', 'polygon', 'soft_margin_m',
                  'hard_margin_m', 'description'):
            if k in data:
                base[k] = data[k]
    except FileNotFoundError:
        pass
    except Exception:
        pass
    return base


def geofence_save(path: str, cfg: dict) -> None:
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)


# ── Generic JSON helpers for the new data files ──────────────

def _load_json(path: str, default: Any) -> Any:
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        return default
    except Exception:
        return default


def _save_json(path: str, data: Any) -> None:
    try:
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
    except Exception as exc:
        sys.stderr.write(f'save {path} failed: {exc}\n')


def _load_lines(path: str) -> list[list[float]]:
    raw = _load_json(path, [])
    # Migrate old [x1,y1,x2,y2] format → new [x1,y1,x2,y2,w]
    # Width is kept only for backward compatibility — UI no longer exposes it.
    migrated = []
    for line in raw:
        if len(line) == 4:
            migrated.append([line[0], line[1], line[2], line[3], 0.10])
        elif len(line) >= 5:
            migrated.append(line[:5])
    return migrated


def _line_endpoints_key(x: float, y: float, grid: float = 0.02) -> tuple[int, int]:
    """Bucket-coords for endpoint matching; 0.02 m ≈ 2 cm tolerance."""
    return (int(round(x / grid)), int(round(y / grid)))


def _load_waypoints(path: str) -> list[dict]:
    return _load_json(path, [])


def _load_sequence(path: str) -> list[dict]:
    return _load_json(path, [])


def _load_trip_log(path: str) -> list[dict]:
    return _load_json(path, [])


def _load_warehouse_state(path: str) -> dict:
    """Persistent state for the 'TỰ KHẢO SÁT' survey loop.

    Format:
        {
          "done_ids": [wp_id, ...],   # waypoint ids that have been unloaded
          "last_run_ts": 0.0,          # epoch seconds of the last completed survey
          "total_unloads": 0           # lifetime counter (across runs)
        }
    """
    data = _load_json(path, {})
    if not isinstance(data, dict):
        return {'done_ids': [], 'last_run_ts': 0.0, 'total_unloads': 0}
    out = {
        'done_ids': [int(x) for x in data.get('done_ids', []) if isinstance(x, (int, float))],
        'last_run_ts': float(data.get('last_run_ts', 0.0)),
        'total_unloads': int(data.get('total_unloads', 0)),
    }
    return out


def _save_warehouse_state(path: str, data: dict) -> None:
    _save_json(path, data)


def geofence_predict(vx: int, vy: int, _omega: int,
                     dt: float, theta: float) -> tuple[float, float]:
    """Predict where the robot will be ``dt`` seconds from now if it
    follows the given body-frame velocity. Result is in the world frame.
    """
    # Convert body-frame (vx, vy) → world-frame linear velocity.
    cos_t = math.cos(theta)
    sin_t = math.sin(theta)
    # Conventional mecanum: body x = forward, body y = left.
    wx = cos_t * vx - sin_t * vy
    wy = sin_t * vx + cos_t * vy
    # dt is in seconds; ESC units here are PWM ticks, so we use a
    # calibration-agnostic scaling: 1 m/s ≈ 100 PWM.
    return (vx * dt * 0.01, vy * dt * 0.01)


# ── WebSocket client (runs on its own thread) ────────────────────────────────

class BridgeClient:
    """Run the asyncio WebSocket loop on a background thread.

    Public API is thread-safe: callers put dicts on ``outgoing`` and read
    decoded events from ``incoming`` (a queue.Queue drained from tkinter).
    """

    def __init__(self, url: str, logger) -> None:
        self.url = url
        self.logger = logger
        self.outgoing: queue.Queue = queue.Queue(maxsize=64)
        self.incoming: queue.Queue = queue.Queue(maxsize=1024)
        self._stop = threading.Event()
        self._connected = threading.Event()
        self._thread = threading.Thread(target=self._run, name='ws-bridge', daemon=True)
        self._thread.start()

    # ── thread lifecycle ─────────────────────────────────────────────

    def _run(self) -> None:
        import asyncio

        asyncio.run(self._asyncio_main())

    async def _asyncio_main(self) -> None:
        import asyncio
        attempt = 0
        while not self._stop.is_set():
            try:
                # open_timeout keeps the connect from hanging for 30 s
                # when the Pi is unreachable.  The 5 s ceiling keeps
                # latency sane on fast LANs while still tolerating the
                # normal TCP SYN round-trip.
                async with websockets.connect(
                    self.url,
                    open_timeout=5.0,
                    ping_interval=PING_INTERVAL,
                    ping_timeout=PING_INTERVAL * 2,
                    max_size=16 * 1024 * 1024,
                ) as ws:
                    attempt = 0
                    self._connected.set()
                    self.logger(f'WS connected: {self.url}')
                    self.incoming.put_nowait({'type': '_connection',
                                              'state': 'connected'})
                    sender = asyncio.create_task(self._sender(ws))
                    try:
                        async for raw in ws:
                            if self._stop.is_set():
                                break
                            self._dispatch(raw)
                    except Exception as e:
                        if not self._stop.is_set():
                            self.logger(f'WS recv error: {e}', error=True)
                    finally:
                        sender.cancel()
                        await asyncio.gather(sender, return_exceptions=True)
            except Exception as e:
                if not self._stop.is_set():
                    self.logger(f'WS connect failed: {e}', error=True)
            self._connected.clear()
            if self._stop.is_set():
                break
            self.incoming.put_nowait({'type': '_connection',
                                      'state': 'disconnected'})
            delay = RECONNECT_BACKOFF[min(attempt, len(RECONNECT_BACKOFF) - 1)]
            attempt += 1
            # Interruptible sleep — ``_stop`` check every 200 ms so close
            # does not block waiting for the full backoff interval.
            for _ in range(int(delay / 0.2)):
                if self._stop.is_set():
                    return
                await asyncio.sleep(0.2)
            if self._stop.is_set():
                return

    async def _sender(self, ws) -> None:
        import asyncio
        loop = asyncio.get_event_loop()
        while not self._stop.is_set():
            try:
                msg = await loop.run_in_executor(None, self.outgoing.get, True, 0.5)
            except queue.Empty:
                continue
            await ws.send(json.dumps(msg))

    def _dispatch(self, raw) -> None:
        try:
            if isinstance(raw, bytes):
                try:
                    raw = gzip.decompress(raw).decode('utf-8')
                except Exception:
                    raw = raw.decode('utf-8', errors='replace')
            obj = json.loads(raw)
        except Exception:
            return
        try:
            self.incoming.put_nowait(obj)
        except queue.Full:
            pass

    # ── public API ───────────────────────────────────────────────────

    def is_connected(self) -> bool:
        return self._connected.is_set()

    def send(self, msg: dict) -> bool:
        if not self._connected.is_set():
            return False
        try:
            self.outgoing.put_nowait(msg)
            return True
        except queue.Full:
            self.logger('outgoing queue full — dropped message', error=True)
            return False

    def close(self) -> None:
        # Signal the asyncio loop to bail out immediately, then wait for
        # the thread to wind down. ``asyncio.run`` will close its loop on
        # return so any pending ``websockets.connect`` handshake aborts.
        self._stop.set()
        # Drop the queue references so any lingering task exits fast.
        try:
            self.outgoing.put_nowait({'type': '_shutdown'})
        except Exception:
            pass
        thread = self._thread
        self._thread = None  # type: ignore[assignment]
        if thread is not None and thread.is_alive():
            thread.join(timeout=2.0)
            # The worker was created as a daemon thread, so a stalled socket
            # cannot prevent the process from exiting after the window closes.


# ── UI state container ───────────────────────────────────────────────────────

class OperatorState:
    def __init__(self) -> None:
        self.pose: dict | None = None
        self.pose_ts: float = 0.0
        self.scan_points: list[tuple[float, float]] = []
        self.scan_ts: float = 0.0
        self.map_data: dict | None = None
        self.map_image: Any | None = None       # tk.PhotoImage
        self.status_text: str = ''
        self.mode: str = 'idle'
        self.info: dict = {}
        self.control_mode: str = 'MANUAL'
        self.esp32_status: dict | None = None
        self.esp32_encoder: list = []
        self.demo_status: dict = {}
        self.ack_log: list[tuple[float, str]] = []  # (time, message)
        self.connected: bool = False
        self.connection_message: str = 'connecting…'

        # Geofence state
        self.geofence: dict = GEOFENCE_DEFAULT.copy()
        self.geofence_ok: bool = True          # last known inside/outside
        self.geofence_warn: bool = False       # near edge (< soft_margin)
        self.geofence_breach: bool = False     # outside polygon (>= hard_margin)
        self.geofence_last_pose: dict | None = None  # last pose checked
        self.geofence_violation_count: int = 0  # consecutive outside readings

        # Canvas mode: 'robot' | 'design' | 'waypoint'
        self.canvas_mode: str = 'robot'

        # Map designer — each entry is [x1, y1, x2, y2, width_m]
        # width_m defaults to 0.20 m (20 cm wall) for backward compat.
        self.map_lines: list[list[float]] = []
        self.selected_wall_index: int = -1

        # Home placement mode
        self.placing_home: bool = False

        # Waypoints
        self.waypoints: list[dict] = []  # [{id, x, y, theta, label}, ...]
        self._next_waypoint_id: int = 1

        # Navigation / Trip timer
        self.home_pose: dict | None = None     # user-placed home position
        self.nav_active: bool = False          # navigating now
        self.nav_goal: dict | None = None      # {x, y, theta}
        self.nav_start_time: float = 0.0       # monotonic when nav began
        self.nav_step_index: int = -1          # for scripted sequences
        self.trip_log: list[dict] = []         # completed trips

        # Scripted sequences
        self.sequence: list[dict] = []         # [{type, waypoint_id/action/wait_s}, ...]
        self.sequence_running: bool = False
        self.sequence_index: int = 0
        self.sequence_paused: bool = False

        # Replay recording
        self.replay_recording: bool = False
        self.replay_data: list[dict] = []      # [{t, pose, scan, mode}, ...]
        self.replay_start_time: float = 0.0
        self.replay_playing: bool = False
        self.replay_data_view: list[dict] = [] # for playback (frozen copy)

        # Auto-survey (TỰ KHẢO SÁT)
        # Goes: [home] -> wp1 -> extend -> retract -> wp2 -> ... -> [home]
        self.survey_running: bool = False
        self.survey_paused: bool = False       # paused by E-STOP or manual
        self.survey_queue: list[dict] = []      # [{'id', 'x', 'y', 'label'}, ...]
        self.survey_done_ids: list[int] = []    # ids of wp already unloaded this run
        self.survey_substep: str = ''           # 'navigate' | 'extend' | 'retract' | 'wait'
        self.survey_substep_at: float = 0.0     # monotonic for timing waits
        self.warehouse_state: dict = {
            'done_ids': [], 'last_run_ts': 0.0, 'total_unloads': 0,
        }

    def push_log(self, msg: str) -> None:
        self.ack_log.append((time.time(), msg))
        if len(self.ack_log) > 50:
            self.ack_log = self.ack_log[-50:]


# ── Main app ────────────────────────────────────────────────────────────────

class OperatorApp:
    def __init__(self, root: tk.Tk, url: str) -> None:
        self.root = root
        self.url = url
        self.root.title(f'AGV Operator — {url}')
        self.root.minsize(1100, 720)
        self.root.protocol('WM_DELETE_WINDOW', self._on_close)

        self.state = OperatorState()
        self.state.geofence = geofence_load(_GEOFENCE_PATH)
        # Load saved map / waypoints / sequence / trip log
        self.state.map_lines = _load_lines(_MAP_PATH)
        self.state.waypoints = _load_waypoints(_WAYPOINTS_PATH)
        self.state.sequence = _load_sequence(_SEQUENCE_PATH)
        self.state.trip_log = _load_trip_log(_TRIP_LOG_PATH)
        self.state.warehouse_state = _load_warehouse_state(_WAREHOUSE_STATE_PATH)
        # Load persisted home pose (set via "Đặt Home" button)
        saved_home = _load_json(_HOME_PATH, None)
        if isinstance(saved_home, dict) and 'x' in saved_home:
            self.state.home_pose = saved_home
        # Auto-generate geofence from lines if they form a closed polygon
        self.root.after(200, self._auto_update_geofence)
        # Compute next waypoint id
        if self.state.waypoints:
            self.state._next_waypoint_id = max(w.get('id', 0) for w in self.state.waypoints) + 1
        # Canvas view state (world-frame canvas)
        self._view_center: tuple[float, float] = (0.0, 0.0)  # (world_x, world_y)
        self._view_range_m: float = 6.0  # metres visible half-width
        self._mouse_world: tuple[float, float] | None = None
        self._drawing_line: list[float] | None = None  # [x1,y1,x2,y2] in-progress
        self._drag_waypoint: int | None = None
        self._drag_wall: dict | None = None  # {'index': int, 'part': str, ...}
        # Internal render width only; the operator edits line length, not thickness.
        self._wall_default_width_m: float = 0.10
        self._waypoint_list_cache: str = ''
        self._sequence_list_cache: str = ''
        self._trip_text_cache: str = ''
        self._pressed: set[str] = set()
        self._last_teleop_sent: float = 0.0
        self._geofence_warned_once: bool = False
        self._closing: bool = False

        # UI scaffolding
        self._build_layout()
        self._build_menu()
        self._bind_keys()

        # WebSocket
        self.bridge = BridgeClient(url, self._log)
        self.root.after(50, self._drain_incoming)
        self.root.after(50, self._tick_teleop)
        self.root.after(100, self._refresh_timer_label)
        # Auto-discovery: scan LAN on startup if no custom URL was provided
        self._udp_discovery: UDPDiscovery | None = None
        self._discovered_devices: list[dict] = []
        if url == DEFAULT_URL:
            self._start_udp_scan()

    # ── Layout ───────────────────────────────────────────────────────

    def _build_layout(self) -> None:
        style = ttk.Style(self.root)
        try:
            style.theme_use('clam')
        except tk.TclError:
            pass

        # Use grid for predictable resizing
        self.root.columnconfigure(1, weight=1)
        self.root.rowconfigure(0, weight=1)

        self.left = ttk.Frame(self.root, padding=8)
        self.left.grid(row=0, column=0, sticky='nsew')
        self.left.columnconfigure(0, weight=1)
        self.right = ttk.Frame(self.root, padding=8)
        self.right.grid(row=0, column=1, sticky='nsew')
        self.right.columnconfigure(0, weight=1)
        self.right.rowconfigure(2, weight=1)

        self._build_left_panel()
        self._build_right_panel()

    def _build_left_panel(self) -> None:
        f = self.left
        ttk.Label(f, text='Bản đồ & quét', font=('Segoe UI', 11, 'bold')).grid(
            row=0, column=0, sticky='w', pady=(0, 4))

        # ── Canvas mode toolbar ───────────────��─────────────────
        mode_bar = ttk.Frame(f)
        mode_bar.grid(row=1, column=0, sticky='ew', pady=(0, 4))
        self.btn_mode_robot = ttk.Button(mode_bar, text='Robot view',
                                         command=lambda: self._set_canvas_mode('robot'))
        self.btn_mode_robot.grid(row=0, column=0, padx=1, sticky='ew')
        self.btn_mode_design = ttk.Button(mode_bar, text='Bản đồ (vẽ)',
                                          command=lambda: self._set_canvas_mode('design'))
        self.btn_mode_design.grid(row=0, column=1, padx=1, sticky='ew')
        self.btn_mode_waypoint = ttk.Button(mode_bar, text='Waypoint',
                                            command=lambda: self._set_canvas_mode('waypoint'))
        self.btn_mode_waypoint.grid(row=0, column=2, padx=1, sticky='ew')
        mode_bar.columnconfigure((0, 1, 2), weight=1)

        # ── Design/waypoint tool bar ────────────────────────────
        tool_bar = ttk.Frame(f)
        tool_bar.grid(row=2, column=0, sticky='ew', pady=(0, 4))
        self.lbl_tool_hint = ttk.Label(tool_bar, text='', font=('Segoe UI', 8),
                                       foreground='#88aacc')
        self.lbl_tool_hint.grid(row=0, column=0, sticky='w')
        ttk.Button(tool_bar, text='Xóa hết map',
                   command=self._clear_map).grid(row=0, column=1, padx=2)
        ttk.Button(tool_bar, text='Lưu bản đồ',
                   command=self._save_map).grid(row=0, column=2, padx=2)

        # ── Survey toolbar (auto-unload shelves) ────────────────
        survey_bar = ttk.Frame(f)
        survey_bar.grid(row=3, column=0, sticky='ew', pady=(0, 4))
        self.btn_survey = ttk.Button(survey_bar,
                                     text='TỰ KHẢO SÁT (bỏ trống kho)',
                                     command=self._begin_survey)
        self.btn_survey.grid(row=0, column=0, padx=(0, 2), sticky='ew')
        self.btn_survey_stop = ttk.Button(survey_bar,
                                          text='DỪNG KHẢO SÁT',
                                          command=self._stop_survey)
        self.btn_survey_stop.grid(row=0, column=1, padx=2, sticky='ew')
        self.btn_survey_reset = ttk.Button(survey_bar,
                                           text='Reset kho đã đổ',
                                           command=self._reset_survey_done)
        self.btn_survey_reset.grid(row=0, column=2, padx=(0, 2), sticky='ew')
        survey_bar.columnconfigure(0, weight=1)
        survey_bar.columnconfigure(1, weight=1)
        self.survey_hint = ttk.Label(f, text='',
                                     font=('Segoe UI', 8), foreground='#88aacc')
        self.survey_hint.grid(row=4, column=0, sticky='w')

        # ── Canvas (larger in design/waypoint modes) ────────────
        self.canvas = tk.Canvas(f, width=MINI_SIZE, height=MINI_SIZE,
                                bg='#04060b', highlightthickness=0)
        self.canvas.grid(row=5, column=0, sticky='nsew', pady=(0, 6))
        f.rowconfigure(5, weight=1)

        # Mouse bindings (added in _set_canvas_mode)
        self._bind_canvas_mouse()

        # ── Trip timer + home row ──────────────────────────────
        trip_frame = ttk.Frame(f)
        trip_frame.grid(row=6, column=0, sticky='ew', pady=(0, 2))
        ttk.Label(trip_frame, text='Trip:', font=('Segoe UI', 9, 'bold')).grid(
            row=0, column=0, padx=(0, 4))
        self.trip_timer_label = ttk.Label(trip_frame, text='⏱ 00:00.0',
                                          font=('Consolas', 10, 'bold'),
                                          foreground='#00d4ff')
        self.trip_timer_label.grid(row=0, column=1, padx=(0, 8))
        ttk.Label(trip_frame, text='Home:', font=('Segoe UI', 9)).grid(
            row=0, column=2, padx=(0, 4))
        home_txt = '(chưa đặt)' if self.state.home_pose is None else (
            f'({self.state.home_pose["x"]:.2f}, {self.state.home_pose["y"]:.2f})')
        self.home_label = ttk.Label(trip_frame, text=home_txt,
                                    font=('Consolas', 9), foreground='#88aacc')
        self.home_label.grid(row=0, column=3, padx=(0, 8))
        trip_frame.columnconfigure(4, weight=1)
        ttk.Button(trip_frame, text='Đặt Home',
                   command=self._begin_place_home).grid(row=0, column=5, padx=2)
        ttk.Button(trip_frame, text='VỀ HOME',
                   command=self._go_home).grid(row=0, column=6, padx=2)

        # ── Status / connection row ─────────────────────────────
        self.status_label = ttk.Label(f, text='mode: idle', font=('Segoe UI', 9))
        self.status_label.grid(row=7, column=0, sticky='w')
        self.connection_label = ttk.Label(f, text='● connecting…',
                                          foreground='#ffaa00',
                                          font=('Segoe UI', 9, 'bold'))
        self.connection_label.grid(row=8, column=0, sticky='w')

    # ── Canvas mode switching + world-frame helpers ─────────────────

    def _set_canvas_mode(self, mode: str) -> None:
        self.state.canvas_mode = mode
        for btn, m in ((self.btn_mode_robot, 'robot'),
                       (self.btn_mode_design, 'design'),
                       (self.btn_mode_waypoint, 'waypoint')):
            state = ['!disabled'] if m != mode else ['disabled']
            btn.state(state)
        hints = {
            'robot': '',
            'design': 'Kéo = vẽ line. Đầu line tự nối khi ở gần nhau. '
                      'Kéo đầu = đổi chiều dài, kéo thân = di chuyển. '
                      'Double-click = chỉnh chi tiết. Chuột phải = xóa line.',
            'waypoint': 'Click = đặt waypoint. Chuột phải = xóa waypoint gần nhất.',
        }
        self.lbl_tool_hint.config(text=hints.get(mode, ''))
        # Auto-center on robot pose when switching to design/waypoint
        if mode != 'robot' and self.state.pose:
            self._view_center = (self.state.pose.get('x', 0.0),
                                 self.state.pose.get('y', 0.0))

    def _bind_canvas_mouse(self) -> None:
        self.canvas.bind('<Button-1>', self._on_canvas_click)
        self.canvas.bind('<B1-Motion>', self._on_canvas_drag)
        self.canvas.bind('<ButtonRelease-1>', self._on_canvas_release)
        self.canvas.bind('<Double-Button-1>', self._on_canvas_double_click)
        self.canvas.bind('<Button-3>', self._on_canvas_right_click)
        self.canvas.bind('<MouseWheel>', self._on_canvas_scroll)
        self.canvas.bind('<Button-2>', self._on_canvas_pan_start)
        self.canvas.bind('<B2-Motion>', self._on_canvas_pan_drag)
        self.canvas.bind('<Motion>', self._on_canvas_motion)

    def _world_to_screen(self, wx: float, wy: float, W: int, H: int) -> tuple[float, float]:
        ppm = min(W, H) / (self._view_range_m * 2)  # pixels per metre
        cx, cy = W / 2, H / 2
        return (cx + (wx - self._view_center[0]) * ppm,
                cy - (wy - self._view_center[1]) * ppm)

    def _screen_to_world(self, sx: float, sy: float, W: int, H: int) -> tuple[float, float]:
        ppm = min(W, H) / (self._view_range_m * 2)
        cx, cy = W / 2, H / 2
        return ((sx - cx) / ppm + self._view_center[0],
                -(sy - cy) / ppm + self._view_center[1])

    def _ppm(self, W: int, H: int) -> float:
        return min(W, H) / (self._view_range_m * 2)

    def _find_nearest_line(self, wx: float, wy: float, threshold_m: float = 0.30) -> int:
        """Find nearest wall (centre-line proximity) within threshold. Returns index or -1."""
        best, best_i = threshold_m, -1
        for i, line in enumerate(self.state.map_lines):
            x1, y1, x2, y2 = line[0], line[1], line[2], line[3]
            dx, dy = x2 - x1, y2 - y1
            length_sq = dx * dx + dy * dy
            if length_sq < 1e-12:
                continue
            t = max(0.0, min(1.0, ((wx - x1) * dx + (wy - y1) * dy) / length_sq))
            px, py = x1 + t * dx, y1 + t * dy
            dist = math.hypot(wx - px, wy - py)
            if dist < best:
                best, best_i = dist, i
        return best_i

    def _find_nearest_waypoint(self, wx: float, wy: float, threshold_m: float = 0.25) -> int | None:
        best, best_id = threshold_m, None
        for w in self.state.waypoints:
            dist = math.hypot(wx - w['x'], wy - w['y'])
            if dist < best:
                best, best_id = dist, w['id']
        return best_id

    # ── Canvas mouse handlers ───────────────────────────────────────

    def _on_canvas_click(self, ev) -> None:
        W = self.canvas.winfo_width()
        H = self.canvas.winfo_height()
        if W == 0 or H == 0:
            return
        wx, wy = self._screen_to_world(ev.x, ev.y, W, H)
        mode = self.state.canvas_mode

        # Handle home placement mode (works in any canvas mode).
        if self.state.placing_home:
            self.state.home_pose = {
                'x': round(wx, 3), 'y': round(wy, 3),
                'theta': 0.0, 'ts': time.time(),
            }
            _save_json(_HOME_PATH, self.state.home_pose)
            self._log(f'✓ Home đặt tại ({wx:.2f}, {wy:.2f})')
            self._draw_world_canvas()
            self.state.placing_home = False
            return

        if mode == 'design':
            hit = self._hit_test_wall(wx, wy)
            if hit is not None:
                self.state.selected_wall_index = hit['index']
                self._drag_wall = hit
                return
            self._drawing_line = [wx, wy, wx, wy]
        elif mode == 'waypoint':
            near_id = self._find_nearest_waypoint(wx, wy, 0.25)
            if near_id is not None:
                self._drag_waypoint = near_id
            else:
                wp_id = self.state._next_waypoint_id
                self.state._next_waypoint_id += 1
                self.state.waypoints.append({'id': wp_id, 'x': wx, 'y': wy,
                                             'theta': 0.0, 'label': str(wp_id)})
                _save_json(_WAYPOINTS_PATH, self.state.waypoints)
                self._log(f'→ waypoint #{wp_id} placed at ({wx:.2f}, {wy:.2f})')

    def _on_canvas_drag(self, ev) -> None:
        W = self.canvas.winfo_width()
        H = self.canvas.winfo_height()
        if W == 0 or H == 0:
            return
        wx, wy = self._screen_to_world(ev.x, ev.y, W, H)
        self._mouse_world = (wx, wy)
        if self.state.canvas_mode == 'design':
            if self._drawing_line:
                # Currently drawing a new wall: move the second endpoint.
                self._drawing_line[2], self._drawing_line[3] = wx, wy
            elif self._drag_wall is not None:
                # Editing an existing wall — update endpoints / midpoint
                # according to which part is being dragged.
                self._update_wall_drag(wx, wy)
        elif self.state.canvas_mode == 'waypoint' and self._drag_waypoint is not None:
            for w in self.state.waypoints:
                if w['id'] == self._drag_waypoint:
                    w['x'], w['y'] = wx, wy

    def _on_canvas_release(self, ev) -> None:
        W = self.canvas.winfo_width()
        H = self.canvas.winfo_height()
        if W == 0 or H == 0:
            return
        if self.state.canvas_mode == 'design':
            if self._drawing_line:
                x1, y1, x2, y2 = self._drawing_line
                length = math.hypot(x2 - x1, y2 - y1)
                if length >= 0.05:  # ignore tiny drags
                    sx1, sy1, sx2, sy2 = self._snap_line_endpoints(x1, y1, x2, y2)
                    self.state.map_lines.append(
                        [sx1, sy1, sx2, sy2, self._wall_default_width_m])
                    _save_json(_MAP_PATH, self.state.map_lines)
                    self._log(f'→ line {length:.2f}m  total {len(self.state.map_lines)}')
                    self._auto_update_geofence()
                self._drawing_line = None
            elif self._drag_wall is not None:
                _save_json(_MAP_PATH, self.state.map_lines)
                idx = self._drag_wall.get('index')
                if idx is not None and 0 <= idx < len(self.state.map_lines):
                    wall = self.state.map_lines[idx]
                    length = math.hypot(wall[2] - wall[0], wall[3] - wall[1])
                    self._log(f'✓ line #{idx}: {length:.2f}m')
                self._drag_wall = None
                self._auto_update_geofence()
        elif self.state.canvas_mode == 'waypoint' and self._drag_waypoint is not None:
            _save_json(_WAYPOINTS_PATH, self.state.waypoints)
            self._drag_waypoint = None

    def _on_canvas_double_click(self, ev) -> None:
        """Double-click a wall opens an editor for length, width, angle."""
        if self.state.canvas_mode != 'design':
            return
        # Cancel any ghost wall the preceding single-click may have started
        self._drawing_line = None
        self._drag_wall = None
        W = self.canvas.winfo_width()
        H = self.canvas.winfo_height()
        if W == 0 or H == 0:
            return
        wx, wy = self._screen_to_world(ev.x, ev.y, W, H)
        idx = self._find_nearest_wall_edge(wx, wy, threshold_m=0.35)
        if idx < 0:
            return
        self.state.selected_wall_index = idx
        self._open_wall_editor(idx)

    def _open_wall_editor(self, idx: int) -> None:
        """Open a small Toplevel to edit one line's length, angle, center."""
        wall = self.state.map_lines[idx]
        x1, y1, x2, y2 = wall[0], wall[1], wall[2], wall[3]
        cur_len = math.hypot(x2 - x1, y2 - y1)
        cur_angle = math.degrees(math.atan2(y2 - y1, x2 - x1))
        cur_cx = (x1 + x2) / 2.0
        cur_cy = (y1 + y2) / 2.0

        win = tk.Toplevel(self.root)
        win.title(f'Chỉnh line #{idx}')
        win.geometry('300x210')
        win.transient(self.root)
        win.grab_set()

        def row(label: str, val: tk.StringVar, row_i: int) -> None:
            ttk.Label(win, text=label, font=('Segoe UI', 9)).grid(
                row=row_i, column=0, sticky='w', padx=8, pady=4)
            ttk.Entry(win, textvariable=val, width=10,
                      font=('Consolas', 10)).grid(
                row=row_i, column=1, sticky='ew', padx=8)

        var_len = tk.StringVar(value=f'{cur_len:.3f}')
        var_ang = tk.StringVar(value=f'{cur_angle:.1f}')
        var_x1 = tk.StringVar(value=f'{cur_cx:.3f}')
        var_y1 = tk.StringVar(value=f'{cur_cy:.3f}')

        row('Chiều dài (m):', var_len, 0)
        row('Góc xoay (°):', var_ang, 1)
        row('Tâm X (m):', var_x1, 2)
        row('Tâm Y (m):', var_y1, 3)

        def save() -> None:
            try:
                new_len = max(0.05, float(var_len.get()))
                new_angle = float(var_ang.get())
                new_cx = float(var_x1.get())
                new_cy = float(var_y1.get())
            except ValueError as exc:
                self._log(f'❌ nhập sai: {exc}', error=True)
                return
            ang_rad = math.radians(new_angle)
            dx = (new_len / 2.0) * math.cos(ang_rad)
            dy = (new_len / 2.0) * math.sin(ang_rad)
            self.state.map_lines[idx] = [
                new_cx - dx, new_cy - dy,
                new_cx + dx, new_cy + dy,
                self._wall_default_width_m,
            ]
            _save_json(_MAP_PATH, self.state.map_lines)
            self._log(f'✓ line #{idx}: {new_len:.2f}m, góc {new_angle:.0f}°')
            self._auto_update_geofence()
            win.destroy()

        ttk.Button(win, text='Lưu', command=save).grid(
            row=4, column=0, columnspan=2, sticky='ew', padx=8, pady=8)

    def _hit_test_wall(self, wx: float, wy: float) -> dict | None:
        """Find which part of which wall the user clicked.

        Returns dict with:
          index  : map_lines index
          part   : 'endpoint' | 'body'
          end    : 0 or 1 (only for endpoint part)
          anchor / start_line : for body drag
        """
        best_i = -1
        best_dist = float('inf')
        best_end = None
        for i, line in enumerate(self.state.map_lines):
            x1, y1, x2, y2 = line[0], line[1], line[2], line[3]
            # Endpoints (priority)
            for end, (ex, ey) in ((0, (x1, y1)), (1, (x2, y2))):
                d = math.hypot(wx - ex, wy - ey)
                if d < 0.35 and d < best_dist:
                    best_dist = d
                    best_i = i
                    best_end = end
            # Midpoint — also acts as body-move (grab & drag whole line)
            mx = (x1 + x2) / 2.0
            my = (y1 + y2) / 2.0
            d = math.hypot(wx - mx, wy - my)
            if d < 0.18 and d < best_dist:
                best_dist = d
                best_i = i
                best_end = None  # midpoint → body
        if best_end is not None:
            return {'index': best_i, 'part': 'endpoint', 'end': best_end}
        if best_i >= 0:
            wall = self.state.map_lines[best_i]
            return {
                'index': best_i,
                'part': 'body',
                'anchor': ((wall[0] + wall[2]) / 2.0,
                           (wall[1] + wall[3]) / 2.0),
                'start_line': [wall[0], wall[1], wall[2], wall[3]],
            }
        # Fallback: any point along the line body
        idx = self._find_nearest_wall_edge(wx, wy, threshold_m=0.35)
        if idx >= 0:
            wall = self.state.map_lines[idx]
            return {
                'index': idx,
                'part': 'body',
                'anchor': ((wall[0] + wall[2]) / 2.0,
                           (wall[1] + wall[3]) / 2.0),
                'start_line': [wall[0], wall[1], wall[2], wall[3]],
            }
        return None

    def _find_nearest_wall_edge(self, wx: float, wy: float,
                                threshold_m: float = 0.20) -> int:
        """Return index of nearest wall line within threshold, or -1."""
        best, best_i = threshold_m, -1
        for i, line in enumerate(self.state.map_lines):
            x1, y1, x2, y2, _w = line
            dx, dy = x2 - x1, y2 - y1
            length_sq = dx * dx + dy * dy
            if length_sq < 1e-12:
                continue
            t = max(0.0, min(1.0, ((wx - x1) * dx + (wy - y1) * dy) / length_sq))
            px, py = x1 + t * dx, y1 + t * dy
            dist = math.hypot(wx - px, wy - py)
            if dist < best:
                best, best_i = dist, i
        return best_i

    def _update_wall_drag(self, wx: float, wy: float) -> None:
        info = self._drag_wall
        if info is None:
            return
        idx = info['index']
        if not (0 <= idx < len(self.state.map_lines)):
            return
        wall = self.state.map_lines[idx]
        x1, y1, x2, y2 = wall[0], wall[1], wall[2], wall[3]
        part = info['part']

        if part == 'endpoint':
            end = info['end']
            if end == 0:
                wall[0], wall[1] = wx, wy
            else:
                wall[2], wall[3] = wx, wy
        elif part == 'body':
            anchor_x = info.get('anchor', (0, 0))[0]
            anchor_y = info.get('anchor', (0, 0))[1]
            start = info.get('start_line', [x1, y1, x2, y2])
            sx1, sy1, sx2, sy2 = start
            dx_m = wx - anchor_x
            dy_m = wy - anchor_y
            wall[0] = sx1 + dx_m
            wall[1] = sy1 + dy_m
            wall[2] = sx2 + dx_m
            wall[3] = sy2 + dy_m
            info['anchor'] = (wx, wy)

    # ── Auto-snap and chain-to-polygon ────────────────────────────────

    def _snap_line_endpoints(self, x1: float, y1: float, x2: float, y2: float,
                             snap_m: float = 0.15) -> tuple[float, float, float, float]:
        """Snap either endpoint of the new line to a nearby existing endpoint."""
        sx1, sy1, sx2, sy2 = x1, y1, x2, y2
        for line in self.state.map_lines:
            lx1, ly1, lx2, ly2 = line[0], line[1], line[2], line[3]
            for ex, ey in ((lx1, ly1), (lx2, ly2)):
                if math.hypot(sx1 - ex, sy1 - ey) < snap_m:
                    sx1, sy1 = ex, ey
                if math.hypot(sx2 - ex, sy2 - ey) < snap_m:
                    sx2, sy2 = ex, ey
        return sx1, sy1, sx2, sy2

    def _build_polygon_from_lines(self) -> list[list[float]] | None:
        """Walk connected line segments and return a closed polygon."""
        lines = self.state.map_lines
        if len(lines) < 3:
            return None
        adj: dict[tuple[int, int], list[tuple[int, int]]] = {}
        coords: dict[tuple[int, int], tuple[float, float]] = {}
        for i, ln in enumerate(lines):
            for end in (0, 1):
                x, y = (ln[0], ln[1]) if end == 0 else (ln[2], ln[3])
                key = _line_endpoints_key(x, y)
                adj.setdefault(key, []).append((i, end))
                coords.setdefault(key, (x, y))
        # A simple polygon has exactly two incident segments per vertex.
        if any(len(incidents) != 2 for incidents in adj.values()):
            return None
        start_key = next(iter(adj))
        current_key = start_key
        previous_line: int | None = None
        visited_lines: set[int] = set()
        vertices: list[tuple[float, float]] = []
        while True:
            vertices.append(coords[current_key])
            choices = [item for item in adj[current_key]
                       if item[0] != previous_line]
            if not choices:
                return None
            line_idx, end = choices[0]
            if line_idx in visited_lines:
                return current_key == start_key and len(visited_lines) == len(lines) \
                    and len(vertices) >= 4
            visited_lines.add(line_idx)
            other_end = 1 - end
            next_x = lines[line_idx][other_end * 2]
            next_y = lines[line_idx][other_end * 2 + 1]
            previous_line = line_idx
            current_key = _line_endpoints_key(next_x, next_y)
            if current_key == start_key:
                vertices.append(coords[start_key])
                break
            if len(visited_lines) == len(lines):
                return None
        if len(visited_lines) != len(lines) or len(vertices) < 4:
            return None
        vertices.pop()  # remove repeated start vertex
        return [[round(x, 3), round(y, 3)] for x, y in vertices]

    def _auto_update_geofence(self) -> None:
        """If the lines form a closed polygon, push it to geofence.json."""
        poly = self._build_polygon_from_lines()
        if poly is None:
            return
        cfg = self.state.geofence.copy()
        cfg['polygon'] = poly
        cfg['enabled'] = True
        geofence_save(_GEOFENCE_PATH, cfg)
        self.state.geofence = cfg
        self._log(f'✓ vùng chạy tự cập nhật: {len(poly)} đỉnh ({poly[0][0]:.1f},{poly[0][1]:.1f}) → ({poly[1][0]:.1f},{poly[1][1]:.1f})')

    def _on_canvas_right_click(self, ev) -> None:
        W = self.canvas.winfo_width()
        H = self.canvas.winfo_height()
        if W == 0 or H == 0:
            return
        wx, wy = self._screen_to_world(ev.x, ev.y, W, H)
        mode = self.state.canvas_mode
        if mode == 'design':
            idx = self._find_nearest_line(wx, wy)
            if idx >= 0:
                self.state.map_lines.pop(idx)
                _save_json(_MAP_PATH, self.state.map_lines)
                self._log(f'→ removed line #{idx}')
                self._auto_update_geofence()
        elif mode == 'waypoint':
            wp_id = self._find_nearest_waypoint(wx, wy)
            if wp_id is not None:
                self.state.waypoints = [w for w in self.state.waypoints if w['id'] != wp_id]
                _save_json(_WAYPOINTS_PATH, self.state.waypoints)
                self._log(f'→ removed waypoint #{wp_id}')

    def _on_canvas_scroll(self, ev) -> None:
        if self.state.canvas_mode == 'robot':
            return
        delta = ev.delta / 120  # Windows: positive = scroll up = zoom in
        factor = 0.85 if delta > 0 else 1.15
        self._view_range_m = max(1.0, min(50.0, self._view_range_m * factor))

    def _on_canvas_pan_start(self, ev) -> None:
        if self.state.canvas_mode == 'robot':
            return
        self._pan_start = (ev.x, ev.y, self._view_center[0], self._view_center[1])

    def _on_canvas_pan_drag(self, ev) -> None:
        if self.state.canvas_mode == 'robot' or not hasattr(self, '_pan_start'):
            return
        W = self.canvas.winfo_width()
        H = self.canvas.winfo_height()
        if W == 0 or H == 0:
            return
        ppm = self._ppm(W, H)
        sx0, sy0, vcx0, vcy0 = self._pan_start
        dx_m = -(ev.x - sx0) / ppm
        dy_m = (ev.y - sy0) / ppm
        self._view_center = (vcx0 + dx_m, vcy0 + dy_m)

    def _on_canvas_motion(self, ev) -> None:
        if self.state.canvas_mode == 'robot':
            return
        W = self.canvas.winfo_width()
        H = self.canvas.winfo_height()
        if W == 0 or H == 0:
            return
        self._mouse_world = self._screen_to_world(ev.x, ev.y, W, H)

    # ── Map save/load/clear ─────────────────────────────────────────

    def _save_map(self) -> None:
        _save_json(_MAP_PATH, self.state.map_lines)
        _save_json(_WAYPOINTS_PATH, self.state.waypoints)
        self._log(f'✓ đã lưu bản đồ ({len(self.state.map_lines)} đường, '
                  f'{len(self.state.waypoints)} waypoint)')

    def _clear_map(self) -> None:
        self.state.map_lines.clear()
        self.state.waypoints.clear()
        self.state._next_waypoint_id = 1
        _save_json(_MAP_PATH, [])
        _save_json(_WAYPOINTS_PATH, [])
        self._log('✓ đã xóa bản đồ + waypoint')

    def _build_right_panel(self) -> None:
        f = self.right
        # ── Mode ─────────────────────────────────────────────────────
        mode_frame = ttk.LabelFrame(f, text='Điều khiển', padding=8)
        mode_frame.grid(row=0, column=0, sticky='ew', pady=(0, 6))
        mode_frame.columnconfigure(0, weight=1)
        mode_frame.columnconfigure(1, weight=1)

        self.btn_manual = ttk.Button(mode_frame, text='MANUAL',
                                     command=lambda: self._set_mode('MANUAL'))
        self.btn_manual.grid(row=0, column=0, sticky='ew', padx=(0, 4))
        self.btn_auto = ttk.Button(mode_frame, text='AUTO',
                                   command=lambda: self._set_mode('AUTO'))
        self.btn_auto.grid(row=0, column=1, sticky='ew', padx=(4, 0))
        self.mode_label = ttk.Label(mode_frame, text='Đang chờ kết nối…',
                                    font=('Segoe UI', 9))
        self.mode_label.grid(row=1, column=0, columnspan=2, sticky='w', pady=(6, 0))

        # ── Mapping controls ─────────────────────────────────────────
        map_frame = ttk.LabelFrame(f, text='SLAM / Mapping', padding=8)
        map_frame.grid(row=1, column=0, sticky='ew', pady=(0, 6))
        map_frame.columnconfigure((0, 1, 2, 3), weight=1)
        for i, (label, cmd) in enumerate([
            ('START', 'start'),
            ('STOP', 'stop'),
            ('IDLE', 'idle'),
            ('RESET', 'reset'),
        ]):
            ttk.Button(map_frame, text=label,
                       command=lambda c=cmd: self._send_cmd(c)).grid(
                row=0, column=i, sticky='ew', padx=2)

        # ── Demo (AUTO) / Teleop (MANUAL) share the same row ─────────
        ctrl_frame = ttk.LabelFrame(f, text='Demo / Teleop', padding=8)
        ctrl_frame.grid(row=2, column=0, sticky='nsew', pady=(0, 6))
        ctrl_frame.columnconfigure((0, 1, 2, 3, 4), weight=1)
        f.rowconfigure(2, weight=1)

        # Demo row (visible only in AUTO)
        self.demo_zone = {
            'A': ttk.Button(ctrl_frame, text='A',
                            command=lambda: self._send_demo('A')),
            'B': ttk.Button(ctrl_frame, text='B',
                            command=lambda: self._send_demo('B')),
            'C': ttk.Button(ctrl_frame, text='C',
                            command=lambda: self._send_demo('C')),
            'D': ttk.Button(ctrl_frame, text='D',
                            command=lambda: self._send_demo('D')),
        }
        for col, key in enumerate(['A', 'B', 'C', 'D']):
            self.demo_zone[key].grid(row=0, column=col, sticky='ew', padx=2)

        self.btn_full = ttk.Button(ctrl_frame, text='FULL DEMO',
                                   command=lambda: self._send_demo('full'))
        self.btn_full.grid(row=1, column=0, columnspan=2, sticky='ew', padx=2, pady=(4, 0))
        self.btn_demo_stop = ttk.Button(ctrl_frame, text='STOP DEMO',
                                        command=lambda: self._send_demo('stop'))
        self.btn_demo_stop.grid(row=1, column=2, columnspan=2, sticky='ew', padx=2, pady=(4, 0))

        # Cylinder (always available in MANUAL, brain handles AUTO)
        ttk.Label(ctrl_frame, text='Xi-lanh (chỉ MANUAL):',
                  font=('Segoe UI', 9)).grid(row=2, column=0, columnspan=5, sticky='w',
                                            pady=(8, 0))
        for col, (label, action) in enumerate([
            ('Nâng lên', 'extend'),
            ('Hạ xuống', 'retract'),
            ('Dừng', 'stop'),
        ]):
            ttk.Button(ctrl_frame, text=label,
                       command=lambda a=action: self._send_cylinder(a)).grid(
                row=3, column=col, sticky='ew', padx=2, pady=(2, 0))

        # Emergency stop
        self.btn_estop = ttk.Button(ctrl_frame, text='⚠ E-STOP (Esc)',
                                    command=self._e_stop)
        self.btn_estop.grid(row=4, column=0, columnspan=5, sticky='ew', pady=(10, 0))

        # ── Telemetry / log tabs ─────────────────────────────────────
        tabs = ttk.Notebook(f)
        tabs.grid(row=3, column=0, sticky='nsew', pady=(0, 0))
        f.rowconfigure(3, weight=1)

        self._build_esp32_tab(tabs)
        self._build_demo_tab(tabs)
        self._build_log_tab(tabs)
        self._build_waypoint_tab(tabs)
        self._build_wall_tab(tabs)
        self._build_sequence_tab(tabs)
        self._build_trip_tab(tabs)
        self._build_help_tab(tabs)

    def _build_esp32_tab(self, tabs: ttk.Notebook) -> None:
        f = ttk.Frame(tabs, padding=8)
        tabs.add(f, text='ESP32')
        self.esp32_text = tk.Text(f, height=8, font=('Consolas', 9), wrap='word')
        self.esp32_text.grid(row=0, column=0, sticky='nsew')
        f.columnconfigure(0, weight=1)
        f.rowconfigure(0, weight=1)

    def _build_demo_tab(self, tabs: ttk.Notebook) -> None:
        f = ttk.Frame(tabs, padding=8)
        tabs.add(f, text='Demo')
        self.demo_text = tk.Text(f, height=8, font=('Consolas', 9))
        self.demo_text.grid(row=0, column=0, sticky='nsew')
        f.columnconfigure(0, weight=1)
        f.rowconfigure(0, weight=1)

    def _build_waypoint_tab(self, tabs: ttk.Notebook) -> None:
        f = ttk.Frame(tabs, padding=8)
        tabs.add(f, text='Waypoint')
        f.columnconfigure(0, weight=1)
        f.rowconfigure(0, weight=1)
        self.waypoint_list = tk.Listbox(f, height=8, font=('Consolas', 9), exportselection=False)
        self.waypoint_list.grid(row=0, column=0, columnspan=4, sticky='nsew', pady=(0, 6))
        ttk.Button(f, text='Đi đến', command=self._goto_selected_waypoint).grid(row=1, column=0, sticky='ew', padx=2)
        ttk.Button(f, text='Xóa', command=self._delete_selected_waypoint).grid(row=1, column=1, sticky='ew', padx=2)
        ttk.Button(f, text='Đổi tên', command=self._rename_selected_waypoint).grid(row=1, column=2, sticky='ew', padx=2)
        ttk.Button(f, text='Lưu', command=self._save_map).grid(row=1, column=3, sticky='ew', padx=2)
        for i in range(4):
            f.columnconfigure(i, weight=1)

    def _build_wall_tab(self, tabs: ttk.Notebook) -> None:
        f = ttk.Frame(tabs, padding=8)
        tabs.add(f, text='Tường')
        f.columnconfigure(0, weight=1)
        f.rowconfigure(0, weight=1)
        self.wall_list = tk.Listbox(
            f, height=8, font=('Consolas', 9), exportselection=False)
        self.wall_list.grid(row=0, column=0, columnspan=3, sticky='nsew', pady=(0, 6))
        self.wall_list.bind('<<ListboxSelect>>', self._select_wall_from_list)
        ttk.Button(f, text='Sửa', command=self._edit_wall_from_list).grid(
            row=1, column=0, sticky='ew', padx=2)
        ttk.Button(f, text='Xóa', command=self._delete_wall_from_list).grid(
            row=1, column=1, sticky='ew', padx=2)
        ttk.Button(f, text='Lưu', command=self._save_map).grid(
            row=1, column=2, sticky='ew', padx=2)
        ttk.Label(f,
                  text='Vẽ line có đầu tự nối → khép kín = vùng chạy.',
                  font=('Segoe UI', 8), foreground='#7799aa',
                  wraplength=240).grid(
            row=2, column=0, columnspan=3, sticky='w', padx=2, pady=(6, 0))
        for i in range(3):
            f.columnconfigure(i, weight=1)

    def _build_sequence_tab(self, tabs: ttk.Notebook) -> None:
        f = ttk.Frame(tabs, padding=8)
        tabs.add(f, text='Kịch bản')
        f.columnconfigure(0, weight=1)
        f.rowconfigure(0, weight=1)
        self.sequence_list = tk.Listbox(f, height=8, font=('Consolas', 9), exportselection=False)
        self.sequence_list.grid(row=0, column=0, columnspan=5, sticky='nsew', pady=(0, 6))
        actions = [
            ('+ WP', self._sequence_add_waypoint),
            ('+ Home', self._sequence_add_home),
            ('+ Nâng', lambda: self._sequence_add_cylinder('extend')),
            ('+ Hạ', lambda: self._sequence_add_cylinder('retract')),
            ('+ Wait', self._sequence_add_wait),
        ]
        for col, (label, cmd) in enumerate(actions):
            ttk.Button(f, text=label, command=cmd).grid(row=1, column=col, sticky='ew', padx=1)
            f.columnconfigure(col, weight=1)
        ttk.Button(f, text='▶ Chạy', command=self._sequence_play).grid(row=2, column=0, sticky='ew', padx=1, pady=(4, 0))
        ttk.Button(f, text='⏸ Tạm dừng', command=self._sequence_pause).grid(row=2, column=1, sticky='ew', padx=1, pady=(4, 0))
        ttk.Button(f, text='⏹ Dừng', command=self._sequence_stop).grid(row=2, column=2, sticky='ew', padx=1, pady=(4, 0))
        ttk.Button(f, text='Xóa bước', command=self._sequence_delete_selected).grid(row=2, column=3, sticky='ew', padx=1, pady=(4, 0))
        ttk.Button(f, text='Lưu', command=self._sequence_save).grid(row=2, column=4, sticky='ew', padx=1, pady=(4, 0))

    def _build_trip_tab(self, tabs: ttk.Notebook) -> None:
        f = ttk.Frame(tabs, padding=8)
        tabs.add(f, text='Chuyến đi')
        f.columnconfigure(0, weight=1)
        f.rowconfigure(0, weight=1)
        self.trip_text = tk.Text(f, height=8, font=('Consolas', 9), wrap='none')
        self.trip_text.grid(row=0, column=0, columnspan=3, sticky='nsew', pady=(0, 6))
        ttk.Button(f, text='Xuất CSV', command=self._export_trip_csv).grid(row=1, column=0, sticky='ew', padx=2)
        ttk.Button(f, text='⏺ Ghi replay', command=self._toggle_replay_recording).grid(row=1, column=1, sticky='ew', padx=2)
        ttk.Button(f, text='▶ Xem replay', command=self._open_replay_viewer).grid(row=1, column=2, sticky='ew', padx=2)
        for i in range(3):
            f.columnconfigure(i, weight=1)

    def _build_log_tab(self, tabs: ttk.Notebook) -> None:
        f = ttk.Frame(tabs, padding=8)
        tabs.add(f, text='Nhật ký')
        self.log_text = tk.Text(f, height=8, font=('Consolas', 9))
        self.log_text.grid(row=0, column=0, sticky='nsew')
        f.columnconfigure(0, weight=1)
        f.rowconfigure(0, weight=1)

    def _build_help_tab(self, tabs: ttk.Notebook) -> None:
        f = ttk.Frame(tabs, padding=8)
        tabs.add(f, text='Phím tắt')
        help_lines = (
            'WASD / Arrows  di chuyển (MANUAL)\n'
            'Q / E          xoay trái / phải (MANUAL)\n'
            'Space          xi-lanh mở rộ (MANUAL)\n'
            'R              xi-lanh thu vào (MANUAL)\n'
            'X              xi-lanh dừng (MANUAL)\n'
            'M              chuyển Manual / Auto\n'
            'Esc            STOP / E-STOP\n'
            'Tab            canvas focus (không cần)\n'
        )
        ttk.Label(f, text=help_lines, font=('Consolas', 10), justify='left').grid(
            row=0, column=0, sticky='nw')

    def _build_menu(self) -> None:
        menu = tk.Menu(self.root)
        # File
        filem = tk.Menu(menu, tearoff=0)
        filem.add_command(label='Kết nối lại', command=self._reconnect)
        filem.add_command(label='🔍 Tìm robot trên mạng', command=self._start_udp_scan)
        filem.add_command(label='Nhập IP / URL thủ công', command=self._on_manual_connect)
        filem.add_separator()
        filem.add_command(label='Thoát', command=self._on_close)
        menu.add_cascade(label='Tệp', menu=filem)
        # Mode
        modem = tk.Menu(menu, tearoff=0)
        modem.add_command(label='Manual', command=lambda: self._set_mode('MANUAL'))
        modem.add_command(label='Auto', command=lambda: self._set_mode('AUTO'))
        menu.add_cascade(label='Chế độ', menu=modem)
        # Tools
        toolsm = tk.Menu(menu, tearoff=0)
        toolsm.add_command(label='Chỉnh vùng hoạt động (geofence)',
                           command=self._open_geofence_editor)
        menu.add_cascade(label='Công cụ', menu=toolsm)
        self.root.config(menu=menu)

    # ── Key handling ────────────────────────────────────────────────

    def _bind_keys(self) -> None:
        for key in ('w', 'a', 's', 'd', 'q', 'e',
                    'Up', 'Down', 'Left', 'Right',
                    'space', 'r', 'x', 'm', 'Escape'):
            self.root.bind(f'<KeyPress-{key}>', self._on_key_down)
            self.root.bind(f'<KeyRelease-{key}>', self._on_key_up)

    def _normal_key(self, key: str) -> str:
        return key.lower()

    def _on_key_down(self, ev) -> None:
        key = self._normal_key(ev.keysym)
        if key == 'escape':
            self._e_stop()
            return
        if key == 'm':
            self._set_mode('AUTO' if self.state.control_mode == 'MANUAL' else 'MANUAL')
            return
        if key == 'space':
            self._send_cylinder('extend')
            return
        if key == 'r' and 'r' not in self._pressed:
            self._send_cylinder('retract')
        if key == 'x' and 'x' not in self._pressed:
            self._send_cylinder('stop')
        self._pressed.add(key)

    def _on_key_up(self, ev) -> None:
        self._pressed.discard(self._normal_key(ev.keysym))

    # ── Periodic tick ──────────────────────────────────────────────

    def _tick_teleop(self) -> None:
        if self._closing:
            return
        try:
            now = time.monotonic()
            if (self.state.control_mode == 'MANUAL'
                    and self.bridge.is_connected()
                    and self._pressed
                    and now - self._last_teleop_sent >= TELEOP_INTERVAL):
                vx, vy, omega = self._teleop_vector()
                if not self._geofence_allows_motion(vx, vy, omega):
                    vx, vy, omega = 0, 0, 0
                # Coalesce: only the latest frame matters; the bridge drops older
                # frames in its queue, so we never queue anything here.
                self.bridge.send({'type': 'teleop',
                                  'vx': int(vx),
                                  'vy': int(vy),
                                  'omega': int(omega)})
                self._last_teleop_sent = now
        except Exception as e:
            self._log(f'teleop tick: {e}', error=True)
        if not self._closing:
            self.root.after(int(TELEOP_INTERVAL * 1000), self._tick_teleop)

    def _teleop_vector(self) -> tuple[int, int, int]:
        vx = vy = omega = 0
        k = self._pressed
        if 'w' in k or 'up' in k:
            vx += TELEOP_MAX_VX
        if 's' in k or 'down' in k:
            vx -= TELEOP_MAX_VX
        if 'a' in k or 'left' in k:
            vy -= TELEOP_MAX_VY
        if 'd' in k or 'right' in k:
            vy += TELEOP_MAX_VY
        if 'q' in k:
            omega -= TELEOP_MAX_OMEGA
        if 'e' in k:
            omega += TELEOP_MAX_OMEGA
        return clamp(vx, -255, 255), clamp(vy, -255, 255), clamp(omega, -255, 255)

    # ── Outbound commands ──────────────────────────────────────────

    def _send_cmd(self, command: str) -> None:
        if self.bridge.send({'type': 'cmd', 'command': command}):
            self._log(f'→ cmd:{command}')
        else:
            self._log('cannot send — bridge disconnected', error=True)

    def _send_demo(self, action: str) -> None:
        if self.state.control_mode != 'AUTO':
            self._log(f'❌ demo:{action} rejected (mode is {self.state.control_mode})',
                      error=True)
            return
        if self.bridge.send({'type': 'demo', 'action': action}):
            self._log(f'→ demo:{action}')
        else:
            self._log('cannot send — bridge disconnected', error=True)

    def _send_cylinder(self, action: str) -> None:
        if self.state.control_mode != 'MANUAL':
            self._log(f'❌ cylinder:{action} rejected (mode is {self.state.control_mode})',
                      error=True)
            return
        if self.bridge.send({'type': 'cylinder', 'action': action}):
            self._log(f'→ cylinder:{action}')

    def _set_mode(self, mode: str) -> None:
        if mode not in ('AUTO', 'MANUAL'):
            return
        if self.bridge.send({'type': 'control_mode', 'mode': mode}):
            self._log(f'→ mode:{mode}')

    def _e_stop(self) -> None:
        """Send a firmware-level E-STOP via the dedicated esp32 channel.

        The bridge forwards ``{"cmd":"e_stop"}`` to ``/esp32/cmd`` which
        ``esp32_telemetry_node`` (the sole serial owner) forwards to the
        ESP32 with priority over any in-flight ``move`` commands.
        Then sends a firmware ``stop`` for the brake state.
        """
        if self.bridge.send({'type': 'esp32', 'cmd': {'cmd': 'e_stop'}}):
            self._log('🛑 ESP32 E-STOP issued')
            if self.state.survey_running:
                self.state.survey_paused = True
                self.state.survey_running = False
                self.btn_survey.state(['!disabled'])
                self.btn_survey_reset.state(['!disabled'])
                self._log('⏸ khảo sát đã tạm dừng do E-STOP', error=True)
                self._update_survey_hint()
        else:
            self._log('cannot E-STOP — bridge disconnected', error=True)

    def _reconnect(self) -> None:
        self.bridge.close()
        self.bridge = BridgeClient(self.url, self._log)
        self._log('manual reconnect requested')

    # ── Navigate (Phase 2) + Trip timer + Home (Phase 4) ─────────

    def _send_navigate(self, x: float, y: float, theta: float = 0.0,
                       label: str = 'wp',
                       _survey: bool = False) -> bool:
        if self.state.control_mode != 'AUTO':
            self._log('❌ navigate rejected — cần chuyển sang AUTO mode', error=True)
            return False
        if self.state.nav_active:
            self._log('❌ navigate rejected — robot đang chạy lệnh khác', error=True)
            return False
        # Survey waypoints are user-designed and should always be reachable;
        # skip geofence validation so shelves placed near walls still work.
        if not _survey and self.state.geofence.get('enabled', True):
            poly = self.state.geofence.get('polygon', [])
            # Allow home / waypoints anywhere inside the polygon, even right
            # against the wall — only reject if the goal is genuinely outside.
            if not point_in_polygon(float(x), float(y), poly):
                self._log(f'❌ waypoint ngoài geofence ({x:.2f}, {y:.2f})', error=True)
                return False
        msg = {'type': 'navigate', 'x': float(x), 'y': float(y), 'theta': float(theta)}
        if self.bridge.send(msg):
            self.state.nav_active = True
            self.state.nav_goal = {'x': x, 'y': y, 'theta': theta, 'label': label}
            self.state.nav_start_time = time.monotonic()
            self._log(f'→ navigate tới ({x:.2f}, {y:.2f}) [{label}]')
            return True
        self._log('cannot send navigate — bridge disconnected', error=True)
        return False

    def _send_navigate_home(self) -> bool:
        if self.state.control_mode != 'AUTO':
            self._log('❌ navigate rejected — cần chuyển sang AUTO mode', error=True)
            return False
        if self.state.nav_active:
            self._log('❌ navigate rejected — robot đang chạy lệnh khác', error=True)
            return False
        h = self.state.home_pose
        if not h:
            self._log('❌ chưa đặt Home — bấm "Đặt Home" trước', error=True)
            return False
        return self._send_navigate(h['x'], h['y'], h.get('theta', 0.0), 'home')

    def _begin_place_home(self) -> None:
        self.state.placing_home = True
        self._log('ℹ click vào canvas tại vị trí bất kỳ để đặt Home')

    # ── Auto-survey ─────────────────────────────────────────────────
    # Full workflow:  [go home] → shelf_1 → extend → retract →
    #                  shelf_2 → … → [go home] → done
    # Persists done shelf ids in warehouse_state.json so the survey can
    # resume / be reviewed after app restart.
    # ─────────────────────────────────────────────────────────────────

    def _begin_survey(self) -> None:
        """Start (or resume) the auto-survey shelf-unload loop."""
        if self.state.survey_running:
            self._log('⚠ khảo sát đang chạy — bấm DỪNG trước nếu muốn restart',
                      error=True)
            return
        if not self.bridge.is_connected():
            self._log('❌ chưa kết nối robot', error=True)
            return
        # --- prerequisite checks ---
        if self.state.control_mode != 'AUTO':
            self._log('❌ chuyển sang chế độ AUTO trước', error=True)
            return
        if not self.state.home_pose:
            self._log('❌ chưa đặt Home — bấm "Đặt Home" trước', error=True)
            return
        wp_all = [w for w in self.state.waypoints
                  if isinstance(w, dict) and 'x' in w and 'y' in w]
        if not wp_all:
            self._log('❌ chưa có waypoint kho nào — thêm waypoint ở chế độ '
                      'Bản đồ (vẽ) rồi Lưu bản đồ trước', error=True)
            return

        # Load persistent done ids (resumes where last run left off)
        ws = _load_warehouse_state(_WAREHOUSE_STATE_PATH)
        done_ids: set[int] = set(int(x) for x in ws.get('done_ids', []))

        # Filter out already-done shelves
        pending = [w for w in wp_all if int(w.get('id', -1)) not in done_ids]
        if not pending:
            self._log('✓ tất cả kho đã được đổ — bấm "Reset kho đã đổ" '
                      'để chạy lại toàn bộ', error=True)
            return

        self.state.warehouse_state = ws
        self.state.survey_done_ids = list(done_ids)
        self.state.survey_queue = pending
        self.state.survey_running = True
        self.state.survey_paused = False

        n_done = len(done_ids)
        n_total = len(wp_all)
        self._log(f'📦 BẮT ĐẦU KHẢO SÁT: {len(pending)} kho còn trống '
                  f'({n_done}/{n_total} đã đổ)')
        self._log('→ đang về Home…')

        # Disable STOP/RESET buttons to prevent mid-survey edits
        self.btn_survey.state(['disabled'])
        self.btn_survey_reset.state(['disabled'])
        self._update_survey_hint()

        # Navigate to home first; _poll_survey picks up on arrival.
        self.state.survey_substep = 'home'
        h = self.state.home_pose
        self._send_navigate(h['x'], h['y'], h.get('theta', 0.0),
                            'survey-home', _survey=True)
        self._poll_survey()

    def _poll_survey(self) -> None:
        """Called via root.after; drives the survey state machine."""
        if not self.state.survey_running:
            self._update_survey_hint()
            return
        if self.state.survey_paused:
            self.root.after(300, self._poll_survey)
            return

        st = self.state.survey_substep

        # Still waiting for a navigate result — poll again
        if st in ('home', 'navigate') and self.state.nav_active:
            self.root.after(300, self._poll_survey)
            return

        # ── Reached home ─────────────────────────────────────────
        if st == 'home' and not self.state.nav_active:
            self.state.survey_substep = 'navigate'
            self._go_to_next_shelf()
            self.root.after(300, self._poll_survey)
            return

        # ── Navigation completed — start unload action ───────────
        if st == 'navigate' and not self.state.nav_active:
            self.state.survey_substep = 'extend'
            self.state.survey_substep_at = time.monotonic()
            self._send_esp32({'cmd': 'extend'})
            wp = self.state.survey_queue[0]
            self._log(f'📦 xi-lanh mở tại {wp.get("label", "?")}')
            self.root.after(300, self._poll_survey)
            return

        # ── Extend → Retract after 1.5s ──────────────────────────
        if st == 'extend':
            elapsed = time.monotonic() - self.state.survey_substep_at
            if elapsed >= 1.5:
                self.state.survey_substep = 'retract'
                self.state.survey_substep_at = time.monotonic()
                self._send_esp32({'cmd': 'retract'})
                self._log('📦 xi-lanh thu vào')
            self.root.after(300, self._poll_survey)
            return

        # ── Retract → done, go to next shelf after 1.5s ──────────
        if st == 'retract':
            elapsed = time.monotonic() - self.state.survey_substep_at
            if elapsed >= 1.5:
                self._on_survey_shelf_done()
                self.root.after(300, self._poll_survey)
                return
            self.root.after(300, self._poll_survey)
            return

    def _go_to_next_shelf(self) -> None:
        """Send navigate to the next pending shelf, or go home when all done."""
        if not self.state.survey_queue:
            self._finish_survey()
            return
        wp = self.state.survey_queue[0]
        self.state.survey_substep = 'navigate'
        self._send_navigate(float(wp['x']), float(wp['y']),
                            float(wp.get('theta', 0.0)),
                            f"survey-wp-{wp.get('id', '?')}",
                            _survey=True)

    def _on_survey_shelf_done(self) -> None:
        """Mark the current shelf as done, save state, and move on."""
        if not self.state.survey_queue:
            self._finish_survey()
            return
        wp = self.state.survey_queue.pop(0)
        wp_id = int(wp.get('id', -1))
        if wp_id >= 0:
            self.state.survey_done_ids.append(wp_id)

        # Persist
        ws = self.state.warehouse_state.copy()
        ws['done_ids'] = list(self.state.survey_done_ids)
        ws['last_run_ts'] = time.time()
        ws['total_unloads'] = int(ws.get('total_unloads', 0)) + 1
        self.state.warehouse_state = ws
        _save_warehouse_state(_WAREHOUSE_STATE_PATH, ws)

        n_left = len(self.state.survey_queue)
        n_done_ws = len(ws['done_ids'])
        self._log(f'✓ kho {wp.get("label", wp_id)} hoàn thành — '
                  f'còn {n_left} kho ({n_done_ws} đã đổ)')
        self._update_survey_hint()

        if self.state.survey_queue:
            self._go_to_next_shelf()
        else:
            # All shelves done — return to home
            self._log('🏁 tất cả kho đã đổ — về Home…')
            self.state.survey_substep = 'home'
            h = self.state.home_pose
            self._send_navigate(h['x'], h['y'], h.get('theta', 0.0),
                                'survey-home-final', _survey=True)
            # Wait for arrival then finish
            self._poll_survey()

    def _finish_survey(self) -> None:
        self.state.survey_running = False
        n_done = len(self.state.survey_done_ids)
        self._log(f'🏁 KHẢO SÁT HOÀN THÀNH — {n_done} kho đã đổ')
        self.btn_survey.state(['!disabled'])
        self.btn_survey_reset.state(['!disabled'])
        self._update_survey_hint()

    def _stop_survey(self) -> None:
        """Pause the running survey (does not cancel current navigate)."""
        if not self.state.survey_running:
            return
        self.state.survey_paused = True
        self.state.survey_running = False
        self._send_esp32({'cmd': 'stop'})
        n_left = len(self.state.survey_queue) + (1 if self.state.survey_substep in ('extend', 'retract') else 0)
        self._log(f'⏸ khảo sát tạm dừng — còn {n_left} kho',
                  error=True)
        self.btn_survey.state(['!disabled'])
        self.btn_survey_reset.state(['!disabled'])
        self._update_survey_hint()

    def _reset_survey_done(self) -> None:
        """Clear the persistent done_ids so next survey starts fresh."""
        ws = _load_warehouse_state(_WAREHOUSE_STATE_PATH)
        if not ws.get('done_ids'):
            self._log('ℹ chưa có kho nào được đánh dấu đã đổ')
            return
        ws['done_ids'] = []
        _save_warehouse_state(_WAREHOUSE_STATE_PATH, ws)
        self.state.warehouse_state = ws
        self.state.survey_done_ids = []
        self._log('✓ đã reset danh sách kho đã đổ — khảo sát lại sẽ '
                  'đổ từ đầu')
        self._update_survey_hint()

    def _update_survey_hint(self) -> None:
        if not hasattr(self, 'survey_hint') or not self.survey_hint:
            return
        ws = self.state.warehouse_state
        n_done = len(ws.get('done_ids', []))
        wp_all = [w for w in self.state.waypoints
                  if isinstance(w, dict) and 'x' in w and 'y' in w]
        n_total = len(wp_all)
        if self.state.survey_running:
            q = len(self.state.survey_queue)
            self.survey_hint.config(
                text=f'🔄 đang chạy: còn {q} kho chưa đổ',
                foreground='#00d4ff')
        elif self.state.survey_paused:
            self.survey_hint.config(
                text=f'⏸ đã tạm dừng ({n_done}/{n_total} đã đổ)',
                foreground='#ffaa00')
        elif n_done == 0:
            self.survey_hint.config(
                text=f'{n_total} kho chờ khảo sát',
                foreground='#88aacc')
        else:
            self.survey_hint.config(
                text=f'{n_done}/{n_total} kho đã đổ',
                foreground='#44ff88')

    # ── UDP auto-discovery ─────────────────────────────────────────────

    def _start_udp_scan(self) -> None:
        self._log('🔍 đang tìm robot trên mạng …')
        self._udp_discovery = UDPDiscovery(self.root, self._on_device_found)
        self._udp_discovery.scan()

    def _on_device_found(self, device: dict) -> None:
        ws_url = device.get('ws_url', '')
        hostname = device.get('hostname', device.get('ip', '?'))
        self._log(f'✓ tìm thấy: {hostname} — {ws_url}')
        self._discovered_devices.append(device)
        if self.bridge._connected.is_set():
            return
        self._log(f'→ tự động kết nối {ws_url} …')
        self._reconnect_to_url(ws_url)

    def _on_manual_connect(self) -> None:
        win = tk.Toplevel(self.root)
        win.title('Kết nối thủ công')
        win.geometry('340x130')
        win.transient(self.root)
        win.grab_set()
        ttk.Label(win, text='Nhập IP hoặc URL của Pi 5:',
                  font=('Segoe UI', 10)).pack(padx=12, pady=(10, 4), anchor='w')
        var = tk.StringVar(value='ws://')
        entry = ttk.Entry(win, textvariable=var, width=38,
                          font=('Consolas', 10))
        entry.pack(padx=12, pady=4)
        entry.select_range(0, tk.END)
        entry.focus_set()

        def connect() -> None:
            url_str = var.get().strip()
            if not url_str:
                return
            if not url_str.startswith('ws://') and not url_str.startswith('wss://'):
                url_str = f'ws://{url_str}:9091'
            win.destroy()
            self._reconnect_to_url(url_str)

        ttk.Button(win, text='Kết nối', command=connect).pack(
            padx=12, pady=8, fill='x')
        entry.bind('<Return>', lambda _: connect())

    def _reconnect_to_url(self, ws_url: str) -> None:
        """Switch the WebSocket bridge to a new URL (discovered or manual)."""
        self.url = ws_url
        self.root.title(f'AGV Operator — {ws_url}')
        self.bridge.close()
        self.bridge = BridgeClient(ws_url, self._log)
        self._log(f'→ đã chuyển sang {ws_url}')

    def _go_home(self) -> None:
        self._send_navigate_home()

    def _finalize_trip(self, success: bool, duration: float) -> None:
        if not self.state.nav_goal:
            return
        entry = {
            'start_ts': time.time() - duration,
            'end_ts': time.time(),
            'duration_s': round(duration, 2),
            'goal': self.state.nav_goal,
            'status': 'completed' if success else 'failed',
        }
        self.state.trip_log.append(entry)
        if len(self.state.trip_log) > 200:
            self.state.trip_log = self.state.trip_log[-200:]
        _save_json(_TRIP_LOG_PATH, self.state.trip_log)
        self.state.nav_goal = None
        # If we're running a scripted sequence, advance.
        if self.state.sequence_running and not self.state.sequence_paused:
            self._advance_sequence()

    def _refresh_timer_label(self) -> None:
        if self._closing:
            return
        if self.state.nav_active and self.state.nav_start_time > 0:
            elapsed = time.monotonic() - self.state.nav_start_time
            mins, secs = divmod(elapsed, 60)
            text = f'⏱ {int(mins):02d}:{secs:04.1f}'
        else:
            text = '⏱ 00:00.0'
        self.trip_timer_label.config(text=text)
        # Home label
        if self.state.home_pose:
            h = self.state.home_pose
            self.home_label.config(text=f'({h["x"]:.2f}, {h["y"]:.2f})')
        else:
            self.home_label.config(text='(chưa đặt)')
        if not self._closing:
            self.root.after(100, self._refresh_timer_label)

    def _record_replay_sample(self) -> None:
        pose = self.state.pose or {}
        # Snapshot scan (small list, just point coords)
        scan = [[round(p[0], 3), round(p[1], 3)] for p in self.state.scan_points[:360]]
        sample = {
            't': time.monotonic() - self.state.replay_start_time,
            'pose': {k: pose.get(k, 0) for k in ('x', 'y', 'theta')},
            'scan': scan,
            'mode': self.state.control_mode,
        }
        self.state.replay_data.append(sample)
        if len(self.state.replay_data) > 50 * 60 * 5:  # 5 min cap
            self.state.replay_data = self.state.replay_data[-50 * 60 * 5:]

    def _export_trip_csv(self) -> None:
        if not self.state.trip_log:
            self._log('⚠ chưa có chuyến đi để xuất', error=True)
            return
        path = _os.path.join(_DESKTOP_DIR, 'trip_log.csv')
        try:
            with open(path, 'w', encoding='utf-8') as f:
                f.write('start_iso,end_iso,duration_s,status,goal_x,goal_y,goal_theta,label\n')
                for e in self.state.trip_log:
                    import datetime as _dt
                    s = _dt.datetime.fromtimestamp(e['start_ts']).isoformat()
                    en = _dt.datetime.fromtimestamp(e['end_ts']).isoformat()
                    g = e.get('goal', {})
                    f.write(f'{s},{en},{e.get("duration_s", 0)},{e.get("status", "?")},'
                            f'{g.get("x", "")},{g.get("y", "")},{g.get("theta", "")},'
                            f'{g.get("label", "")}\n')
            self._log(f'✓ đã xuất {path}')
        except Exception as exc:
            self._log(f'❌ xuất CSV lỗi: {exc}', error=True)

    # ── Inbound dispatch ───────────────────────────────────────────

    def _drain_incoming(self) -> None:
        if self._closing:
            return
        try:
            for _ in range(200):
                msg = self.bridge.incoming.get_nowait()
                self._handle(msg)
        except queue.Empty:
            pass
        self._refresh_view()
        if not self._closing:
            self.root.after(50, self._drain_incoming)

    def _handle(self, msg: dict) -> None:
        t = msg.get('type')
        data = msg.get('data')

        if t == '_connection':
            conn_state = msg.get('data', msg.get('state'))
            self.state.connected = (conn_state == 'connected')
            self.state.connection_message = ('● connected'
                                             if self.state.connected
                                             else '● disconnected')
            return

        if t == 'pose':
            self.state.pose = data
            self.state.pose_ts = time.monotonic()
            # Home is now set explicitly via "Đặt Home" — no auto-capture.
            # Replay recording samples at receive cadence.
            if self.state.replay_recording:
                self._record_replay_sample()
            self._check_geofence(data.get('x', 0), data.get('y', 0))
            return

        if t == 'scan':
            pts = data.get('points') or []
            self.state.scan_points = [(p['x'], p['y']) for p in pts]
            self.state.scan_ts = time.monotonic()
            return

        if t == 'map_layer':
            self.state.map_data = data
            return

        if t == 'mode':
            self.state.mode = data
            return

        if t == 'status':
            self.state.status_text = data
            return

        if t == 'info':
            self.state.info = data
            return

        if t == 'control_mode_status':
            if isinstance(data, dict):
                new_mode = str(data.get('mode', '')).upper()
                if new_mode in ('AUTO', 'MANUAL'):
                    self.state.control_mode = new_mode
            return

        if t == 'esp32_status':
            self.state.esp32_status = data
            return

        if t == 'esp32_encoder':
            self.state.esp32_encoder = data
            return

        if t == 'demo_status':
            self.state.demo_status = data
            return

        if t == 'ack':
            cmd = safe_get(data, 'command', default='?')
            accepted = safe_get(data, 'accepted', default=False)
            err = safe_get(data, 'error', default=None)
            if accepted:
                self.state.push_log(f'✓ {cmd}')
            else:
                self.state.push_log(f'✗ {cmd}' + (f' — {err}' if err else ''))
            return

        if t == 'pong':
            return

        if t == 'navigate_result':
            ok = bool(data.get('success', False))
            duration = float(data.get('duration_s', 0.0))
            self.state.nav_active = False
            self._log(f'{"✓" if ok else "✗"} navigate result: {duration:.1f}s')
            self._finalize_trip(ok, duration)
            return

        if t == 'navigate_status':
            self._log(f'⏳ nav: {data}')
            return

    # ── Geofence safety ─────────────────────────────────────────────

    def _check_geofence(self, x: float, y: float) -> None:
        cfg = self.state.geofence
        if not cfg.get('enabled', True):
            self.state.geofence_ok = True
            self.state.geofence_warn = False
            self.state.geofence_breach = False
            return
        poly = cfg.get('polygon', [])
        signed_distance = distance_to_polygon_edge(float(x), float(y), poly)
        inside = signed_distance >= 0.0
        abs_distance = abs(signed_distance)
        soft = max(0.0, float(cfg.get('soft_margin_m', 0.30)))
        hard = max(0.0, float(cfg.get('hard_margin_m', 0.10)))
        self.state.geofence_ok = inside
        self.state.geofence_warn = inside and abs_distance <= soft
        self.state.geofence_breach = (not inside) and abs_distance >= hard
        self.state.geofence_last_pose = {'x': float(x), 'y': float(y), 'distance_m': signed_distance}
        if inside:
            self.state.geofence_violation_count = 0
            self._geofence_warned_once = False
            return
        self.state.geofence_violation_count += 1
        # One confirmed pose outside the hard boundary is enough to stop.
        if self.state.geofence_violation_count == 1:
            self._log(f'⚠ GEOFENCE: robot ngoài vùng tại ({x:.2f}, {y:.2f})', error=True)
            self._send_esp32({'cmd': 'e_stop'})

    def _geofence_allows_motion(self, vx: int, vy: int, omega: int) -> bool:
        cfg = self.state.geofence
        if not cfg.get('enabled', True) or not self.state.pose:
            return True
        if self.state.geofence_breach or not self.state.geofence_ok:
            if not self._geofence_warned_once:
                self._log('❌ GEOFENCE: khóa điều khiển vì robot ngoài vùng', error=True)
                self._geofence_warned_once = True
            return False
        if vx == 0 and vy == 0:
            return True
        pose = self.state.pose
        theta = float(pose.get('theta', 0.0))
        dx, dy = geofence_predict(vx, vy, 0.25, theta)
        px = float(pose.get('x', 0.0)) + dx
        py = float(pose.get('y', 0.0)) + dy
        poly = cfg.get('polygon', [])
        margin = max(0.0, float(cfg.get('hard_margin_m', 0.10)))
        allowed = point_in_polygon(px, py, poly)
        if not allowed or distance_to_polygon_edge(px, py, poly) < margin:
            if not self._geofence_warned_once:
                self._log('⚠ GEOFENCE: chặn lệnh đi ra ngoài vùng cho phép', error=True)
                self._geofence_warned_once = True
            return False
        return True

    def _send_esp32(self, cmd: dict) -> bool:
        if self.bridge.send({'type': 'esp32', 'cmd': cmd}):
            self._log(f'→ esp32:{cmd.get("cmd", "?")}')
            return True
        self._log('cannot send ESP32 command — bridge disconnected', error=True)
        return False

    def _open_geofence_editor(self) -> None:
        """Open a small JSON editor so the operator can calibrate the polygon."""
        win = tk.Toplevel(self.root)
        win.title('Geofence — vùng hoạt động cho phép')
        win.geometry('620x440')
        win.transient(self.root)
        text = tk.Text(win, font=('Consolas', 10), wrap='none')
        text.pack(fill='both', expand=True, padx=8, pady=8)
        text.insert('1.0', json.dumps(self.state.geofence, indent=2, ensure_ascii=False))
        def save() -> None:
            try:
                cfg = json.loads(text.get('1.0', 'end'))
                poly = cfg.get('polygon', [])
                if not cfg.get('enabled', True) or (isinstance(poly, list) and len(poly) >= 3):
                    geofence_save(_GEOFENCE_PATH, cfg)
                    self.state.geofence = cfg
                    self._log('✓ đã lưu geofence.json')
                    win.destroy()
                else:
                    raise ValueError('polygon cần ít nhất 3 điểm [x, y]')
            except Exception as exc:
                self._log(f'❌ geofence không hợp lệ: {exc}', error=True)
        ttk.Button(win, text='Lưu vùng hoạt động', command=save).pack(pady=(0, 8))

    # ── Waypoint tab handlers ────────────────────────────
    def _selected_waypoint_id(self) -> int | None:
        sel = self.waypoint_list.curselection()
        if not sel:
            return None
        for w in self.state.waypoints:
            if str(w['id']) == self.waypoint_list.get(sel[0]).split(' ')[0]:
                return w['id']
        return None

    def _goto_selected_waypoint(self) -> None:
        wid = self._selected_waypoint_id()
        if wid is None:
            self._log('⚠ chọn 1 waypoint trước', error=True)
            return
        w = next((x for x in self.state.waypoints if x['id'] == wid), None)
        if w is None:
            return
        self._send_navigate(w['x'], w['y'], w.get('theta', 0.0), str(w['id']))

    def _delete_selected_waypoint(self) -> None:
        wid = self._selected_waypoint_id()
        if wid is None:
            return
        self.state.waypoints = [w for w in self.state.waypoints if w['id'] != wid]
        _save_json(_WAYPOINTS_PATH, self.state.waypoints)
        self._refresh_waypoint_list()
        self._log(f'✓ đã xóa waypoint #{wid}')

    def _rename_selected_waypoint(self) -> None:
        wid = self._selected_waypoint_id()
        if wid is None:
            return
        from tkinter import simpledialog as _sd
        new_label = _sd.askstring('Đổi tên', f'Đổi tên waypoint #{wid}:',
                                  initialvalue=str(wid))
        if not new_label:
            return
        for w in self.state.waypoints:
            if w['id'] == wid:
                w['label'] = new_label
        _save_json(_WAYPOINTS_PATH, self.state.waypoints)
        self._refresh_waypoint_list()
        self._log(f'✓ waypoint #{wid} đổi tên → {new_label}')

    def _refresh_waypoint_list(self) -> None:
        if not hasattr(self, 'waypoint_list'):
            return
        self.waypoint_list.delete(0, tk.END)
        for w in self.state.waypoints:
            self.waypoint_list.insert(
                tk.END,
                f"{w['id']}  ({w['x']:+.2f},{w['y']:+.2f})  {w.get('label', '')}",
            )

    # ── Sequence (scripted trip) handlers ─────────────────────
    def _sequence_save(self) -> None:
        _save_json(_SEQUENCE_PATH, self.state.sequence)
        self._log(f'✓ đã lưu sequence ({len(self.state.sequence)} bước)')

    def _sequence_add_waypoint(self) -> None:
        if not self.state.waypoints:
            self._log('⚠ chưa có waypoint — chuyển sang tab Waypoint trên bản đồ',
                      error=True)
            return
        # Use the first waypoint as a placeholder; user can edit later.
        wp = self.state.waypoints[0]
        self.state.sequence.append({'type': 'navigate',
                                    'waypoint_id': wp['id']})
        self._sequence_save()
        self._refresh_sequence_list()

    def _sequence_add_home(self) -> None:
        self.state.sequence.append({'type': 'navigate_home'})
        self._sequence_save()
        self._refresh_sequence_list()

    def _sequence_add_cylinder(self, action: str) -> None:
        self.state.sequence.append({'type': 'cylinder', 'action': action})
        self._sequence_save()
        self._refresh_sequence_list()

    def _sequence_add_wait(self) -> None:
        from tkinter import simpledialog as _sd
        secs = _sd.askfloat('Wait', 'Số giây chờ:', initialvalue=2.0, minvalue=0.1)
        if not secs:
            return
        self.state.sequence.append({'type': 'wait', 'wait_s': float(secs)})
        self._sequence_save()
        self._refresh_sequence_list()

    def _sequence_delete_selected(self) -> None:
        sel = self.sequence_list.curselection()
        if not sel:
            return
        idx = sel[0]
        if 0 <= idx < len(self.state.sequence):
            self.state.sequence.pop(idx)
            self._sequence_save()
            self._refresh_sequence_list()

    def _sequence_play(self) -> None:
        if not self.state.sequence:
            self._log('⚠ sequence trống', error=True)
            return
        self.state.sequence_running = True
        self.state.sequence_paused = False
        self.state.sequence_index = 0
        self._log(f'▶ chạy sequence ({len(self.state.sequence)} bước)')
        self._execute_sequence_step()

    def _sequence_pause(self) -> None:
        self.state.sequence_paused = True
        self._log('⏸ sequence tạm dừng')

    def _sequence_stop(self) -> None:
        self.state.sequence_running = False
        self.state.sequence_paused = False
        self.state.sequence_index = 0
        self._log('⏹ sequence dừng')

    def _refresh_sequence_list(self) -> None:
        if not hasattr(self, 'sequence_list'):
            return
        self.sequence_list.delete(0, tk.END)
        for i, step in enumerate(self.state.sequence):
            label = step.get('type', '?')
            if label == 'navigate':
                wid = step.get('waypoint_id', '?')
                self.sequence_list.insert(tk.END, f'{i + 1}. navigate → wp #{wid}')
            elif label == 'navigate_home':
                self.sequence_list.insert(tk.END, f'{i + 1}. navigate_home')
            elif label == 'cylinder':
                self.sequence_list.insert(tk.END, f"{i + 1}. cylinder {step.get('action', '?')}")
            elif label == 'wait':
                self.sequence_list.insert(tk.END, f"{i + 1}. wait {step.get('wait_s', 0)}s")
            else:
                self.sequence_list.insert(tk.END, f'{i + 1}. {label}')

    def _execute_sequence_step(self) -> None:
        if not self.state.sequence_running or self.state.sequence_paused:
            return
        if self.state.sequence_index >= len(self.state.sequence):
            self._log('✓ sequence hoàn tất')
            self.state.sequence_running = False
            return
        step = self.state.sequence[self.state.sequence_index]
        kind = step.get('type', '?')
        self._log(f'▶ sequence[{self.state.sequence_index + 1}] {kind}')

        if kind == 'navigate':
            wid = step.get('waypoint_id')
            wp = next((w for w in self.state.waypoints if w['id'] == wid), None)
            if wp is None:
                self._log(f'⚠ wp #{wid} không tồn tại', error=True)
                self._advance_sequence()
                return
            self.state.nav_step_index = self.state.sequence_index
            self._send_navigate(wp['x'], wp['y'], wp.get('theta', 0.0),
                                str(wp['id']))
            # _finalize_trip advances the sequence on navigate_result.
        elif kind == 'navigate_home':
            self.state.nav_step_index = self.state.sequence_index
            self._send_navigate_home()
        elif kind == 'cylinder':
            action = step.get('action', 'stop')
            if self.state.control_mode == 'MANUAL':
                self.bridge.send({'type': 'cylinder', 'action': action})
                self._log(f'→ cylinder:{action}')
            self.root.after(800, self._advance_sequence)
        elif kind == 'wait':
            secs = float(step.get('wait_s', 1.0))
            self.root.after(int(secs * 1000), self._advance_sequence)
        else:
            self._log(f'⚠ unknown step {kind}', error=True)
            self._advance_sequence()

    def _advance_sequence(self) -> None:
        self.state.sequence_index += 1
        self.root.after(50, self._execute_sequence_step)

    # ── Wall tab handlers ──────────────────────────────────────────────
    def _refresh_wall_list(self) -> None:
        if not hasattr(self, 'wall_list'):
            return
        self.wall_list.delete(0, tk.END)
        for i, line in enumerate(self.state.map_lines):
            x1, y1, x2, y2 = line[0], line[1], line[2], line[3]
            length = math.hypot(x2 - x1, y2 - y1)
            self.wall_list.insert(tk.END, f'#{i}  dài {length:.2f}m')
        if 0 <= self.state.selected_wall_index < len(self.state.map_lines):
            self.wall_list.selection_set(self.state.selected_wall_index)

    def _select_wall_from_list(self, _ev=None) -> None:
        sel = self.wall_list.curselection()
        if sel:
            self.state.selected_wall_index = sel[0]
        else:
            self.state.selected_wall_index = -1

    def _delete_wall_from_list(self) -> None:
        sel = self.wall_list.curselection()
        if not sel:
            self._log('⚠ chọn 1 line trước', error=True)
            return
        idx = sel[0]
        if 0 <= idx < len(self.state.map_lines):
            self.state.map_lines.pop(idx)
            self.state.selected_wall_index = -1
            _save_json(_MAP_PATH, self.state.map_lines)
            self._log(f'✓ đã xóa line #{idx}')
            self._auto_update_geofence()

    def _edit_wall_from_list(self) -> None:
        sel = self.wall_list.curselection()
        if not sel:
            self._log('⚠ chọn 1 line trước', error=True)
            return
        idx = sel[0]
        if 0 <= idx < len(self.state.map_lines):
            self._open_wall_editor(idx)

    def _apply_walls_as_geofence(self) -> None:
        """Convert exactly 4 drawn walls into a geofence polygon."""
        if len(self.state.map_lines) != 4:
            self._log(f'⚠ cần đúng 4 tường (hiện có {len(self.state.map_lines)})',
                      error=True)
            return
        # Collect all 8 endpoints from 4 walls
        points: list[tuple[float, float]] = []
        for wall in self.state.map_lines:
            points.append((wall[0], wall[1]))
            points.append((wall[2], wall[3]))
        # De-duplicate near-identical points (walls sharing a corner)
        unique: list[tuple[float, float]] = [points[0]]
        for p in points[1:]:
            if all(math.hypot(p[0] - u[0], p[1] - u[1]) > 0.05 for u in unique):
                unique.append(p)
        if len(unique) < 3:
            self._log('⚠ các tường không tạo được polygon đủ đỉnh', error=True)
            return
        # Sort by angle from centroid → ordered polygon
        cx = sum(p[0] for p in unique) / len(unique)
        cy = sum(p[1] for p in unique) / len(unique)
        unique.sort(key=lambda p: math.atan2(p[1] - cy, p[0] - cx))
        # Write to geofence
        cfg = self.state.geofence.copy()
        cfg['polygon'] = [[round(p[0], 3), round(p[1], 3)] for p in unique]
        cfg['enabled'] = True
        geofence_save(_GEOFENCE_PATH, cfg)
        self.state.geofence = cfg
        self._log(f'✓ geofence từ 4 tường → {len(unique)} đỉnh polygon')

    # ── Trip log + replay handlers ─────���───────────────────
    def _toggle_replay_recording(self) -> None:
        if self.state.replay_recording:
            self._save_replay()
            self.state.replay_recording = False
            self._log('⏹ replay recording dừng')
        else:
            self.state.replay_data.clear()
            self.state.replay_start_time = time.monotonic()
            self.state.replay_recording = True
            self._log('⏺ replay recording bắt đầu')

    def _save_replay(self) -> None:
        if not self.state.replay_data:
            return
        stamp = time.strftime('%Y%m%d_%H%M%S')
        path = _os.path.join(_DESKTOP_DIR, f'replay_{stamp}.json')
        payload = {
            'started_at': time.time() - (time.monotonic() - self.state.replay_start_time),
            'duration_s': round(time.monotonic() - self.state.replay_start_time, 2),
            'samples': self.state.replay_data,
        }
        _save_json(path, payload)
        self._log(f'✓ đã lưu replay → {path}')

    def _open_replay_viewer(self) -> None:
        if not self.state.replay_data:
            self._log('⚠ chưa có dữ liệu replay', error=True)
            return
        win = tk.Toplevel(self.root)
        win.title('Replay — xem lại')
        win.geometry('640x460')
        win.transient(self.root)

        info = ttk.Label(win, text='', font=('Consolas', 9))
        info.pack(padx=8, pady=4, anchor='w')

        canvas = tk.Canvas(win, width=600, height=380, bg='#04060b', highlightthickness=0)
        canvas.pack(padx=8, pady=4, fill='both', expand=True)

        data = self.state.replay_data
        if not data:
            info.config(text='(trống)')
            return
        info.config(text=f'{len(data)} mẫu  •  {data[-1]["t"]:.1f}s cuối')

        # Compute bounds
        xs = [s['pose'].get('x', 0) for s in data]
        ys = [s['pose'].get('y', 0) for s in data]
        x_min, x_max = min(xs), max(xs)
        y_min, y_max = min(ys), max(ys)
        cx, cy = (x_min + x_max) / 2, (y_min + y_max) / 2
        span = max(x_max - x_min, y_max - y_min, 1.0) + 1.0
        ppm = min(600, 380) / span

        def plot(frac: float) -> None:
            canvas.delete('all')
            n = max(1, int(len(data) * frac))
            pts = data[:n]
            for i in range(1, len(pts)):
                p1 = pts[i - 1]['pose']
                p2 = pts[i]['pose']
                x1 = 300 + (p1.get('x', 0) - cx) * ppm
                y1 = 190 - (p1.get('y', 0) - cy) * ppm
                x2 = 300 + (p2.get('x', 0) - cx) * ppm
                y2 = 190 - (p2.get('y', 0) - cy) * ppm
                canvas.create_line(x1, y1, x2, y2, fill='#00d4ff', width=2)
            if pts:
                last = pts[-1]['pose']
                lx = 300 + (last.get('x', 0) - cx) * ppm
                ly = 190 - (last.get('y', 0) - cy) * ppm
                canvas.create_oval(lx - 6, ly - 6, lx + 6, ly + 6,
                                   fill='#00ff88', outline='#ffffff', width=2)
                info.config(text=f'{n}/{len(data)} mẫu  •  t={pts[-1]["t"]:.1f}s  '
                                 f'pos=({last.get("x", 0):.2f}, {last.get("y", 0):.2f})')

        plot(1.0)
        ttk.Button(win, text='Đóng', command=win.destroy).pack(pady=(0, 8))

    # ── Rendering ──────────────────────────────────────────────────

    def _refresh_view(self) -> None:
        self._draw_minimap()
        self._refresh_labels()
        self._refresh_esp32_panel()
        self._refresh_demo_panel()
        self._refresh_log_panel()
        self._refresh_waypoint_list()
        self._refresh_wall_list()
        self._refresh_sequence_list()
        self._refresh_trip_text()
        self._refresh_button_state()

    def _draw_minimap(self) -> None:
        if self.state.canvas_mode in ('design', 'waypoint'):
            self._draw_world_canvas()
            return
        c = self.canvas
        c.delete('all')
        W = c.winfo_width() or MINI_SIZE
        H = c.winfo_height() or MINI_SIZE
        # Background
        c.create_rectangle(0, 0, W, H, fill='#07101c', outline='')

        # Radial radar rings
        cx, cy = W / 2, H / 2
        scale = (min(W, H) / 2 - 10) / MAP_VIEW_RANGE
        for r in (1, 2, 3):
            c.create_arc(cx - r * scale, cy - r * scale,
                         cx + r * scale, cy + r * scale,
                         start=0, extent=359.9, style='arc',
                         outline='#0aa3c7' if r == 3 else '#0a3a4a',
                         width=1 if r == 3 else 1)
        c.create_line(0, cy, W, cy, fill='#103040', dash=(2, 4))
        c.create_line(cx, 0, cx, H, fill='#103040', dash=(2, 4))

        # Scan points
        stale = (time.monotonic() - self.state.scan_ts) > STALE_DATA_AFTER
        if self.state.scan_points and not stale:
            pts = self.state.scan_points
            if len(pts) > 300:
                pts = pts[::3]
            for x, y in pts:
                # scan points are robot-centric; we render in robot frame
                sx = cx + x * scale
                sy = cy - y * scale
                if 0 <= sx < W and 0 <= sy < H:
                    c.create_oval(sx - 1, sy - 1, sx + 1, sy + 1,
                                  fill='#00d4ff', outline='')

        # Geofence polygon (if enabled and pose known)
        cfg = self.state.geofence
        if cfg.get('enabled', True) and self.state.pose:
            poly = cfg.get('polygon', [])
            if len(poly) >= 3:
                # Render polygon in world coords (map frame).
                px = self.state.pose.get('x', 0.0)
                py = self.state.pose.get('y', 0.0)
                world_pts = [(px + vx, py + vy) for vx, vy in poly]
                screen_pts = [cx + wx * scale for wx, _ in world_pts]
                # Y is flipped: world Y+ up, screen Y+ down.
                screen_pts_y = [cy - wy * scale for _, wy in world_pts]
                flat = []
                for sx, sy in zip(screen_pts, screen_pts_y):
                    flat.extend([sx, sy])
                if self.state.geofence_breach or not self.state.geofence_ok:
                    fill_color = '#3a0a0a'
                    outline_color = '#ff4444'
                elif self.state.geofence_warn:
                    fill_color = '#3a2a0a'
                    outline_color = '#ffb800'
                else:
                    fill_color = '#0a3a0a'
                    outline_color = '#00ff88'
                c.create_polygon(flat, fill=fill_color, outline=outline_color,
                                 width=2, dash=(4, 3))

        # Robot at center
        c.create_oval(cx - 5, cy - 5, cx + 5, cy + 5,
                      fill='#00ff88', outline='')
        c.create_polygon(cx + 8, cy, cx + 2, cy - 3, cx + 2, cy + 3,
                        fill='#ff3b5c', outline='')

        # Stale banner
        if stale:
            c.create_rectangle(0, H - 26, W, H, fill='#1a0808', stipple='gray50')
            c.create_text(W / 2, H - 13, text='⚠ không có dữ liệu quét',
                          fill='#ff6666', font=('Segoe UI', 9, 'bold'))

    def _draw_world_canvas(self) -> None:
        """Designer / waypoint canvas: world-frame, metres, grid, map lines."""
        c = self.canvas
        c.delete('all')
        W = c.winfo_width() or MINI_SIZE
        H = c.winfo_height() or MINI_SIZE
        c.create_rectangle(0, 0, W, H, fill='#06101c', outline='')

        # Grid bounds in world coordinates
        wx0, wy0 = self._screen_to_world(0, H, W, H)
        wx1, wy1 = self._screen_to_world(W, 0, W, H)
        min_x, max_x = math.floor(min(wx0, wx1)) - 1, math.ceil(max(wx0, wx1)) + 1
        min_y, max_y = math.floor(min(wy0, wy1)) - 1, math.ceil(max(wy0, wy1)) + 1

        # 1m grid; thicker every 5m
        for x in range(min_x, max_x + 1):
            sx1, sy1 = self._world_to_screen(x, min_y, W, H)
            sx2, sy2 = self._world_to_screen(x, max_y, W, H)
            color = '#244052' if x % 5 == 0 else '#102434'
            c.create_line(sx1, sy1, sx2, sy2, fill=color, width=1)
            if x % 2 == 0:
                c.create_text(sx1 + 16, 14, text=f'{x}m', fill='#406070',
                              font=('Consolas', 7))
        for y in range(min_y, max_y + 1):
            sx1, sy1 = self._world_to_screen(min_x, y, W, H)
            sx2, sy2 = self._world_to_screen(max_x, y, W, H)
            color = '#244052' if y % 5 == 0 else '#102434'
            c.create_line(sx1, sy1, sx2, sy2, fill=color, width=1)
            if y % 2 == 0:
                c.create_text(20, sy1 - 8, text=f'{y}m', fill='#406070',
                              font=('Consolas', 7))

        # Axis lines
        sx1, sy1 = self._world_to_screen(min_x, 0, W, H)
        sx2, sy2 = self._world_to_screen(max_x, 0, W, H)
        c.create_line(sx1, sy1, sx2, sy2, fill='#00d4ff', width=2)
        sx1, sy1 = self._world_to_screen(0, min_y, W, H)
        sx2, sy2 = self._world_to_screen(0, max_y, W, H)
        c.create_line(sx1, sy1, sx2, sy2, fill='#00d4ff', width=2)

        # Geofence polygon
        cfg = self.state.geofence
        poly = cfg.get('polygon', []) if cfg.get('enabled', True) else []
        if len(poly) >= 3:
            flat = []
            for wx, wy in poly:
                sx, sy = self._world_to_screen(wx, wy, W, H)
                flat.extend([sx, sy])
            c.create_polygon(flat, fill='', outline='#00ff88', width=2, dash=(6, 4))

        # Map designer lines (single stroke — thickness is internal only)
        sel = self.state.selected_wall_index
        for _idx, line in enumerate(self.state.map_lines):
            x1, y1, x2, y2 = line[0], line[1], line[2], line[3]
            length = math.hypot(x2 - x1, y2 - y1)
            if length < 1e-6:
                continue
            sx1, sy1 = self._world_to_screen(x1, y1, W, H)
            sx2, sy2 = self._world_to_screen(x2, y2, W, H)
            is_sel = (_idx == sel)
            stroke_color = '#ff4444' if is_sel else '#ffb800'
            stroke_w = 3 if is_sel else 2
            c.create_line(sx1, sy1, sx2, sy2, fill=stroke_color, width=stroke_w)
            cx_w = (x1 + x2) / 2.0
            cy_w = (y1 + y2) / 2.0
            sx_m, sy_m = self._world_to_screen(cx_w, cy_w, W, H)
            label_color = '#ff6666' if is_sel else '#ffdf80'
            c.create_text(sx_m, sy_m - 8,
                          text=f'{"★ " if is_sel else ""}#{_idx} {length:.2f}m',
                          fill=label_color, font=('Consolas', 8, 'bold'))
            # Endpoint handles (small white squares)
            for ex, ey in ((x1, y1), (x2, y2)):
                sx, sy = self._world_to_screen(ex, ey, W, H)
                c.create_rectangle(sx - 4, sy - 4, sx + 4, sy + 4,
                                   fill='#ffffff', outline=stroke_color)
            # Midpoint handle (white circle — drag to reposition line)
            c.create_oval(sx_m - 4, sy_m - 4, sx_m + 4, sy_m + 4,
                          fill='#ffffff', outline=stroke_color)

        # In-progress design line (preview while dragging out a new wall)
        if self._drawing_line:
            x1, y1, x2, y2 = self._drawing_line
            sx1, sy1 = self._world_to_screen(x1, y1, W, H)
            sx2, sy2 = self._world_to_screen(x2, y2, W, H)
            c.create_line(sx1, sy1, sx2, sy2, fill='#ffffff', width=2, dash=(3, 2))

        # Waypoints
        for w in self.state.waypoints:
            sx, sy = self._world_to_screen(w['x'], w['y'], W, H)
            c.create_oval(sx - 8, sy - 8, sx + 8, sy + 8,
                          fill='#00d4ff', outline='#ffffff', width=2)
            c.create_text(sx, sy - 18, text=str(w.get('label', w['id'])),
                          fill='#ffffff', font=('Consolas', 9, 'bold'))

        # Home marker
        if self.state.home_pose:
            hx_ = self.state.home_pose['x']
            hy_ = self.state.home_pose['y']
            shx, shy = self._world_to_screen(hx_, hy_, W, H)
            c.create_oval(shx - 9, shy - 9, shx + 9, shy + 9,
                          fill='#ffcc00', outline='#ffffff', width=2)
            c.create_text(shx, shy, text='⌂', fill='#1a1a00',
                          font=('Segoe UI', 11, 'bold'))
            c.create_text(shx, shy - 16, text='HOME', fill='#ffcc00',
                          font=('Consolas', 8, 'bold'))

        # Robot pose marker
        if self.state.pose:
            px = float(self.state.pose.get('x', 0.0))
            py = float(self.state.pose.get('y', 0.0))
            theta = float(self.state.pose.get('theta', 0.0))
            sx, sy = self._world_to_screen(px, py, W, H)
            c.create_oval(sx - 7, sy - 7, sx + 7, sy + 7,
                          fill='#00ff88', outline='#ffffff', width=2)
            hx = sx + math.cos(theta) * 18
            hy = sy - math.sin(theta) * 18
            c.create_line(sx, sy, hx, hy, fill='#ff3b5c', width=3, arrow='last')

        # Mouse coordinate tooltip
        if self._mouse_world:
            mx, my = self._mouse_world
            c.create_rectangle(6, H - 30, 230, H - 6,
                               fill='#07101c', outline='#244052')
            c.create_text(12, H - 18, anchor='w', fill='#88ddff',
                          font=('Consolas', 9, 'bold'),
                          text=f'X={mx:.2f}m   Y={my:.2f}m   zoom={self._view_range_m:.1f}m')

        # Mode badge
        badge = 'VẼ BẢN ĐỒ' if self.state.canvas_mode == 'design' else 'WAYPOINT'
        c.create_rectangle(W - 150, 8, W - 8, 34, fill='#07101c', outline='#244052')
        c.create_text(W - 79, 21, text=badge, fill='#00d4ff',
                      font=('Segoe UI', 9, 'bold'))

    def _refresh_labels(self) -> None:
        m = self.state.mode or 'idle'
        c = self.state.control_mode
        cfg = self.state.geofence
        geo_enabled = cfg.get('enabled', True)
        if not geo_enabled:
            geofence = 'OFF'
        elif self.state.geofence_breach or not self.state.geofence_ok:
            geofence = '🔴 NGOÀI VÙNG'
        elif self.state.geofence_warn:
            geofence = '🟡 RÌA VÙNG'
        else:
            geofence = '🟢 OK'
        self.status_label.config(
            text=f'mode: {m}   |   ctrl: {c}   |   geofence: {geofence}   |   '
                 f'{self.state.status_text or "—"}')
        if self.state.connected:
            txt, color = '● connected', '#00ff88'
        else:
            txt, color = '● disconnected', '#ff4444'
        self.connection_label.config(text=txt, foreground=color)

    def _refresh_esp32_panel(self) -> None:
        s = self.state.esp32_status
        enc = self.state.esp32_encoder or []
        if not s and not enc:
            msg = '(chờ ESP32 telemetry…)'
        else:
            lines: list[str] = []
            if s:
                ts = s.get('ts', 0)
                mot = s.get('motors', [])
                st = s.get('st', {}) or {}
                nav = s.get('nav', [])
                ir = s.get('ir', [])
                lines.extend([
                    '=== ESP32 STATUS / TYPE 131 ===',
                    f'uptime_ms     : {ts}',
                    f'mode          : {s.get("mode", "?")}',
                    f'e_stop        : {s.get("estop", False)}',
                    f'max_speed_pct : {s.get("max_pct", "?")}',
                    f'nav vx/vy/w   : {nav}',
                    f'ir sensors    : {ir}',
                    '',
                    '--- sensors ---',
                    f'imu_ok        : {st.get("imu", "—")}',
                    f'power_ok      : {st.get("pwr", "—")}',
                    f'sharp_cm      : {st.get("sharp", "—")}',
                    f'obstacle      : {st.get("obs", "—")}',
                    f'tof_mm        : {st.get("tof_mm", "—")}',
                    f'cylinder      : {st.get("cyl", "—")}',
                    f'cargo         : {st.get("cargo", "—")}',
                    '',
                    '--- motors (target / rpm / encoder / dir) ---',
                ])
                names = ['FL', 'FR', 'RL', 'RR']
                for i, m in enumerate(mot):
                    name = names[i] if i < len(names) else f'M{i}'
                    lines.append(
                        f'{name:<2}  t={m.get("t", "—"):>5}  '
                        f'rpm={float(m.get("r", 0)):>7.1f}  '
                        f'cnt={m.get("c", "—"):>10}  '
                        f'dir={m.get("d", "—")}'
                    )
                # Show any extra firmware keys that are not explicitly formatted.
                known = {'ts', 'type', 'mode', 'estop', 'max_pct', 'nav', 'motors', 'ir', 'st'}
                extra = {k: v for k, v in s.items() if k not in known}
                if extra:
                    lines.extend(['', '--- extra raw status fields ---',
                                  json.dumps(extra, indent=2, ensure_ascii=False)])
            if enc:
                lines.extend(['', '=== ENCODER SNAPSHOT / TYPE 130 ==='])
                for item in enc:
                    if isinstance(item, dict):
                        lines.append(
                            f'{item.get("name", item.get("id", "?")):<3}  '
                            f'tgt={item.get("tgt", item.get("target", "—")):>5}  '
                            f'rpm={float(item.get("rpm", item.get("r", 0))):>7.1f}  '
                            f'cnt={item.get("cnt", item.get("count", "—")):>10}'
                        )
            msg = '\n'.join(lines)
        self._set_text(self.esp32_text, msg)

    def _refresh_demo_panel(self) -> None:
        d = self.state.demo_status or {}
        if not d:
            msg = '(chờ lệnh demo…)'
        else:
            msg = json.dumps(d, indent=2, ensure_ascii=False)
        self._set_text(self.demo_text, msg)

    def _refresh_log_panel(self) -> None:
        lines = [f'{time.strftime("%H:%M:%S", time.localtime(t))}  {m}'
                 for t, m in self.state.ack_log]
        self._set_text(self.log_text, '\n'.join(lines) or '(trống)')

    def _refresh_trip_text(self) -> None:
        if not hasattr(self, 'trip_text') or not self.trip_text:
            return
        if not self.state.trip_log:
            self._set_text(self.trip_text, '(chưa có chuyến đi)')
            return
        lines = []
        for e in self.state.trip_log[-25:]:
            start = time.strftime('%H:%M:%S', time.localtime(e.get('start_ts', 0)))
            dur = e.get('duration_s', 0)
            goal = e.get('goal', {})
            glabel = goal.get('label', '?')
            gx = goal.get('x', 0)
            gy = goal.get('y', 0)
            status = e.get('status', '?')
            lines.append(f'{start}  {status}  {dur:.1f}s  → {glabel} ({gx:+.2f},{gy:+.2f})')
        self._set_text(self.trip_text, '\n'.join(lines))

    def _refresh_button_state(self) -> None:
        auto = self.state.control_mode == 'AUTO'
        manual = not auto
        for btn, key in ((self.btn_auto, 'AUTO'), (self.btn_manual, 'MANUAL')):
            state = ['disabled'] if (
                (key == 'AUTO' and auto) or (key == 'MANUAL' and manual)
            ) else ['!disabled']
            btn.state(state)
        # Demo buttons only enabled in AUTO
        for btn in self.demo_zone.values():
            btn.state(['!disabled'] if auto else ['disabled'])
        self.btn_full.state(['!disabled'] if auto else ['disabled'])
        self.btn_demo_stop.state(['!disabled'] if auto else ['disabled'])
        # Survey hint refresh (lightweight — only updates text if changed)
        self._update_survey_hint()

    def _set_text(self, widget: tk.Text, content: str) -> None:
        widget.configure(state='normal')
        widget.delete('1.0', tk.END)
        widget.insert('1.0', content)
        widget.configure(state='disabled')

    # ── Logging ────────────────────────────────────────────────────

    def _log(self, msg: str, error: bool = False) -> None:
        ts = time.strftime('%H:%M:%S')
        line = f'{ts}  {msg}'
        if error:
            sys.stderr.write(f'[operator] {msg}\n')
        self.state.push_log(msg)
        # Always keep the on-screen log in sync via the periodic refresh

    # ── Shutdown ───────────────────────────────────────────────────

    def _on_close(self) -> None:
        # Disable further ``after`` callbacks so the event loop drains
        # immediately on ``destroy()`` instead of getting stuck processing
        # stale timers.
        self._closing = True
        try:
            if self._udp_discovery is not None:
                self._udp_discovery.stop()
            self.bridge.close()
        except Exception:
            pass
        finally:
            try:
                self.root.quit()
            except Exception:
                pass
            try:
                self.root.destroy()
            except Exception:
                pass


# ── Entry point ─────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description='AGV operator desktop fallback')
    p.add_argument('--url', default=DEFAULT_URL,
                   help=f'WebSocket URL (default: {DEFAULT_URL})')
    return p.parse_args()


def main() -> None:
    args = parse_args()
    root = tk.Tk()
    try:
        OperatorApp(root, args.url)
    except Exception as e:
        # If anything blows up during startup, show the error in a
        # system dialog so the user can report it.
        try:
            from tkinter import messagebox
            messagebox.showerror('AGV Operator — lỗi khởi động', str(e))
        except Exception:
            sys.stderr.write(f'FATAL: {e}\n')
        root.destroy()
        return
    # Bring window to front immediately (Windows 11 often buries it).
    root.lift()
    root.attributes('-topmost', True)
    root.after(250, lambda: root.attributes('-topmost', False))
    root.mainloop()


if __name__ == '__main__':
    main()
