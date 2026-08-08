"""UDP discovery beacon for the AIoT logistics robot.

Lets any desktop / mobile client ask "are you a Pi 5 here?" without
knowing the IP. Clients send a tiny JSON ping to UDP port 9090; the
beacon replies with the WS URL, hostname, and basic robot info.

Format
------
Client → beacon:
    {"type": "find_pi", "from": "operator_app"}

Beacon → client:
    {
      "type": "pi_info",
      "hostname": "robot-pi5",
      "ip": "192.168.1.42",
      "ws_port": 9091,
      "ws_url": "ws://192.168.1.42:9091",
      "lidar": true,
      "mode": "live"
    }

Designed to be looped via ``asyncio`` in the same event loop as the WS
server, started from ``main()`` in web_bridge.py.
"""
from __future__ import annotations

import asyncio
import json
import socket
from typing import Any, Callable, Awaitable, Optional


BEACON_PORT = 9090
BEACON_MAGIC = b'{"type":"find_pi"'  # cheap prefix match for sniffing


def _local_ip() -> str:
    """Best-effort local IP for the WS URL we announce.  Opens a UDP socket
    that does not actually send anything to figure out which interface would
    route a public packet."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(('8.8.8.8', 80))
            return s.getsockname()[0]
        finally:
            s.close()
    except Exception:
        return '127.0.0.1'


class DiscoveryBeacon:
    """Listens for find_pi pings; replies with our WS URL."""

    def __init__(self,
                 get_info: Callable[[], Awaitable[dict] | dict],
                 port: int = BEACON_PORT) -> None:
        self.get_info = get_info
        self.port = port
        self._transport: Optional[asyncio.DatagramTransport] = None
        self._protocol: Optional[_BeaconProtocol] = None

    async def start(self) -> None:
        loop = asyncio.get_running_loop()
        # Reuse the IP helper at startup; cheap, runs once.
        self._ip_hint = _local_ip()
        self._transport, self._protocol = await loop.create_datagram_endpoint(
            lambda: _BeaconProtocol(self),
            local_addr=('0.0.0.0', self.port),
            allow_broadcast=True,
        )
        print(f'[UDP beacon] listening on udp://0.0.0.0:{self.port}')

    async def stop(self) -> None:
        if self._transport is not None:
            self._transport.close()
            self._transport = None


class _BeaconProtocol(asyncio.DatagramProtocol):
    def __init__(self, owner: DiscoveryBeacon) -> None:
        self.owner = owner

    def datagram_received(self, data: bytes, addr: tuple[str, int]) -> None:
        # Cheap prefix filter — avoid JSON parse cost on noisy networks.
        if not data.lstrip().startswith(b'{"type"'):
            return
        try:
            payload = json.loads(data.decode('utf-8', errors='ignore'))
        except Exception:
            return
        if payload.get('type') != 'find_pi':
            return
        # Schedule the reply so we don't block the protocol callback.
        asyncio.create_task(self._reply(addr))

    async def _reply(self, addr: tuple[str, int]) -> None:
        info = self.owner.get_info()
        if asyncio.iscoroutine(info):
            info = await info
        info = dict(info or {})
        info.setdefault('type', 'pi_info')
        info.setdefault('hostname', socket.gethostname())
        info.setdefault('ip', self.owner._ip_hint)
        info.setdefault('ws_port', 9091)
        ws_ip = info['ip']
        info.setdefault('ws_url', f'ws://{ws_ip}:{info["ws_port"]}')
        msg = json.dumps(info).encode('utf-8')
        try:
            assert self.owner._transport is not None
            self.owner._transport.sendto(msg, addr)
        except Exception:
            pass