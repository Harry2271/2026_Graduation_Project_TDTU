"""Pure geometry helpers — no Qt dependency.

Extracted from the Tkinter operator_app to keep geo logic reusable
and testable independently of any GUI framework.
"""
from __future__ import annotations

import math


# ── Geofence defaults ──────────────────────────────────────────────────────
GEOFENCE_DEFAULT: dict = {
    'enabled': True,
    'polygon': [[-2.5, -2.0], [2.5, -2.0], [2.5, 2.0], [-2.5, 2.0]],
    'soft_margin_m': 0.30,
    'hard_margin_m': 0.10,
    'description': 'Vùng demo nhà kho (5m x 4m)',
}


# ── Tiny helpers ───────────────────────────────────────────────────────────
def clamp(v: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, v))


def safe_get(d: dict, *keys: str, default=None):
    cur = d
    for k in keys:
        if isinstance(cur, dict):
            cur = cur.get(k, default)
        else:
            return default
    return cur


# ── Polygon geometry ───────────────────────────────────────────────────────
def point_in_polygon(px: float, py: float, poly: list[list[float]]) -> bool:
    """Ray-casting point-in-polygon test."""
    n = len(poly)
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if ((yi > py) != (yj > py)) and (px < (xj - xi) * (py - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


def distance_to_polygon_edge(px: float, py: float,
                             poly: list[list[float]]) -> float:
    """Signed distance from point to polygon edge.

    Positive = inside, negative = outside.
    """
    inside = point_in_polygon(px, py, poly)
    n = len(poly)
    min_dist = float('inf')
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        dist = _point_to_segment_dist(px, py, x1, y1, x2, y2)
        min_dist = min(min_dist, dist)
    return min_dist if inside else -min_dist


def _point_to_segment_dist(px: float, py: float,
                           x1: float, y1: float,
                           x2: float, y2: float) -> float:
    dx = x2 - x1
    dy = y2 - y1
    len_sq = dx * dx + dy * dy
    if len_sq < 1e-12:
        return math.hypot(px - x1, py - y1)
    t = max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / len_sq))
    proj_x = x1 + t * dx
    proj_y = y1 + t * dy
    return math.hypot(px - proj_x, py - proj_y)


# ── Wall / line helpers ────────────────────────────────────────────────────
def line_endpoints_key(x: float, y: float, grid: float = 0.02) -> tuple[int, int]:
    return (round(x / grid), round(y / grid))


def snap_line_endpoints(x1: float, y1: float, x2: float, y2: float,
                        existing: list[list[float]],
                        snap_m: float = 0.15) -> tuple[float, float, float, float]:
    """Snap new line endpoints to nearest existing endpoints."""
    best_dist = snap_m
    best_x1, best_y1, best_x2, best_y2 = x1, y1, x2, y2

    for line in existing:
        if len(line) < 4:
            continue
        for (ex, ey) in ((line[0], line[1]), (line[2], line[3])):
            # Check against (x1, y1)
            d = math.hypot(x1 - ex, y1 - ey)
            if d < best_dist:
                best_x1, best_y1 = ex, ey
            # Check against (x2, y2)
            d = math.hypot(x2 - ex, y2 - ey)
            if d < best_dist:
                best_x2, best_y2 = ex, ey

    return best_x1, best_y1, best_x2, best_y2


def build_polygon_from_lines(lines: list[list[float]]) -> list[list[float]] | None:
    """Walk connected line chain to build an ordered closed polygon.

    Returns [[x,y], ...] if the lines form a closed loop, else None.
    """
    if not lines:
        return None

    # Build adjacency: endpoint_key → [(line_idx, end_idx)]
    # end_idx: 0 = (x1,y1), 1 = (x2,y2)
    adj: dict[tuple[int, int], list[tuple[int, int]]] = {}
    for idx, line in enumerate(lines):
        if len(line) < 4:
            continue
        k1 = line_endpoints_key(line[0], line[1])
        k2 = line_endpoints_key(line[2], line[3])
        adj.setdefault(k1, []).append((idx, 0))
        adj.setdefault(k2, []).append((idx, 1))

    # Find a starting endpoint (prefer degree-1 = chain end)
    start_key = None
    for key, edges in adj.items():
        if len(edges) == 1:
            start_key = key
            break
    if start_key is None:
        # All degree ≥ 2 → already closed, pick any
        start_key = next(iter(adj))

    visited: set[int] = set()
    polygon: list[list[float]] = []
    current_key = start_key

    while True:
        edges = adj.get(current_key, [])
        found = False
        for line_idx, end_idx in edges:
            if line_idx in visited:
                continue
            visited.add(line_idx)
            line = lines[line_idx]
            # Add the point at current_key
            px, py = (line[0], line[1]) if end_idx == 0 else (line[2], line[3])
            polygon.append([round(px, 3), round(py, 3)])
            # The other end becomes current
            next_key = line_endpoints_key(line[2], line[3]) if end_idx == 0 else line_endpoints_key(line[0], line[1])
            current_key = next_key
            found = True
            break
        if not found:
            break

    # Check if closed (first == last key)
    if len(polygon) >= 3:
        first_key = line_endpoints_key(polygon[0][0], polygon[0][1])
        if first_key == current_key:
            return polygon

    return None
