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
    test_data = {'_id': 'job-1', 'fromSlotCode': 'S1A1'}
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
