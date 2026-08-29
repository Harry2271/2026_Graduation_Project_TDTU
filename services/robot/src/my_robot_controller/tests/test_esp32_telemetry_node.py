"""Command-queue safety tests for the sole ESP32 serial gateway."""
from __future__ import annotations

from collections import deque
import json

import pytest

pytest.importorskip('rclpy')

from my_robot_controller.esp32_telemetry_node import Esp32TelemetryNode  # noqa: E402


class _Logger:
    def error(self, *args: object, **kwargs: object) -> None:
        pass

    def warn(self, *args: object, **kwargs: object) -> None:
        pass


def _gateway() -> Esp32TelemetryNode:
    """Create only the state used by _on_cmd/_drain_commands, without ROS."""
    node = Esp32TelemetryNode.__new__(Esp32TelemetryNode)
    node._priority_cmd_q = deque()
    node._cmd_q = deque(maxlen=32)
    node._last_pending_move = None
    node._motion_epoch = 0
    node._dropped_total = 0
    node._accepted_total = 0
    node._rejected_total = 0
    node._overflow_active = False
    node._overload_history = deque(maxlen=64)
    node._last_overload_warn = 0.0
    node.get_logger = lambda: _Logger()
    node._emit_cmd_status = lambda *args, **kwargs: None
    return node


def _enqueue(node: Esp32TelemetryNode, command: str) -> None:
    node._on_cmd(type('Message', (), {'data': json.dumps({'cmd': command})})())


def test_stop_discards_queued_begin_dock() -> None:
    node = _gateway()

    _enqueue(node, 'begin_dock')
    _enqueue(node, 'stop')

    assert node._drain_commands() == [{'cmd': 'stop'}]
    assert node._dropped_total == 1


def test_cancel_dock_follows_queued_e_stop() -> None:
    node = _gateway()

    _enqueue(node, 'e_stop')
    _enqueue(node, 'cancel_dock')

    assert node._drain_commands() == [
        {'cmd': 'e_stop'},
        {'cmd': 'cancel_dock'},
    ]


def test_cylinder_stop_discards_queued_estop_clear() -> None:
    node = _gateway()

    _enqueue(node, 'e_stop_clear')
    _enqueue(node, 'cylinder_stop')

    assert node._drain_commands() == [{'cmd': 'cylinder_stop'}]
    assert node._dropped_total == 1


def test_estop_clear_discards_pending_move_and_requires_fresh_move() -> None:
    node = _gateway()

    node._on_cmd(type('Message', (), {
        'data': json.dumps({'cmd': 'move', 'vx': 100, 'seq': 1})
    })())
    _enqueue(node, 'e_stop')
    _enqueue(node, 'e_stop_clear')

    assert node._drain_commands() == [
        {'cmd': 'e_stop'}, {'cmd': 'e_stop_clear'}
    ]

    node._on_cmd(type('Message', (), {
        'data': json.dumps({'cmd': 'move', 'vx': 20, 'seq': 2})
    })())
    assert node._drain_commands() == [
        {'cmd': 'move', 'vx': 20, 'seq': 2}
    ]


def test_estop_clear_is_not_followed_by_pending_move_same_tick() -> None:
    node = _gateway()

    _enqueue(node, 'e_stop_clear')
    node._on_cmd(type('Message', (), {
        'data': json.dumps({'cmd': 'move', 'vx': 100, 'seq': 1})
    })())

    assert node._drain_commands() == [{'cmd': 'e_stop_clear'}]
