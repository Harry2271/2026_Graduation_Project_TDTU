"""Unit tests for the BrainNode state machine.

These tests don't spin up rclpy; they construct the BrainNode class
directly and exercise its transition_to() method. This lets us verify
the state machine logic without ROS infrastructure.
"""
import pytest

from my_robot_controller.brain_node import BrainNode, BrainState


@pytest.fixture
def brain() -> BrainNode:
    """Construct a BrainNode without rclpy spin.

    We monkey-patch rclpy.node.Node.__init__ to skip the heavy ROS setup.
    """
    # Patch out rclpy.node.Node.__init__ before constructing BrainNode.
    import rclpy.node
    original_init = rclpy.node.Node.__init__

    def _noop_init(self, name: str) -> None:
        # Skip rclpy.node.Node setup; just stash the name.
        self.__dict__['_name'] = name

    rclpy.node.Node.__init__ = _noop_init  # type: ignore[assignment]
    try:
        node = BrainNode()
        yield node
    finally:
        rclpy.node.Node.__init__ = original_init  # type: ignore[assignment]


def test_brain_starts_in_boot(brain: BrainNode) -> None:
    assert brain.state == BrainState.BOOT


def test_brain_can_transition_to_idle(brain: BrainNode) -> None:
    brain.transition_to(BrainState.IDLE, reason='boot complete')
    assert brain.state == BrainState.IDLE


def test_brain_can_transition_to_job_states(brain: BrainNode) -> None:
    brain.transition_to(BrainState.JOB_NAV_TO_PICKUP, reason='job dispatch')
    assert brain.state == BrainState.JOB_NAV_TO_PICKUP
    brain.transition_to(BrainState.JOB_NAV_TO_DROPOFF, reason='pickup complete')
    assert brain.state == BrainState.JOB_NAV_TO_DROPOFF
    brain.transition_to(BrainState.JOB_PLACE, reason='dropoff complete')
    assert brain.state == BrainState.JOB_PLACE
    brain.transition_to(BrainState.IDLE, reason='job complete')
    assert brain.state == BrainState.IDLE


def test_brain_can_transition_to_e_stop(brain: BrainNode) -> None:
    brain.transition_to(BrainState.E_STOP, reason='IR sensor trip')
    assert brain.state == BrainState.E_STOP


def test_brain_can_transition_to_wait_for_clear(brain: BrainNode) -> None:
    brain.transition_to(BrainState.JOB_NAV_TO_DROPOFF)
    brain.transition_to(BrainState.JOB_WAIT_FOR_CLEAR, reason='destination occupied')
    assert brain.state == BrainState.JOB_WAIT_FOR_CLEAR


def test_brain_uses_fake_esp32_bridge(brain: BrainNode) -> None:
    """The brain's _bridge should be a FakeEsp32Bridge in Phase 2."""
    from my_robot_controller.esp32_bridge import FakeEsp32Bridge
    assert isinstance(brain._bridge, FakeEsp32Bridge)
