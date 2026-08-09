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

# Retry settings for API connection
_MAX_CONNECT_RETRIES = 10
_BASE_RETRY_DELAY = 2.0
_MAX_RETRY_DELAY = 60.0


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
        self._cancel_handlers: list[DispatchCallback] = []

        @self._sio.on('job:dispatch', namespace='/robot')
        async def _on_job_dispatch(data: dict[str, Any]) -> None:
            logger.info('Received job:dispatch: %s', data.get('_id', 'unknown'))
            for handler in self._dispatch_handlers:
                await handler(data)

        @self._sio.on('job:cancel', namespace='/robot')
        async def _on_job_cancel(data: dict[str, Any]) -> None:
            logger.info('Received job:cancel: %s', data.get('jobId', 'unknown'))
            for handler in self._cancel_handlers:
                await handler(data)

        @self._sio.on('connect', namespace='/robot')
        def _on_connect() -> None:
            self._connected = True
            logger.info('Connected to API /robot namespace')

        @self._sio.on('disconnect', namespace='/robot')
        def _on_disconnect() -> None:
            self._connected = False
            logger.info('Disconnected from API /robot namespace')

    async def connect(self) -> None:
        """Connect to the API server with retry + exponential backoff.

        Retries up to ``_MAX_CONNECT_RETRIES`` times. Does NOT raise on
        failure — the caller should handle the fact that ``connected`` may
        still be False after calling this method.
        """
        if self._connected:
            return

        delay = _BASE_RETRY_DELAY
        for attempt in range(1, _MAX_CONNECT_RETRIES + 1):
            try:
                await self._sio.connect(
                    self._server_url,
                    namespaces=['/robot'],
                    auth={'token': self._token},
                )
                # _on_connect sets _connected = True
                logger.info(
                    'BrainApiClient connected to %s (attempt %d)',
                    self._server_url,
                    attempt,
                )
                return
            except Exception as e:
                logger.warning(
                    'BrainApiClient connect attempt %d/%d failed: %s',
                    attempt,
                    _MAX_CONNECT_RETRIES,
                    e,
                )
                if attempt < _MAX_CONNECT_RETRIES:
                    import asyncio
                    await asyncio.sleep(delay)
                    delay = min(delay * 2, _MAX_RETRY_DELAY)

        logger.error(
            'BrainApiClient: all %d connect attempts failed — '
            'will retry in background loop',
            _MAX_CONNECT_RETRIES,
        )

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

    def on_job_cancel(self, callback: DispatchCallback) -> None:
        """Register a handler for job:cancel events from the API."""
        self._cancel_handlers.append(callback)

    async def emit_job_cancel_ack(self, job_id: str) -> None:
        """Acknowledge a job:cancel so the API can release the slot safely."""
        if not self._connected:
            return
        await self._sio.emit(
            'job:cancel:ack', {'jobId': job_id}, namespace='/robot',
        )

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

    async def emit_job_phase(self, job_id: str, phase: str) -> None:
        """Emit a job phase checkpoint to the API (for UI progress display)."""
        if not self._connected:
            return
        await self._sio.emit(
            'job:phase',
            {'jobId': job_id, 'phase': phase},
            namespace='/robot',
        )

    async def emit_robot_health(self) -> None:
        """Emit a keepalive health heartbeat to the API.

        Called periodically from the brain's async loop to let the API
        know the brain is alive and track last-seen timestamps.
        """
        if not self._connected:
            return
        await self._sio.emit('robot:health', {}, namespace='/robot')

    async def emit_cargo_ready(self) -> None:
        """Emit a cargo-ready event when a new package is detected on the bed.

        The warehouse UI can use this to dispatch a delivery job to the
        robot, or to show a 'cargo detected' indicator.
        """
        if not self._connected:
            return
        await self._sio.emit('robot:cargo_ready', {}, namespace='/robot')

    async def emit_job_timing(self, job_id: str, timing: dict) -> None:
        """Emit delivery timing data to the API.

        Timing dict keys: startedAt, pickupAt, dropoffAt, unloadAt,
        totalDurationMs, travelToPickupMs, travelToDropoffMs, unloadDurationMs.
        All Date values should be ISO-format strings.
        """
        if not self._connected:
            return
        payload = {'jobId': job_id, **timing}
        await self._sio.emit('job:timing', payload, namespace='/robot')

    async def emit_robot_error(self, severity: str, code: str, message: str) -> None:
        """Emit a robot error/warning event to the API for real-time alerting.

        severity: 'warning' | 'error' | 'critical'
        code: machine-readable error code (e.g. 'NAV_FAILED', 'DOCK_TIMEOUT')
        message: human-readable description
        """
        if not self._connected:
            return
        await self._sio.emit('robot:error', {
            'severity': severity,
            'code': code,
            'message': message,
        }, namespace='/robot')
