# Plan C: Brain Wiring + Faked Movement (Phase 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Brain connects to API as a Socket.io client, receives jobs, walks the state machine through faked movement (sleeps + emits status events).

**Architecture:** `BrainApiClient` (python-socketio) wraps the `/robot` namespace connection. `brain_node.py` uses it to subscribe to `job:dispatch` events and drive the state machine via `_execute_job()` async coroutine.

**Tech Stack:** Python, python-socketio[asyncio_client], ROS 2 rclpy, asyncio.

**Spec:** `docs/superpowers/specs/2026-06-09-auth-job-brain-wiring-design.md` §4

---

### Task C1: Install python-socketio dependency

**Files:**
- Modify: `services/robot/install-pi.sh`
- Modify: `services/robot/src/my_robot_controller/requirements-test.txt`

- [ ] **Step 1: Add to install-pi.sh**

Find the `pip3 install` line and update:

```bash
pip3 install --break-system-packages websockets numpy "python-socketio[asyncio_client]"
```

- [ ] **Step 2: Add to requirements-test.txt**

File: `services/robot/src/my_robot_controller/requirements-test.txt`

```
pytest>=7.0
pytest-asyncio>=0.21
python-socketio[asyncio_client]
```

- [ ] **Step 3: Commit**

```bash
git add services/robot/install-pi.sh services/robot/src/my_robot_controller/requirements-test.txt
git commit -m "feat(robot): add python-socketio[asyncio_client] dependency"
```

---

### Task C2: api_client.py — BrainApiClient

**Files:**
- Create: `services/robot/src/my_robot_controller/my_robot_controller/api_client.py`
- Test: `services/robot/src/my_robot_controller/tests/test_api_client.py`

- [ ] **Step 1: Create BrainApiClient**

File: `services/robot/src/my_robot_controller/my_robot_controller/api_client.py`

```python
"""Socket.io client for brain↔API communication.

Connects to the API's /robot namespace, authenticates with ROBOT_BRAIN_TOKEN,
and provides methods to emit state/job-status and subscribe to job:dispatch.
"""
from __future__ import annotations

import asyncio
import logging
import os
from typing import Callable, Any, Awaitable

import socketio

logger = logging.getLogger(__name__)

DispatchCallback = Callable[[dict[str, Any]], Awaitable[None]]


class BrainApiClient:
    """Manages a single Socket.io connection to the API's /robot namespace.

    Usage:
        client = BrainApiClient()
        await client.connect()
        client.on_job_dispatch(my_handler)
        await client.emit_job_status(job_id, 'COMPLETED')
        await client.disconnect()
    """

    def __init__(
        self,
        server_url: str | None = None,
        token: str | None = None,
    ) -> None:
        self._server_url = server_url or os.environ.get(
            'API_SOCKET_URL', 'http://localhost:5000'
        )
        self._token = token or os.environ.get('ROBOT_BRAIN_TOKEN', '')
        self._sio = socketio.AsyncClient()
        self._connected = False
        self._dispatch_handlers: list[DispatchCallback] = []

        # Register event handlers
        @self._sio.on('job:dispatch', namespace='/robot')
        async def _on_job_dispatch(data: dict[str, Any]) -> None:
            logger.info('Received job:dispatch: %s', data.get('_id', 'unknown'))
            for handler in self._dispatch_handlers:
                await handler(data)

        @self._sio.on('connect', namespace='/robot')
        def _on_connect() -> None:
            logger.info('Connected to API /robot namespace')

        @self._sio.on('disconnect', namespace='/robot')
        def _on_disconnect() -> None:
            logger.info('Disconnected from API /robot namespace')

    async def connect(self) -> None:
        """Connect to the API server with ROBOT_BRAIN_TOKEN auth."""
        if self._connected:
            return
        try:
            await self._sio.connect(
                self._server_url,
                namespaces=['/robot'],
                auth={'token': self._token},
            )
            self._connected = True
            logger.info('BrainApiClient connected to %s', self._server_url)
        except Exception as e:
            logger.error('BrainApiClient connection failed: %s', e)
            raise

    async def disconnect(self) -> None:
        """Disconnect from the API server."""
        if not self._connected:
            return
        await self._sio.disconnect()
        self._connected = False
        logger.info('BrainApiClient disconnected')

    @property
    def connected(self) -> bool:
        return self._connected

    def on_job_dispatch(self, callback: DispatchCallback) -> None:
        """Register a handler for job:dispatch events from the API."""
        self._dispatch_handlers.append(callback)

    async def emit_state(self, state: str) -> None:
        """Emit the robot's current state to the API."""
        if not self._connected:
            return
        await self._sio.emit('robot:state', {'state': state}, namespace='/robot')

    async def emit_job_status(self, job_id: str, status: str) -> None:
        """Emit a job status update to the API."""
        if not self._connected:
            return
        await self._sio.emit(
            'job:status',
            {'jobId': job_id, 'status': status},
            namespace='/robot',
        )
```

- [ ] **Step 2: Write test for api_client**

File: `services/robot/src/my_robot_controller/tests/test_api_client.py`

