"""QGraphicsItem subclasses for efficient canvas rendering.

Instead of redrawing ~200 individual shapes every frame, these items
are persistent scene objects that are created once and updated in-place.
"""
from __future__ import annotations

import math
from typing import Any

from PySide6.QtCore import Qt, QPointF, QRectF, Signal
from PySide6.QtGui import (
    QPen, QBrush, QColor, QFont, QPainterPath, QPolygonF, QTransform,
)
from PySide6.QtWidgets import (
    QGraphicsItem, QGraphicsEllipseItem, QGraphicsLineItem,
    QGraphicsPolygonItem, QGraphicsPathItem, QGraphicsTextItem,
    QGraphicsScene,
)

from .geo import point_in_polygon, distance_to_polygon_edge


# ── Custom pen/brush helpers ───────────────────────────────────────────────
def _pen(color: str, width: float = 1, style: Qt.PenStyle = Qt.PenStyle.SolidLine) -> QPen:
    p = QPen(QColor(color))
    p.setWidthF(width)
    p.setStyle(style)
    p.setCosmetic(True)
    return p

def _brush(color: str) -> QBrush:
    return QBrush(QColor(color))

def _font(size: int = 9, bold: bool = False) -> QFont:
    f = QFont('Cascadia Mono', size)
    f.setBold(bold)
    return f

SEGOE_FONT = QFont('Segoe UI', 9)


# ── Scan item — single batch draw of LiDAR points ──────────────────────────
class ScanItem(QGraphicsItem):
    """Renders all scan dots as one item for performance."""

    def __init__(self) -> None:
        super().__init__()
        self._points: list[tuple[float, float]] = []  # world-frame (wx, wy)
        self._color = QColor('#00d4ff')
        self._pen = _pen('#00d4ff', 1.5)

    def set_points(self, points: list[tuple[float, float]],
                   color: str = '#00d4ff') -> None:
        self._color = QColor(color)
        self._pen = QPen(self._color)
        self._pen.setWidthF(1.5)
        self._pen.setCosmetic(True)
        self._points = points
        self.prepareGeometryChange()
        self.update()

    def boundingRect(self) -> QRectF:
        if not self._points:
            return QRectF()
        xs = [p[0] for p in self._points]
        ys = [p[1] for p in self._points]
        return QRectF(min(xs) - 0.05, min(ys) - 0.05,
                      max(xs) - min(xs) + 0.1, max(ys) - min(ys) + 0.1)

    def paint(self, painter: Any, option: Any, widget: Any) -> None:
        painter.setPen(self._pen)
        painter.setBrush(Qt.BrushStyle.NoBrush)
        for wx, wy in self._points:
            painter.drawEllipse(QPointF(wx, wy), 0.03, 0.03)


# ── Trajectory trail ───────────────────────────────────────────────────────
class TrajectoryItem(QGraphicsPathItem):
    """Fading cyan trail from historical pose positions."""

    def __init__(self) -> None:
        super().__init__()
        self.setZValue(5)
        self._points: list[tuple[float, float]] = []

    def set_points(self, points: list[tuple[float, float]]) -> None:
        self._points = points
        self._build_path()

    def _build_path(self) -> None:
        path = QPainterPath()
        n = len(self._points)
        if n < 2:
            self.setPath(path)
            return
        path.moveTo(self._points[0][0], self._points[0][1])
        for i in range(1, n):
            path.lineTo(self._points[i][0], self._points[i][1])
        self.setPath(path)
        self.prepareGeometryChange()

    def paint(self, painter: Any, option: Any, widget: Any) -> None:
        n = len(self._points)
        if n < 2:
            return
        for i in range(1, n):
            frac = i / n
            alpha = int(30 + 225 * frac)
            g = int(140 + 115 * frac)
            b = int(180 + 75 * frac)
            pen = QPen(QColor(0, g, b, alpha))
            pen.setWidthF(2)
            pen.setCosmetic(True)
            painter.setPen(pen)
            painter.drawLine(QPointF(*self._points[i - 1]),
                             QPointF(*self._points[i]))


