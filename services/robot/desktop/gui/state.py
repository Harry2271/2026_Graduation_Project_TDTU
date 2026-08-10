"""Application state + file I/O — no Qt dependency.

This module is a direct port of the OperatorState class and the JSON/geofence
persistence helpers from the Tkinter operator_app.py, kept framework-free so
it can be unit-tested without PySide6.
"""
from __future__ import annotations

import collections
import json
import os
import time
from typing import Any

# ── File paths ─────────────────────────────────────────────────────────────
_DESKTOP_DIR = os.path.dirname(os.path.abspath(__file__))
_PARENT_DIR = os.path.dirname(_DESKTOP_DIR)
_GEOFENCE_PATH = os.path.join(_PARENT_DIR, 'geofence.json')
_MAP_PATH = os.path.join(_PARENT_DIR, 'custom_map.json')
_WAYPOINTS_PATH = os.path.join(_PARENT_DIR, 'waypoints.json')
_SEQUENCE_PATH = os.path.join(_PARENT_DIR, 'sequence.json')
_TRIP_LOG_PATH = os.path.join(_PARENT_DIR, 'trip_log.json')
_HOME_PATH = os.path.join(_PARENT_DIR, 'home_pose.json')
_WAREHOUSE_STATE_PATH = os.path.join(_PARENT_DIR, 'warehouse_state.json')


# ── JSON I/O ───────────────────────────────────────────────────────────────
def load_json(path: str, default: Any) -> Any:
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return default


def save_json(path: str, data: Any) -> None:
    try:
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
    except OSError:
        pass


# ── Specialised loaders ────────────────────────────────────────────────────
def load_lines(path: str) -> list[list[float]]:
    data = load_json(path, [])
    if not isinstance(data, list):
        return []
    out: list[list[float]] = []
    for item in data:
        if isinstance(item, list) and len(item) >= 4:
            out.append([float(item[0]), float(item[1]),
                        float(item[2]), float(item[3]),
                        float(item[4]) if len(item) > 4 else 0.10])
    return out


def load_waypoints(path: str) -> list[dict]:
    return load_json(path, [])


def load_sequence(path: str) -> list[dict]:
    return load_json(path, [])


def load_trip_log(path: str) -> list[dict]:
    return load_json(path, [])


def load_warehouse_state(path: str) -> dict:
    data = load_json(path, {})
    if not isinstance(data, dict):
        return {'done_ids': [], 'last_run_ts': 0.0, 'total_unloads': 0}
    return {
        'done_ids': [int(x) for x in data.get('done_ids', []) if isinstance(x, (int, float))],
        'last_run_ts': float(data.get('last_run_ts', 0.0)),
        'total_unloads': int(data.get('total_unloads', 0)),
    }


def save_warehouse_state(path: str, data: dict) -> None:
    save_json(path, data)


# ── Geofence I/O ───────────────────────────────────────────────────────────
def geofence_load(path: str) -> dict:
    from .geo import GEOFENCE_DEFAULT
    data = load_json(path, None)
    if isinstance(data, dict) and 'polygon' in data:
        return data
    return GEOFENCE_DEFAULT.copy()


def geofence_save(path: str, cfg: dict) -> None:
    save_json(path, cfg)


# ── UI state container ─────────────────────────────────────────────────────
class OperatorState:
    def __init__(self) -> None:
        self.pose: dict | None = None
        self.pose_ts: float = 0.0
        self.scan_points: list[tuple[float, float]] = []
        self.scan_ts: float = 0.0
        # Trajectory in map/world frame (not persisted).
        self.trajectory: collections.deque[tuple[float, float]] = collections.deque(maxlen=500)
        # Latest AprilTag detections keyed by tag id (camera-frame).
        self.detected_tags: dict[int, dict] = {}
        self.detected_tag_ts: float = 0.0
        self.map_data: dict | None = None
        self.map_image: Any | None = None
        self.status_text: str = ''
        self.mode: str = 'idle'
        self.info: dict = {}
        self.control_mode: str = 'MANUAL'
        self.esp32_status: dict | None = None
        self.esp32_encoder: list = []
        self.demo_status: dict = {}
        self.ack_log: list[tuple[float, str]] = []
        self.connected: bool = False
        self.connection_message: str = 'connecting…'

        # Geofence
        from .geo import GEOFENCE_DEFAULT
        self.geofence: dict = GEOFENCE_DEFAULT.copy()
        self.geofence_ok: bool = True
        self.geofence_warn: bool = False
        self.geofence_breach: bool = False
        self.geofence_last_pose: dict | None = None
        self.geofence_violation_count: int = 0

        # Canvas mode: 'robot' | 'design' | 'waypoint'
        self.canvas_mode: str = 'robot'

        # Map lines [x1, y1, x2, y2, width_m]
        self.map_lines: list[list[float]] = []
        self.selected_wall_index: int = -1

        # Home placement
        self.placing_home: bool = False

        # Waypoints
        self.waypoints: list[dict] = []
        self._next_waypoint_id: int = 1
        # Placement intent for the map editor: ordinary waypoint or warehouse.
        self.waypoint_kind: str = 'waypoint'
        self.selected_waypoint_id: int = -1

        # Navigation
        self.home_pose: dict | None = None
        self.nav_active: bool = False
        self.nav_goal: dict | None = None
        self.nav_start_time: float = 0.0
        self.nav_step_index: int = -1
        self.trip_log: list[dict] = []

        # Scripted sequences
        self.sequence: list[dict] = []
        self.sequence_running: bool = False
        self.sequence_index: int = 0
        self.sequence_paused: bool = False

        # Replay
        self.replay_recording: bool = False
        self.replay_data: list[dict] = []
        self.replay_start_time: float = 0.0
        self.replay_playing: bool = False
        self.replay_data_view: list[dict] = []

        # ESP32 telemetry extensions (populated by _handle)
        self.esp32_imu: dict | None = None
        self.esp32_power: dict | None = None

        # Robot error log (brain → web_bridge → desktop, real-time alerts)
        self.robot_errors: list[dict] = []
        self.robot_errors_ts: float = 0.0

        # Obstacle layer (2m awareness zone grid from bridge)
        self.obstacle_layer: dict | None = None

        # Auto-survey
        self.survey_running: bool = False
        self.survey_paused: bool = False
        self.survey_queue: list[dict] = []
        self.survey_done_ids: list[int] = []
        self.survey_substep: str = ''
        self.survey_substep_at: float = 0.0
        self.warehouse_state: dict = {
            'done_ids': [], 'last_run_ts': 0.0, 'total_unloads': 0,
        }

    def push_log(self, msg: str) -> None:
        self.ack_log.append((time.time(), msg))
        if len(self.ack_log) > 50:
            self.ack_log = self.ack_log[-50:]
