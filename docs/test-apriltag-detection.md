# Testing AprilTag Detection on Raspberry Pi 5

This guide helps you manually verify that the AprilTag detection pipeline is working correctly.

---

## 1. Check PM2 Services

```bash
# Check if all robot services are running
pm2 status

# Look for these services:
# - nexus-robot-vision     (AprilTag detector)
# - nexus-robot-web-bridge (WebSocket server)
# - nexus-robot-lidar      (RPLidar driver)
# - nexus-robot-slam       (SLAM/mapping)
```

If `nexus-robot-vision` is not running:
```bash
pm2 restart nexus-robot-vision
pm2 logs nexus-robot-vision --lines 20
```

---

## 2. View AprilTag Node Logs

```bash
pm2 logs nexus-robot-vision --lines 50
```

**What to look for:**
```
[april_tag_node] april_tag_node ready: device=/dev/video0 640x480 family=tag36h11 size=0.166m @ 10Hz
[april_tag_node] Using pupil_apriltags for AprilTag detection
[april_tag_node] tags #42 x=0.31 z=0.85, #15 x=-0.12 z=1.20
```

If you see **"No AprilTag library found"**, install it:
```bash
pip3 install --break-system-packages dt-apriltags
# or
pip3 install --break-system-packages pupil-apriltags
```

---

## 3. Listen to ROS Topic Directly

```bash
# Source ROS 2 environment
source /opt/ros/jazzy/setup.bash

# Listen to detected_tags topic
ros2 topic echo /detected_tags
```

**Expected output when a tag is detected:**
```yaml
data: '{"ts": 1234567890.123, "tags": [{"tag_id": 42, "x": 0.31, "y": 0.02, "z": 0.85, "yaw": 1.57, "pitch": 0.0, "roll": 0.0, "confidence": 0.92, "size_m": 0.166}]}'
---
```

**No output?** Check:
- Camera is connected: `ls -la /dev/video0`
- Camera snapshot is available: `curl -f http://127.0.0.1:9092/snapshot -o /tmp/apriltag-test.jpg`
- AprilTag is in camera view (distance: 0.5–2 meters)
- Lighting is adequate (avoid glare)

---

## 4. Check WebSocket Forwarding

```bash
pm2 logs nexus-robot-web-bridge --lines 50
```

**What to look for:**
```
[WS] + 192.168.1.100
[WebBridge] Subscribed to /detected_tags
```

The web_bridge should forward `/detected_tags` ROS messages to all connected WebSocket clients.

---

## 5. Test WebSocket Connection from Command Line

```bash
# Install wscat (WebSocket client)
sudo npm install -g wscat

# Get the auth token from environment
TOKEN=$(grep ROBOT_BRAIN_TOKEN /home/pi/robot_ws/src/my_robot_controller/.env | cut -d= -f2)

# Connect to robot WebSocket
wscat -c "ws://localhost:9091?token=$TOKEN"
```

**Expected output:**
```json
< {"type":"info","data":{"lidar":true,"map":true,"pose":true,"mode":"idle"}}
< {"type":"scan","data":{"points":[...],"count":360}}
< {"type":"pose","data":{"x":1.234,"y":0.567,"theta":1.57}}
```

**When you scan an AprilTag:**
```json
< {"type":"detected_tags","data":{"ts":1234567890.123,"tags":[{"tag_id":42,"x":0.31,"y":0.02,"z":0.85,"yaw":1.57,"pitch":0.0,"roll":0.0,"confidence":0.92,"size_m":0.166}]}}
```

Press `Ctrl+C` to disconnect.

---

## 6. Check Camera Device

```bash
# List video devices
ls -la /dev/video*

# Should show:
# /dev/video0 -> video device (camera)
# /dev/video1 -> metadata device (ignore)

# Get device info
v4l2-ctl --list-devices

# Test the same camera snapshot consumed by AprilTag detection
curl -f http://127.0.0.1:9092/snapshot -o test.jpg

# View the captured image
feh test.jpg
# or transfer to your PC:
# scp pi@robot-ip:~/test.jpg .
```

**Camera not found?**
- Check USB connection
- Try another USB port
- Reboot: `sudo reboot`

---

## 7. Verify AprilTag Library Installation