# ── Geofence polygon ───────────────────────────────────────────────────────
class GeofenceItem(QGraphicsPolygonItem):
    """Green dashed polygon boundary."""

    def __init__(self) -> None:
        super().__init__()
        self.setZValue(1)
        self.setPen(_pen('#00ff88', 2, Qt.PenStyle.DashLine))
        self.setBrush(Qt.BrushStyle.NoBrush)

    def set_polygon(self, poly: list[list[float]], ok: bool = True,
                    warn: bool = False, breach: bool = False) -> None:
        if len(poly) < 3:
            self.setVisible(False)
            return
        qpoly = QPolygonF([QPointF(p[0], p[1]) for p in poly])
        self.setPolygon(qpoly)
        self.setVisible(True)
        if breach or not ok:
            self.setPen(_pen('#ff4444', 2, Qt.PenStyle.DashLine))
            self.setBrush(_brush('#3a0a0a'))
        elif warn:
            self.setPen(_pen('#ffb800', 2, Qt.PenStyle.DashLine))
            self.setBrush(_brush('#3a2a0a'))
        else:
            self.setPen(_pen('#00ff88', 2, Qt.PenStyle.DashLine))
            self.setBrush(Qt.BrushStyle.NoBrush)


# ── Robot pose marker (dot + arrow + heading triangle) ─────────────────────
class RobotItem(QGraphicsItem):
    """Green dot + red arrow showing robot pose in the map frame."""

    def __init__(self) -> None:
        super().__init__()
        self._x = 0.0
        self._y = 0.0
        self._theta = 0.0

    def set_pose(self, x: float, y: float, theta: float) -> None:
        self.prepareGeometryChange()
        self._x, self._y, self._theta = x, y, theta
        self.update()

    def boundingRect(self) -> QRectF:
        margin = 0.25
        return QRectF(self._x - margin, self._y - margin, margin * 2, margin * 2)

    def paint(self, painter: Any, option: Any, widget: Any) -> None:
        t = self._theta
        # Green dot
        painter.setPen(_pen('#ffffff', 1.5))
        painter.setBrush(_brush('#00ff88'))
        painter.drawEllipse(QPointF(self._x, self._y), 0.08, 0.08)
        # Red arrow line
        hx = self._x + math.cos(t) * 0.20
        hy = self._y + math.sin(t) * 0.20
        painter.setPen(_pen('#ff3b5c', 2.5))
        painter.drawLine(QPointF(self._x, self._y), QPointF(hx, hy))
        # Heading triangle
        painter.setBrush(_brush('#ff3b5c'))
        painter.setPen(Qt.PenStyle.NoPen)
        tri = QPolygonF([
            QPointF(hx, hy),
            QPointF(self._x + math.cos(t + 2.5) * 0.06,
                    self._y + math.sin(t + 2.5) * 0.06),
            QPointF(self._x + math.cos(t - 2.5) * 0.06,
                    self._y + math.sin(t - 2.5) * 0.06),
        ])
        painter.drawPolygon(tri)


