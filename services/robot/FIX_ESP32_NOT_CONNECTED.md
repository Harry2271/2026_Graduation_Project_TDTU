# ESP32 Not Connected — Quick Fix Guide

## Problem
The ESP32 telemetry node is crash-looping because `/dev/ttyACM0` doesn't exist. The ESP32-S3 is not connected to the Raspberry Pi 5.

## Diagnosis Results (from your Pi)

```
✅ LiDAR connected:     /dev/robot-lidar → /dev/ttyUSB0 (Silicon Labs CP210x)
❌ ESP32 NOT connected: no /dev/ttyACM* devices found
✅ Camera working:      /dev/video0 (Logitech Brio 100)
✅ AprilTag node OK:    running, ready to detect tag25h9 tags
```

## Root Cause
The ESP32-S3 WeAct board is physically disconnected or the USB cable is faulty.

---

## Solution — Connect the ESP32

### 1. Locate the ESP32-S3 board
The ESP32-S3 WeAct N16R8 should be:
- Connected via USB-C cable (data-capable, NOT charge-only)
- Powered on (LED indicator should be visible)
- Running the motor controller firmware

### 2. Check the USB cable
Many USB-C cables are **charge-only** and won't work for serial communication. Try a different cable if available.

### 3. Connect and verify

```bash
# Before connecting: check current devices
ls -la /dev/ttyACM* /dev/ttyUSB*

# Connect the ESP32 USB cable to the Pi 5
# Wait 3 seconds

# After connecting: check again
ls -la /dev/ttyACM* /dev/ttyUSB*

# Expected: you should now see /dev/ttyACM0 or /dev/ttyACM1
# Example output:
#   crw-rw-rw- 1 root dialout 166, 0 Aug 27 11:30 /dev/ttyACM0
```

### 4. Verify the device vendor/product ID

```bash
# Check if the ESP32 is recognized
lsusb

# Expected line (WCH CH9102 USB-UART bridge on ESP32-S3 WeAct):
#   Bus 00X Device 00X: ID 1a86:55d3 QinHeng Electronics USB Single Serial
```

If you see a different vendor ID, the udev rules need adjustment (but the basic connection will still work).

### 5. Find your repo path

```bash
# The repo is NOT in /home/pi/robot-for-nguyen
# Find it:
find ~ -name 'robot-for-nguyen' -type d 2>/dev/null | head -1

# Or check common locations:
ls -ld ~/robot-for-nguyen
ls -ld ~/projects/robot-for-nguyen
ls -ld ~/code/robot-for-nguyen
```

Once you find it, update the path below:

```bash
REPO_PATH="<your-actual-path>"  # e.g., ~/projects/robot-for-nguyen
cd "$REPO_PATH/services/robot"
```

### 6. Install udev rules (for stable device names)

```bash
cd <repo-path>/services/robot
sudo ./tools/install_udev_rules.sh

# This creates:
#   /dev/robot-esp32 → /dev/ttyACM0
#   /dev/robot-lidar → /dev/ttyUSB0
# So devices don't swap after reboot
```

### 7. Restart the telemetry node

```bash
pm2 restart nexus-robot-esp32-telemetry
pm2 logs nexus-robot-esp32-telemetry --lines 20 --nostream
```

**Expected success log:**
```
[INFO] [esp32_telemetry]: opening ESP32 bridge on /dev/robot-esp32 @ 115200
[INFO] [esp32_telemetry]: ESP32 telemetry bridge connected — gateway active
```

### 8. Verify ROS topics

```bash
ros2 topic list | grep esp32

# Expected topics:
#   /esp32/ack
#   /esp32/alive
#   /esp32/cmd
#   /esp32/encoder
#   /esp32/imu
#   /esp32/power
#   /esp32/status

ros2 topic echo /esp32/status --once
# Should return a JSON frame within 2 seconds
```

---

## Alternative: Run Without ESP32 (SLAM-only mode)

If the ESP32 is unavailable but you want to test SLAM/mapping:

```bash
# Stop the crash-looping node
pm2 stop nexus-robot-esp32-telemetry
pm2 stop nexus-robot-odom
pm2 stop nexus-robot-teleop

# Save PM2 state
pm2 save

# Verify other nodes are still running
pm2 list | grep online
```

The robot will operate in **SLAM-only mode**:
- ✅ LiDAR scanning works
- ✅ Map building works (slam_toolbox)
- ✅ WebSocket bridge works (port 9091)
- ✅ AprilTag detection works
- ❌ Motor control disabled (no /cmd_vel → ESP32 path)
- ❌ Odometry disabled (no encoder/IMU data)

---

## Code Changes Applied

I've updated `start.sh` and `deploy.sh` to:

1. **Fallback port detection** — if `/dev/robot-esp32` doesn't exist, try `/dev/ttyACM0`, `/dev/ttyACM1`, etc.
2. **Graceful degradation** — skip ESP32-dependent nodes (telemetry, odom, teleop) if the device isn't found
3. **Clear error messages** — explain what's missing and how to fix it

**To apply the fixes on the Pi:**

```bash
cd <repo-path>
git pull origin master
cd services/robot
./start.sh
```

Or if you're already using PM2:

```bash
cd <repo-path>
git pull origin master
cd services/robot
./deploy.sh
```

---

## Troubleshooting

### "No such file or directory: /dev/ttyACM0" persists after connecting

**Cause:** The ESP32 firmware isn't running or the USB bridge chip failed.

**Fix:**
1. Re-flash the firmware from your dev machine:
   ```bash
   cd firmware
   pio run --target upload
   ```
2. Check the ESP32 serial monitor:
   ```bash
   pio device monitor --port /dev/ttyACM0 --baud 115200
   ```
   You should see boot messages and `{"type":144,...}` heartbeat frames every 500ms.

### "Permission denied" on /dev/ttyACM0

**Cause:** The `pi` user isn't in the `dialout` group.

**Fix:**
```bash
sudo usermod -aG dialout pi
# Log out and back in, or:
newgrp dialout
pm2 restart nexus-robot-esp32-telemetry
```

### lsusb shows "1a86:7523" instead of "1a86:55d3"

**Cause:** Different USB-UART bridge chip (CH340 vs CH9102).

**Fix:** The udev rules already handle this (line 36-41 in `99-robot-ports.rules`). The symlink will still work.

---

## Summary

**Current state:**
- ESP32 is physically disconnected
- LiDAR, camera, and AprilTag vision are working
- The code fixes allow graceful operation without ESP32

**Next steps:**
1. Connect ESP32 via USB
2. Find repo path: `find ~ -name 'robot-for-nguyen' -type d 2>/dev/null`
3. Install udev rules: `cd <repo>/services/robot && sudo ./tools/install_udev_rules.sh`
4. Restart: `pm2 restart nexus-robot-esp32-telemetry`
5. Verify: `ros2 topic echo /esp32/status --once`

**Or:** Continue in SLAM-only mode by stopping the ESP32-dependent nodes and testing mapping without motor control.
