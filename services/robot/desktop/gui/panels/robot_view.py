"""Robot view telemetry — live panel shown only in robot/teleop mode.

Displays compact LiDAR, ESP32, navigation, AprilTag, and AUTO-process
status so the operator can monitor the robot without leaving Robot view.
"""
from __future__ import annotations
import math
import time
from typing import Any
from PySide6.QtCore import Qt
from PySide6.QtGui import QFont
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QGroupBox,
    QGridLayout, QFrame,
)

_MONO = QFont('Consolas', 9)
_MONO_B = QFont('Consolas', 9, QFont.Weight.Bold)


def _mono_label(text: str = '') -> QLabel:
    lbl = QLabel(text)
    lbl.setFont(_MONO)
    lbl.setWordWrap(True)
    lbl.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
    return lbl


def _val(parent: QGridLayout, row: int, col: int, text: str,
         color: str = '#c9d1d9') -> QLabel:
    lbl = _mono_label(text)
    lbl.setStyleSheet(f'color:{color};')
    parent.addWidget(lbl, row, col)
    return lbl


class RobotTelemetryPanel(QWidget):
    """Compact live-telemetry readout for the Robot view mode."""

    def __init__(self, state: Any, parent=None) -> None:
        super().__init__(parent)
        self.state = state
        self._prev_log_len = 0

        root = QVBoxLayout(self)
        root.setContentsMargins(6, 6, 6, 6)
        root.setSpacing(8)

        # ── Status bar ─────────────────────────────────────────────
        self.lbl_status = QLabel()
        self.lbl_status.setStyleSheet(
            'font:bold 13px;color:#58a6ff;background:#0d1117;'
            'padding:6px 10px;border-radius:4px;')
        root.addWidget(self.lbl_status)

        # ── LiDAR group ────────────────────────────────────────────
        g_scan = QGroupBox('LiDAR / Scan')
        g_scan.setStyleSheet('QGroupBox{color:#00d4ff;}')
        self._scan = QGridLayout(g_scan)
        self._scan.setContentsMargins(8, 4, 8, 4)
        self._scan.setHorizontalSpacing(12)
        self._lbl_scan_count = _val(self._scan, 0, 0, '0 pts')
        self._lbl_scan_range = _val(self._scan, 0, 1, 'range: -')
        self._lbl_scan_fresh = _val(self._scan, 0, 2, '')
        self._lbl_scan_world = _mono_label('AGV: no pose')
        self._lbl_scan_world.setStyleSheet('color:#c9d1d9;')
        self._scan.addWidget(self._lbl_scan_world, 1, 0, 1, 3)
        root.addWidget(g_scan)

        # ── ESP32 group ────────────────────────────────────────────
        g_esp = QGroupBox('ESP32')
        g_esp.setStyleSheet('QGroupBox{color:#ff9e64;}')
        el = QGridLayout(g_esp)
        el.setContentsMargins(8, 4, 8, 4)
        el.setHorizontalSpacing(12)
        self._lbl_esp_mode = _val(el, 0, 0, 'mode: -')
        self._lbl_esp_estop = _val(el, 0, 1, 'estop: -')
        self._lbl_esp_ir = _val(el, 0, 2, 'IR: -')
        self._lbl_esp_tof = _val(el, 1, 0, 'tof: -')
        self._lbl_esp_cyl = _val(el, 1, 1, 'cyl: -')
        self._lbl_esp_cargo = _val(el, 1, 2, 'cargo: -')
        self._lbl_esp_power = _val(el, 2, 0, 'power: -')
        self._lbl_esp_imu = _val(el, 2, 1, 'IMU: -')
        self._lbl_esp_nav = _mono_label('nav vx/vy/w: -')
        self._lbl_esp_nav.setStyleSheet('color:#c9d1d9;')
        el.addWidget(self._lbl_esp_nav, 3, 0, 1, 3)
        self._lbl_motors = _mono_label('motors: -')
        self._lbl_motors.setStyleSheet('color:#c9d1d9;')
        el.addWidget(self._lbl_motors, 4, 0, 1, 3)
        root.addWidget(g_esp)

        # ── Navigation / Survey group ───────────────────────────────
        g_nav = QGroupBox('Navigation / Survey')
        g_nav.setStyleSheet('QGroupBox{color:#ffcc00;}')
        nl = QGridLayout(g_nav)
        nl.setContentsMargins(8, 4, 8, 4)
        nl.setHorizontalSpacing(12)
        self._lbl_nav_mode = _val(nl, 0, 0, 'mode: -')
        self._lbl_nav_goal = _val(nl, 0, 1, 'goal: -')
        self._lbl_nav_dist = _val(nl, 0, 2, 'dist: -')
        self._lbl_nav_elapsed = _val(nl, 1, 0, 'elapsed: -')
        self._lbl_survey = _val(nl, 1, 1, 'survey: -')
        self._lbl_survey.colspan = 2
        nl.addWidget(self._lbl_survey, 1, 1, 1, 2)
        root.addWidget(g_nav)

        # ── AprilTag group ─────────────────────────────────────────
        g_tag = QGroupBox('AprilTag')
        g_tag.setStyleSheet('QGroupBox{color:#9ece6a;}')
        tl = QVBoxLayout(g_tag)
        tl.setContentsMargins(8, 4, 8, 4)
        self._lbl_tags = _mono_label('(chưa phát hiện)')
        self._lbl_tags.setWordWrap(True)
        self._lbl_tags.setStyleSheet('color:#9ece6a;')
        tl.addWidget(self._lbl_tags)
        root.addWidget(g_tag)

        # ── Process log (compact, last 8 entries) ──────────────────
        g_log = QGroupBox('Quy trình chạy')
        g_log.setStyleSheet('QGroupBox{color:#7aa2f7;}')
        ll = QVBoxLayout(g_log)
        ll.setContentsMargins(8, 4, 8, 4)
        self._lbl_log = QLabel()
        self._lbl_log.setFont(_MONO)
        self._lbl_log.setWordWrap(True)
        self._lbl_log.setTextInteractionFlags(
            Qt.TextInteractionFlag.TextSelectableByMouse)
        self._lbl_log.setStyleSheet('color:#c9d1d9;')
        ll.addWidget(self._lbl_log)
        root.addWidget(g_log)

        root.addStretch(1)

    def refresh(self) -> None:
        s = self.state
        ts_now = time.monotonic()

        # ── Status line ─────────────────────────────────────────────
        mode = s.control_mode
        mode_color = '#00ff88' if mode == 'AUTO' else '#ffcc00'
        conn = '● connected' if s.connected else '● disconnected'
        conn_color = '#9ece6a' if s.connected else '#f7768e'
        self.lbl_status.setText(
            f'<span style="color:{conn_color}">{conn}</span>'
            f' &nbsp; | &nbsp; '
            f'<span style="color:{mode_color}">{mode}</span>'
            f' &nbsp; | &nbsp; '
            f'ROS mode: {s.mode or "-"}')

        # ── LiDAR ──────────────────────────────────────────────────
        n_pts = len(s.scan_points)
        stale = (ts_now - s.scan_ts) > 8.0 if s.scan_ts else True
        if n_pts > 0:
            dists = [math.hypot(x, y) for x, y in s.scan_points]
            lo, hi = min(dists), max(dists)
            self._lbl_scan_count.setText(f'{n_pts} pts')
            self._lbl_scan_range.setText(f'range: {lo:.1f}-{hi:.1f}m')
        else:
            self._lbl_scan_count.setText('0 pts')
            self._lbl_scan_range.setText('range: -')
        self._lbl_scan_fresh.setText(
            '🟢 LIVE' if not stale else '🔴 STALE')
        self._lbl_scan_fresh.setStyleSheet(
            'color:#9ece6a;' if not stale else 'color:#f7768e;')
        if s.pose:
            px = float(s.pose.get('x', 0))
            py = float(s.pose.get('y', 0))
            th = float(s.pose.get('theta', 0))
            th_deg = math.degrees(th)
            self._lbl_scan_world.setText(
                f'AGV X={px:.2f}  Y={py:.2f}  th={th_deg:.1f}°')
        else:
            self._lbl_scan_world.setText('AGV: no pose')

        # ── ESP32 ──────────────────────────────────────────────────
        esp = s.esp32_status or {}
        st = esp.get('st', {}) or {}
        ir = esp.get('ir', []) or []
        motors = esp.get('motors', []) or []
        ir_str = ''.join('1' if v else '0' for v in ir) if ir else '-'
        estop_color = '#f7768e' if esp.get('estop') else '#c9d1d9'
        self._lbl_esp_mode.setText(f'mode: {esp.get("mode", "-")}')
        self._lbl_esp_estop.setText(f'estop: {esp.get("estop", "-")}')
        self._lbl_esp_estop.setStyleSheet(f'color:{estop_color};')
        self._lbl_esp_ir.setText(f'IR: [{ir_str}]')
        tof = st.get('tof_mm', '-')
        obs = st.get('obs', False)
        obs_str = '⚠ OBS' if obs else ''
        self._lbl_esp_tof.setText(f'tof: {tof}mm {obs_str}')
        self._lbl_esp_tof.setStyleSheet(
            'color:#f7768e;' if obs else 'color:#c9d1d9;')
        cyl = st.get('cyl', '-')
        self._lbl_esp_cyl.setText(f'cyl: {cyl}')
        self._lbl_esp_cargo.setText(f'cargo: {st.get("cargo", "-")}')
        # Power (INA226)
        pw = s.esp32_power or {}
        if pw:
            v = pw.get('bus_v', 0)
            c = pw.get('current_ma', 0)
            bat = pw.get('battery_pct', 0)
            bat_color = '#9ece6a' if bat > 30 else '#ff9e64' if bat > 15 else '#f7768e'
            self._lbl_esp_power.setText(f'bat:{bat}%  V:{v/1000:.1f}V  I:{c:.0f}mA')
            self._lbl_esp_power.setStyleSheet(f'color:{bat_color};')
        else:
            self._lbl_esp_power.setText('power: -')
        # IMU (BNO055)
        imu = s.esp32_imu or {}
        if imu:
            heading = imu.get('heading', imu.get('yaw', 0))
            self._lbl_esp_imu.setText(f'IMU heading:{heading:.1f}°')
            self._lbl_esp_imu.setStyleSheet('color:#c9d1d9;')
        else:
            self._lbl_esp_imu.setText('IMU: -')
        nav_v = esp.get('nav', []) or [0, 0, 0]
        self._lbl_esp_nav.setText(f'nav vx/vy/w: {nav_v}')
        if motors:
            parts = []
            for i, m in enumerate(motors):
                parts.append(
                    f'{i}:t={m.get("t", 0):3d}  r={m.get("r", 0):3d}')
            self._lbl_motors.setText('  '.join(parts))
        else:
            self._lbl_motors.setText('motors: -')

        # ── Navigation / Survey ─────────────────────────────────────
        self._lbl_nav_mode.setText(f'control: {s.control_mode}')
        goal = s.nav_goal or {}
        if goal:
            gx = float(goal.get('x', 0))
            gy = float(goal.get('y', 0))
            gl = goal.get('label', '')
            self._lbl_nav_goal.setText(f'goal: ({gx:.2f},{gy:.2f}) [{gl}]')
            if s.pose:
                dx = gx - float(s.pose.get('x', 0))
                dy = gy - float(s.pose.get('y', 0))
                self._lbl_nav_dist.setText(f'dist: {math.hypot(dx, dy):.2f}m')
            else:
                self._lbl_nav_dist.setText('dist: -')
            if s.nav_start_time:
                dt = ts_now - s.nav_start_time
                self._lbl_nav_elapsed.setText(f'elapsed: {dt:.1f}s')
            else:
                self._lbl_nav_elapsed.setText('elapsed: -')
        else:
            self._lbl_nav_goal.setText('goal: -')
            self._lbl_nav_dist.setText('dist: -')
            self._lbl_nav_elapsed.setText('elapsed: -')

        if s.survey_running:
            step = s.survey_substep or '-'
            nq = len(s.survey_queue)
            nd = len(s.survey_done_ids)
            self._lbl_survey.setText(
                f'survey: 🟢 RUNNING  step={step}  queue={nq}  done={nd}')
            self._lbl_survey.setStyleSheet('color:#9ece6a;')
        elif s.survey_paused:
            self._lbl_survey.setText('survey: ⏸ PAUSED')
            self._lbl_survey.setStyleSheet('color:#ff9e64;')
        else:
            nd = len(s.survey_done_ids)
            self._lbl_survey.setText(f'survey: stopped  done={nd}')
            self._lbl_survey.setStyleSheet('color:#c9d1d9;')

        # ── AprilTag ────────────────────────────────────────────────
        tags = s.detected_tags
        # Build warehouse tag map: tag_id → waypoint label
        wh_map = {}
        for wp in (s.waypoints or []):
            if wp.get('kind') == 'warehouse' and wp.get('tag_id', 0):
                wh_map[wp['tag_id']] = wp.get('label', f'wp-{wp.get("id", "?")}')

        if tags:
            lines = []
            for tid, td in sorted(tags.items()):
                conf = td.get('confidence', 0)
                if tid in wh_map:
                    lines.append(f'🎯 #{tid}  conf={conf:.2f}  → {wh_map[tid]}')
                else:
                    lines.append(f'👁 #{tid}  conf={conf:.2f}  (chưa map)')
            t_age = ts_now - s.detected_tag_ts
            lines.append(f'  (age {t_age:.0f}s)')
            self._lbl_tags.setText('\n'.join(lines))
            self._lbl_tags.setStyleSheet('color:#9ece6a;')
        else:
            self._lbl_tags.setText('(chưa phát hiện)')
            self._lbl_tags.setStyleSheet('color:#8b949e;')

        # ── Process log (last 8 lines from ack_log) ─────────────────
        logs = s.ack_log[-8:]
        if logs:
            lines = [entry[1] for entry in logs]
            self._lbl_log.setText('\n'.join(lines))
