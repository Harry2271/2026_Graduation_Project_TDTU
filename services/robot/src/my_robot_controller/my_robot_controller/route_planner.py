"""Validated, deterministic route planning for the four-zone demo.

This module contains no ROS or hardware dependencies.  It deliberately keeps
route order explicit: camera left/right ordering is not a substitute for a
map-frame route because the robot heading changes between zones.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Any, Mapping


class RouteConfigError(ValueError):
    """Raised when a route cannot be safely executed."""


@dataclass(frozen=True)
class ZoneConfig:
    zone_id: str
    label: str
    tag_id: int
    x: float
    y: float
    theta: float
    side: str
    depth: str
    calibrated: bool


@dataclass(frozen=True)
class RoutePlan:
    route_id: str
    zones: tuple[ZoneConfig, ...]
    dock_distance_mm: int
    distance_status: str

    @property
    def zone_ids(self) -> tuple[str, ...]:
        return tuple(zone.zone_id for zone in self.zones)


def _number(value: Any, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise RouteConfigError(f'{name} must be a number')
    return float(value)


def build_route_plan(config: Mapping[str, Any], *, allow_uncalibrated: bool = False) -> RoutePlan:
    """Validate and create an immutable route plan from the YAML-shaped mapping."""
    demo = config.get('demo')
    if not isinstance(demo, Mapping):
        raise RouteConfigError("missing 'demo' configuration")

    raw_route = demo.get('route')
    raw_zones = demo.get('zones')
    if not isinstance(raw_route, (list, tuple)) or not raw_route:
        raise RouteConfigError("demo.route must be a non-empty list")
    if not isinstance(raw_zones, Mapping):
        raise RouteConfigError("demo.zones must be a mapping")

    route = tuple(str(item).strip().upper() for item in raw_route)
    if len(set(route)) != len(route):
        raise RouteConfigError('route contains duplicate zones')
    if set(route) != set(raw_zones):
        raise RouteConfigError('route must contain exactly the configured zones')

    zones: list[ZoneConfig] = []
    tag_ids: set[int] = set()
    for zone_id in route:
        raw = raw_zones.get(zone_id)
        if not isinstance(raw, Mapping):
            raise RouteConfigError(f'zone {zone_id!r} is missing')
        try:
            tag_id = int(raw['tag_id'])
            zone = ZoneConfig(
                zone_id=zone_id,
                label=str(raw.get('label', f'Khu {zone_id}')),
                tag_id=tag_id,
                x=_number(raw['approach_x'], f'{zone_id}.approach_x'),
                y=_number(raw['approach_y'], f'{zone_id}.approach_y'),
                theta=_number(raw['approach_theta'], f'{zone_id}.approach_theta'),
                side=str(raw['side']).lower(),
                depth=str(raw['depth']).lower(),
                calibrated=bool(raw.get('calibrated', False)),
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise RouteConfigError(f'invalid configuration for zone {zone_id!r}') from exc
        if zone.side not in {'left', 'right'}:
            raise RouteConfigError(f'{zone_id}.side must be left or right')
        if zone.depth not in {'near', 'far'}:
            raise RouteConfigError(f'{zone_id}.depth must be near or far')
        if tag_id in tag_ids:
            raise RouteConfigError(f'duplicate AprilTag ID {tag_id}')
        tag_ids.add(tag_id)
        if not allow_uncalibrated and not zone.calibrated:
            raise RouteConfigError(f'zone {zone_id} is not calibrated')
        zones.append(zone)

    distance_status = str(demo.get('distance_status', 'MEASURE_REQUIRED')).upper()
    if not allow_uncalibrated and distance_status not in {'READY', 'VERIFIED'}:
        raise RouteConfigError(f'dock distance is not verified ({distance_status})')
    dock_distance = demo.get('dock_distance_mm')
    if isinstance(dock_distance, bool) or not isinstance(dock_distance, (int, float)):
        raise RouteConfigError('demo.dock_distance_mm must be a number')
    if not 100 <= float(dock_distance) <= 1500:
        raise RouteConfigError('dock distance must be between 100 and 1500 mm')

    return RoutePlan('four_zone_left_then_right', tuple(zones), int(dock_distance), distance_status)


def load_yaml_config(path: str | Path) -> Mapping[str, Any]:
    """Load the route YAML without making PyYAML a ROS runtime requirement."""
    try:
        import yaml  # type: ignore[import-not-found]
    except ImportError as exc:
        raise RouteConfigError('PyYAML is required to load demo_zones.yaml') from exc
    config_path = Path(path)
    try:
        with config_path.open('r', encoding='utf-8') as stream:
            loaded = yaml.safe_load(stream)
    except OSError as exc:
        raise RouteConfigError(f'cannot read route config {config_path}') from exc
    if not isinstance(loaded, Mapping):
        raise RouteConfigError('route config root must be a mapping')
    return MappingProxyType(dict(loaded))
