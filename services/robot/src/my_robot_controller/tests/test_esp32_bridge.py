"""Unit tests for the Esp32Bridge interface.

The tests use FakeEsp32Bridge which records every command sent and
lets us inject responses for assertions.
"""
import asyncio
import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from my_robot_controller.esp32_bridge import FakeEsp32Bridge, RealEsp32Bridge


@pytest.mark.asyncio
async def test_fake_bridge_records_move_command() -> None:
    bridge = FakeEsp32Bridge()
    await bridge.connect()
    await bridge.move(vx=100, vy=0, omega=0)
    await bridge.disconnect()

    sent = bridge.sent_commands()
    assert sent == [{'cmd': 'move', 'vx': 100, 'vy': 0, 'omega': 0}]


@pytest.mark.asyncio
async def test_fake_bridge_stop_command() -> None:
    bridge = FakeEsp32Bridge()
    await bridge.connect()
    await bridge.stop()
    await bridge.disconnect()

    assert bridge.sent_commands() == [{'cmd': 'stop'}]


@pytest.mark.asyncio
async def test_fake_bridge_e_stop_command() -> None:
    bridge = FakeEsp32Bridge()
    await bridge.connect()
    await bridge.e_stop()
    await bridge.disconnect()

    assert bridge.sent_commands() == [{'cmd': 'e_stop'}]


@pytest.mark.asyncio
async def test_fake_bridge_heartbeat_runs_at_interval() -> None:
    bridge = FakeEsp32Bridge(heartbeat_interval_s=0.01)
    await bridge.connect()
    # Sleep long enough for at least 5 heartbeat cycles; assertion is loose
    # (>= 2) so it stays stable across platforms with different clock
    # resolution and asyncio scheduling overhead.
    await asyncio.sleep(0.1)
    await bridge.disconnect()

    sent = bridge.sent_commands()
    heartbeat_count = sum(1 for cmd in sent if cmd == {'cmd': 'heartbeat'})
    assert heartbeat_count >= 2, f'expected at least 2 heartbeats, got {heartbeat_count}'


@pytest.mark.asyncio
async def test_fake_bridge_injects_status_event() -> None:
    bridge = FakeEsp32Bridge()
    await bridge.connect()

    received: list[dict] = []
    bridge.on_status_update = lambda data: received.append(data)

    bridge.inject_status({'uptime_ms': 1234, 'mode': 'NAV', 'e_stop': False})
    await asyncio.sleep(0.01)

    assert received == [{'uptime_ms': 1234, 'mode': 'NAV', 'e_stop': False}]
    await bridge.disconnect()


@pytest.mark.asyncio
async def test_fake_bridge_serializes_concurrent_writes() -> None:
    bridge = FakeEsp32Bridge()
    await bridge.connect()

    await asyncio.gather(*[bridge.move(i, 0, 0) for i in range(10)])
    await bridge.disconnect()

    sent = bridge.sent_commands()
    assert len(sent) == 10
    assert [s['vx'] for s in sent] == list(range(10))


@pytest.mark.asyncio
async def test_real_bridge_encodes_move_as_json_line() -> None:
    writer = MagicMock()
    writer.write = MagicMock()
    writer.drain = AsyncMock()
    reader = MagicMock()
    reader.readline = AsyncMock(return_value=b'{"type":128,"data":{"cmd":"move"}}\n')

    bridge = RealEsp32Bridge(writer=writer, reader=reader)
    await bridge.move(vx=100, vy=0, omega=0)

    writer.write.assert_called_once()
    written_bytes = writer.write.call_args[0][0]
    assert written_bytes.endswith(b'\n')
    payload = json.loads(written_bytes.decode('utf-8').strip())
    assert payload == {'cmd': 'move', 'vx': 100, 'vy': 0, 'omega': 0}
