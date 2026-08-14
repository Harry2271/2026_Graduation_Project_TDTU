"""Pure-Python tests for the deterministic four-zone route planner."""
import pytest

from my_robot_controller.route_planner import RouteConfigError, build_route_plan


BASE = {
    'demo': {
        'route': ['A', 'B', 'C', 'D'],
        'dock_distance_mm': 300,
        'distance_status': 'VERIFIED',
        'zones': {
            'A': {'label': 'A', 'tag_id': 0, 'approach_x': 1.0, 'approach_y': .9,
                  'approach_theta': 0.0, 'side': 'left', 'depth': 'near', 'calibrated': True},
            'B': {'label': 'B', 'tag_id': 2, 'approach_x': 1.0, 'approach_y': 2.2,
                  'approach_theta': 0.0, 'side': 'left', 'depth': 'far', 'calibrated': True},
            'C': {'label': 'C', 'tag_id': 3, 'approach_x': 2.4, 'approach_y': 2.2,
                  'approach_theta': 0.0, 'side': 'right', 'depth': 'far', 'calibrated': True},
            'D': {'label': 'D', 'tag_id': 1, 'approach_x': 2.4, 'approach_y': .9,
                  'approach_theta': 0.0, 'side': 'right', 'depth': 'near', 'calibrated': True},
        },
    }
}


def test_route_preserves_left_then_right_order():
    plan = build_route_plan(BASE)
    assert plan.zone_ids == ('A', 'B', 'C', 'D')
    assert [zone.tag_id for zone in plan.zones] == [0, 2, 3, 1]


def test_uncalibrated_config_is_rejected():
    config = {**BASE, 'demo': {**BASE['demo'], 'zones': {
        **BASE['demo']['zones'], 'C': {**BASE['demo']['zones']['C'], 'calibrated': False}
    }}}
    with pytest.raises(RouteConfigError, match='not calibrated'):
        build_route_plan(config)


def test_duplicate_tag_is_rejected():
    config = {**BASE, 'demo': {**BASE['demo'], 'zones': {
        **BASE['demo']['zones'], 'D': {**BASE['demo']['zones']['D'], 'tag_id': 0}
    }}}
    with pytest.raises(RouteConfigError, match='duplicate AprilTag'):
        build_route_plan(config)


def test_route_must_contain_exactly_configured_zones():
    config = {**BASE, 'demo': {**BASE['demo'], 'route': ['A', 'B', 'D']}}
    with pytest.raises(RouteConfigError, match='exactly'):
        build_route_plan(config)


def test_unverified_distance_is_rejected():
    config = {**BASE, 'demo': {**BASE['demo'], 'distance_status': 'MEASURE_REQUIRED'}}
    with pytest.raises(RouteConfigError, match='not verified'):
        build_route_plan(config)
