"""Thread-safe WebSocket and UDP discovery bridges for PySide6."""
from __future__ import annotations

import asyncio
import gzip
import json
import queue
import socket
import threading
import time
from typing import Any

from PySide6.QtCore import QThread, Signal

try:
    import websockets
except ImportError as exc:  # pragma: no cover - launcher installs it
    raise RuntimeError('Missing dependency: websockets') from exc


UDP_DISCOVERY_PORT = 9090
UDP_SCAN_TIMEOUT = 3.0
DEFAULT_URL = 'ws://127.0.0.1:9091'
RECONNECT_BACKOFF = (1.0, 2.0, 4.0, 8.0, 16.0)
PING_INTERVAL = 5.0


class BridgeClient(QThread):
    """WebSocket client running its asyncio loop outside the Qt GUI thread.

    ``message_received`` is a queued Qt signal, so all UI state changes happen
    on the main thread. Outbound messages are put into a bounded queue and
    consumed by the async sender task.
    """

    message_received = Signal(dict)
    connection_changed = Signal(bool, str)
    log_message = Signal(str, bool)

    def __init__(self, url: str) -> None:
        super().__init__()
        self.url = url
        self._stop = threading.Event()
        self._connected = threading.Event()
        self._outgoing: queue.Queue[dict] = queue.Queue(maxsize=100)

    def run(self) -> None:
        asyncio.run(self._async_main())

    async def _async_main(self) -> None:
        attempt = 0
        while not self._stop.is_set():
            try:
                self.log_message.emit(f'WS connecting {self.url}', False)
                async with websockets.connect(
                    self.url, ping_interval=None, open_timeout=5.0,
                    close_timeout=1.0,
                ) as ws:
                    attempt = 0
                    self._connected.set()
                    self.connection_changed.emit(True, self.url)
                    await asyncio.gather(
                        self._receiver(ws), self._sender(ws), self._pinger(ws),
                    )
            except asyncio.CancelledError:
                break
            except Exception as exc:
                self._connected.clear()
                self.connection_changed.emit(False, str(exc))
                self.log_message.emit(f'WS connect failed: {exc}', True)
                delay = RECONNECT_BACKOFF[min(attempt, len(RECONNECT_BACKOFF) - 1)]
                attempt += 1
                for _ in range(max(1, int(delay / 0.2))):
                    if self._stop.is_set():
                        return
                    await asyncio.sleep(0.2)

    async def _receiver(self, ws: Any) -> None:
        async for raw in ws:
            if self._stop.is_set():
                return
            self._dispatch(raw)

    async def _sender(self, ws: Any) -> None:
        loop = asyncio.get_running_loop()
        while not self._stop.is_set():
            try:
                msg = await loop.run_in_executor(None, self._outgoing.get, True, 0.5)
            except queue.Empty:
                continue
            if msg.get('type') == '_shutdown':
                return
            await ws.send(json.dumps(msg, ensure_ascii=False))

    async def _pinger(self, ws: Any) -> None:
        while not self._stop.is_set():
            await asyncio.sleep(PING_INTERVAL)
            try:
                await ws.send(json.dumps({'type': 'ping'}))
            except Exception:
                return

    def _dispatch(self, raw: Any) -> None:
        try:
            if isinstance(raw, bytes):
                try:
                    raw = gzip.decompress(raw).decode('utf-8')
                except Exception:
                    raw = raw.decode('utf-8', errors='replace')
            obj = json.loads(raw)
            if isinstance(obj, dict):
                self.message_received.emit(obj)
        except Exception:
            return

    def is_connected(self) -> bool:
        return self._connected.is_set()

    def send(self, msg: dict) -> bool:
        if not self.is_connected():
            return False
        try:
            self._outgoing.put_nowait(msg)
            return True
        except queue.Full:
            self.log_message.emit('outgoing queue full — dropped message', True)
            return False

    def close(self) -> None:
        self._stop.set()
        try:
            self._outgoing.put_nowait({'type': '_shutdown'})
        except queue.Full:
            pass
        self.requestInterruption()
        self.wait(2500)


class UDPDiscovery(QThread):
    """Broadcast ``find_pi`` and emit discovered Pi bridge endpoints."""

    device_found = Signal(dict)
    log_message = Signal(str, bool)

    def __init__(self) -> None:
        super().__init__()
        self._stop = threading.Event()

    def run(self) -> None:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        except OSError:
            pass
        sock.settimeout(0.25)
        try:
            ping = json.dumps({'type': 'find_pi', 'from': 'pyside6_operator'}).encode()
            sock.sendto(ping, ('255.255.255.255', UDP_DISCOVERY_PORT))
            deadline = time.monotonic() + UDP_SCAN_TIMEOUT
            while not self._stop.is_set() and time.monotonic() < deadline:
                try:
                    payload, addr = sock.recvfrom(2048)
                    msg = json.loads(payload.decode('utf-8', errors='ignore'))
                    if msg.get('type') != 'pi_info':
                        continue
                    ws_url = msg.get('ws_url') or f'ws://{addr[0]}:{msg.get("ws_port", 9091)}'
                    device = {
                        'ws_url': ws_url, 'ip': msg.get('ip', addr[0]),
                        'hostname': msg.get('hostname', 'unknown'),
                        'mode': msg.get('mode', ''),
                    }
                    self.device_found.emit(device)
                except socket.timeout:
                    continue
                except (OSError, ValueError, json.JSONDecodeError):
                    continue
        finally:
            sock.close()

    def close(self) -> None:
        self._stop.set()
        self.wait(1000)
