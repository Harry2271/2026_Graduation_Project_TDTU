"""Unit tests for the BrainNode state machine.

These tests don't spin up rclpy; they construct the BrainNode class
directly and exercise its transition_to() method. This lets us verify
the state machine logic without ROS infrastructure.

These tests require `rclpy` (a ROS 2 Python package). On a non-Pi dev
machine without ROS 2 Jazzy installed, the module-level import will
fail and pytest will skip the entire file.
"""
import pytest

# Skip the whole module if rclpy is unavailable. This keeps the rest
# of the test suite runnable on plain CPython (e.g. Windows dev) and
# the brain tests run automatically on the Pi where rclpy is present.
rclpy = pytest.importorskip('rclpy')

from my_robot_controller.brain_node import BrainNode, BrainState  # noqa: E402


@pytest.fixture
def brain() -> BrainNode:
    """Construct a BrainNode without rclpy spin.

    We monkey-patch rclpy.node.Node.__init__ to skip the heavy ROS setup
    AND stub get_logger / get_name so the BrainNode's __init__ can call
    self.get_logger().info(...) without needing the rest of rclpy.
    """
    # Patch out rclpy.node.Node.__init__ before constructing BrainNode.
    import rclpy.node
    original_init = rclpy.node.Node.__init__
    original_get_logger = rclpy.node.Node.get_logger
    original_get_name = rclpy.node.Node.get_name

    class _StubLogger:
        def info(self, *args: object, **kwargs: object) -> None:
            pass

        def warn(self, *args: object, **kwargs: object) -> None:
            pass

        def error(self, *args: object, **kwargs: object) -> None:
            pass

        def debug(self, *args: object, **kwargs: object) -> None:
            pass

    def _noop_init(self, name: str) -> None:
        # Skip rclpy.node.Node setup; just stash the name.
        self.__dict__['_name'] = name

    def _stub_get_logger(self) -> _StubLogger:
        return _StubLogger()

    def _stub_get_name(self) -> str:
        return str(self.__dict__.get('_name', 'brain'))

    rclpy.node.Node.__init__ = _noop_init  # type: ignore[assignment]
    rclpy.node.Node.get_logger = _stub_get_logger  # type: ignore[assignment]
    rclpy.node.Node.get_name = _stub_get_name  # type: ignore[assignment]
    try:
        node = BrainNode()
        yield node
    finally:
        rclpy.node.Node.__init__ = original_init  # type: ignore[assignment]
        rclpy.node.Node.get_logger = original_get_logger  # type: ignore[assignment]
        rclpy.node.Node.get_name = original_get_name  # type: ignore[assignment]


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


def test_brain_has_navigate_to_method(brain: BrainNode) -> None:
    """The brain node has a navigate_to method (Nav2 not available in unit test)."""
    assert hasattr(brain, 'navigate_to')
    assert callable(brain.navigate_to)
