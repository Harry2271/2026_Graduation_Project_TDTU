"""Socket.io client for brain↔API communication.

Connects to the API's /robot namespace, authenticates with ROBOT_BRAIN_TOKEN,
and provides methods to emit state/job-status and subscribe to job:dispatch.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Awaitable, Callable

import socketio

logger = logging.getLogger(__name__)

DispatchCallback = Callable[[dict[str, Any]], Awaitable[None]]


class BrainApiClient:
    """Manages a single Socket.io connection to the API's /robot namespace."""

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
