"""Regression tests for INA226 to sensor_msgs/BatteryState conversion."""
from __future__ import annotations

import math
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

pytest.importorskip('rclpy')

from builtin_interfaces.msg import Time  # noqa: E402
from sensor_msgs.msg import BatteryState  # noqa: E402

from my_robot_controller.odom_node import OdomNode  # noqa: E402


class _FakeClock:
    def __init__(self, seconds: float) -> None:
        self._seconds = seconds

    def now(self) -> SimpleNamespace:
        return SimpleNamespace(
            nanoseconds=int(self._seconds * 1e9),
            to_msg=lambda: Time(),
        )


def _node_with_power(power: dict, age_s: float = 0.0) -> tuple[SimpleNamespace, MagicMock]:
    publisher = MagicMock()
    node = SimpleNamespace(
        _last_power=power,
        _last_power_msg_time=100.0 - age_s,
        _battery_pub=publisher,
        get_clock=lambda: _FakeClock(100.0),
    )
    return node, publisher


def test_valid_battery_is_present_and_reports_percentage() -> None:
    node, publisher = _node_with_power({
        'voltage_v': 20.1,
        'current_a': 0.45,
        'battery_pct': 92,
        'battery_status': 'ok',
        'noload': False,
    })

    OdomNode._publish_battery(node)  # type: ignore[arg-type]

    battery = publisher.publish.call_args.args[0]
    assert battery.voltage == pytest.approx(20.1)
    assert battery.current == pytest.approx(0.45)
    assert battery.present is True
    assert battery.percentage == pytest.approx(0.92)
    assert battery.power_supply_status == BatteryState.POWER_SUPPLY_STATUS_DISCHARGING
    assert battery.power_supply_health == BatteryState.POWER_SUPPLY_HEALTH_GOOD


def test_valid_zero_percent_battery_is_not_treated_as_noload() -> None:
    node, publisher = _node_with_power({
        'voltage_v': 12.0,
        'current_a': 0.0,
        'battery_pct': 0,
        'battery_status': 'critical',
        'noload': False,
    })

    OdomNode._publish_battery(node)  # type: ignore[arg-type]

    battery = publisher.publish.call_args.args[0]
    assert battery.present is True
    assert battery.percentage == 0.0
    assert battery.power_supply_status == BatteryState.POWER_SUPPLY_STATUS_DISCHARGING


def test_noload_battery_is_unavailable_not_empty() -> None:
    node, publisher = _node_with_power({
        'voltage_v': 0.0,
        'current_a': 0.0,
        'battery_pct': 0,
        'battery_status': 'unknown',
        'noload': True,
    })

    OdomNode._publish_battery(node)  # type: ignore[arg-type]

    battery = publisher.publish.call_args.args[0]
    assert battery.voltage == 0.0
    assert battery.current == 0.0
    assert math.isnan(battery.percentage)
    assert battery.present is False
    assert battery.power_supply_status == BatteryState.POWER_SUPPLY_STATUS_UNKNOWN
    assert battery.power_supply_health == BatteryState.POWER_SUPPLY_HEALTH_UNKNOWN


def test_empty_or_stale_power_does_not_publish() -> None:
    empty, empty_pub = _node_with_power({})
    OdomNode._publish_battery(empty)  # type: ignore[arg-type]
    empty_pub.publish.assert_not_called()

    stale, stale_pub = _node_with_power({
        'voltage_v': 20.1,
        'battery_pct': 92,
        'battery_status': 'ok',
        'noload': False,
    }, age_s=5.1)
    OdomNode._publish_battery(stale)  # type: ignore[arg-type]
    stale_pub.publish.assert_not_called()