```python
"""Unit tests for BrainApiClient."""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from my_robot_controller.api_client import BrainApiClient


@pytest.mark.asyncio
async def test_connect_sends_auth_token() -> None:
    """BrainApiClient should send ROBOT_BRAIN_TOKEN on connect."""
    client = BrainApiClient(server_url='http://test:5000', token='test-token-123')

    with patch.object(client._sio, 'connect', new_callable=AsyncMock) as mock_connect:
        await client.connect()

    mock_connect.assert_awaited_once_with(
        'http://test:5000',
        namespaces=['/robot'],
        auth={'token': 'test-token-123'},
    )


@pytest.mark.asyncio
async def test_connect_skips_if_already_connected() -> None:
    client = BrainApiClient(server_url='http://test:5000', token='x')
    client._connected = True
    with patch.object(client._sio, 'connect', new_callable=AsyncMock) as mock_connect:
        await client.connect()
    mock_connect.assert_not_awaited()


@pytest.mark.asyncio
async def test_disconnect() -> None:
    client = BrainApiClient(server_url='http://test:5000', token='x')
    client._connected = True
    with patch.object(client._sio, 'disconnect', new_callable=AsyncMock) as mock_disconnect:
        await client.disconnect()
    mock_disconnect.assert_awaited_once()
    assert not client.connected


@pytest.mark.asyncio
async def test_emit_job_status() -> None:
    client = BrainApiClient(server_url='http://test:5000', token='x')
    client._connected = True
    with patch.object(client._sio, 'emit', new_callable=AsyncMock) as mock_emit:
        await client.emit_job_status('job-123', 'COMPLETED')
    mock_emit.assert_awaited_once_with(
        'job:status',
        {'jobId': 'job-123', 'status': 'COMPLETED'},
        namespace='/robot',
    )


@pytest.mark.asyncio
async def test_emit_job_status_when_disconnected() -> None:
    client = BrainApiClient(server_url='http://test:5000', token='x')
    client._connected = False
    with patch.object(client._sio, 'emit', new_callable=AsyncMock) as mock_emit:
        await client.emit_job_status('job-1', 'FAILED')
    mock_emit.assert_not_awaited()


@pytest.mark.asyncio
async def test_on_job_dispatch_registers_handler() -> None:
    client = BrainApiClient(server_url='http://test:5000', token='x')
    handler = AsyncMock()
    client.on_job_dispatch(handler)
    # Simulate receiving a job:dispatch event by calling the handler directly
    test_data = {'_id': 'job-1', 'fromSlotCode': 'S1A1'}
    # Trigger via the internal event mechanism
    for h in client._dispatch_handlers:
        await h(test_data)
    handler.assert_awaited_once_with(test_data)


@pytest.mark.asyncio
async def test_emit_state() -> None:
    client = BrainApiClient(server_url='http://test:5000', token='x')
    client._connected = True
    with patch.object(client._sio, 'emit', new_callable=AsyncMock) as mock_emit:
        await client.emit_state('IDLE')
    mock_emit.assert_awaited_once_with(
        'robot:state', {'state': 'IDLE'}, namespace='/robot'
    )
```

- [ ] **Step 3: Run tests**

```bash
cd services/robot/src/my_robot_controller && python -m pytest tests/test_api_client.py -v
```

Expected: All 7 tests pass

- [ ] **Step 4: Commit**

```bash
git add services/robot/src/my_robot_controller/my_robot_controller/api_client.py services/robot/src/my_robot_controller/tests/test_api_client.py
git commit -m "feat(robot): add BrainApiClient with Socket.io connection + tests"
```

---

### Task C3: brain_node.py — Add API client + job execution

**Files:**
- Modify: `services/robot/src/my_robot_controller/my_robot_controller/brain_node.py`
- Test: `services/robot/src/my_robot_controller/tests/test_brain_node.py`

- [ ] **Step 1: Read current brain_node.py to plan integration points**

Read the existing file to understand what hooks exist.

- [ ] **Step 2: Add API client integration**

In `__init__`, add:

```python
import asyncio
from my_robot_controller.api_client import BrainApiClient

class BrainNode(Node):
    def __init__(self) -> None:
        super().__init__('brain')
        self._state: BrainState = BrainState.BOOT
        self._bridge: Esp32Bridge = FakeEsp32Bridge()
        self._api_client = BrainApiClient()
        self._api_client.on_job_dispatch(self._handle_job_dispatch)
        self.get_logger().info(f'brain_node started in state {self._state}')
```

Add the job handling methods:

