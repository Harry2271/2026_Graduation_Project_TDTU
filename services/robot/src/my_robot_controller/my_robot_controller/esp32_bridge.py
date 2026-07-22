"""Pi <-> ESP32 link.

This module defines:
  - Esp32Bridge: a Protocol describing the interface the brain uses
  - FakeEsp32Bridge: an in-memory implementation for unit tests
  - RealEsp32Bridge: a pyserial-asyncio implementation for production

The brain only ever talks to the Esp32Bridge Protocol; it never sees
the concrete implementation.

Two transports are supported:
  - USB CDC: device appears as /dev/ttyACM0 on the Pi (default for the
    WeAct ESP32-S3).  Firmware alias: PiSerial = Serial.
  - UART GPIO 43/44: legacy hardware UART.  Only kept for old hardware;
    avoid on Pi 5 because it triggers PL011 DMA "non-idle" hangs.

Both transports send the same JSON-line protocol at 115200 baud
(USB CDC ignores baud but the constant is shared for clarity).

Read loop:
  - Lines NOT starting with '{' are ignored.  This skips firmware debug
    logs that share the same USB endpoint.
  - JSON lines are dispatched by `type` field to the right callback.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Callable, Optional, Protocol

LOG = logging.getLogger(__name__)


# ---------- Protocol -----------------------------------------------------


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


# ---------- Helpers ------------------------------------------------------


def _to_json_line(cmd: dict) -> bytes:
    """Encode a command as a newline-terminated JSON line (matches the ESP32 protocol)."""
    return (json.dumps(cmd) + '\n').encode('utf-8')


async def _open_serial(port: str, baudrate: int = 115200):
    """Open a USB CDC or UART serial port and return (reader, writer).

    Uses pyserial-asyncio's open_serial_connection() under the hood.

    Args:
        port: device path, e.g. '/dev/ttyACM0' (USB CDC) or '/dev/ttyAMA0' (UART).
        baudrate: baud rate (ignored for USB CDC, kept for clarity).

    Returns:
        (StreamReader, StreamWriter) pair.

    Note:
        - User must be in the `dialout` group on the Pi, or have write
          permission to the device node.
        - pyserial-asyncio resets the ESP32 by default (DTR toggle).
          Pass dsrdtr=False if you want a non-resetting open.
    """
    import serial_asyncio  # local import so tests don't pull this dependency

    return await serial_asyncio.open_serial_connection(
        url=port,
        baudrate=baudrate,
        # 8N1 — same on UART and USB CDC.
        bytesize=8,
        parity='N',
        stopbits=1,
        # Short read timeout keeps the loop responsive; the reader
        # discards non-JSON lines instead of blocking.
        timeout=0.5,
    )


# ---------- Fake bridge (tests) ------------------------------------------


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


# ---------- Real bridge (production) -------------------------------------


class RealEsp32Bridge:
    """USB CDC / UART-backed Esp32Bridge.

    Typical use:

        reader, writer = await _open_serial('/dev/ttyACM0', 115200)
        bridge = RealEsp32Bridge(reader=reader, writer=writer)
        bridge.on_status_update = my_status_handler
        bridge.on_encoder_update = my_encoder_handler
        bridge.on_e_stop = my_e_stop_handler
        bridge.on_error = my_error_handler
        await bridge.connect()              # starts read loop
        await bridge.move(100, 0, 0)
        ...
        await bridge.disconnect()           # stops read loop

    The constructor accepts pre-opened StreamReader/StreamWriter so
    tests can inject mock streams without pulling pyserial-asyncio.
    """

    # Type constants the firmware emits on each JSON line.  See firmware
    # documentation (firmware/CLAUDE.md) for the full list.
    TYPE_ACK         = 128
    TYPE_ERROR       = 129
    TYPE_ENCODER     = 130
    TYPE_STATUS      = 131
    TYPE_MOVE_ACK    = 132
    TYPE_POWER       = 133
    TYPE_IMU         = 134
    TYPE_IR          = 135
    TYPE_SHARP       = 136
    TYPE_TOF         = 138
    TYPE_UNLOAD_STATE = 140

    # Best-effort cap on a single JSON line — keeps memory bounded if ESP32
    # ever goes into a runaway write loop.  Status JSON is ~700 bytes; power
    # telemetry fits in 200.
    _MAX_LINE_BYTES = 2048

    def __init__(self, writer: Any, reader: Any) -> None:
        self._writer = writer
        self._reader = reader
        self._lock = asyncio.Lock()
        self._connected = False
        self._heartbeat_task: Optional[asyncio.Task[None]] = None
        self._reader_task: Optional[asyncio.Task[None]] = None
        self._heartbeat_interval = 0.05

        self._last_e_stop = False  # track rising edge for on_e_stop callback

        self.on_status_update: Callable[[dict], None] = lambda _data: None
        self.on_encoder_update: Callable[[list[dict]], None] = lambda _data: None
        self.on_e_stop: Callable[[], None] = lambda: None
        self.on_error: Callable[[str], None] = lambda _msg: None

    # ----- lifecycle -----

    async def connect(self) -> None:
        """Start the reader + heartbeat background tasks."""
        if self._connected:
            return
        self._connected = True
        self._reader_task = asyncio.create_task(self._read_loop())
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())

    async def disconnect(self) -> None:
        """Stop background tasks.  Does NOT close the writer."""
        self._connected = False
        for task in (self._reader_task, self._heartbeat_task):
            if task is not None:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
        self._reader_task = None
        self._heartbeat_task = None

    # ----- command API -----

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
        """Synchronous placeholder — use on_status_update callback instead."""
        return {'uptime_ms': 0, 'mode': 'NAV', 'e_stop': False}

    async def get_encoder(self) -> list[dict]:
        """Synchronous placeholder — use on_encoder_update callback instead."""
        return []

    # ----- internals -----

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

    async def _read_loop(self) -> None:
        """Read newline-terminated lines from the ESP32 forever.

        - Bytes that don't form a complete line are buffered.
        - Lines that don't start with '{' (firmware debug text mixed on
          USB CDC) are silently dropped.
        - Malformed JSON is logged and dropped.
        - Recognised JSON types are dispatched to the matching callback.
        """
        buf = bytearray()
        while self._connected:
            try:
                chunk = await self._reader.read(256)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                LOG.warning('read failed: %s', exc)
                self.on_error(f'read failed: {exc}')
                await asyncio.sleep(0.05)
                continue

            if not chunk:
                # EOF or no-data — back off to avoid a tight CPU loop.
                await asyncio.sleep(0.01)
                continue

            buf.extend(chunk)

            # Slice out complete lines.  pyserial-asyncio delivers newlines
            # at chunk boundaries; handle them one at a time so a giant
            # burst doesn't overflow the per-line cap.
            while b'\n' in buf:
                raw, buf = buf.split(b'\n', 1)
                if len(raw) > self._MAX_LINE_BYTES:
                    LOG.warning('dropping oversized line (%d bytes)', len(raw))
                    continue
                # Wrap each callback invocation — a buggy user handler
                # must NOT kill the reader task.
                try:
                    self._handle_line(raw)
                except asyncio.CancelledError:
                    raise
                except Exception:  # noqa: BLE001
                    LOG.exception('handler raised on line: %r', raw[:120])

            # Guardrail: if buffer grows without a newline, drop it.
            if len(buf) > self._MAX_LINE_BYTES:
                LOG.warning('discarding unterminated buffer (%d bytes)', len(buf))
                buf.clear()

    def _handle_line(self, raw: bytes) -> None:
        text = raw.decode('utf-8', errors='replace').strip()
        if not text:
            return
        # Firmware logs and status messages both share USB CDC.
        # Anything that isn't JSON starts with '{'.
        if not text.startswith('{'):
            return
        try:
            msg = json.loads(text)
        except json.JSONDecodeError as exc:
            LOG.warning('bad JSON: %s', exc)
            return

        msg_type = msg.get('type')
        if msg_type is None:
            return  # no type field — not a valid protocol frame

        # ── Flat vs envelope format ────────────────────────────────────────
        # The firmware sends flat frames:
        #   {"ts":1053920,"type":131,"mode":"AUTO_ROAM","estop":false,...}
        # The brain node and older code expect envelope frames:
        #   {"type":131,"data":{"mode":"AUTO_ROAM","estop":false,...}}
        # To support both, prefer `msg["data"]` if present; otherwise use the
        # full message dict as the payload — fields like "ts" are harmless.
        data = msg.get('data') or msg

        if msg_type == self.TYPE_STATUS:
            self.on_status_update(data)
        elif msg_type == self.TYPE_ENCODER:
            # Flat encoder frame: {"ts":...,"type":130,"motors":[...]}
            # Envelope frame:     {"type":130,"data":{"motors":[...]}}
            motors = data.get('motors') if 'motors' in data else data
            if not isinstance(motors, list):
                motors = []
            self.on_encoder_update(motors)
        elif msg_type == self.TYPE_ERROR:
            self.on_error(str(data.get('error', 'unknown')))
        elif msg_type == self.TYPE_MOVE_ACK:
            status = data.get('status')
            if status == 'rejected':
                self.on_error(f"move rejected: {data.get('reason', '?')}")
        else:
            # IMU, POWER, IR, SHARP, TOF, UNLOAD_STATE, ACK, … — ignore
            # by default.  Hosts that want them can subclass or wrap.
            pass

        # Rising-edge e_stop trigger from any status frame.
        if msg_type == self.TYPE_STATUS:
            e_stop = bool(data.get('e_stop', False))
            if e_stop and not self._last_e_stop:
                try:
                    self.on_e_stop()
                except Exception:  # noqa: BLE001
                    LOG.exception('on_e_stop handler raised')
            self._last_e_stop = e_stop


# ---------- Convenience factory ------------------------------------------


async def open_esp32_bridge(
    port: str = '/dev/ttyACM0',
    baudrate: int = 115200,
) -> RealEsp32Bridge:
    """Open /dev/ttyACM0 (or any port) and return a connected RealEsp32Bridge.

    Default port is /dev/ttyACM0 — the USB CDC device the WeAct ESP32-S3
    creates.  Pass '/dev/ttyAMA0' instead for the legacy GPIO 43/44 UART
    (NOT recommended on Pi 5 — see PL011 DMA bug history).

    Remember to set up the callbacks BEFORE calling .connect():

        bridge = await open_esp32_bridge()
        bridge.on_status_update = my_status_handler
        bridge.on_encoder_update = my_encoder_handler
        bridge.on_e_stop        = my_e_stop_handler
        bridge.on_error         = my_error_handler
        await bridge.connect()
    """
    reader, writer = await _open_serial(port, baudrate)
    bridge = RealEsp32Bridge(reader=reader, writer=writer)
    return bridge
