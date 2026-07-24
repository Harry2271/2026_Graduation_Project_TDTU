#!/usr/bin/env python3
"""Continuous reader for ESP32 USB CDC — never asserts DTR.

Run on Pi 5:

    python3 tools/continuous_reader.py
    python3 tools/continuous_reader.py --port /dev/ttyACM0 --seconds 30
    python3 tools/continuous_reader.py --json-only

Why not just `cat`?  The cdc_acm driver on the Pi 5 sometimes throws
'device reports readiness to read but returned no data' when the host
opens/closes the port rapidly.  This script opens once, disables DTR,
and reads forever — proving the link is truly continuous.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections import deque

try:
    import serial
except ImportError:
    print("ERROR: pyserial not installed.  Run: pipx install pyserial", file=sys.stderr)
    sys.exit(2)


def _summarise(msg: dict) -> str:
    t = msg.get("type")
    d = msg.get("data") or {}
    if t == 141:
        return (f"alive={d.get('alive')} uptime={d.get('uptime_ms')}ms "
                f"mode={d.get('mode')} e_stop={d.get('e_stop')}")
    if t == 131:
        motors = d.get("motors") or []
        running = sum(1 for m in motors if abs(m.get("target", 0) or m.get("t", 0)) > 0)
        return f"status motors_running={running}/{len(motors)}"
    return f"type={t}"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--port", default="/dev/ttyACM0")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--seconds", type=float, default=0,
                    help="stop after N seconds (0 = run forever)")
    ap.add_argument("--json-only", action="store_true")
    ap.add_argument("-v", "--verbose", action="store_true",
                    help="also print debug text lines from ESP32")
    args = ap.parse_args()

    print(f"opening {args.port} @ {args.baud} baud (DTR=disabled)", file=sys.stderr, flush=True)
    s = serial.Serial(
        args.port,
        args.baud,
        bytesize=8,
        parity="N",
        stopbits=1,
        timeout=0.5,
        # CRITICAL — do not toggle DTR/RTS on open.  ESP32-S3 USB CDC
        # resets if DTR is asserted, which disconnects mid-read.
        dsrdtr=False,
        rtscts=False,
    )
    # Belt-and-braces: explicitly clear both after open.
    s.dtr = False
    s.rts = False
    # Drain anything queued from the boot banner.
    s.reset_input_buffer()

    t0 = time.monotonic()
    buf = b""
    json_count = 0
    alive_count = 0
    text_count = 0
    last_alive_t = 0.0
    alive_gaps: deque[float] = deque(maxlen=20)
    last_stats_t = t0

    try:
        while True:
            if args.seconds and (time.monotonic() - t0) > args.seconds:
                break
            chunk = s.read(256)
            now = time.monotonic()

            if alive_count and (now - last_alive_t) > 5.0:
                print(f"\n[FROZEN] no alive frame for {now - last_alive_t:.1f}s",
                      file=sys.stderr, flush=True)
                return 3
            if not chunk:
                if now - last_stats_t > 5:
                    elapsed = now - t0
                    rate = alive_count / elapsed if elapsed > 0 else 0
                    avg_gap = sum(alive_gaps) / len(alive_gaps) if alive_gaps else 0
                    print(f"\n[stats] {json_count} JSON ({alive_count} alive), "
                          f"{text_count} text, {rate:.1f} alive/s, "
                          f"gap avg={avg_gap*1000:.0f}ms",
                          file=sys.stderr, flush=True)
                    last_stats_t = now
                continue
            buf += chunk
            while b"\n" in buf:
                raw, buf = buf.split(b"\n", 1)
                text = raw.decode("utf-8", errors="replace").rstrip("\r")
                if text.startswith("{"):
                    json_count += 1
                    try:
                        msg = json.loads(text)
                        if msg.get("type") == 141:
                            alive_count += 1
                            if last_alive_t:
                                alive_gaps.append(now - last_alive_t)
                            last_alive_t = now
                        if args.json_only:
                            print(text, flush=True)
                        else:
                            print(f"  [{msg.get('type')}] {_summarise(msg)}", flush=True)
                    except json.JSONDecodeError:
                        print(f"  bad-json: {text[:120]}", flush=True)
                else:
                    text_count += 1
                    if args.verbose and not args.json_only:
                        print(f"  txt: {text[:200]}", flush=True)
    except KeyboardInterrupt:
        pass
    finally:
        s.close()

    elapsed = time.monotonic() - t0
    print(f"\n[done] {alive_count} alive frames in {elapsed:.1f}s "
          f"({alive_count/elapsed if elapsed else 0:.1f} alive/s)", flush=True)
    return 0 if alive_count >= 10 else 1


if __name__ == "__main__":
    sys.exit(main())