#!/usr/bin/env python3
"""Read ESP32 USB CDC continuously and prove the link is alive.

Run on Pi 5:

    python3 tools/serial_monitor.py
    python3 tools/serial_monitor.py --port /dev/ttyACM0 --baud 115200
    python3 tools/serial_monitor.py --json-only   # hide debug text, show only JSON

Exits with non-zero status if no alive frame arrives within 5 s.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
import time
from collections import deque
from typing import Any

LOG = logging.getLogger("serial-monitor")


# ---------- helpers ------------------------------------------------------


def _looks_like_json(line: str) -> bool:
    s = line.strip()
    return s.startswith("{") and s.endswith("}")


def _summarise(msg: dict[str, Any]) -> str:
    """One-line human summary of a parsed ESP32 frame."""
    t = msg.get("type")
    d = msg.get("data") or {}
    if t == 141:
        # Alive heartbeat — the "is firmware still ticking" frame.
        return (
            f"alive={d.get('alive')} "
            f"uptime={d.get('uptime_ms')} ms "
            f"mode={d.get('mode')} "
            f"e_stop={d.get('e_stop')}"
        )
    if t == 131:
        motors = d.get("motors") or []
        running = sum(1 for m in motors if abs(m.get("target", 0) or m.get("t", 0)) > 0)
        return f"status motors_running={running}/{len(motors)}"
    return f"type={t}"


# ---------- main loop ----------------------------------------------------


async def main_async(args: argparse.Namespace) -> int:
    try:
        import serial_asyncio
    except ImportError:
        print("ERROR: pyserial-asyncio not installed.\n"
              "  pip install pyserial-asyncio", file=sys.stderr)
        return 2

    LOG.info("opening %s @ %d baud", args.port, args.baud)
    reader, _writer = await serial_asyncio.open_serial_connection(
        url=args.port,
        baudrate=args.baud,
        bytesize=8,
        parity="N",
        stopbits=1,
        timeout=0.5,
    )

    buf = bytearray()
    lines_received = 0
    json_lines = 0
    alive_seen = 0
    last_alive_t = 0.0
    alive_gaps: deque[float] = deque(maxlen=32)
    start = time.monotonic()
    last_report = start

    try:
        while True:
            chunk = await reader.read(256)
            now = time.monotonic()

            # Watchdog — if no alive for >5 s, declare frozen.
            if alive_seen and (now - last_alive_t) > 5.0:
                print(f"\n[FROZEN] no alive frame for {now - last_alive_t:.1f}s",
                      file=sys.stderr)
                return 3

            if not chunk:
                # Heartbeat from this side — keep connection fresh.
                if alive_seen and (now - last_report) > 5.0:
                    elapsed = now - start
                    rate = json_lines / elapsed if elapsed > 0 else 0.0
                    print(f"\n[stats] {lines_received} lines, "
                          f"{json_lines} JSON, "
                          f"{alive_seen} alive, "
                          f"{rate:.1f} JSON/s, "
                          f"alive-gap avg={_avg(alive_gaps)*1000:.0f} ms",
                          file=sys.stderr)
                    last_report = now
                await asyncio.sleep(0.05)
                continue

            buf.extend(chunk)
            while b"\n" in buf:
                raw, buf = buf.split(b"\n", 1)
                lines_received += 1
                text = raw.decode("utf-8", errors="replace").rstrip("\r")
                if not _looks_like_json(text):
                    if args.verbose and not args.json_only:
                        print(f"  txt: {text[:200]}", flush=True)
                    continue

                json_lines += 1
                try:
                    msg = json.loads(text)
                except json.JSONDecodeError as exc:
                    if args.verbose:
                        print(f"  bad-json: {exc}: {text[:120]}", flush=True)
                    continue

                # Track alive frames for liveness check.
                if msg.get("type") == 141:
                    alive_seen += 1
                    if last_alive_t > 0:
                        alive_gaps.append(now - last_alive_t)
                    last_alive_t = now

                if args.json_only:
                    # One line per JSON frame.
                    print(text, flush=True)
                else:
                    print(f"  [{msg.get('type')}] {_summarise(msg)}", flush=True)
    except asyncio.CancelledError:
        return 0
    except KeyboardInterrupt:
        return 0


def _avg(values: deque[float]) -> float:
    return sum(values) / len(values) if values else 0.0


# ---------- CLI ----------------------------------------------------------


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--port", default="/dev/ttyACM0",
                   help="serial device (default: /dev/ttyACM0)")
    p.add_argument("--baud", type=int, default=115200,
                   help="baud rate (default: 115200)")
    p.add_argument("--json-only", action="store_true",
                   help="suppress debug text, show only JSON lines")
    p.add_argument("-v", "--verbose", action="store_true",
                   help="show debug text lines too")
    p.add_argument("--log-level", default="INFO")
    args = p.parse_args()

    logging.basicConfig(
        level=args.log_level,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    return asyncio.run(main_async(args))


if __name__ == "__main__":
    sys.exit(main())