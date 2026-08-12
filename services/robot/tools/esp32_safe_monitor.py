#!/usr/bin/env python3
"""ESP32 safe monitor — kills all competing processes, verifies port is free, then reads.

Run on Pi 5:
    python3 esp32_safe_monitor.py
    python3 esp32_safe_monitor.py --seconds 60
"""
import serial, json, time, sys, os, subprocess, argparse

def kill_competing():
    """Kill any process holding /dev/ttyACM0 or /dev/robot-esp32."""
    for port in ["/dev/ttyACM0", "/dev/robot-esp32"]:
        try:
            result = subprocess.run(
                ["sudo", "lsof", "-t", port],
                capture_output=True, text=True, timeout=5
            )
            pids = result.stdout.strip().split()
            for pid in pids:
                if pid and pid.isdigit() and int(pid) != os.getpid():
                    print(f"  killing PID {pid} on {port}", flush=True)
                    subprocess.run(["sudo", "kill", "-9", pid],
                                   capture_output=True, timeout=5)
        except Exception:
            pass

    # Also kill rplidar, ros2 launch
    for pattern in ["rplidar", "ros2 launch", "esp32_telemetry"]:
        try:
            subprocess.run(["pkill", "-9", "-f", pattern],
                           capture_output=True, timeout=5)
        except Exception:
            pass

def wait_port_free(timeout=10):
    """Wait until no process holds /dev/ttyACM0."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            result = subprocess.run(
                ["sudo", "lsof", "/dev/ttyACM0"],
                capture_output=True, text=True, timeout=5
            )
            lines = [l for l in result.stdout.strip().split("\n") if l.strip()]
            if len(lines) <= 1:  # only header = no process
                return True
        except Exception:
            pass
        time.sleep(0.5)
    return False

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", default="/dev/robot-esp32")
    ap.add_argument("--seconds", type=float, default=0)
    args = ap.parse_args()

    print("[1/4] Killing competing processes...", flush=True)
    kill_competing()
    time.sleep(1)

    print("[2/4] Waiting for port to be free...", flush=True)
    if not wait_port_free(timeout=5):
        print("  WARNING: port still occupied, trying anyway", flush=True)
    else:
        print("  port is free", flush=True)

    print(f"[3/4] Opening {args.port}...", flush=True)
    s = serial.Serial(
        args.port, 115200,
        timeout=0.1,
        dsrdtr=False,
        rtscts=False,
    )
    s.dtr = False
    s.rts = False
    s.reset_input_buffer()
    print("[OK] connected", flush=True)

    print("[4/4] Reading ESP32 data. Ctrl+C to stop.\n", flush=True)
    t0 = time.monotonic()
    buf = b""
    alive = 0
    last_counter = -1
    last_alive_t = t0

    try:
        while True:
            if args.seconds and (time.monotonic() - t0) > args.seconds:
                break
            try:
                chunk = s.read(1024)
            except serial.SerialException as e:
                print(f"\n[USB-DISCONNECT] {e}", flush=True)
                break
            now = time.monotonic()

            # If no data for 3s, check if port is still held by someone else
            if alive > 0 and (now - last_alive_t) > 3:
                result = subprocess.run(
                    ["sudo", "lsof", "/dev/ttyACM0"],
                    capture_output=True, text=True, timeout=5
                )
                lines = [l for l in result.stdout.strip().split("\n")
                         if l.strip() and "python" not in l.lower()]
                if len(lines) > 1:  # something else is on the port
                    print(f"\n[CONFLICT] another process took the port:", flush=True)
                    print(f"  {result.stdout.strip()}", flush=True)
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
                except:
                    continue
                if msg.get("type") != 144:
                    continue
                alive += 1
                last_alive_t = now
                d = msg.get("data", {})
                ec = d.get("alive", -1)
                if last_counter >= 0 and ec != last_counter + 1:
                    print(f"\n!!! RESET DETECTED: {last_counter} -> {ec}", flush=True)
                last_counter = ec
                elapsed = now - t0
                rate = alive / elapsed if elapsed > 0 else 0
                print(f"  [{alive:>4}] alive={ec:>3} uptime={d.get('uptime_ms')}ms "
                      f"mode={d.get('mode')} rate={rate:.1f}/s", flush=True)
    except KeyboardInterrupt:
        pass
    finally:
        s.close()
        elapsed = time.monotonic() - t0
        print(f"\nDone: {alive} alive frames in {elapsed:.1f}s "
              f"({alive/elapsed if elapsed else 0:.1f} alive/s)", flush=True)

if __name__ == "__main__":
    main()
