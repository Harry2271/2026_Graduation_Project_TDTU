"""World-frame canvas using QPainter in paintEvent (pixel-controlled).

Uses a direct QPainter approach instead of QGraphicsView to avoid the
"everything is in metres" scaling problem. Pan/zoom are handled manually
with mouse events and coordinate transforms — same UX as the Tkinter
operator_app but cleaner.
"""
from __future__ import annotations

import math
import time
from typing import Any

from PySide6.QtCore import Qt, QPointF, QRect, Signal
from PySide6.QtGui import (
    QPainter, QPen, QBrush, QColor, QFont, QFontMetrics, QPolygonF,
    QTransform, QPaintEvent, QMouseEvent, QWheelEvent, QResizeEvent,
)
from PySide6.QtWidgets import QWidget, QApplication

from .geo import snap_line_endpoints


# ── Constants ──────────────────────────────────────────────────────────────
_GRID_FONT = QFont('Consolas', 7)
_LABEL_FONT = QFont('Consolas', 9, QFont.Weight.Bold)
_TITLE_FONT = QFont('Segoe UI', 10, QFont.Weight.Bold)
_HOME_FONT = QFont('Segoe UI', 11, QFont.Weight.Bold)
_WP_FONT = QFont('Consolas', 9, QFont.Weight.Bold)
_WP_SMALL = QFont('Consolas', 7, QFont.Weight.Bold)
_HINT_FONT = QFont('Segoe UI', 8)
_ENDPOINT_HIT_R = 8     # px — endpoint click tolerance
_ENDPOINT_DRAW_R = 5    # px — endpoint square half-size
_WALL_HIT_R = 0.18      # m — wall body click tolerance


def _rgb(r: int, g: int, b: int) -> str:
    return f'#{r:02x}{g:02x}{b:02x}'


