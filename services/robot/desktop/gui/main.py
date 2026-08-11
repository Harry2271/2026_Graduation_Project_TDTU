#!/usr/bin/env python3
"""AGV Operator — PySide6 desktop app.

Entry point: ``python -m gui.main [--url ws://IP:9091]``
"""
from __future__ import annotations

import argparse
import collections
import math
import sys
import time
from typing import Any

from PySide6.QtCore import Qt, QTimer, QSettings, Signal, Slot
from PySide6.QtGui import QAction, QKeySequence, QShortcut
from PySide6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QSplitter, QVBoxLayout,
    QHBoxLayout, QLabel, QPushButton, QTabWidget, QFrame, QMessageBox,
    QFileDialog, QPlainTextEdit, QTextEdit, QGroupBox, QStackedWidget,
)

from .theme import DARK_THEME
from .state import (
    OperatorState, load_json, save_json,
    load_lines, load_waypoints, load_sequence, load_trip_log, load_warehouse_state,
    save_warehouse_state, geofence_load, geofence_save,
    _MAP_PATH, _WAYPOINTS_PATH, _SEQUENCE_PATH, _TRIP_LOG_PATH,
    _HOME_PATH, _WAREHOUSE_STATE_PATH, _GEOFENCE_PATH,
)
from .geo import (
    GEOFENCE_DEFAULT, clamp, safe_get,
    point_in_polygon, distance_to_polygon_edge,
    snap_line_endpoints, build_polygon_from_lines,
)
from .bridge import BridgeClient, UDPDiscovery, DEFAULT_URL, resolve_token
from .canvas import MapCanvas, MinimapCanvas
from .panels.control import ControlPanel
from .panels.survey import SurveyPanel
from .panels.esp32 import Esp32Panel
from .panels.design_tools import WaypointPanel, WallPanel, SequencePanel
from .panels.log_tabs import LogPanel, TripPanel, HelpPanel
from .panels.robot_view import RobotTelemetryPanel
from .dialogs import ConnectDialog, WallEditorDialog, GeofenceEditorDialog


# ── Constants ─────────────────────────────────────────────────────────────
TELEOP_HZ = 20.0
TELEOP_INTERVAL = 1.0 / TELEOP_HZ
TELEOP_MAX_VX = 120
TELEOP_MAX_VY = 120
TELEOP_MAX_OMEGA = 120