```python
    async def _handle_job_dispatch(self, payload: dict) -> None:
        """Called when a job:dispatch event is received from the API."""
        job_id = payload.get('_id', 'unknown')
        self.get_logger().info(f'Received job dispatch: {job_id}')
        asyncio.create_task(self._execute_job(payload))

    async def _execute_job(self, job: dict) -> None:
        """Walk the state machine with faked movement."""
        job_id = job.get('_id', 'unknown')
        self.get_logger().info(f'Starting job {job_id}')
        try:
            # Phase 5: faked movement — just sleep
            self.transition_to(BrainState.JOB_NAV_TO_PICKUP, f'job {job_id}')
            await self._api_client.emit_job_status(job_id, 'IN_PROGRESS')
            await asyncio.sleep(5)

            self.transition_to(BrainState.JOB_NAV_TO_DROPOFF, f'job {job_id}')
            await asyncio.sleep(5)

            self.transition_to(BrainState.JOB_PLACE, f'job {job_id}')
            await asyncio.sleep(3)

            self.transition_to(BrainState.IDLE, f'job {job_id} completed')
            await self._api_client.emit_job_status(job_id, 'COMPLETED')
            self.get_logger().info(f'Job {job_id} completed successfully')
        except Exception as e:
            self.get_logger().error(f'Job {job_id} failed: {e}')
            await self._api_client.emit_job_status(job_id, 'FAILED')
            self.transition_to(BrainState.ERROR, f'job {job_id} failed')
```

Add connection in `main`:

```python
async def _run_async(node: BrainNode) -> None:
    await node._api_client.connect()
    while rclpy.ok():
        rclpy.spin_once(node, timeout_sec=0.1)
        await asyncio.sleep(0.1)
    await node._api_client.disconnect()


def main() -> None:
    rclpy.init()
    node = BrainNode()
    try:
        asyncio.run(_run_async(node))
    except KeyboardInterrupt:
        pass
    finally:
        rclpy.shutdown()
```

- [ ] **Step 3: Add test**

File: `tests/test_brain_node.py`

Add a test verifying `_api_client` is created on brain node:

```python
def test_brain_has_api_client(brain: BrainNode) -> None:
    """BrainNode should have a BrainApiClient instance."""
    from my_robot_controller.api_client import BrainApiClient
    assert hasattr(brain, '_api_client')
    assert isinstance(brain._api_client, BrainApiClient)
```

- [ ] **Step 4: Run tests**

```bash
cd services/robot/src/my_robot_controller && python -m pytest tests/test_brain_node.py -v
```

Expected: All tests pass (including the existing ones + the new api_client test)

- [ ] **Step 5: Verify syntax**

```bash
python -c "import ast; ast.parse(open('my_robot_controller/brain_node.py').read()); print('OK')"
```

Expected: OK

- [ ] **Step 6: Commit**

```bash
git add services/robot/src/my_robot_controller/my_robot_controller/brain_node.py services/robot/src/my_robot_controller/tests/test_brain_node.py
git commit -m "feat(robot): wire BrainApiClient into BrainNode + job execution state machine"
```

---

### Task C4: deploy.sh — Add API_SOCKET_URL and ROBOT_BRAIN_TOKEN

**Files:**
- Modify: `services/robot/deploy.sh`

- [ ] **Step 1: Add env vars to deploy.sh**

Find the `start_ros_node` call for brain and add env vars to the PM2 command:

```bash
# Replace the brain node line with env vars
start_ros_node "${SERVICE_NAME_PREFIX}-brain" \
  "API_SOCKET_URL=${API_SOCKET_URL:-https://api.nguyen-robot.io.vn} \
   ROBOT_BRAIN_TOKEN=${ROBOT_BRAIN_TOKEN:-} \
   ros2 run my_robot_controller brain"
```

Alternatively, export them before the PM2 start to make them available to all nodes:

```bash
# --- Environment variables for brain<->API connection ---
export API_SOCKET_URL="${API_SOCKET_URL:-https://api.nguyen-robot.io.vn}"
export ROBOT_BRAIN_TOKEN="${ROBOT_BRAIN_TOKEN:-}"

start_ros_node "${SERVICE_NAME_PREFIX}-brain" "ros2 run my_robot_controller brain"
```

- [ ] **Step 2: Document in CLAUDE.md**

Add to the Nav2 section in `services/robot/CLAUDE.md`:

```
### Environment variables
| Variable | Purpose | Default |
|---|---|---|
| `API_SOCKET_URL` | API Socket.io server URL | `https://api.nguyen-robot.io.vn` |
| `ROBOT_BRAIN_TOKEN` | Shared secret for brain↔API auth | '' (must be set) |
```

- [ ] **Step 3: Commit**

```bash
git add services/robot/deploy.sh services/robot/CLAUDE.md
git commit -m "feat(robot): add API_SOCKET_URL and ROBOT_BRAIN_TOKEN to deploy"
```

---

### Task C5: Final verification — build + test + syntax

- [ ] **Step 1: Run all Python tests**

```bash
cd services/robot/src/my_robot_controller && python -m pytest tests/ -v
```

Expected: All tests pass

- [ ] **Step 2: Check Python AST parsing**

```bash
python -c "
import ast, sys
files = ['my_robot_controller/brain_node.py', 'my_robot_controller/api_client.py']
for f in files:
    ast.parse(open(f).read())
    print(f'OK: {f}')
"
```

Expected: Both files parse

- [ ] **Step 3: Show final commit log**

```bash
git log --oneline -10
```

Expected: All Phase 5 commits visible
