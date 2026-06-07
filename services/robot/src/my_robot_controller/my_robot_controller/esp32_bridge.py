"""Pi <-> ESP32 UART bridge.

This module defines:
  - Esp32Bridge: a Protocol describing the interface the brain uses
  - FakeEsp32Bridge: an in-memory implementation for unit tests
  - RealEsp32Bridge: a pyserial-asyncio implementation for production

The brain only ever talks to the Esp32Bridge Protocol; it never sees
the concrete implementation.
"""
from __future__ import annotations

import asyncio
import json
from typing import Any, Callable, Optional, Protocol


class Esp32Bridge(Protocol):
    async def connect(self) -> None: ...
    async def disconnect(self) -> None: ...
    async def move(self, vx: int, vy: int, omega: int) -> None: ...
    async def stop(self) -> None: ...
    async def e_stop(self) -> None: ...
    async def clear_e_stop(self) -> None: ...
    async def heartbeat(self) -> None: ...
    async def get_status(self) -> dict: ...
    async def get_encoder(self) -> list[dict]: ...

    on_status_update: Callable[[dict], None]
    on_encoder_update: Callable[[list[dict]], None]
    on_e_stop: Callable[[], None]
    on_error: Callable[[str], None]


def _to_json_line(cmd: dict) -> bytes:
    """Encode a command as a newline-terminated JSON line (matches the ESP32 protocol)."""
    return (json.dumps(cmd) + '\n').encode('utf-8')


class FakeEsp32Bridge:
    """In-memory Esp32Bridge for unit tests.

    Records every command sent to .sent_commands(). Use .inject_*() to
    simulate the ESP32 emitting events back to the brain.
    """

    def __init__(self, heartbeat_interval_s: float = 0.05) -> None:
        self._commands: list[dict] = []
        self._lock = asyncio.Lock()
        self._heartbeat_task: Optional[asyncio.Task[None]] = None
        self._heartbeat_interval = heartbeat_interval_s
        self._connected = False

        self.on_status_update: Callable[[dict], None] = lambda _data: None
        self.on_encoder_update: Callable[[list[dict]], None] = lambda _data: None
        self.on_e_stop: Callable[[], None] = lambda: None
        self.on_error: Callable[[str], None] = lambda _msg: None

    async def connect(self) -> None:
        self._connected = True
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())

    async def disconnect(self) -> None:
        self._connected = False
        if self._heartbeat_task is not None:
            self._heartbeat_task.cancel()
            try:
                await self._heartbeat_task
            except asyncio.CancelledError:
                pass
            self._heartbeat_task = None

    async def move(self, vx: int, vy: int, omega: int) -> None:
        await self._send({'cmd': 'move', 'vx': vx, 'vy': vy, 'omega': omega})

    async def stop(self) -> None:
        await self._send({'cmd': 'stop'})

    async def e_stop(self) -> None:
        await self._send({'cmd': 'e_stop'})

    async def clear_e_stop(self) -> None:
        await self._send({'cmd': 'e_stop_clear'})

    async def heartbeat(self) -> None:
        await self._send({'cmd': 'heartbeat'})

    async def get_status(self) -> dict:
        return {'uptime_ms': 0, 'mode': 'NAV', 'e_stop': False}

    async def get_encoder(self) -> list[dict]:
        return []

    def sent_commands(self) -> list[dict]:
        return list(self._commands)

    def inject_status(self, data: dict) -> None:
        self.on_status_update(data)

    def inject_encoder(self, data: list[dict]) -> None:
        self.on_encoder_update(data)

    def inject_e_stop(self) -> None:
        self.on_e_stop()

    def inject_error(self, message: str) -> None:
        self.on_error(message)

    async def _send(self, cmd: dict) -> None:
        async with self._lock:
            if not self._connected:
                raise RuntimeError('FakeEsp32Bridge: not connected')
            self._commands.append(cmd)

    async def _heartbeat_loop(self) -> None:
        while self._connected:
            await asyncio.sleep(self._heartbeat_interval)
            try:
                await self.heartbeat()
            except Exception:  # noqa: BLE001
                pass


class RealEsp32Bridge:
    """UART-backed Esp32Bridge.

    Takes a pre-opened StreamReader/StreamWriter pair (from
    pyserial-asyncio's SerialTransport.open_serial_connection). This
    indirection lets tests inject mock streams.
    """

    def __init__(self, writer: Any, reader: Any) -> None:
        self._writer = writer
        self._reader = reader
        self._lock = asyncio.Lock()
        self._connected = False
        self._heartbeat_task: Optional[asyncio.Task[None]] = None
        self._heartbeat_interval = 0.05

        self.on_status_update: Callable[[dict], None] = lambda _data: None
        self.on_encoder_update: Callable[[list[dict]], None] = lambda _data: None
        self.on_e_stop: Callable[[], None] = lambda: None
        self.on_error: Callable[[str], None] = lambda _msg: None

    async def connect(self) -> None:
        self._connected = True
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())

    async def disconnect(self) -> None:
        self._connected = False
        if self._heartbeat_task is not None:
            self._heartbeat_task.cancel()
            try:
                await self._heartbeat_task
            except asyncio.CancelledError:
                pass
            self._heartbeat_task = None

    async def move(self, vx: int, vy: int, omega: int) -> None:
        await self._send_line({'cmd': 'move', 'vx': vx, 'vy': vy, 'omega': omega})

    async def stop(self) -> None:
        await self._send_line({'cmd': 'stop'})

    async def e_stop(self) -> None:
        await self._send_line({'cmd': 'e_stop'})

    async def clear_e_stop(self) -> None:
        await self._send_line({'cmd': 'e_stop_clear'})

    async def heartbeat(self) -> None:
        await self._send_line({'cmd': 'heartbeat'})

    async def get_status(self) -> dict:
        return {'uptime_ms': 0, 'mode': 'NAV', 'e_stop': False}

    async def get_encoder(self) -> list[dict]:
        return []

    async def _send_line(self, cmd: dict) -> None:
        async with self._lock:
            line = _to_json_line(cmd)
            self._writer.write(line)
            await self._writer.drain()

    async def _heartbeat_loop(self) -> None:
        while self._connected:
            await asyncio.sleep(self._heartbeat_interval)
            try:
                await self.heartbeat()
            except Exception:  # noqa: BLE001
                self.on_error('heartbeat failed')