# ══════════════════════════════════════════════════════════════════════════
class OperatorWindow(QMainWindow):
    """Main PySide6 operator window."""

    def __init__(self, url: str) -> None:
        super().__init__()
        self.url = url
        self._settings = QSettings('NguyenRobot', 'AGVOperator')
        self.setWindowTitle(f'AGV Operator — {url}')
        self.setMinimumSize(1200, 760)
        # Restore window geometry from last session
        geom = self._settings.value('window/geometry')
        if geom:
            self.restoreGeometry(geom)
        else:
            self.resize(1600, 900)

        # ── State ────────────────────────────────────────────────────
        self.state = OperatorState()
        self.state.geofence = geofence_load(_GEOFENCE_PATH)
        self.state.map_lines = load_lines(_MAP_PATH)
        self.state.waypoints = load_waypoints(_WAYPOINTS_PATH)
        self.state.sequence = load_sequence(_SEQUENCE_PATH)
        self.state.trip_log = load_trip_log(_TRIP_LOG_PATH)
        self.state.warehouse_state = load_warehouse_state(_WAREHOUSE_STATE_PATH)
        saved_home = load_json(_HOME_PATH, None)
        if isinstance(saved_home, dict) and 'x' in saved_home:
            self.state.home_pose = saved_home
        if self.state.waypoints:
            self.state._next_waypoint_id = max(
                w.get('id', 0) for w in self.state.waypoints) + 1
        self._geofence_warned_once = False
        self._pressed: set[str] = set()
        self._last_teleop_sent: float = 0.0

        # ── Layout ───────────────────────────────────────────────────
        central = QWidget()
        self.setCentralWidget(central)
        root_layout = QVBoxLayout(central)
        root_layout.setContentsMargins(6, 6, 6, 6)
        root_layout.setSpacing(4)

        # Canvas + right panel
        self._build_canvas()
        self._build_right_tabs()
        self._build_control_bar()
        self._bind_shortcuts()

        # ── WebSocket ────────────────────────────────────────────────
        self.bridge = BridgeClient(url, auth_token=resolve_token())
        self.bridge.message_received.connect(self._handle, Qt.ConnectionType.QueuedConnection)
        self.bridge.connection_changed.connect(self._on_connection_changed, Qt.ConnectionType.QueuedConnection)
        self.bridge.log_message.connect(lambda m, e: self._log(m, e), Qt.ConnectionType.QueuedConnection)
        self.bridge.start()
        self._build_menu()

        # ── UDP auto-discovery ───────────────────────────────────────
        self._udp: UDPDiscovery | None = None
        if url == DEFAULT_URL:
            self._start_udp_scan()

        # ── Timers ───────────────────────────────────────────────────
        self._timer_ui = QTimer(self)
        self._timer_ui.timeout.connect(self._ui_tick)
        self._timer_ui.start(100)
        self._timer_teleop = QTimer(self)
        self._timer_teleop.timeout.connect(self._tick_teleop)
        self._timer_teleop.start(50)
        self._timer_survey = QTimer(self)
        self._timer_survey.timeout.connect(self._poll_survey)
        self._timer_survey.start(300)

        QTimer.singleShot(200, self._auto_update_geofence)

    # ══════════════════════════════════════════════════════════════════════
    # LAYOUT
    # ══════════════════════════════════════════════════════════════════════
    def _build_canvas(self) -> None:
        self.map_canvas = MapCanvas(self.state)
        self.minimap = MinimapCanvas(self.state)
        self.map_canvas.waypoint_created.connect(self._on_waypoint_created)
        self.map_canvas.wall_created.connect(self._on_wall_created)
        self.map_canvas.wall_selected.connect(self._on_wall_selected)
        self.map_canvas.wall_deleted.connect(self._delete_wall_at)
        self.map_canvas.wall_changed.connect(self._on_wall_changed)
        self.map_canvas.edit_wall_requested.connect(self._edit_wall)
        self.map_canvas.waypoint_moved.connect(self._on_waypoint_moved)
        self.map_canvas.home_requested.connect(self._on_home_requested)

    def _build_right_tabs(self) -> None:
        tabs = QTabWidget()
        tabs.setTabPosition(QTabWidget.TabPosition.North)
        # Control tab — reorganized by operational mode
        ctrl_tab = QWidget()
        ctrl_layout = QVBoxLayout(ctrl_tab)
        ctrl_layout.setContentsMargins(8, 8, 8, 8)
        ctrl_layout.setSpacing(6)

        # -- Mode + Status
        self.control_panel = ControlPanel(self.state)
        self.control_panel.mode_changed.connect(self._set_mode)
        self.control_panel.e_stop_requested.connect(self._e_stop)
        ctrl_layout.addWidget(self.control_panel)

        # -- MANUAL: Cylinder (most-used in teleop)
        grp_cyl = QGroupBox('XI-LANH (MANUAL)')
        cyl_layout = QHBoxLayout(grp_cyl)
        for label, action in [('Mở (Space)', 'extend'), ('Thu (R)', 'retract'), ('Dừng (X)', 'stop')]:
            b = QPushButton(label)
            b.setMinimumHeight(34)
            b.clicked.connect(lambda _, a=action: self._send_cylinder(a))
            cyl_layout.addWidget(b)
        ctrl_layout.addWidget(grp_cyl)

        # -- AUTO: Demo
        grp_demo = QGroupBox('CHƯƠNG TRÌNH DEMO (AUTO)')
        dl = QVBoxLayout(grp_demo)
        row_a = QHBoxLayout()
        self.demo_zone: dict[str, QPushButton] = {}
        for letter in 'ABCD':
            b = QPushButton(letter)
            b.setMinimumHeight(32)
            b.clicked.connect(lambda _, l=letter: self._send_demo(l))
            self.demo_zone[letter] = b
            row_a.addWidget(b)
        dl.addLayout(row_a)
        row_b = QHBoxLayout()
        self.btn_full = QPushButton('FULL DEMO')
        self.btn_full.setMinimumHeight(32)
        self.btn_full.clicked.connect(lambda: self._send_demo('full'))
        row_b.addWidget(self.btn_full)
        self.btn_demo_stop = QPushButton('STOP DEMO')
        self.btn_demo_stop.setMinimumHeight(32)
        self.btn_demo_stop.clicked.connect(lambda: self._send_demo('stop'))
        row_b.addWidget(self.btn_demo_stop)
        dl.addLayout(row_b)
        ctrl_layout.addWidget(grp_demo)

        # -- Quick reference
        ref_group = QGroupBox('PHÍM TẮT NHANH')
        ref_layout = QVBoxLayout(ref_group)
        ref = QLabel(
            '<span style="color:#8b949e;font-size:11px;">'
            'WASD — di chuyển &nbsp; Q/E — xoay &nbsp; '
            'Space/R/X — xi-lanh &nbsp; M — chuyển mode<br>'
            'F1/F2/F3 — chuyển view &nbsp; Esc — E-STOP</span>'
        )
        ref_layout.addWidget(ref)
        ctrl_layout.addWidget(ref_group)
        ctrl_layout.addStretch(1)
        tabs.addTab(ctrl_tab, 'Điều khiển')

        # ESP32 tab
        self.esp32_panel = Esp32Panel(self.state)
        tabs.addTab(self.esp32_panel, 'ESP32')

        # Waypoint tab
        self.waypoint_panel = WaypointPanel(self.state)
        self.waypoint_panel.goto_requested.connect(self._goto_waypoint)
        self.waypoint_panel.delete_requested.connect(self._delete_waypoint)
        self.waypoint_panel.rename_requested.connect(self._rename_waypoint)
        self.waypoint_panel.set_apriltag.connect(self._set_waypoint_tag)
        tabs.addTab(self.waypoint_panel, 'Waypoint / Kho')

        # Wall tab
        self.wall_panel = WallPanel(self.state)
        self.wall_panel.delete_wall.connect(self._delete_wall_at)
        self.wall_panel.edit_wall.connect(self._edit_wall)
        self.wall_panel.apply_geofence.connect(self._apply_walls_as_geofence)
        tabs.addTab(self.wall_panel, 'Tường / Geofence')

        # Sequence tab
        self.seq_panel = SequencePanel(self.state)
        tabs.addTab(self.seq_panel, 'Kịch bản')

        # Trip tab
        self.trip_panel = TripPanel(self.state)
        tabs.addTab(self.trip_panel, 'Trip')

        # Log tab
        self.log_panel = LogPanel(self.state)
        tabs.addTab(self.log_panel, 'Log')

        # Help tab
        tabs.addTab(HelpPanel(), 'Phím tắt')

        # AUTO-only telemetry view — replaces the right tab stack when the
        # operator selects Robot view canvas mode + control mode is AUTO.
        self.robot_telemetry = RobotTelemetryPanel(self.state)

        # Right-side container: tab widget (default) OR telemetry panel.
        self.right_stack = QStackedWidget()
        self.right_stack.addWidget(tabs)                  # index 0
        self.right_stack.addWidget(self.robot_telemetry)  # index 1
        self.right_tabs = tabs

    def _build_control_bar(self) -> None:
        central = self.centralWidget()
        root_layout = central.layout()

        # Structured toolbar: each row has one clear responsibility.
        top_bar = QFrame()
        top_layout = QVBoxLayout(top_bar)
        top_layout.setContentsMargins(0, 0, 0, 0)
        top_layout.setSpacing(3)

        # Row 1 — view/mode selection
        view_group = QGroupBox('HIỂN THỊ')
        view_layout = QHBoxLayout(view_group)
        view_layout.setContentsMargins(6, 2, 6, 2)
        self.btn_robot_view = QPushButton('F1  Robot view')
        self.btn_design = QPushButton('F2  Bản đồ / Vẽ tường')
        self.btn_waypoint_mode = QPushButton('F3  Kho / Vị trí')
        for btn, mode in [
            (self.btn_robot_view, 'robot'),
            (self.btn_design, 'design'),
            (self.btn_waypoint_mode, 'waypoint'),
        ]:
            btn.setMinimumHeight(30)
            btn.clicked.connect(lambda _, m=mode: self._set_canvas_mode(m))
            view_layout.addWidget(btn)
        top_layout.addWidget(view_group)

        # Row 2 — combined map design + waypoint/warehouse tools
        merged_group = QGroupBox('BẢN ĐỒ / VỊ TRÍ / GEOFENCE')
        merged_layout = QHBoxLayout(merged_group)
        merged_layout.setContentsMargins(6, 2, 6, 2)
        btn_save = QPushButton('💾 Lưu bản đồ')
        btn_save.clicked.connect(self._save_map)
        merged_layout.addWidget(btn_save)
        btn_geofence = QPushButton('🛡 Áp dụng geofence')
        btn_geofence.clicked.connect(self._apply_walls_as_geofence)
        merged_layout.addWidget(btn_geofence)
        btn_edit_wall = QPushButton('✎ Sửa line đã chọn')
        btn_edit_wall.clicked.connect(self._edit_selected_wall)
        merged_layout.addWidget(btn_edit_wall)
        btn_clear = QPushButton('🗑 Xóa bản đồ')
        btn_clear.setStyleSheet('color:#ff6b6b;')
        btn_clear.clicked.connect(self._confirm_clear_map)
        merged_layout.addWidget(btn_clear)
        merged_layout.addWidget(QLabel('|'))
        merged_layout.addWidget(QLabel('Loại điểm:'))
        self.btn_wp_waypoint = QPushButton('📍 Waypoint thường')
        self.btn_wp_warehouse = QPushButton('📦 Kho + AprilTag')
        for btn, kind in [
            (self.btn_wp_waypoint, 'waypoint'),
            (self.btn_wp_warehouse, 'warehouse'),
        ]:
            btn.setCheckable(True)
            btn.clicked.connect(lambda _, k=kind: self._set_waypoint_kind(k))
            merged_layout.addWidget(btn)
        merged_layout.addWidget(QLabel('Chọn loại rồi click canvas để đặt'))
        merged_layout.addStretch(1)
        top_layout.addWidget(merged_group)

        # Row 4 — automatic survey controls
        survey_group = QGroupBox('AUTO / KHẢO SÁT KHO')
        survey_layout = QHBoxLayout(survey_group)
        survey_layout.setContentsMargins(6, 2, 6, 2)
        self.survey_panel = SurveyPanel(self.state)
        self.survey_panel.survey_begin.connect(self._begin_survey)
        self.survey_panel.survey_stop.connect(self._stop_survey)
        self.survey_panel.survey_reset.connect(self._reset_survey_done)
        survey_layout.addWidget(self.survey_panel)
        survey_layout.addStretch(1)
        top_layout.addWidget(survey_group)

        # Row 5 — SLAM mapping controls + demo status
        slam_group = QGroupBox('SLAM / MAP')
        slam_layout = QHBoxLayout(slam_group)
        slam_layout.setContentsMargins(6, 2, 6, 2)
        for label, cmd in [('▶ Start', 'start'), ('■ Stop', 'stop'),
                           ('⊙ Idle', 'idle'), ('↺ Reset', 'reset')]:
            btn = QPushButton(label)
            btn.setMinimumHeight(28)
            btn.clicked.connect(lambda _, c=cmd: self._send_cmd(c))
            slam_layout.addWidget(btn)
        slam_layout.addWidget(QLabel('|'))
        self.lbl_demo_status = QLabel('demo: -')
        self.lbl_demo_status.setStyleSheet(
            'color:#c9d1d9;font-family:Consolas;font-size:11px;')
        slam_layout.addWidget(self.lbl_demo_status)
        slam_layout.addStretch(1)
        top_layout.addWidget(slam_group)

        root_layout.addWidget(top_bar)
        self._update_waypoint_kind_buttons()

        # Main splitter: canvas + right panel
        splitter = QSplitter(Qt.Orientation.Horizontal)
        left_frame = QWidget(); ll = QVBoxLayout(left_frame)
        ll.setContentsMargins(0, 0, 0, 0)
        ll.addWidget(self.map_canvas, 1)

        # Bottom status bar
        bottom_bar = QFrame()
        bb_layout = QHBoxLayout(bottom_bar)
        bb_layout.setContentsMargins(8, 3, 8, 3)
        bb_layout.setSpacing(10)
        bb_layout.addWidget(QLabel('⏱'))
        self.lbl_trip = QLabel('00:00.0')
        self.lbl_trip.setStyleSheet('color:#58a6ff; font-family:Consolas; font-size:12px;')
        bb_layout.addWidget(self.lbl_trip)
        bb_layout.addWidget(QLabel('|'))
        bb_layout.addWidget(QLabel('Home:'))
        self.lbl_home = QLabel('(chưa đặt)')
        self.lbl_home.setStyleSheet('color:#8b949e; font-family:Consolas; font-size:11px;')
        bb_layout.addWidget(self.lbl_home)
        btn_place_home = QPushButton('📍 Đặt Home')
        btn_place_home.setMinimumHeight(28)
        btn_place_home.clicked.connect(self._begin_place_home)
        bb_layout.addWidget(btn_place_home)
        btn_go_home = QPushButton('🏠 Về Home')
        btn_go_home.setMinimumHeight(28)
        btn_go_home.clicked.connect(self._go_home)
        bb_layout.addWidget(btn_go_home)
        bb_layout.addStretch(1)
        ll.addWidget(bottom_bar)
        splitter.addWidget(left_frame)
        splitter.addWidget(self.right_stack)
        splitter.setSizes([900, 500])
        root_layout.addWidget(splitter, 1)

    def _build_menu(self) -> None:
        mb = self.menuBar()
        file_menu = mb.addMenu('Tệp')
        file_menu.addAction('Kết nối lại', self.bridge.close)
        file_menu.addAction('🔍 Tìm robot', self._start_udp_scan)
        file_menu.addAction('Nhập URL thủ công', self._on_manual_connect)
        mode_menu = mb.addMenu('Chế độ')
        mode_menu.addAction('MANUAL', lambda: self._set_mode('MANUAL'))
        mode_menu.addAction('AUTO', lambda: self._set_mode('AUTO'))
        tools_menu = mb.addMenu('Công cụ')
        tools_menu.addAction('Sửa geofence', self._open_geofence_editor)
        tools_menu.addAction('Lưu bản đồ', self._save_map)
        tools_menu.addAction('Xóa bản đồ', self._clear_map)

    def _bind_shortcuts(self) -> None:
        for key, slot in [
            ('W', lambda: self._press('w')), ('S', lambda: self._press('s')),
            ('A', lambda: self._press('a')), ('D', lambda: self._press('d')),
            ('Q', lambda: self._press('q')), ('E', lambda: self._press('e')),
            ('Space', lambda: self._send_cylinder('extend')),
            ('R', lambda: self._send_cylinder('retract')),
            ('X', lambda: self._send_cylinder('stop')),
            ('M', lambda: self._set_mode('AUTO' if self.state.control_mode == 'MANUAL' else 'MANUAL')),
            ('Escape', self._e_stop),
            ('F1', lambda: self._set_canvas_mode('robot')),
            ('F2', lambda: self._set_canvas_mode('design')),
            ('F3', lambda: self._set_canvas_mode('waypoint')),
            ('Delete', self._shortcut_delete_warehouse),
        ]:
            sc = QShortcut(QKeySequence(key), self)
            sc.setContext(Qt.ShortcutContext.WindowShortcut)
            sc.activated.connect(slot)

    def _press(self, key: str) -> None:
        self._pressed.add(key)

    def keyReleaseEvent(self, ev: Any) -> None:
        key = ev.text().lower()
        self._pressed.discard(key)
        super().keyReleaseEvent(ev)

    def closeEvent(self, ev: Any) -> None:
        self._settings.setValue('window/geometry', self.saveGeometry())
        self._settings.setValue('connection/url', self.url)
        self.bridge.close()
        if self._udp:
            self._udp.close()
        ev.accept()

    # ══════════════════════════════════════════════════════════════════════
    # UI TICK
    # ══════════════════════════════════════════════════════════════════════
    def _ui_tick(self) -> None:
        self.control_panel.refresh()
        self.map_canvas.refresh()
        self.minimap.refresh()
        self.esp32_panel.refresh()
        self.survey_panel.refresh()
        self.waypoint_panel.refresh()
        self.wall_panel.refresh()
        self.seq_panel.refresh()
        self.trip_panel.refresh()
        self.log_panel.refresh()
        # Telemetry panel only updates when Robot view is active.
        if self.state.canvas_mode == 'robot':
            self.robot_telemetry.refresh()
        h = self.state.home_pose
        self.lbl_home.setText(
            f'({h["x"]:.2f}, {h["y"]:.2f})' if h else '(chưa đặt)')
        # Demo status
        ds = self.state.demo_status
        if ds:
            d_state = ds.get('state', ds.get('status', ''))
            d_zone = ds.get('zone', '')
            d_msg = ds.get('message', '')
            self.lbl_demo_status.setText(
                f'demo: {d_state}  {d_zone}  {d_msg}')
            demo_color = '#9ece6a' if d_state in ('active', 'running') else '#c9d1d9'
            self.lbl_demo_status.setStyleSheet(
                f'color:{demo_color};font-family:Consolas;font-size:11px;')
        if self.state.nav_active and self.state.nav_start_time:
            dt = time.monotonic() - self.state.nav_start_time
            self.lbl_trip.setText(f'⏱ {int(dt//60):02d}:{dt%60:04.1f}')
        # Dim buttons by mode
        auto = self.state.control_mode == 'AUTO'
        for btn in self.demo_zone.values():
            btn.setEnabled(auto)
        self.btn_full.setEnabled(auto)
        self.btn_demo_stop.setEnabled(auto)
        self._update_canvas_mode_buttons()

    def _update_canvas_mode_buttons(self) -> None:
        mode = self.state.canvas_mode
        # All three buttons stay enabled — highlight the active one instead.
        self.btn_robot_view.setStyleSheet(
            'background:#1f6feb;' if mode == 'robot' else '')
        self.btn_design.setStyleSheet(
            'background:#1f6feb;' if mode == 'design' else '')
        self.btn_waypoint_mode.setStyleSheet(
            'background:#1f6feb;' if mode == 'waypoint' else '')
        # Waypoint kind buttons only active in waypoint mode
        active = mode == 'waypoint'
        self.btn_wp_waypoint.setEnabled(active)
        self.btn_wp_warehouse.setEnabled(active)
        if not active:
            self.btn_wp_waypoint.setChecked(False)
            self.btn_wp_warehouse.setChecked(False)

    def _update_waypoint_kind_buttons(self) -> None:
        kind = self.state.waypoint_kind
        self.btn_wp_waypoint.setChecked(kind == 'waypoint')
        self.btn_wp_warehouse.setChecked(kind == 'warehouse')

    def _set_waypoint_kind(self, kind: str) -> None:
        if kind not in ('waypoint', 'warehouse'):
            return
        self.state.waypoint_kind = kind
        # Also switch canvas to waypoint mode automatically.
        if self.state.canvas_mode != 'waypoint':
            self.state.canvas_mode = 'waypoint'
        self._update_waypoint_kind_buttons()
        self.map_canvas.refresh()
        self._log(f'ℹ click trên canvas để đặt '
                  f'{"kho (TAG)" if kind == "warehouse" else "waypoint"}')

    def _confirm_clear_map(self) -> None:
        if not self.state.map_lines and not self.state.waypoints:
            self._log('ℹ bản đồ trống')
            return
        ok = QMessageBox.question(self, 'Xóa bản đồ',
                                   'Xóa toàn bộ tường + waypoint?',
                                   QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No)
        if ok == QMessageBox.StandardButton.Yes:
            self._clear_map()

    # ══════════════════════════════════════════════════════════════════════
    # CANVAS MODE
    # ══════════════════════════════════════════════════════════════════════
    def _set_canvas_mode(self, mode: str) -> None:
        if mode not in ('robot', 'design', 'waypoint'):
            return
        self.state.canvas_mode = mode
        self.state.placing_home = False
        # Robot view: show the AUTO telemetry panel on the right.
        # Other modes: show the tab stack (waypoints, walls, etc.).
        self.right_stack.setCurrentIndex(1 if mode == 'robot' else 0)
        self.map_canvas.refresh()

    def _on_world_click(self, wx: float, wy: float) -> None:
        if self.state.placing_home:
            self.state.home_pose = {'x': round(wx, 3), 'y': round(wy, 3),
                                    'theta': 0.0, 'ts': time.time()}
            save_json(_HOME_PATH, self.state.home_pose)
            self._log(f'✓ Home đặt tại ({wx:.2f}, {wy:.2f})')
            self.state.placing_home = False
        elif self.state.canvas_mode == 'design':
            pass  # handled via wall_created / wall_selected / wall_deleted signals
        elif self.state.canvas_mode == 'waypoint':
            self._add_waypoint(wx, wy)

    def _on_waypoint_created(self, wx: float, wy: float) -> None:
        self._add_waypoint(wx, wy)

    def _add_waypoint(self, wx: float, wy: float) -> None:
        wp_id = self.state._next_waypoint_id
        self.state._next_waypoint_id += 1
        kind = self.state.waypoint_kind
        label = f'wp-{wp_id}'
        wp = {'id': wp_id, 'x': round(wx, 3), 'y': round(wy, 3),
              'theta': 0.0, 'label': label, 'kind': kind}
        if kind == 'warehouse':
            from PySide6.QtWidgets import QInputDialog
            tag_id, ok = QInputDialog.getInt(self, 'AprilTag kho',
                                              'Nhập ID AprilTag:', wp_id, 1, 9999)
            if not ok:
                self.state._next_waypoint_id -= 1
                return
            wp['tag_id'] = tag_id
            wp['label'] = f'kho-{tag_id}'
        self.state.waypoints.append(wp)
        save_json(_WAYPOINTS_PATH, self.state.waypoints)
        self._log(f'✓ {"kho" if kind == "warehouse" else "waypoint"} '
                  f'#{wp_id} ({wx:.2f}, {wy:.2f})')

    def _on_waypoint_moved(self, wp_id: int, wx: float, wy: float) -> None:
        for wp in self.state.waypoints:
            if int(wp.get('id', -1)) == wp_id:
                wp['x'] = round(wx, 3)
                wp['y'] = round(wy, 3)
                break
        save_json(_WAYPOINTS_PATH, self.state.waypoints)

    def _on_wall_selected(self, idx: int) -> None:
        self.state.selected_wall_index = idx
        self.wall_panel.list.setCurrentRow(idx)
        self.map_canvas.refresh()

    def _on_wall_changed(self, idx: int) -> None:
        if 0 <= idx < len(self.state.map_lines):
            save_json(_MAP_PATH, self.state.map_lines)
            self._auto_update_geofence()

    def _on_wall_created(self, x1: float, y1: float, x2: float, y2: float) -> None:
        sx1, sy1, sx2, sy2 = snap_line_endpoints(x1, y1, x2, y2,
                                                  self.state.map_lines)
        self.state.map_lines.append([sx1, sy1, sx2, sy2, 0.10])
        save_json(_MAP_PATH, self.state.map_lines)
        length = math.hypot(sx2 - sx1, sy2 - sy1)
        self._log(f'→ line {length:.2f}m  total {len(self.state.map_lines)}')
        self._auto_update_geofence()

    def _delete_wall_at(self, idx: int) -> None:
        if 0 <= idx < len(self.state.map_lines):
            self.state.map_lines.pop(idx)
            self.state.selected_wall_index = -1
            save_json(_MAP_PATH, self.state.map_lines)
            self._log(f'✓ đã xóa line #{idx}')
            self._auto_update_geofence()

    def _on_home_requested(self, wx: float, wy: float) -> None:
        self.state.home_pose = {'x': round(wx, 3), 'y': round(wy, 3),
                                'theta': 0.0, 'ts': time.time()}
        save_json(_HOME_PATH, self.state.home_pose)
        self._log(f'✓ Home đặt tại ({wx:.2f}, {wy:.2f})')
        self.state.placing_home = False

    # ══════════════════════════════════════════════════════════════════════
    # COMMANDS
    # ══════════════════════════════════════════════════════════════════════
    def _set_mode(self, mode: str) -> None:
        if mode not in ('AUTO', 'MANUAL'):
            return
        if self.bridge.send({'type': 'control_mode', 'mode': mode}):
            self._log(f'→ mode:{mode}')
            # Optimistically update local state — server ack will confirm.
            self.state.control_mode = mode

    def _send_cmd(self, command: str) -> None:
        if self.bridge.send({'type': 'cmd', 'command': command}):
            self._log(f'→ cmd:{command}')
        else:
            self._log('cannot send — bridge disconnected', error=True)

    def _send_demo(self, action: str) -> None:
        if self.state.control_mode != 'AUTO':
            self._log(f'❌ demo:{action} rejected (mode is {self.state.control_mode})', error=True)
            return
        if self.bridge.send({'type': 'demo', 'action': action}):
            self._log(f'→ demo:{action}')
        else:
            self._log('cannot send — bridge disconnected', error=True)

    def _send_cylinder(self, action: str) -> None:
        if self.state.control_mode != 'MANUAL':
            self._log(f'❌ cylinder:{action} rejected (mode is {self.state.control_mode})', error=True)
            return
        if self.bridge.send({'type': 'cylinder', 'action': action}):
            self._log(f'→ cylinder:{action}')

    def _send_esp32(self, cmd: dict) -> bool:
        if self.bridge.send({'type': 'esp32', 'cmd': cmd}):
            self._log(f'→ esp32:{cmd.get("cmd", "?")}')
            return True
        self._log('cannot send ESP32 command — bridge disconnected', error=True)
        return False

    def _e_stop(self) -> None:
        if self.bridge.send({'type': 'esp32', 'cmd': {'cmd': 'e_stop'}}):
            self._log('🛑 ESP32 E-STOP issued')
            if self.state.survey_running:
                self.state.survey_paused = True
                self.state.survey_running = False
                self._log('⏸ khảo sát đã tạm dừng do E-STOP', error=True)
        else:
            self._log('cannot E-STOP — bridge disconnected', error=True)

    def _send_navigate(self, x: float, y: float, theta: float = 0.0,
                       label: str = 'wp', _survey: bool = False) -> bool:
        if self.state.control_mode != 'AUTO':
            self._log('❌ navigate rejected — cần chuyển sang AUTO mode', error=True)
            return False
        if self.state.nav_active:
            self._log('❌ navigate rejected — robot đang chạy lệnh khác', error=True)
            return False
        if not _survey and self.state.geofence.get('enabled', True):
            poly = self.state.geofence.get('polygon', [])
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

    def _go_home(self) -> None:
        h = self.state.home_pose
        if not h:
            self._log('❌ chưa đặt Home — bấm "Đặt Home" trước', error=True)
            return
        self._send_navigate(h['x'], h['y'], h.get('theta', 0.0), 'home')

    def _begin_place_home(self) -> None:
        self.state.placing_home = True
        self._log('ℹ click vào canvas để đặt Home')

    def _finalize_trip(self, success: bool, duration: float) -> None:
        """Record a completed navigation as a trip-log entry and persist."""
        goal = self.state.nav_goal
        if not goal:
            return
        entry = {
            'start_ts': time.time() - duration,
            'end_ts': time.time(),
            'duration_s': round(duration, 2),
            'goal': goal,
            'status': 'completed' if success else 'failed',
        }
        self.state.trip_log.append(entry)
        if len(self.state.trip_log) > 200:
            self.state.trip_log = self.state.trip_log[-200:]
        save_json(_TRIP_LOG_PATH, self.state.trip_log)
        self.state.nav_goal = None
        # Advance scripted sequence if running.
        if self.state.sequence_running and not self.state.sequence_paused:
            self._advance_sequence()

    def _advance_sequence(self) -> None:
        """Move to the next step in a running scripted sequence."""
        self.state.sequence_index += 1
        QTimer.singleShot(50, self._execute_sequence_step)

    def _execute_sequence_step(self) -> None:
        """Dispatch the current sequence step to its concrete handler.

        Supported step types: ``waypoint``, ``home``, ``cylinder``.
        Unknown types are logged and the sequence advances.
        """
        if not self.state.sequence_running or self.state.sequence_paused:
            return
        if self.state.sequence_index >= len(self.state.sequence):
            self.state.sequence_running = False
            self._log('✓ kịch bản hoàn thành')
            return
        step = self.state.sequence[self.state.sequence_index]
        kind = step.get('type')
        if kind == 'waypoint':
            wid = int(step.get('waypoint_id', -1))
            wp = next((w for w in self.state.waypoints
                       if int(w.get('id', -1)) == wid), None)
            if wp is None:
                self._log(f'⚠ step #{self.state.sequence_index}: waypoint #{wid} not found',
                          error=True)
                self._advance_sequence()
                return
            self._send_navigate(float(wp['x']), float(wp['y']), 0.0,
                                label=str(wp.get('label', f'wp-{wid}')))
            # navigate_result → _finalize_trip → _advance_sequence
        elif kind == 'home':
            self._go_home()
        elif kind == 'cylinder':
            action = step.get('action', 'stop')
            self._send_cylinder(action)
            QTimer.singleShot(500, self._advance_sequence)
        else:
            self._log(f'⚠ step type không hỗ trợ: {kind}', error=True)
            self._advance_sequence()

    # ══════════════════════════════════════════════════════════════════════
    # TELEOP
    # ══════════════════════════════════════════════════════════════════════
    def _tick_teleop(self) -> None:
        if self.state.control_mode != 'MANUAL' or not self.bridge.is_connected():
            return
        now = time.monotonic()
        if now - self._last_teleop_sent < TELEOP_INTERVAL:
            return
        vx, vy, omega = self._teleop_vector()
        if vx == 0 and vy == 0 and omega == 0:
            return
        # Predictive geofence block — if heading outside the polygon, drop the
        # packet. The breach-detector still E-STOPs when an actual sample falls
        # outside, this just prevents us from steering into the wall first.
        if not self._geofence_allows_motion(vx, vy):
            self._geofence_blocked_count = getattr(self, '_geofence_blocked_count', 0) + 1
            if self._geofence_blocked_count == 1:
                self._log('⚠ teleop blocked — heading ra ngoài geofence', error=True)
            return
        self._geofence_blocked_count = 0
        self._last_teleop_sent = now
        self.bridge.send({'type': 'teleop', 'vx': vx, 'vy': vy, 'omega': omega})

    def _geofence_allows_motion(self, vx: int, vy: int) -> bool:
        """Predict the next pose one tick ahead. If outside geofence → reject."""
        cfg = self.state.geofence
        if not cfg.get('enabled', True):
            return True
        pose = self.state.pose
        if not pose:
            return True
        poly = cfg.get('polygon', [])
        if not poly:
            return True
        # Convert PWM-scaled velocities to a world-frame step (~0.1 s look-ahead).
        # Coarse mapping: PWM 120 ≈ 0.3 m/s.
        dt = TELEOP_INTERVAL
        scale = 0.3 / TELEOP_MAX_VX if TELEOP_MAX_VX else 0
        theta = float(pose.get('theta', 0))
        body_x = float(vx) * scale * dt
        body_y = float(vy) * scale * dt
        dx = body_x * math.cos(theta) - body_y * math.sin(theta)
        dy = body_x * math.sin(theta) + body_y * math.cos(theta)
        nx = float(pose.get('x', 0)) + dx
        ny = float(pose.get('y', 0)) + dy
        return point_in_polygon(nx, ny, poly)

    def _teleop_vector(self) -> tuple[int, int, int]:
        vx, vy, omega = 0, 0, 0
        if 'w' in self._pressed or 'up' in self._pressed:
            vx += TELEOP_MAX_VX
        if 's' in self._pressed or 'down' in self._pressed:
            vx -= TELEOP_MAX_VX
        if 'a' in self._pressed or 'left' in self._pressed:
            vy += TELEOP_MAX_VY
        if 'd' in self._pressed or 'right' in self._pressed:
            vy -= TELEOP_MAX_VY
        if 'q' in self._pressed:
            omega += TELEOP_MAX_OMEGA
        if 'e' in self._pressed:
            omega -= TELEOP_MAX_OMEGA
        return (clamp(vx, -TELEOP_MAX_VX, TELEOP_MAX_VX),
                clamp(vy, -TELEOP_MAX_VY, TELEOP_MAX_VY),
                clamp(omega, -TELEOP_MAX_OMEGA, TELEOP_MAX_OMEGA))

    # ══════════════════════════════════════════════════════════════════════
    # MESSAGE HANDLER
    # ══════════════════════════════════════════════════════════════════════
    @Slot(dict)
    def _handle(self, msg: dict) -> None:
        t = msg.get('type')
        data = msg.get('data')
        if t == 'pose':
            self.state.pose = data
            self.state.pose_ts = time.monotonic()
            try:
                self.state.trajectory.append(
                    (float(data.get('x', 0)), float(data.get('y', 0))))
            except (TypeError, ValueError):
                pass
            self._check_geofence(data.get('x', 0), data.get('y', 0))
            return
        if t == 'scan':
            # The bridge sends robot-frame points as {x, y}; accept the
            # occasional [x, y] shape too so one malformed point cannot
            # discard the entire scan frame.
            raw_points = data.get('points') if isinstance(data, dict) else data
            points: list[tuple[float, float]] = []
            for point in (raw_points or []):
                try:
                    if isinstance(point, dict):
                        points.append((float(point['x']), float(point['y'])))
                    elif isinstance(point, (list, tuple)) and len(point) >= 2:
                        points.append((float(point[0]), float(point[1])))
                except (KeyError, TypeError, ValueError):
                    continue
            self.state.scan_points = points
            self.state.scan_ts = time.monotonic()
            # Log first scan + periodic updates for debugging.
            n = len(points)
            if not getattr(self, '_scan_logged', False) or n == 0:
                self._log(f'📡 scan: {n} pts (age 0s)')
                self._scan_logged = True
            elif getattr(self, '_scan_count_log', 0) % 20 == 0:
                age = time.monotonic() - self.state.scan_ts
                self._log(f'📡 scan: {n} pts (age {age:.1f}s)')
            self._scan_count_log = getattr(self, '_scan_count_log', 0) + 1
            return
        if t == 'detected_tags':
            if isinstance(data, dict):
                tags = data.get('tags')
                if not isinstance(tags, list) and 'tag_id' in data:
                    tags = [data]  # legacy single-tag payload
                if isinstance(tags, list):
                    seen_ids = set()
                    for tag in tags:
                        if not isinstance(tag, dict) or 'tag_id' not in tag:
                            continue
                        try:
                            tag_id = int(tag['tag_id'])
                        except (TypeError, ValueError):
                            continue
                        self.state.detected_tags[tag_id] = tag
                        seen_ids.add(tag_id)
                    if seen_ids:
                        self.state.detected_tag_ts = time.monotonic()
                        self._log(
                            '📷 phát hiện AprilTags: ' +
                            ', '.join(f'#{tag_id}' for tag_id in sorted(seen_ids)))
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
        if t == 'esp32_status':
            self.state.esp32_status = data
            return
        if t == 'esp32_encoder':
            self.state.esp32_encoder = data if isinstance(data, list) else []
            return
        if t == 'esp32_imu':
            self.state.esp32_imu = data
            return
        if t == 'esp32_power':
            self.state.esp32_power = data
            return
        if t == 'obstacle_layer':
            self.state.obstacle_layer = data
            return
        if t == 'control_mode_status':
            if isinstance(data, dict):
                new_mode = str(data.get('mode', '')).upper()
                if new_mode in ('AUTO', 'MANUAL'):
                    self.state.control_mode = new_mode
            return
        if t == 'demo_status':
            self.state.demo_status = data
            return
        if t == 'ack':
            cmd = safe_get(data, 'command', default='?')
            accepted = safe_get(data, 'accepted', default=False)
            err = safe_get(data, 'error', default=None)
            self._log(f'{"✓" if accepted else "✗"} {cmd}' +
                      (f' — {err}' if err else ''), error=not accepted)
            # Revert optimistic mode update if server rejected it.
            if not accepted and cmd.startswith('mode:'):
                rejected_mode = cmd.split(':', 1)[1].upper()
                if rejected_mode in ('AUTO', 'MANUAL'):
                    prev = 'MANUAL' if rejected_mode == 'AUTO' else 'AUTO'
                    self.state.control_mode = prev
            return
        if t == 'pong':
            return
        if t == 'navigate_result':
            ok = bool(data.get('success', False))
            duration = float(data.get('duration_s', 0.0))
            self.state.nav_active = False
            self._log(f'{"✓" if ok else "✗"} navigate result: {duration:.1f}s')
            self._finalize_trip(ok, duration)
            # Keep the current survey substep. The survey timer sees
            # nav_active=False and advances home/navigate → unload.
            if not ok and self.state.survey_running:
                self.state.survey_paused = True
                self.state.survey_running = False
                self._log('⏸ khảo sát tạm dừng vì navigate thất bại', error=True)
            elif ok and self.state.survey_running and self.state.survey_substep == 'final_home':
                self._finish_survey()
            return
        if t == 'navigate_status':
            self._log(f'⏳ nav: {data}')
            return
        if t == 'robot_error':
            severity = (data.get('severity') if isinstance(data, dict) else 'error') or 'error'
            code = (data.get('code') if isinstance(data, dict) else 'UNKNOWN') or 'UNKNOWN'
            message = (data.get('message') if isinstance(data, dict) else str(data)) or ''
            self.state.robot_errors.append({
                'ts': time.time(),
                'severity': severity,
                'code': code,
                'message': message,
            })
            self.state.robot_errors_ts = time.monotonic()
            icon = {'critical': '⛔', 'warning': '⚠️'}.get(severity.lower(), '❌')
            self._log(f'{icon} [{severity.upper()}] {code}: {message}', error=True)
            # Pop a message box for critical errors so the operator notices immediately.
            if severity.lower() in ('critical', 'error'):
                try:
                    QMessageBox.warning(
                        self,
                        f'{icon} {severity.upper()}: {code}',
                        message,
                        QMessageBox.StandardButton.Ok,
                    )
                except Exception:
                    pass
            return

    @Slot(bool, str)
    def _on_connection_changed(self, connected: bool, msg: str) -> None:
        self.state.connected = connected
        self.state.connection_message = msg
        if connected:
            self._log(f'✓ connected to {msg}')
        else:
            self._log(f'● disconnected ({msg})', error=True)

    # ══════════════════════════════════════════════════════════════════════
    # GEOFENCE
    # ══════════════════════════════════════════════════════════════════════
    def _check_geofence(self, x: float, y: float) -> None:
        cfg = self.state.geofence
        if not cfg.get('enabled', True):
            self.state.geofence_ok = True
            return
        poly = cfg.get('polygon', [])
        signed = distance_to_polygon_edge(float(x), float(y), poly)
        inside = signed >= 0
        soft = max(0, float(cfg.get('soft_margin_m', 0.30)))
        hard = max(0, float(cfg.get('hard_margin_m', 0.10)))
        self.state.geofence_ok = inside
        self.state.geofence_warn = inside and abs(signed) <= soft
        self.state.geofence_breach = (not inside) and abs(signed) >= hard
        if inside:
            self.state.geofence_violation_count = 0
            self._geofence_warned_once = False
            return
        self.state.geofence_violation_count += 1
        if self.state.geofence_violation_count == 1:
            self._log(f'⚠ GEOFENCE: robot ngoài vùng tại ({x:.2f}, {y:.2f})', error=True)
            self._send_esp32({'cmd': 'e_stop'})

    def _auto_update_geofence(self) -> None:
        poly = build_polygon_from_lines(self.state.map_lines)
        if poly is not None:
            cfg = self.state.geofence.copy()
            cfg['polygon'] = poly
            cfg['enabled'] = True
            geofence_save(_GEOFENCE_PATH, cfg)
            self.state.geofence = cfg
            self._log(f'✓ geofence tự cập nhật: {len(poly)} đỉnh')

    def _open_geofence_editor(self) -> None:
        dlg = GeofenceEditorDialog(self.state.geofence, self)
        if dlg.exec() == GeofenceEditorDialog.DialogCode.Accepted:
            poly = dlg.result_polygon()
            if poly:
                cfg = self.state.geofence.copy()
                cfg['polygon'] = poly
                geofence_save(_GEOFENCE_PATH, cfg)
                self.state.geofence = cfg
                self._log(f'✓ geofence đã lưu: {len(poly)} đỉnh')

    # ══════════════════════════════════════════════════════════════════════
    # WAYPOINT ACTIONS
    # ══════════════════════════════════════════════════════════════════════
    def _goto_waypoint(self, wp_id: int) -> None:
        wp = next((w for w in self.state.waypoints if int(w.get('id', -1)) == wp_id), None)
        if wp:
            self._send_navigate(float(wp['x']), float(wp['y']),
                                float(wp.get('theta', 0.0)), str(wp.get('label', wp_id)))

    def _delete_waypoint(self, wp_id: int) -> None:
        self.state.waypoints = [w for w in self.state.waypoints
                                if int(w.get('id', -1)) != wp_id]
        self.state.selected_waypoint_id = -1
        save_json(_WAYPOINTS_PATH, self.state.waypoints)
        self._log(f'✓ đã xóa waypoint #{wp_id}')

    def _shortcut_delete_warehouse(self) -> None:
        """Global Delete key: only active in F3 mode on a selected warehouse."""
        if self.state.canvas_mode != 'waypoint':
            return
        wp_id = self.state.selected_waypoint_id
        if wp_id < 0:
            self._log('chọn1 kho trong danh sách trước khi nhấn Delete', error=True)
            return
        wp = next((w for w in self.state.waypoints
                   if int(w.get('id', -1)) == wp_id), None)
        if wp is None:
            return
        kind = wp.get('kind', 'waypoint')
        label = wp.get('label', str(wp_id))
        ok = QMessageBox.question(
            self, 'Xóa waypoint',
            f'Xóa {kind} "{label}" (id={wp_id})?',
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No)
        if ok == QMessageBox.StandardButton.Yes:
            self._delete_waypoint(wp_id)

    def _rename_waypoint(self, wp_id: int) -> None:
        wp = next((w for w in self.state.waypoints if int(w.get('id', -1)) == wp_id), None)
        if wp:
            from PySide6.QtWidgets import QInputDialog
            new_label, ok = QInputDialog.getText(self, 'Đổi tên', f'Label cho #{wp_id}:',
                                                 text=wp.get('label', str(wp_id)))
            if ok and new_label.strip():
                wp['label'] = new_label.strip()
                save_json(_WAYPOINTS_PATH, self.state.waypoints)
                self._log(f'✓ waypoint #{wp_id} → {new_label.strip()}')

    def _set_waypoint_tag(self, wp_id: int) -> None:
        wp = next((w for w in self.state.waypoints if int(w.get('id', -1)) == wp_id), None)
        if not wp:
            return
        from PySide6.QtWidgets import QInputDialog
        tag_str, ok = QInputDialog.getInt(self, 'AprilTag ID',
                                          f'ID cho #{wp_id}:',
                                          int(wp.get('tag_id', 0)), 0, 9999)
        if ok:
            wp['tag_id'] = tag_str
            wp['kind'] = 'warehouse' if tag_str > 0 else 'waypoint'
            if tag_str > 0 and not wp.get('label', '').startswith('kho'):
                wp['label'] = f'kho-{tag_str}'
            save_json(_WAYPOINTS_PATH, self.state.waypoints)
            self._log(f'✓ #{wp_id} → TAG#{tag_str} ({wp.get("label", "?")})')

    def _edit_wall(self, idx: int) -> None:
        if idx < 0 or idx >= len(self.state.map_lines):
            return
        self._edit_wall_at(idx)

    def _edit_selected_wall(self) -> None:
        idx = self.state.selected_wall_index
        if idx < 0 or idx >= len(self.state.map_lines):
            self._log('ℹ hãy click chọn một đường tường trước', error=True)
            return
        self._edit_wall_at(idx)

    def _edit_wall_at(self, idx: int) -> None:
        line = self.state.map_lines[idx]
        dlg = WallEditorDialog(line, self)
        if dlg.exec() == WallEditorDialog.DialogCode.Accepted:
            new_line = dlg.result_line()
            self.state.map_lines[idx] = new_line
            save_json(_MAP_PATH, self.state.map_lines)
            length = math.hypot(new_line[2] - new_line[0],
                                new_line[3] - new_line[1])
            self._log(f'✓ line #{idx} cập nhật — dài {length:.2f}m')
            self._auto_update_geofence()
            self.map_canvas.refresh()

    def _apply_walls_as_geofence(self) -> None:
        self._auto_update_geofence()

    # ══════════════════════════════════════════════════════════════════════
    # MAP PERSISTENCE
    # ══════════════════════════════════════════════════════════════════════
    def _save_map(self) -> None:
        save_json(_MAP_PATH, self.state.map_lines)
        save_json(_WAYPOINTS_PATH, self.state.waypoints)
        self._log(f'✓ đã lưu bản đồ ({len(self.state.map_lines)} đường, '
                  f'{len(self.state.waypoints)} waypoint)')

    def _clear_map(self) -> None:
        self.state.map_lines.clear()
        self.state.waypoints.clear()
        self.state._next_waypoint_id = 1
        save_json(_MAP_PATH, [])
        save_json(_WAYPOINTS_PATH, [])
        self._log('✓ đã xóa bản đồ + waypoint')

    # ══════════════════════════════════════════════════════════════════════
    # SURVEY STATE MACHINE
    # ══════════════════════════════════════════════════════════════════════
    def _begin_survey(self) -> None:
        if self.state.survey_running:
            self._log('⚠ khảo sát đang chạy', error=True)
            return
        if not self.bridge.is_connected():
            self._log('❌ chưa kết nối robot', error=True)
            return
        if self.state.control_mode != 'AUTO':
            self._log('❌ chuyển sang AUTO mode trước', error=True)
            return
        if not self.state.home_pose:
            self._log('❌ chưa đặt Home', error=True)
            return
        wp_all = [w for w in self.state.waypoints
                  if isinstance(w, dict) and 'x' in w and 'y' in w]
        if not wp_all:
            self._log('❌ chưa có waypoint kho nào', error=True)
            return
        ws = load_warehouse_state(_WAREHOUSE_STATE_PATH)
        done_ids: set[int] = set(int(x) for x in ws.get('done_ids', []))
        pending = [w for w in wp_all if int(w.get('id', -1)) not in done_ids]
        if not pending:
            self._log('✓ tất cả kho đã được đổ — bấm Reset để chạy lại', error=True)
            return
        self.state.warehouse_state = ws
        self.state.survey_done_ids = list(done_ids)
        self.state.survey_queue = pending
        self.state.survey_running = True
        self.state.survey_paused = False
        self._log(f'📦 BẮT ĐẦU KHẢO SÁT: {len(pending)} kho còn trống')
        self.state.survey_substep = 'home'
        h = self.state.home_pose
        if not self._send_navigate(h['x'], h['y'], h.get('theta', 0.0),
                                   'survey-home', _survey=True):
            self.state.survey_running = False
            self.state.survey_paused = True
            self._log('⏸ không thể bắt đầu khảo sát — lệnh Home thất bại', error=True)

    def _poll_survey(self) -> None:
        if not self.state.survey_running:
            return
        if self.state.survey_paused:
            return
        st = self.state.survey_substep
        if st in ('home', 'navigate', 'final_home') and self.state.nav_active:
            return
        if st == 'home' and not self.state.nav_active:
            self.state.survey_substep = 'navigate'
            self._go_to_next_shelf()
            return
        if st == 'final_home' and not self.state.nav_active:
            # A failed final-home result is handled in _handle; do not
            # declare completion merely because the command is no longer active.
            return
        if st == 'navigate' and not self.state.nav_active:
            self.state.survey_substep = 'extend'
            self.state.survey_substep_at = time.monotonic()
            self._send_esp32({'cmd': 'extend'})
            wp = self.state.survey_queue[0] if self.state.survey_queue else {}
            self._log(f'📦 xi-lanh mở tại {wp.get("label", "?")}')
            return
        if st == 'extend':
            if time.monotonic() - self.state.survey_substep_at >= 1.5:
                self.state.survey_substep = 'retract'
                self.state.survey_substep_at = time.monotonic()
                self._send_esp32({'cmd': 'retract'})
                self._log('📦 xi-lanh thu vào')
            return
        if st == 'retract':
            if time.monotonic() - self.state.survey_substep_at >= 1.5:
                self._on_survey_shelf_done()
            return

    def _go_to_next_shelf(self) -> None:
        if not self.state.survey_queue:
            self._finish_survey()
            return
        wp = self.state.survey_queue[0]
        self.state.survey_substep = 'navigate'
        self._send_navigate(float(wp['x']), float(wp['y']),
                            float(wp.get('theta', 0.0)),
                            f"survey-wp-{wp.get('id', '?')}", _survey=True)

    def _on_survey_shelf_done(self) -> None:
        if not self.state.survey_queue:
            self._finish_survey()
            return
        wp = self.state.survey_queue.pop(0)
        wp_id = int(wp.get('id', -1))
        if wp_id >= 0:
            self.state.survey_done_ids.append(wp_id)
        ws = self.state.warehouse_state.copy()
        ws['done_ids'] = list(self.state.survey_done_ids)
        ws['last_run_ts'] = time.time()
        ws['total_unloads'] = int(ws.get('total_unloads', 0)) + 1
        self.state.warehouse_state = ws
        save_warehouse_state(_WAREHOUSE_STATE_PATH, ws)
        n_left = len(self.state.survey_queue)
        n_done = len(ws['done_ids'])
        self._log(f'✓ kho {wp.get("label", wp_id)} — còn {n_left} ({n_done} đã đổ)')
        if self.state.survey_queue:
            self._go_to_next_shelf()
        else:
            self._log('🏁 tất cả kho đã đổ — về Home…')
            self.state.survey_substep = 'final_home'
            h = self.state.home_pose
            self._send_navigate(h['x'], h['y'], h.get('theta', 0.0),
                                'survey-home-final', _survey=True)
            # Wait for navigate_result before declaring the survey finished.

    def _finish_survey(self) -> None:
        self.state.survey_running = False
        n_done = len(self.state.survey_done_ids)
        self._log(f'🏁 KHẢO SÁT HOÀN THÀNH — {n_done} kho đã đổ')

    def _stop_survey(self) -> None:
        if not self.state.survey_running:
            return
        self.state.survey_paused = True
        self.state.survey_running = False
        self._send_esp32({'cmd': 'stop'})
        q = len(self.state.survey_queue)
        self._log(f'⏸ khảo sát tạm dừng — còn {q} kho', error=True)

    def _reset_survey_done(self) -> None:
        ws = load_warehouse_state(_WAREHOUSE_STATE_PATH)
        if not ws.get('done_ids'):
            self._log('ℹ chưa có kho nào được đánh dấu đã đổ')
            return
        ws['done_ids'] = []
        save_warehouse_state(_WAREHOUSE_STATE_PATH, ws)
        self.state.warehouse_state = ws
        self.state.survey_done_ids = []
        self._log('✓ đã reset danh sách kho đã đổ')

    # ══════════════════════════════════════════════════════════════════════
    # UDP DISCOVERY + MANUAL CONNECT
    # ══════════════════════════════════════════════════════════════════════
    def _start_udp_scan(self) -> None:
        self._log('🔍 đang tìm robot trên mạng …')
        self._udp = UDPDiscovery()
        self._udp.device_found.connect(self._on_device_found)
        self._udp.log_message.connect(lambda m, e: self._log(m, e))
        self._udp.start()

    def _on_device_found(self, device: dict) -> None:
        ws_url = device.get('ws_url', '')
        hostname = device.get('hostname', device.get('ip', '?'))
        self._log(f'✓ tìm thấy: {hostname} — {ws_url}')
        # Skip if already connected to this URL (avoid duplicate connections).
        if self.bridge.is_connected() and self.bridge.url == ws_url:
            return
        if not self.bridge.is_connected():
            self._log(f'→ tự động kết nối {ws_url} …')
            self.bridge.close()
            self.bridge = BridgeClient(ws_url, auth_token=resolve_token())
            self.bridge.message_received.connect(self._handle, Qt.ConnectionType.QueuedConnection)
            self.bridge.connection_changed.connect(self._on_connection_changed, Qt.ConnectionType.QueuedConnection)
            self.bridge.log_message.connect(lambda m, e: self._log(m, e), Qt.ConnectionType.QueuedConnection)
            self.bridge.start()

    def _on_manual_connect(self) -> None:
        dlg = ConnectDialog(self)
        if dlg.exec() == ConnectDialog.DialogCode.Accepted:
            url = dlg.get_url()
            self.bridge.close()
            self.bridge = BridgeClient(url, auth_token=resolve_token())
            self.bridge.message_received.connect(self._handle, Qt.ConnectionType.QueuedConnection)
            self.bridge.connection_changed.connect(self._on_connection_changed, Qt.ConnectionType.QueuedConnection)
            self.bridge.log_message.connect(lambda m, e: self._log(m, e), Qt.ConnectionType.QueuedConnection)
            self.bridge.start()
            self.setWindowTitle(f'AGV Operator — {url}')

    # ══════════════════════════════════════════════════════════════════════
    # LOGGING
    # ══════════════════════════════════════════════════════════════════════
    def _log(self, msg: str, error: bool = False) -> None:
        ts = time.strftime('%H:%M:%S')
        prefix = '✗' if error else '·'
        self.state.push_log(f'{prefix} {msg}')
        try:
            print(f'[operator] {msg}', file=sys.stderr if error else sys.stdout)
        except UnicodeEncodeError:
            safe = msg.encode('ascii', errors='replace').decode('ascii')
            print(f'[operator] {safe}', file=sys.stderr if error else sys.stdout)


# ══════════════════════════════════════════════════════════════════════════
# ENTRY POINT
# ══════════════════════════════════════════════════════════════════════════
def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description='AGV operator — PySide6')
    p.add_argument('--url', default=DEFAULT_URL,
                   help=f'WebSocket URL (default: {DEFAULT_URL})')
    return p.parse_args()


def main() -> None:
    args = parse_args()
    app = QApplication(sys.argv)
    app.setStyleSheet(DARK_THEME)
    app.setApplicationName('AGV Operator')
    win = OperatorWindow(args.url)
    win.show()
    # Bring window to front (Windows 11 often buries it)
    win.raise_()
    win.activateWindow()
    sys.exit(app.exec())


if __name__ == '__main__':
    main()
