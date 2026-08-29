"""Focused tests for AprilTag dock-safety gates."""
from __future__ import annotations

import time

import pytest

pytest.importorskip('rclpy')

from my_robot_controller.brain_node import (  # noqa: E402
    BrainNode,
    TAG_MAX_HAMMING,
    TAG_MAX_X_SPREAD_M,
    TAG_MAX_Z_SPREAD_M,
    TAG_MIN_CONFIDENCE,
    TAG_REQUIRED_OBSERVATIONS,
)


def _brain() -> BrainNode:
    brain = BrainNode.__new__(BrainNode)
    brain._tag_cache = {}
    brain._tag_observations = {}
    brain._last_tag_detection_s = 0.0
    return brain


def _tag(tag_id: int, *, confidence: float = TAG_MIN_CONFIDENCE + 1.0,
         hamming: int = 0, x: float = 0.0, z: float = 1.0) -> dict:
    return {
        'tag_id': tag_id,
        'confidence': confidence,
        'hamming': hamming,
        'x': x,
        'z': z,
        '_age': time.time(),
    }


def _stable_observations(*, hamming: int = 0) -> list[dict]:
    now = time.time()
    return [
        {'ts': now - index * 0.05, 'x': 0.01, 'z': 1.0,
         'confidence': TAG_MIN_CONFIDENCE + 1.0, 'hamming': hamming}
        for index in range(TAG_REQUIRED_OBSERVATIONS)
    ]


def test_verified_tag_requires_required_stable_observations() -> None:
    brain = _brain()
    tag = _tag(7)
    brain._tag_cache[7] = tag
    brain._tag_observations[7] = _stable_observations()
    assert brain._verified_tag(7) == tag


def test_verified_tag_rejects_lateral_instability() -> None:
    brain = _brain()
    now = time.time()
    brain._tag_cache[7] = _tag(7)
    brain._tag_observations[7] = [
        {'ts': now - index * 0.05,
         'x': 0.0 if index else TAG_MAX_X_SPREAD_M + 0.01,
         'z': 1.0, 'confidence': TAG_MIN_CONFIDENCE + 1.0, 'hamming': 0}
        for index in range(TAG_REQUIRED_OBSERVATIONS)
    ]
    assert brain._verified_tag(7) is None


def test_verified_tag_rejects_distance_instability() -> None:
    brain = _brain()
    now = time.time()
    brain._tag_cache[7] = _tag(7)
    brain._tag_observations[7] = [
        {'ts': now - index * 0.05, 'x': 0.0,
         'z': 1.0 if index else 1.0 + TAG_MAX_Z_SPREAD_M + 0.01,
         'confidence': TAG_MIN_CONFIDENCE + 1.0, 'hamming': 0}
        for index in range(TAG_REQUIRED_OBSERVATIONS)
    ]
    assert brain._verified_tag(7) is None


def test_wrong_visible_tag_is_not_accepted_for_expected_id() -> None:
    brain = _brain()
    brain._tag_cache[8] = _tag(8)
    brain._last_tag_detection_s = time.time()
    assert brain._verified_tag(7) is None
    assert brain._tag_failure_reason(7) == 'WRONG_TAG'


def test_low_confidence_expected_tag_is_rejected() -> None:
    brain = _brain()
    brain._tag_cache[7] = _tag(7, confidence=TAG_MIN_CONFIDENCE - 0.1)
    brain._last_tag_detection_s = time.time()
    assert brain._verified_tag(7) is None
    assert brain._tag_failure_reason(7) == 'TAG_LOW_CONFIDENCE'


def test_high_hamming_expected_tag_is_rejected() -> None:
    brain = _brain()
    high_hamming = TAG_MAX_HAMMING + 1
    brain._tag_cache[7] = _tag(7, hamming=high_hamming)
    brain._tag_observations[7] = _stable_observations(hamming=high_hamming)
    brain._last_tag_detection_s = time.time()
    assert brain._verified_tag(7) is None
    assert brain._tag_failure_reason(7) == 'HAMMING_HIGH'