class MapCanvas(QWidget):
    """Pixel-controlled world-frame map with pan/zoom."""

    world_clicked = Signal(float, float)
    edit_wall_requested = Signal(int)
    waypoint_created = Signal(float, float)
    wall_created = Signal(float, float, float, float)
    wall_selected = Signal(int)
    wall_deleted = Signal(int)
    wall_changed = Signal(int)
    waypoint_moved = Signal(int, float, float)
    home_requested = Signal(float, float)

    def __init__(self, state: Any, parent=None) -> None:
        super().__init__(parent)
        self.state = state
        self.setMinimumSize(400, 300)
        self.setMouseTracking(True)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.setAutoFillBackground(True)
        self.palette().setColor(self.palette().ColorRole.Window, QColor('#06101c'))

        self._cx: float = 0.0   # world coords at screen centre
        self._cy: float = 0.0
        self._range_m: float = 6.0  # world metres visible across viewport width
        self._panning = False
        self._pan_start = (0.0, 0.0)
        self._drawing_line: list[float] | None = None
        self._drag_wall: dict | None = None
        self._drag_wp: int | None = None
        self._mouse_pos: tuple[float, float] | None = None
        # Single-click timer to distinguish click (select) from double-click (edit).
        from PySide6.QtCore import QTimer
        self._wall_click_pending = None
        self._wall_click_timer = QTimer(self)
        self._wall_click_timer.setSingleShot(True)
        self._wall_click_timer.timeout.connect(self._on_wall_click_timeout)

    def refresh(self) -> None:
        """Repaint the canvas after state or telemetry changes."""
        self.update()

    def _draw_obstacle_layer(self, p: QPainter, layer: dict) -> None:
        """Render the awareness-zone occupancy grid as a faint overlay."""
        try:
            data = layer.get('data') or []
            w = int(layer.get('width', 0))
            h = int(layer.get('height', 0))
            res = float(layer.get('resolution', 0.05))
            ox = float(layer.get('origin_x', 0))
            oy = float(layer.get('origin_y', 0))
        except (TypeError, ValueError):
            return
        if w <= 0 or h <= 0 or not data or len(data) < w * h:
            return
        # Mark every occupied cell — sample every Nth cell for speed.
        step = max(1, int(0.5 / res))
        for jy in range(0, h, step):
            for ix in range(0, w, step):
                val = data[jy * w + ix]
                if val is None or val < 50:
                    continue
                wx = ox + (ix + 0.5) * res
                wy = oy + (jy + 0.5) * res
                sx, sy = self._world_to_screen(wx, wy)
                if 0 <= sx <= self.width() and 0 <= sy <= self.height():
                    p.fillRect(int(sx) - 2, int(sy) - 2, 4, 4,
                               QColor(255, 80, 80, 90))

    # ── Coordinate helpers ────────────────────────────────────────────────
    def _px_per_m(self) -> float:
        return self.width() / max(self._range_m, 0.5)

    def _world_to_screen(self, wx: float, wy: float) -> tuple[float, float]:
        ppm = self._px_per_m()
        sx = self.width() / 2 + (wx - self._cx) * ppm
        sy = self.height() / 2 - (wy - self._cy) * ppm  # Y-flip
        return sx, sy

    def _screen_to_world(self, sx: float, sy: float) -> tuple[float, float]:
        ppm = self._px_per_m()
        wx = self._cx + (sx - self.width() / 2) / ppm
        wy = self._cy - (sy - self.height() / 2) / ppm
        return wx, wy

    # ── Mouse ─────────────────────────────────────────────────────────────
    def mousePressEvent(self, ev: QMouseEvent) -> None:
        if ev.button() == Qt.MouseButton.MiddleButton:
            self._panning = True
            self._pan_start = (ev.position().x(), ev.position().y(),
                               self._cx, self._cy)
            ev.accept(); return
        if ev.button() == Qt.MouseButton.RightButton:
            wx, wy = self._screen_to_world(ev.position().x(), ev.position().y())
            hit = self._hit_wall(wx, wy)
            if hit is not None:
                self.wall_deleted.emit(hit)
            ev.accept(); return
        if ev.button() != Qt.MouseButton.LeftButton:
            return super().mousePressEvent(ev)
        wx, wy = self._screen_to_world(ev.position().x(), ev.position().y())
        if self.state.placing_home:
            self.home_requested.emit(wx, wy); ev.accept(); return
        mode = self.state.canvas_mode
        if mode == 'waypoint':
            wp = self._hit_waypoint(wx, wy)
            if wp is not None:
                self._drag_wp = wp
            else:
                self.waypoint_created.emit(wx, wy)
            ev.accept(); return
        if mode == 'design':
            # 1. Clicking near an endpoint drags that endpoint.
            ep = self._hit_endpoint(wx, wy)
            if ep is not None:
                self._drag_wall = {'index': ep[0], 'end': ep[1]}
                self.wall_selected.emit(ep[0])
                ev.accept(); return
            # 2. Clicking the wall body selects it (single click selects,
            #    double click opens the edit dialog).
            hit = self._hit_wall(wx, wy)
            if hit is not None:
                self._wall_click_pending = (hit, ev.position().toPoint())
                self.wall_selected.emit(hit)
                self._wall_click_timer.start(
                    QApplication.doubleClickInterval())
                ev.accept(); return
            # 3. Empty space starts a new wall.
            self._drawing_line = [wx, wy, wx, wy]
            ev.accept(); return
        super().mousePressEvent(ev)

    def mouseDoubleClickEvent(self, ev: QMouseEvent) -> None:
        if self.state.canvas_mode != 'design':
            return super().mouseDoubleClickEvent(ev)
        if ev.button() != Qt.MouseButton.LeftButton:
            return super().mouseDoubleClickEvent(ev)
        wx, wy = self._screen_to_world(ev.position().x(), ev.position().y())
        hit = self._hit_wall(wx, wy)
        if hit is not None:
            self.wall_selected.emit(hit)
            self.edit_wall_requested.emit(hit)
            ev.accept()
            return
        super().mouseDoubleClickEvent(ev)

    def mouseMoveEvent(self, ev: QMouseEvent) -> None:
        self._mouse_pos = (ev.position().x(), ev.position().y())
        if self._panning:
            sx, sy = ev.position().x(), ev.position().y()
            start_sx, start_sy, start_cx, start_cy = self._pan_start
            ppm = self._px_per_m()
            self._cx = start_cx - (sx - start_sx) / ppm
            self._cy = start_cy + (sy - start_sy) / ppm
            self.update(); ev.accept(); return
        wx, wy = self._screen_to_world(ev.position().x(), ev.position().y())
        if self._drag_wp is not None:
            self.waypoint_moved.emit(self._drag_wp, wx, wy); ev.accept(); return
        if self._drag_wall is not None:
            idx = self._drag_wall['index']
            end = self._drag_wall['end']
            if 0 <= idx < len(self.state.map_lines):
                line = self.state.map_lines[idx]
                if end == 0:
                    line[0], line[1] = round(wx, 3), round(wy, 3)
                else:
                    line[2], line[3] = round(wx, 3), round(wy, 3)
                self.wall_changed.emit(idx)
                self.update()
            ev.accept(); return
        if self._drawing_line is not None:
            self._drawing_line[2], self._drawing_line[3] = wx, wy
            self.update(); ev.accept(); return
        # Hover cursor feedback in design mode
        if self.state.canvas_mode == 'design':
            if self._hit_endpoint(wx, wy) is not None:
                self.setCursor(Qt.CursorShape.SizeAllCursor)
            elif self._hit_wall(wx, wy) is not None:
                self.setCursor(Qt.CursorShape.PointingHandCursor)
            else:
                self.setCursor(Qt.CursorShape.CrossCursor)
        else:
            self.setCursor(Qt.CursorShape.ArrowCursor)
        super().mouseMoveEvent(ev)

    def mouseReleaseEvent(self, ev: QMouseEvent) -> None:
        if ev.button() == Qt.MouseButton.MiddleButton:
            self._panning = False; ev.accept(); return
        if ev.button() != Qt.MouseButton.LeftButton:
            return super().mouseReleaseEvent(ev)
        wx, wy = self._screen_to_world(ev.position().x(), ev.position().y())
        if self._drag_wp is not None:
            self.waypoint_moved.emit(self._drag_wp, wx, wy)
            self._drag_wp = None
        elif self._drag_wall is not None:
            self._drag_wall = None
            self.update()
        elif self._drawing_line is not None:
            x1, y1 = self._drawing_line[0], self._drawing_line[1]
            if math.hypot(wx - x1, wy - y1) >= 0.05:
                self.wall_created.emit(x1, y1, wx, wy)
            self._drawing_line = None
            self.update()
        ev.accept()

    def wheelEvent(self, ev: QWheelEvent) -> None:
        factor = 0.85 if ev.angleDelta().y() > 0 else 1.18
        self._range_m = max(1.0, min(80.0, self._range_m * factor))
        self.update(); ev.accept()

    # ── Hit tests ─────────────────────────────────────────────────────────
    def _hit_wall(self, wx: float, wy: float) -> int | None:
        best, best_d = None, _WALL_HIT_R
        for idx, line in enumerate(self.state.map_lines):
            if len(line) < 4:
                continue
            d = self._pt_seg_dist(wx, wy, line[0], line[1], line[2], line[3])
            if d < best_d:
                best, best_d = idx, d
        return best

    def _hit_endpoint(self, wx: float, wy: float) -> tuple[int, int] | None:
        """Find the nearest endpoint click within _ENDPOINT_HIT_R pixels.

        Returns (wall_index, endpoint_index) where endpoint_index is 0 or 1,
        or None if nothing close enough was hit.
        """
        ppm = self._px_per_m()
        best: tuple[int, int] | None = None
        best_px = _ENDPOINT_HIT_R + 1.0
        for idx, line in enumerate(self.state.map_lines):
            if len(line) < 4:
                continue
            for end_i, ex, ey in ((0, line[0], line[1]), (1, line[2], line[3])):
                sx, sy = self._world_to_screen(ex, ey)
                px = math.hypot(wx - ex, wy - ey) * ppm
                if px < best_px:
                    best_px = px
                    best = (idx, end_i)
        return best

    def _on_wall_click_timeout(self) -> None:
        """Single-click on wall body: just keep the selection (no action)."""
        self._wall_click_pending = None

    def _hit_waypoint(self, wx: float, wy: float) -> int | None:
        for wp in self.state.waypoints:
            if math.hypot(wx - float(wp.get('x', 0)), wy - float(wp.get('y', 0))) < 0.25:
                return int(wp.get('id', -1))
        return None

    @staticmethod
    def _pt_seg_dist(px, py, x1, y1, x2, y2):
        dx, dy = x2 - x1, y2 - y1
        l2 = dx * dx + dy * dy
        if l2 < 1e-12: return math.hypot(px - x1, py - y1)
        t = max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / l2))
        return math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))

    # ══════════════════════════════════════════════════════════════════════
    # PAINT
    # ══════════════════════════════════════════════════════════════════════
    def paintEvent(self, ev: QPaintEvent) -> None:
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        W, H = self.width(), self.height()
        p.fillRect(0, 0, W, H, QColor('#06101c'))
        ppm = self._px_per_m()

        # ── Grid (1m lines, thick every 5m) ─────────────────────────────
        wx0, wy0 = self._screen_to_world(0, H)
        wx1, wy1 = self._screen_to_world(W, 0)
        x_lo, x_hi = math.floor(min(wx0, wx1)) - 1, math.ceil(max(wx0, wx1)) + 1
        y_lo, y_hi = math.floor(min(wy0, wy1)) - 1, math.ceil(max(wy0, wy1)) + 1
        for x in range(x_lo, x_hi + 1):
            sx, _ = self._world_to_screen(x, 0)
            color = QColor('#244052') if x % 5 == 0 else QColor('#102434')
            p.setPen(QPen(color, 1 if x % 5 else 2))
            p.drawLine(int(sx), 0, int(sx), H)
            if x % 2 == 0:
                p.setFont(_GRID_FONT)
                p.setPen(QPen(QColor('#406070')))
                p.drawText(int(sx) + 4, 14, f'{x}m')
        for y in range(y_lo, y_hi + 1):
            _, sy = self._world_to_screen(0, y)
            color = QColor('#244052') if y % 5 == 0 else QColor('#102434')
            p.setPen(QPen(color, 1 if y % 5 else 2))
            p.drawLine(0, int(sy), W, int(sy))
            if y % 2 == 0:
                p.setFont(_GRID_FONT)
                p.setPen(QPen(QColor('#406070')))
                p.drawText(4, int(sy) - 4, f'{y}m')

        # ── World axes (origin stays at the true 0,0 position) ───────────
        ox, oy = self._world_to_screen(0.0, 0.0)
        p.setPen(QPen(QColor('#00d4ff'), 2))
        if 0 <= oy <= H:
            p.drawLine(0, int(oy), W, int(oy))  # +X to the right
            p.drawLine(W - 12, int(oy) - 5, W - 2, int(oy))
            p.drawLine(W - 12, int(oy) + 5, W - 2, int(oy))
            p.setFont(_GRID_FONT)
            p.drawText(W - 28, int(oy) - 8, '+X')
        if 0 <= ox <= W:
            p.drawLine(int(ox), 0, int(ox), H)  # +Y upward (screen Y reverses)
            p.drawLine(int(ox) - 5, 12, int(ox), 2)
            p.drawLine(int(ox) + 5, 12, int(ox), 2)
            p.setFont(_GRID_FONT)
            p.drawText(int(ox) + 6, 12, '+Y')
        if 0 <= ox <= W and 0 <= oy <= H:
            p.setBrush(QColor('#00d4ff'))
            p.setPen(QPen(QColor('#06101c'), 1))
            p.drawEllipse(int(ox) - 4, int(oy) - 4, 8, 8)
            p.setFont(_GRID_FONT)
            p.setPen(QPen(QColor('#8be9fd')))
            p.drawText(int(ox) + 6, int(oy) + 14, '(0,0)')

        # ── Geofence polygon ──────────────────────────────────────────────
        cfg = self.state.geofence
        poly = cfg.get('polygon', []) if cfg.get('enabled', True) else []
        if len(poly) >= 3:
            breach = self.state.geofence_breach or not self.state.geofence_ok
            warn = self.state.geofence_warn and not breach
            p.setPen(QPen(QColor('#ff4444' if breach else '#ffb800' if warn else '#00ff88'),
                          2, Qt.PenStyle.DashLine))
            p.setBrush(QColor('#3a0a0a') if breach else QColor('#3a2a0a') if warn
                       else QColor(0, 0, 0, 0))
            pts = [QPointF(*self._world_to_screen(x, y)) for x, y in poly]
            p.drawPolygon(QPolygonF(pts))

        # ── Obstacle layer (2m awareness zone) ─────────────────────────────
        obs = self.state.obstacle_layer
        if isinstance(obs, dict) and obs.get('data'):
            self._draw_obstacle_layer(p, obs)

        # ── Map lines (walls) ─────────────────────────────────────────────
        if self.state.canvas_mode == 'design':
            for idx, line in enumerate(self.state.map_lines):
                if len(line) < 4: continue
                sx1, sy1 = self._world_to_screen(line[0], line[1])
                sx2, sy2 = self._world_to_screen(line[2], line[3])
                sel = idx == self.state.selected_wall_index
                p.setPen(QPen(QColor('#ff4444' if sel else '#ffb800'),
                              3 if sel else 2))
                p.drawLine(int(sx1), int(sy1), int(sx2), int(sy2))
                # Length label at midpoint
                mx, my = (line[0] + line[2]) / 2, (line[1] + line[3]) / 2
                length = math.hypot(line[2] - line[0], line[3] - line[1])
                msx, msy = self._world_to_screen(mx, my)
                p.setFont(_LABEL_FONT)
                p.setPen(QPen(QColor('#ff6666' if sel else '#ffdf80')))
                prefix = '★ ' if sel else ''
                p.drawText(int(msx) + 4, int(msy) - 6,
                           f'{prefix}#{idx} {length:.2f}m')
                # Endpoint handles — larger and outlined when selected
                ep_selected = sel
                for i, (ex, ey) in enumerate(((line[0], line[1]),
                                              (line[2], line[3]))):
                    esx, esy = self._world_to_screen(ex, ey)
                    color = QColor('#ff4444' if ep_selected else '#ffdf80')
                    p.setPen(QPen(QColor('#ffffff'), 1.5))
                    p.setBrush(color)
                    p.drawRect(int(esx) - _ENDPOINT_DRAW_R,
                               int(esy) - _ENDPOINT_DRAW_R,
                               _ENDPOINT_DRAW_R * 2,
                               _ENDPOINT_DRAW_R * 2)

        # ── Preview line (while drawing) ──────────────────────────────────
        if self._drawing_line is not None:
            x1, y1, x2, y2 = self._drawing_line
            sx1, sy1 = self._world_to_screen(x1, y1)
            sx2, sy2 = self._world_to_screen(x2, y2)
            p.setPen(QPen(QColor('#ffffff'), 1, Qt.PenStyle.DashLine))
            p.drawLine(int(sx1), int(sy1), int(sx2), int(sy2))
            # Length preview
            length = math.hypot(x2 - x1, y2 - y1)
            p.setFont(_LABEL_FONT)
            p.setPen(QPen(QColor('#ffffff')))
            mx, my = self._world_to_screen((x1 + x2) / 2, (y1 + y2) / 2)
            p.drawText(int(mx) + 6, int(my) - 6, f'{length:.2f}m')

        # ── Trajectory trail ──────────────────────────────────────────────
        traj = list(self.state.trajectory)
        if len(traj) >= 2:
            n = len(traj)
            for i in range(1, n):
                frac = i / n
                alpha = int(30 + 225 * frac)
                g = int(140 + 115 * frac)
                b = int(180 + 75 * frac)
                sx0, sy0 = self._world_to_screen(*traj[i - 1])
                sx1, sy1 = self._world_to_screen(*traj[i])
                p.setPen(QPen(QColor(0, g, b, alpha), 2))
                p.drawLine(int(sx0), int(sy0), int(sx1), int(sy1))

        # ── LiDAR scan in world frame ─────────────────────────────────────
        stale = (time.monotonic() - self.state.scan_ts) > 8.0
        if self.state.scan_points and not stale and self.state.pose:
            px = float(self.state.pose.get('x', 0))
            py = float(self.state.pose.get('y', 0))
            th = float(self.state.pose.get('theta', 0))
            ct, st = math.cos(th), math.sin(th)
            step = max(1, len(self.state.scan_points) // 360)
            p.setPen(QPen(QColor('#00d4ff'), 1.5))
            for i in range(0, len(self.state.scan_points), step):
                lx, ly = self.state.scan_points[i]
                wx = px + lx * ct - ly * st
                wy = py + lx * st + ly * ct
                sx, sy = self._world_to_screen(wx, wy)
                if 0 <= sx <= W and 0 <= sy <= H:
                    p.drawEllipse(int(sx) - 1, int(sy) - 1, 2, 2)

        # ── Waypoints ─────────────────────────────────────────────────────
        nav_goal = self.state.nav_goal or {}
        nav_label = nav_goal.get('label', '')
        next_id = -1
        if self.state.survey_running and self.state.survey_queue:
            next_id = int(self.state.survey_queue[0].get('id', -1))
        if self.state.waypoints:
            for wp in self.state.waypoints:
                wx = float(wp['x']); wy = float(wp['y'])
                sx, sy = self._world_to_screen(wx, wy)
                wp_id = int(wp.get('id', -1))
                is_nav = nav_label in (str(wp.get('label', '')),
                                       f'survey-wp-{wp_id}')
                is_next = self.state.survey_running and wp_id == next_id
                is_detected = wp_id in self.state.detected_tags
                # Fill color
                if is_next:
                    fill = QColor('#ff8800')
                elif is_nav:
                    fill = QColor('#ffdd00')
                elif is_detected:
                    fill = QColor('#00ff88')
                else:
                    fill = QColor('#00d4ff')
                # Glow rings
                if is_nav:
                    p.setPen(QPen(QColor('#ffdd00'), 1, Qt.PenStyle.DashLine))
                    p.setBrush(Qt.BrushStyle.NoBrush)
                    r = int(16 * ppm / 10)
                    p.drawEllipse(int(sx) - r, int(sy) - r, r * 2, r * 2)
                if is_next:
                    p.setPen(QPen(QColor('#ff8800'), 1, Qt.PenStyle.DashLine))
                    p.setBrush(Qt.BrushStyle.NoBrush)
                    r = int(20 * ppm / 10)
                    p.drawEllipse(int(sx) - r, int(sy) - r, r * 2, r * 2)
                    p.setFont(_WP_SMALL)
                    p.setPen(QPen(QColor('#ff8800')))
                    p.drawText(int(sx), int(sy) + r + 12, 'SHELF')
                if is_detected:
                    p.setPen(QPen(QColor('#00ff88'), 2))
                    p.setBrush(Qt.BrushStyle.NoBrush)
                    r = int(12 * ppm / 10)
                    p.drawEllipse(int(sx) - r, int(sy) - r, r * 2, r * 2)
                    p.drawText(int(sx) + r + 2, int(sy) - r + 4, '✓')
                # Dot
                r = max(6, int(0.09 * ppm))
                p.setPen(QPen(QColor('#ffffff'), 1.5))
                p.setBrush(fill)
                p.drawEllipse(int(sx) - r, int(sy) - r, r * 2, r * 2)
                # Label
                p.setFont(_WP_FONT)
                p.setPen(QPen(QColor('#ffffff')))
                p.drawText(int(sx) + r + 3, int(sy) - r + 4,
                           str(wp.get('label', wp_id)))

        # ── Home marker ───────────────────────────────────────────────────
        if self.state.home_pose:
            hx = float(self.state.home_pose['x'])
            hy = float(self.state.home_pose['y'])
            sx, sy = self._world_to_screen(hx, hy)
            r = max(8, int(0.10 * ppm))
            p.setPen(QPen(QColor('#ffffff'), 1.5))
            p.setBrush(QColor('#ffcc00'))
            p.drawEllipse(int(sx) - r, int(sy) - r, r * 2, r * 2)
            p.setFont(_HOME_FONT)
            p.setPen(QPen(QColor('#1a1a00')))
            p.drawText(int(sx) - 4, int(sy) + 5, '⌂')
            p.setFont(_WP_SMALL)
            p.setPen(QPen(QColor('#ffcc00')))
            p.drawText(int(sx) + r + 2, int(sy) + 4, 'HOME')

        # ── Robot pose (dot + arrow + heading triangle) ───────────────────
        if self.state.pose:
            rpx = float(self.state.pose.get('x', 0))
            rpy = float(self.state.pose.get('y', 0))
            rth = float(self.state.pose.get('theta', 0))
            sx, sy = self._world_to_screen(rpx, rpy)
            # Green dot
            p.setPen(QPen(QColor('#ffffff'), 1.5))
            p.setBrush(QColor('#00ff88'))
            p.drawEllipse(int(sx) - 8, int(sy) - 8, 16, 16)
            # Red arrow
            arrow_len = max(18, int(0.20 * ppm))
            hx = sx + math.cos(rth) * arrow_len
            hy = sy - math.sin(rth) * arrow_len
            p.setPen(QPen(QColor('#ff3b5c'), 3))
            p.drawLine(int(sx), int(sy), int(hx), int(hy))
            # Heading triangle
            p.setPen(Qt.PenStyle.NoPen)
            p.setBrush(QColor('#ff3b5c'))
            tl = max(5, int(0.06 * ppm))
            p.drawPolygon(QPolygonF([
                QPointF(int(hx), int(hy)),
                QPointF(sx + math.cos(rth + 2.5) * tl,
                        sy - math.sin(rth + 2.5) * tl),
                QPointF(sx + math.cos(rth - 2.5) * tl,
                        sy - math.sin(rth - 2.5) * tl),
            ]))

        # ── Mouse coordinate tooltip ──────────────────────────────────────
        if self._mouse_pos is not None:
            mx, my = self._screen_to_world(*self._mouse_pos)
            p.setBrush(QColor('#07101c'))
            p.setPen(QPen(QColor('#244052')))
            p.drawRect(4, H - 28, 260, 22)
            p.setFont(_LABEL_FONT)
            p.setPen(QPen(QColor('#88ddff')))
            p.drawText(8, H - 12,
                       f'X={mx:.2f}m   Y={my:.2f}m   zoom={self._range_m:.1f}m')

        # ── Mode badge ────────────────────────────────────────────────────
        badge = 'VẼ BẢN ĐỒ' if self.state.canvas_mode == 'design' else \
                'WAYPOINT' if self.state.canvas_mode == 'waypoint' else 'ROBOT VIEW'
        p.setBrush(QColor('#07101c'))
        p.setPen(QPen(QColor('#244052')))
        p.drawRect(W - 160, 8, 150, 24)
        p.setFont(_TITLE_FONT)
        p.setPen(QPen(QColor('#00d4ff')))
        p.drawText(W - 155, 25, badge)

        p.end()


class MinimapCanvas(QWidget):
    """Compact robot-centric radar view."""

    def __init__(self, state: Any, parent=None) -> None:
        super().__init__(parent)
        self.state = state
        self.setMinimumHeight(200)
        self.setAutoFillBackground(True)
        self.palette().setColor(self.palette().ColorRole.Window, QColor('#06101c'))

    def refresh(self) -> None:
        self.update()

    def paintEvent(self, ev: QPaintEvent) -> None:
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        W, H = self.width(), self.height()
        p.fillRect(0, 0, W, H, QColor('#06101c'))
        cx, cy = W / 2, H / 2
        scale = (min(W, H) / 2 - 10) / 4.0
        # Radar rings
        for r in (1, 2, 3, 4):
            col = QColor('#0aa3c7') if r == 4 else QColor('#0a3a4a')
            p.setPen(QPen(col, 1))
            p.setBrush(Qt.BrushStyle.NoBrush)
            p.drawEllipse(int(cx - r * scale), int(cy - r * scale),
                          int(r * scale * 2), int(r * scale * 2))
        p.setPen(QPen(QColor('#103040'), 1, Qt.PenStyle.DashLine))
        p.drawLine(0, int(cy), W, int(cy))
        p.drawLine(int(cx), 0, int(cx), H)
        # Scan points (robot frame)
        for x, y in self.state.scan_points[::max(1, len(self.state.scan_points) // 300)]:
            sx = int(cx + x * scale)
            sy = int(cy - y * scale)
            if 0 <= sx < W and 0 <= sy < H:
                p.setPen(Qt.PenStyle.NoPen)
                p.setBrush(QColor('#00d4ff'))
                p.drawEllipse(sx - 1, sy - 1, 2, 2)
        # Robot marker
        p.setPen(QPen(QColor('#ffffff'), 1))
        p.setBrush(QColor('#00ff88'))
        p.drawEllipse(int(cx) - 5, int(cy) - 5, 10, 10)
        # Heading
        theta = float((self.state.pose or {}).get('theta', 0))
        p.setPen(QPen(QColor('#ff3b5c'), 2))
        hx = int(cx + math.cos(theta) * 20)
        hy = int(cy - math.sin(theta) * 20)
        p.drawLine(int(cx), int(cy), hx, hy)
        p.setFont(_WP_SMALL)
        p.setPen(QColor('#ffffff'))
        p.drawText(int(cx) + 8, int(cy) - 8, 'AGV')
        # Stale banner
        if (time.monotonic() - self.state.scan_ts) > 8.0:
            p.fillRect(0, H - 22, W, 22, QColor(26, 8, 8, 180))
            p.setFont(_LABEL_FONT)
            p.setPen(QColor('#ff6666'))
            p.drawText(0, H - 6, Qt.AlignmentFlag.AlignHCenter, '⚠ không có dữ liệu quét')
        p.end()
