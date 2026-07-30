#!/usr/bin/env python3
"""serial_test.py — interactive ESP32 motor tester (no ROS required).

Reads keyboard in real-time:
  Movement (one-shot):
    w/s        forward/backward
    a/d        strafe left/right
    q/e        rotate CCW/CW

  Speed (sticky):
    [/]        decrease/increase max speed (10%)
    x          stop (brake)
    +          e-stop (lock until reset)
    -          clear e-stop

  Heartbeat (sent automatically; usually irrelevant):
    h          send one manual heartbeat

  Quit:
    ESC or Ctrl-C  → graceful stop + disconnect

Each movement press triggers a SHORT burst (default 500 ms) and then
auto-stops.  This prevents "press w and the robot shoots off the table".

Arguments:
    --port     Serial device (default /dev/robot-esp32)
    --speed    Initial max PWM (default 70 — safe bench speed)
    --burst    Auto-stop timeout after a movement key (ms, default 500)
    --dev      Use /dev/ttyACM0 instead of /dev/robot-esp32

Why not use ros2 teleop_twist_keyboard?  Two reasons:
1. This script works on a fresh Pi WITHOUT ros2 sourcing (if you only
   want to test the serial link, e.g. after flashing new firmware).
2. It prints everything in one terminal — easier to debug.

Verify on Pi:
    python3 services/robot/tools/serial_test.py
    # → press w, robot (elevated) should roll forward briefly
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time

try:
    import serial_asyncio
except ImportError:
    print('ERROR: pyserial-asyncio not installed.', file=sys.stderr)
    print('  pip install pyserial-asyncio pyserial', file=sys.stderr)
    sys.exit(2)


def _print_frame(prefix: str, msg: dict) -> None:
    t = msg.get('type')
    d = msg.get('data') or {}
    if t == 141:  # alive
        print(f"  [alive] #{d.get('alive')} mode={d.get('mode')} "
              f"e_stop={d.get('e_stop')} uptime={d.get('uptime_ms')}ms",
              flush=True)
    elif t == 131:  # status
        motors = d.get('motors', [])
        running = sum(1 for m in motors if abs(m.get('t', 0)) > 0)
        print(f"  [status] mode={d.get('mode')} motors_running={running}/4",
              flush=True)
    elif t == 130:  # encoder
        motors = d.get('motors') or d.get('data', [])
        if motors:
            line = ', '.join(f"{m.get('name','?')}:{m.get('rpm',0):.0f}rpm"
                             for m in motors if isinstance(m, dict))
            print(f"  [encoder] {line}", flush=True)
    elif t == 129:  # error
        print(f"  [ERROR] {d.get('error')}", flush=True)
    elif t == 128:  # ack
        print(f"  [ACK] {d}", flush=True)


class SerialTester:
    """Interactive serial motor tester.

    Uses pynput-style key reading on Linux/macOS/Windows via simple
    getch(); intentionally lightweight — no external dep on keyboard libs.
    """

    def __init__(self, port: str, baud: int, speed: int, burst_ms: int):
        self.port = port
        self.baud = baud
        self.speed = speed
        self.burst_ms = burst_ms
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._buffer = bytearray()
        self._e_stopped = False
        self._alive_count = 0
        self._last_alive_t = 0.0
        self._connected = False

    # ── Serial I/O ────────────────────────────────────────────────

    async def connect(self) -> None:
        print(f'opening {self.port} @ {self.baud} baud (8N1, no DTR toggle)',
              flush=True)
        self._reader, self._writer = await serial_asyncio.open_serial_connection(
            url=self.port, baudrate=self.baud,
            bytesize=8, parity='N', stopbits=1,
            timeout=0.5, dsrdtr=False, rtscts=False,
        )
        self._connected = True
        print('  connected. starting heartbeat + read loop.', flush=True)

    async def disconnect(self) -> None:
        self._connected = False
        if self._writer:
            self._writer.close()
            try:
                await self._writer.wait_closed()
            except Exception:
                pass

    async def _send(self, cmd: dict) -> None:
        line = (json.dumps(cmd) + '\n').encode('utf-8')
        if self._writer is None:
            return
        self._writer.write(line)
        await self._writer.drain()

    async def _heartbeat_loop(self) -> None:
        """Send heartbeat every 50 ms — keeps ESP32 in MODE_NAV."""
        while self._connected:
            try:
                await self._send({'cmd': 'heartbeat'})
            except Exception as e:
                print(f'  [heartbeat-err] {e}', flush=True)
            await asyncio.sleep(0.05)

    async def _read_loop(self) -> None:
        if self._reader is None:
            return
        while self._connected:
            try:
                chunk = await self._reader.read(256)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                print(f'  [read-err] {e}', flush=True)
                await asyncio.sleep(0.05)
                continue
            if not chunk:
                await asyncio.sleep(0.01)
                continue
            self._buffer.extend(chunk)
            while b'\n' in self._buffer:
                raw, self._buffer = self._buffer.split(b'\n', 1)
                text = raw.decode('utf-8', errors='replace').strip()
                if not text.startswith('{'):
                    continue
                try:
                    msg = json.loads(text)
                except Exception:
                    continue
                if msg.get('type') == 141:
                    self._alive_count += 1
                    self._last_alive_t = time.monotonic()
                _print_frame('rx', msg)

    # ── Movement commands ─────────────────────────────────────────

    async def move_burst(self, vx: int, vy: int, omega: int, label: str) -> None:
        """Send a movement command for burst_ms milliseconds, then stop."""
        if self._e_stopped:
            print('  [blocked] e_stop is latched — press "-" to clear', flush=True)
            return
        spd = self.speed
        vx = max(-spd, min(spd, vx))
        vy = max(-spd, min(spd, vy))
        omega = max(-spd, min(spd, omega))
        print(f'  → move vx={vx} vy={vy} omega={omega} ({label}) '
              f'for {self.burst_ms}ms', flush=True)
        await self._send({'cmd': 'move', 'vx': vx, 'vy': vy, 'omega': omega})
        await asyncio.sleep(self.burst_ms / 1000)
        await self._send({'cmd': 'stop'})
        print(f'  → stop', flush=True)

    async def emergency_stop(self) -> None:
        self._e_stopped = True
        print('  → E-STOP latched. Press "-" to clear.', flush=True)
        await self._send({'cmd': 'e_stop'})

    async def clear_estop(self) -> None:
        self._e_stopped = False
        print('  → E-STOP cleared.', flush=True)
        await self._send({'cmd': 'e_stop_clear'})

    async def manual_heartbeat(self) -> None:
        await self._send({'cmd': 'heartbeat'})
        print('  → manual heartbeat sent', flush=True)

    def speed_step(self, delta: int) -> int:
        self.speed = max(0, min(255, self.speed + delta))
        return self.speed

    # ── Main loop ─────────────────────────────────────────────────

    async def run(self) -> None:
        await self.connect()

        # Start heartbeat + read background tasks
        asyncio.create_task(self._heartbeat_loop())
        asyncio.create_task(self._read_loop())

        # Request initial status snapshot
        await self._send({'cmd': 'get_status'})
        print('\n=== INTERACTIVE MODE ===', flush=True)
        print('Movement:', flush=True)
        print('  w/s    forward/backward', flush=True)
        print('  a/d    strafe left/right', flush=True)
        print('  q/e    rotate CCW/CW', flush=True)
        print('Other:', flush=True)
        print('  [/]    speed ±10%   (now {} PWM)'.format(self.speed), flush=True)
        print('  x      stop', flush=True)
        print('  +      e-STOP (latched)', flush=True)
        print('  -      clear e-stop', flush=True)
        print('  h      manual heartbeat', flush=True)
        print('  ESC    quit', flush=True)
        print('========================\n', flush=True)

        try:
            while self._connected:
                key = await _async_getch()
                if key is None:
                    break
                k = key.lower()
                if k in ('\x1b', 'q\0'):  # ESC
                    break
                elif k == 'w':
                    await self.move_burst(self.speed, 0, 0, 'forward')
                elif k == 's':
                    await self.move_burst(-self.speed, 0, 0, 'backward')
                elif k == 'a':
                    await self.move_burst(0, -self.speed, 0, 'strafe-left')
                elif k == 'd':
                    await self.move_burst(0, self.speed, 0, 'strafe-right')
                elif k == 'q':
                    await self.move_burst(0, 0, -self.speed, 'rotate-CCW')
                elif k == 'e':
                    await self.move_burst(0, 0, self.speed, 'rotate-CW')
                elif k == 'x':
                    await self._send({'cmd': 'stop'})
                    print('  → stop', flush=True)
                elif k == '+':
                    await self.emergency_stop()
                elif k == '-':
                    await self.clear_estop()
                elif k == 'h':
                    await self.manual_heartbeat()
                elif k == '[':
                    self.speed_step(-10)
                    print(f'  speed now {self.speed} PWM', flush=True)
                elif k == ']':
                    self.speed_step(+10)
                    print(f'  speed now {self.speed} PWM', flush=True)
                else:
                    print(f'  (key {k!r} ignored)', flush=True)
        except (asyncio.CancelledError, KeyboardInterrupt):
            pass
        finally:
            print('\nshutting down — sending stop + disconnect', flush=True)
            try:
                await self._send({'cmd': 'stop'})
                await asyncio.sleep(0.05)
            except Exception:
                pass
            await self.disconnect()
            elapsed = time.monotonic() - self._last_alive_t if self._last_alive_t else 0
            print(f'  {self._alive_count} alive frames received', flush=True)


async def _async_getch() -> str | None:
    """Async version of getch() — works on Linux, macOS, and Windows.

    Returns the key as a single char, or None if EOF.
    """
    loop = asyncio.get_event_loop()

    def _getch() -> str:
        try:
            import termios, tty  # POSIX
            fd = sys.stdin.fileno()
            old_settings = termios.tcgetattr(fd)
            try:
                tty.setraw(fd)
                ch = sys.stdin.read(1)
            finally:
                termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
            return ch
        except Exception:
            # Windows fallback — msvcrt.kbhit + getch
            import msvcrt
            if not msvcrt.kbhit():
                return ''
            ch = msvcrt.getch()
            try:
                return ch.decode('utf-8')
            except UnicodeDecodeError:
                return ''

    key = await loop.run_in_executor(None, _getch)
    if key == '' or key is None:
        return None
    return key


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--port', default='/dev/robot-esp32',
                   help='serial device (default /dev/robot-esp32)')
    p.add_argument('--speed', type=int, default=70,
                   help='initial max PWM (default 70, safe bench)')
    p.add_argument('--burst', type=int, default=500,
                   help='auto-stop ms after a movement key (default 500)')
    p.add_argument('--baud', type=int, default=115200)
    p.add_argument('--dev', action='store_true',
                   help='use /dev/ttyACM0 instead of /dev/robot-esp32')
    args = p.parse_args()

    if args.dev:
        args.port = '/dev/ttyACM0'

    tester = SerialTester(args.port, args.baud, args.speed, args.burst)
    try:
        asyncio.run(tester.run())
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == '__main__':
    sys.exit(main())
