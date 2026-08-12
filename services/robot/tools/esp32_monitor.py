#!/usr/bin/env python3
"""ESP32 monitor — single open, no DTR toggle, no reconnect.

Run on Pi 5:
    python3 tools/esp32_monitor.py
    python3 tools/esp32_monitor.py --port /dev/robot-esp32 --seconds 300
"""

import serial, json, time, sys, argparse

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", default="/dev/robot-esp32")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--seconds", type=float, default=0, help="0 = forever")
    args = ap.parse_args()

    s = serial.Serial(
        args.port, args.baud,
        timeout=0.1,
        dsrdtr=False,
        rtscts=False,
    )
    s.dtr = False
    s.rts = False
    s.reset_input_buffer()

    t0 = time.monotonic()
    buf = b""
    alive = 0
    last_alive_counter = -1

    try:
        while True:
            if args.seconds and (time.monotonic() - t0) > args.seconds:
                break
            chunk = s.read(1024)
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
                except:
                    continue

                t = msg.get("type")
                d = msg.get("data", {})

                if t == 144:
                    alive += 1
                    ec = d.get("alive", -1)
                    if last_alive_counter >= 0 and ec != last_alive_counter + 1:
                        print(f"\n!!! RESET: alive {last_alive_counter} -> {ec}", flush=True)
                    last_alive_counter = ec
                    print(f"[{alive:>4}] alive={ec:>3} uptime={d.get('uptime_ms')}ms "
                          f"mode={d.get('mode')} e_stop={d.get('e_stop')}", flush=True)
                elif t == 131:
                    motors = d.get("motors", [])
                    running = sum(1 for m in motors if abs(m.get("t",0)) > 0)
                    print(f"  [131] mode={d.get('mode')} motors={running}/4 "
                          f"sharp={d.get('st',{}).get('sharp','?')}cm", flush=True)

    except KeyboardInterrupt:
        pass
    except serial.SerialException as e:
        print(f"\n[DISCONNECT] {e}", flush=True)
    finally:
        s.close()
        elapsed = time.monotonic() - t0
        print(f"\nDone: {alive} alive frames in {elapsed:.1f}s", flush=True)

if __name__ == "__main__":
    main()
