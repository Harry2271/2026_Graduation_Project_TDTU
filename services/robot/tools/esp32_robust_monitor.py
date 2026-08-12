#!/usr/bin/env python3
"""ESP32 USB CDC robust monitor — no port reopen, no DTR toggle.

Run on Pi 5:

    python3 ~/esp32_robust_monitor.py
    python3 ~/esp32_robust_monitor.py --seconds 60

Design choices:
- Opens port ONCE, holds it for the entire session.
- Never closes/reopens (which would reset ESP32 via DTR toggle).
- Reads everything available in 100 ms chunks.
- Surfaces alive counter jumps (indicating ESP32 silently rebooted).
"""

from __future__ import annotations

import argparse
import json
import sys
import time

try:
    import serial
except ImportError:
    print("ERROR: pyserial not installed.  Run: pip3 install pyserial --break-system-packages",
          file=sys.stderr)
    sys.exit(2)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--port", default="/dev/robot-esp32")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--seconds", type=float, default=0,
                    help="stop after N seconds (0 = run forever)")
    ap.add_argument("--quiet", action="store_true",
                    help="only print alive frames, suppress other JSON")
    args = ap.parse_args()

    print(f"opening {args.port} @ {args.baud} (NO DTR/RTS toggle)", flush=True)
    s = serial.Serial(
        args.port,
        args.baud,
        bytesize=8,
        parity="N",
        stopbits=1,
        timeout=0.1,
        dsrdtr=False,
        rtscts=False,
    )
    # Belt-and-braces: explicitly clear both after open.
    s.dtr = False
    s.rts = False
    s.reset_input_buffer()

    print("[OK] port opened, waiting for ESP32...", flush=True)

    t0 = time.monotonic()
    buf = b""
    last_alive = -1
    alive_total = 0
    alive_gap = 0.0

    try:
        while True:
            if args.seconds and (time.monotonic() - t0) > args.seconds:
                break
            try:
                chunk = s.read(256)
            except serial.SerialException as exc:
                print(f"\n[USB-DISCONNECT] {exc}", flush=True)
                break
            if not chunk:
                continue

            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                text = line.decode("utf-8", errors="replace").strip()
                if not text.startswith("{"):
                    continue
                try:
                    msg = json.loads(text)
                except json.JSONDecodeError:
                    continue
                if msg.get("type") != 144:
                    if not args.quiet:
                        d = msg.get("data", {})
                        print(f"  [{msg.get('type')}] {str(d)[:100]}", flush=True)
                    continue
                # Alive frame
                d = msg.get("data", {})
                alive = d.get("alive", -1)
                uptime = d.get("uptime_ms", 0)
                if last_alive >= 0 and alive != last_alive + 1:
                    print(f"\n[RESET-DETECTED] alive jumped {last_alive} -> {alive} "
                          f"(ESP32 rebooted silently)",
                          flush=True)
                alive_total += 1
                gap = (uptime / 1000.0) - (last_alive * 0.5) if last_alive >= 0 else 0.5
                print(f"  alive={alive:>3} uptime={uptime:>6}ms "
                      f"mode={d.get('mode')} e_stop={d.get('e_stop')}",
                      flush=True)
                last_alive = alive
                alive_gap = gap
    except KeyboardInterrupt:
        pass
    finally:
        s.close()

    elapsed = time.monotonic() - t0
    print(f"\n[done] {alive_total} alive frames in {elapsed:.1f}s "
          f"({alive_total/elapsed if elapsed else 0:.2f} alive/s)",
          flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())