# ── Waypoint marker ────────────────────────────────────────────────────────
class WaypointItem(QGraphicsEllipseItem):
    """Colored dot with label — color reflects nav/survey/detected state."""

    def __init__(self, wp_id: int, label: str, x: float, y: float) -> None:
        super().__init__(-0.09, -0.09, 0.18, 0.18)
        self.wp_id = wp_id
        self._label = label
        self._is_nav = False
        self._is_survey_next = False
        self._is_detected = False
        self.setZValue(10)
        self.setPen(_pen('#ffffff', 1.5))
        self.setPos(x, y)
        self._update_color()

    def set_nav_state(self, is_nav: bool, is_survey_next: bool,
                      is_detected: bool) -> None:
        self._is_nav = is_nav
        self._is_survey_next = is_survey_next
        self._is_detected = is_detected
        self._update_color()

    def _update_color(self) -> None:
        if self._is_survey_next:
            self.setBrush(_brush('#ff8800'))
        elif self._is_nav:
            self.setBrush(_brush('#ffdd00'))
        elif self._is_detected:
            self.setBrush(_brush('#00ff88'))
        else:
            self.setBrush(_brush('#00d4ff'))

    def update_position(self, x: float, y: float) -> None:
        self.prepareGeometryChange()
        self.setPos(x, y)

    def paint(self, painter: Any, option: Any, widget: Any) -> None:
        super().paint(painter, option, widget)
        # Label above
        painter.setPen(QPen(QColor('#ffffff')))
        painter.setFont(_font(9, True))
        painter.drawText(QPointF(0, -0.15), self._label)
        # Glow rings for nav/survey targets
        if self._is_nav:
            painter.setPen(_pen('#ffdd00', 1.5, Qt.PenStyle.DashLine))
            painter.setBrush(Qt.BrushStyle.NoBrush)
            painter.drawEllipse(QPointF(0, 0), 0.18, 0.18)
            painter.drawText(QPointF(0, 0.24), 'NAV')
        if self._is_survey_next:
            painter.setPen(_pen('#ff8800', 1.5, Qt.PenStyle.DashLine))
            painter.setBrush(Qt.BrushStyle.NoBrush)
            painter.drawEllipse(QPointF(0, 0), 0.22, 0.22)
            painter.drawText(QPointF(0, 0.28), 'SHELF')
        if self._is_detected:
            painter.setPen(_pen('#00ff88', 2))
            painter.setBrush(Qt.BrushStyle.NoBrush)
            painter.drawEllipse(QPointF(0, 0), 0.13, 0.13)
            painter.drawText(QPointF(0.14, -0.14), '✓')


# ── Home marker ────────────────────────────────────────────────────────────
class HomeItem(QGraphicsItem):
    """Yellow circle with '⌂ HOME' label."""

    def __init__(self) -> None:
        super().__init__()
        self._visible = False
        self._x = 0.0
        self._y = 0.0

    def set_position(self, x: float, y: float) -> None:
        self.prepareGeometryChange()
        self._x, self._y = x, y
        self._visible = True
        self.update()

    def clear(self) -> None:
        self.prepareGeometryChange()
        self._visible = False
        self.update()

    def boundingRect(self) -> QRectF:
        return QRectF(self._x - 0.2, self._y - 0.3, 0.4, 0.6)

    def paint(self, painter: Any, option: Any, widget: Any) -> None:
        if not self._visible:
            return
        painter.setPen(_pen('#ffffff', 1.5))
        painter.setBrush(_brush('#ffcc00'))
        painter.drawEllipse(QPointF(self._x, self._y), 0.10, 0.10)
        painter.setPen(QPen(QColor('#1a1a00')))
        painter.setFont(_font(11, True))
        painter.drawText(QPointF(self._x, self._y), '⌂')
        painter.setPen(QPen(QColor('#ffcc00')))
        painter.setFont(_font(8, True))
        painter.drawText(QPointF(self._x, self._y - 0.18), 'HOME')


# ── Wall / line segment ───────────────────────────────────────────────────
class WallItem(QGraphicsLineItem):
    """A single wall line segment with label and endpoint handles."""

    def __init__(self, idx: int, x1: float, y1: float,
                 x2: float, y2: float) -> None:
        super().__init__(x1, y1, x2, y2)
        self.wall_idx = idx
        self._selected = False
        self.setZValue(8)
        self._update_style()

    def set_selected(self, selected: bool) -> None:
        self._selected = selected
        self._update_style()

    def _update_style(self) -> None:
        if self._selected:
            self.setPen(_pen('#ff4444', 3))
        else:
            self.setPen(_pen('#ffb800', 2))