```bash
python3 -c "import pupil_apriltags; print('pupil_apriltags OK')" 2>/dev/null || \
python3 -c "import dt_apriltags; print('dt_apriltags OK')" 2>/dev/null || \
echo "No AprilTag library found!"
```

**Install if missing:**
```bash
# dt-apriltags (recommended for Pi 5 / Python 3.12)
pip3 install --break-system-packages dt-apriltags

# or pupil-apriltags (may require building from source)
sudo apt install libopencv-dev python3-opencv
pip3 install --break-system-packages pupil-apriltags
```

---

## 8. Check Environment Variables

```bash
# View april_tag_node environment
pm2 env 0  # Replace 0 with the actual process ID from pm2 status

# Look for these variables:
# CAMERA_DEVICE=/dev/video0
# CAMERA_WIDTH=640
# CAMERA_HEIGHT=480
# APRILTAG_FAMILY=tag36h11
# APRILTAG_SIZE_M=0.166
# APRILTAG_HZ=10
```

---

## 9. Generate Test AprilTag

If you don't have a physical AprilTag, generate one:

```bash
# Install apriltag generator (Python)
pip3 install --break-system-packages apriltag

# Generate tag36h11 ID 42 (A4 size)
python3 << EOF
from apriltag import ApriltagGenerator
gen = ApriltagGenerator()
gen.generate('tag36h11', [42], 'tag_42.png')
EOF

# Print or display on screen
feh tag_42.png
```

Or use the web frontend:
1. Open `https://web.nguyen-robot.io.vn/calibrate`
2. Scroll to "Generate AprilTag" section
3. Enter tag ID (0-586)
4. Print the generated SVG

---

## 10. Common Issues

### Camera snapshot unavailable
```bash
curl -f http://127.0.0.1:9092/
pm2 restart nexus-robot-camera
pm2 logs nexus-robot-camera --lines 30 --nostream
```

### "No such file or directory: /dev/video0"
Camera not connected or recognized. Check USB connection.

### "tags" array is empty in /detected_tags
- AprilTag is too far (>2m) or too close (<0.3m)
- Tag is blurry or partially occluded
- Lighting is poor
- Tag family mismatch (check APRILTAG_FAMILY env var)

### WebSocket connection refused
```bash
# Check if web_bridge is running
pm2 status nexus-robot-web-bridge

# Check port 9091 is open
sudo lsof -i :9091

# Restart if needed
pm2 restart nexus-robot-web-bridge
```

### "Permission denied" on /dev/video0
```bash
# Add user to video group
sudo usermod -a -G video $USER
# Log out and back in, or reboot
```

---

## 11. Full Integration Test

Once the robot pipeline is working, test the full flow:

1. **Assign AprilTag to a package** (via API or web UI):
   ```bash
   curl -X PATCH http://localhost:5000/packages/PACKAGE_ID/status \
     -H "Content-Type: application/json" \
     -d '{"status": "IN_PROGRESS"}'
   # This auto-assigns a tagId from the pool (0-586)
   ```

2. **Scan the tag** with the robot camera

3. **Check frontend notification**:
   - Open `https://web.nguyen-robot.io.vn` in browser
   - Login
   - Browser console should show: `[RobotWS] Connected`
   - When tag is detected, notification appears with package info

4. **Verify API call**:
   ```bash
   # Check backend logs
   docker compose logs -f api | grep "by-tag"
   # Should show: GET /packages/by-tag/42
   ```

---

## Quick Debug Checklist

```bash
# 1. PM2 services
pm2 status

# 2. Camera
ls -la /dev/video0

# 3. ROS topic
source /opt/ros/jazzy/setup.bash && ros2 topic list | grep detected

# 4. WebSocket
sudo lsof -i :9091

# 5. Logs
pm2 logs nexus-robot-vision --lines 20

# 6. Python library
python3 -c "import dt_apriltags"
```

---

## Restart Everything

If issues persist, restart all robot services:

```bash
cd /home/pi/robot_ws/src/my_robot_controller
./start.sh
```

Or restart individual services:

```bash
pm2 restart nexus-robot-vision
pm2 restart nexus-robot-web-bridge
```

---

**Need help?** Check the main docs:
- `services/robot/CLAUDE.md` — Robot architecture
- `services/robot/src/my_robot_controller/my_robot_controller/april_tag_node.py` — Detection code
- `services/robot/src/my_robot_controller/my_robot_controller/web_bridge.py` — WebSocket forwarding
