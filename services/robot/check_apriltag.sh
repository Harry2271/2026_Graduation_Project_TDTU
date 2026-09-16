#!/bin/bash
# =============================================================================
# check_apriltag.sh — AprilTag Detection Diagnostic Tool
# =============================================================================
# Kiểm tra toàn bộ hệ thống AprilTag detection trên Raspberry Pi 5
# Usage: ./check_apriltag.sh

set +e  # Continue on errors to show all diagnostics

echo "╔═══════════════════════════════════════════════════════════════════╗"
echo "║         APRILTAG DETECTION DIAGNOSTIC TOOL                        ║"
echo "║         Raspberry Pi 5 + ROS 2 Jazzy + dt-apriltags              ║"
echo "╚═══════════════════════════════════════════════════════════════════╝"
echo ""

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

pass_count=0
fail_count=0

print_pass() {
    echo -e "${GREEN}✅ $1${NC}"
    ((pass_count++))
}

print_fail() {
    echo -e "${RED}❌ $1${NC}"
    ((fail_count++))
}

print_warn() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_section() {
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "$1"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

# =============================================================================
# 1. Camera Hardware Check
# =============================================================================
print_section "1️⃣  CAMERA HARDWARE CHECK"

if [ -c /dev/video0 ]; then
    print_pass "/dev/video0 exists"
    ls -la /dev/video0

    # Check permissions
    if [ -r /dev/video0 ] && [ -w /dev/video0 ]; then
        print_pass "Camera permissions OK (readable + writable)"
    else
        print_fail "Camera permissions issue"
        echo "   Run: sudo chmod 666 /dev/video0"
    fi

    # Check if device is being used
    LSOF_OUTPUT=$(sudo lsof /dev/video0 2>/dev/null)
    if [ -n "$LSOF_OUTPUT" ]; then
        print_warn "Camera is being used by:"
        echo "$LSOF_OUTPUT"
    else
        print_pass "Camera not in use (available)"
    fi
else
    print_fail "/dev/video0 NOT FOUND"
    echo "   Available video devices:"
    ls -la /dev/video* 2>/dev/null || echo "   No video devices found"
    echo ""
    echo "   Troubleshooting:"
    echo "   • Check USB connection"
    echo "   • Run: dmesg | tail -50"
    echo "   • Try: lsusb | grep -i camera"
fi

# =============================================================================
# 2. PM2 Services Status
# =============================================================================
print_section "2️⃣  PM2 SERVICES STATUS"

if command -v pm2 &> /dev/null; then
    PM2_CAMERA=$(pm2 jlist 2>/dev/null | grep -o '"name":"nexus-robot-camera"' || echo "")
    PM2_VISION=$(pm2 jlist 2>/dev/null | grep -o '"name":"nexus-robot-vision"' || echo "")

    if [ -n "$PM2_CAMERA" ]; then
        CAMERA_STATUS=$(pm2 jlist 2>/dev/null | grep -A 5 "nexus-robot-camera" | grep -o '"status":"[^"]*"' | head -1)
        if [[ "$CAMERA_STATUS" == *"online"* ]]; then
            print_pass "nexus-robot-camera is running"
        else
            print_fail "nexus-robot-camera status: $CAMERA_STATUS"
        fi
    else
        print_fail "nexus-robot-camera NOT found in PM2"
        echo "   Run: pm2 restart nexus-robot-camera"
    fi

    if [ -n "$PM2_VISION" ]; then
        VISION_STATUS=$(pm2 jlist 2>/dev/null | grep -A 5 "nexus-robot-vision" | grep -o '"status":"[^"]*"' | head -1)
        if [[ "$VISION_STATUS" == *"online"* ]]; then
            print_pass "nexus-robot-vision is running"
        else
            print_fail "nexus-robot-vision status: $VISION_STATUS"
        fi
    else
        print_fail "nexus-robot-vision NOT found in PM2"
        echo "   Run: pm2 restart nexus-robot-vision"
    fi

    echo ""
    echo "Full PM2 status:"
    pm2 list | grep -E "camera|vision" || echo "No camera/vision services"
else
    print_fail "PM2 not installed"
fi

# =============================================================================
# 3. Camera HTTP Stream Check
# =============================================================================
print_section "3️⃣  CAMERA HTTP STREAM CHECK (Port 9092)"

HEALTH_JSON=$(curl -s -m 2 http://127.0.0.1:9092/ 2>/dev/null)
if [ $? -eq 0 ]; then
    print_pass "Camera stream responding on port 9092"
    echo "$HEALTH_JSON" | python3 -m json.tool 2>/dev/null || echo "$HEALTH_JSON"

    # Parse health status
    CAMERA_OK=$(echo "$HEALTH_JSON" | grep -o '"camera":\s*true' || echo "")
    HAS_FRAME=$(echo "$HEALTH_JSON" | grep -o '"has_frame":\s*true' || echo "")

    if [ -n "$CAMERA_OK" ]; then
        print_pass "Camera capture is active"
    else
        print_fail "Camera capture is NOT active"
    fi

    if [ -n "$HAS_FRAME" ]; then
        print_pass "Camera has frames available"
    else
        print_fail "Camera has NO frames"
    fi
else
    print_fail "Cannot connect to camera stream on port 9092"
    echo "   Troubleshooting:"
    echo "   • Check: pm2 logs nexus-robot-camera --lines 20"
    echo "   • Restart: pm2 restart nexus-robot-camera"
fi

# =============================================================================
# 4. Snapshot Capture Test
# =============================================================================
print_section "4️⃣  SNAPSHOT CAPTURE TEST"

SNAPSHOT_FILE="/tmp/apriltag_test_snapshot_$$.jpg"
curl -s -m 5 -o "$SNAPSHOT_FILE" http://127.0.0.1:9092/snapshot 2>/dev/null
if [ -f "$SNAPSHOT_FILE" ]; then
    SIZE=$(stat -c%s "$SNAPSHOT_FILE" 2>/dev/null || stat -f%z "$SNAPSHOT_FILE" 2>/dev/null)
    FILE_TYPE=$(file "$SNAPSHOT_FILE" | grep -o "JPEG" || echo "")

    if [ -n "$FILE_TYPE" ]; then
        if [ "$SIZE" -gt 5000 ]; then
            print_pass "Snapshot captured: ${SIZE} bytes (valid JPEG)"
            echo "   Saved to: $SNAPSHOT_FILE"
        else
            print_warn "Snapshot captured but very small: ${SIZE} bytes"
            echo "   This might indicate a black/corrupted frame"
        fi
    else
        print_fail "Snapshot is not a valid JPEG"
        echo "   File type: $(file "$SNAPSHOT_FILE")"
    fi
else
    print_fail "Failed to capture snapshot"
    echo "   Camera stream might not be running"
fi

# =============================================================================
# 5. Python Dependencies Check
# =============================================================================
print_section "5️⃣  PYTHON DEPENDENCIES CHECK"

# Check dt-apriltags
if python3 -c "from dt_apriltags import Detector" 2>/dev/null; then
    DT_VERSION=$(python3 -c "import dt_apriltags; print(dt_apriltags.__version__ if hasattr(dt_apriltags, '__version__') else 'unknown')" 2>/dev/null)
    print_pass "dt-apriltags installed (version: $DT_VERSION)"
else
    print_fail "dt-apriltags NOT installed"
    echo "   Install: pip install --break-system-packages dt-apriltags"
fi

# Check OpenCV
if python3 -c "import cv2" 2>/dev/null; then
    CV_VERSION=$(python3 -c "import cv2; print(cv2.__version__)" 2>/dev/null)
    print_pass "OpenCV installed (version: $CV_VERSION)"
else
    print_fail "OpenCV NOT installed"
    echo "   Install: sudo apt-get install -y python3-opencv"
fi

# Check NumPy
if python3 -c "import numpy" 2>/dev/null; then
    NP_VERSION=$(python3 -c "import numpy; print(numpy.__version__)" 2>/dev/null)
    print_pass "NumPy installed (version: $NP_VERSION)"
else
    print_fail "NumPy NOT installed"
    echo "   Install: pip install --break-system-packages numpy"
fi

# Check ffmpeg
if command -v ffmpeg &> /dev/null; then
    FFMPEG_VERSION=$(ffmpeg -version 2>/dev/null | head -1)
    print_pass "ffmpeg installed"
    echo "   $FFMPEG_VERSION"
else
    print_fail "ffmpeg NOT installed"
    echo "   Install: sudo apt-get install -y ffmpeg"
fi

# =============================================================================
# 6. AprilTag Detector Test
# =============================================================================
print_section "6️⃣  APRILTAG DETECTOR TEST"

DETECTOR_TEST=$(python3 <<'PY' 2>&1
try:
    from dt_apriltags import Detector
    import numpy as np

    # Create detector
    detector = Detector(
        families="tag36h11",
        nthreads=2,
        quad_decimate=2.0,
        quad_sigma=0.0,
        refine_edges=True,
        decode_sharpening=0.25
    )
    print("DETECTOR_OK")

    # Test with blank image
    blank = np.zeros((480, 640), dtype=np.uint8)
    detections = detector.detect(blank, estimate_tag_pose=False)
    print(f"BLANK_DETECT:{len(detections)}")

except Exception as e:
    print(f"ERROR:{e}")
PY
)

if [[ "$DETECTOR_TEST" == *"DETECTOR_OK"* ]]; then
    print_pass "AprilTag detector created successfully"

    if [[ "$DETECTOR_TEST" == *"BLANK_DETECT:0"* ]]; then
        print_pass "Detector test passed (0 tags on blank image)"
    else
        print_warn "Detector returned unexpected result on blank image"
    fi
else
    print_fail "AprilTag detector test failed"
    echo "$DETECTOR_TEST"
fi

# =============================================================================
# 7. ROS 2 Topics Check
# =============================================================================
print_section "7️⃣  ROS 2 TOPICS CHECK"

if command -v ros2 &> /dev/null; then
    # Source ROS 2
    if [ -f /opt/ros/jazzy/setup.bash ]; then
        source /opt/ros/jazzy/setup.bash
        ROS_WS="$HOME/robot_ws"
        if [ -f "$ROS_WS/install/setup.bash" ]; then
            source "$ROS_WS/install/setup.bash"
        fi
    fi

    # Check /detected_tags topic
    if ros2 topic list 2>/dev/null | grep -q "/detected_tags"; then
        print_pass "/detected_tags topic exists"

        # Try to get one message (timeout 5s)
        echo ""
        echo "Listening for AprilTag messages (5 seconds)..."
        TOPIC_MSG=$(timeout 5 ros2 topic echo /detected_tags --once 2>/dev/null)
        if [ -n "$TOPIC_MSG" ]; then
            print_pass "Received message from /detected_tags"
            echo "$TOPIC_MSG"

            # Check if any tags detected
            if [[ "$TOPIC_MSG" == *'"tags": []'* ]]; then
                print_warn "Message received but NO TAGS detected"
                echo "   This means:"
                echo "   • AprilTag node is working"
                echo "   • Camera is working"
                echo "   • But NO AprilTag is visible in camera view"
                echo ""
                echo "   Solutions:"
                echo "   • Print an AprilTag (tag36h11 family)"
                echo "   • Place it in front of camera (0.5m - 3m distance)"
                echo "   • Ensure good lighting and tag is flat"
            else
                print_pass "AprilTag(s) detected! Check message above for details"
            fi
        else
            print_warn "No messages received in 5 seconds"
            echo "   This could mean:"
            echo "   • Node is starting up (wait longer)"
            echo "   • Node crashed (check logs)"
            echo "   • No AprilTag in camera view"
        fi
    else
        print_fail "/detected_tags topic NOT found"
        echo "   Check: pm2 logs nexus-robot-vision"
    fi
else
    print_fail "ROS 2 not found"
    echo "   Source: /opt/ros/jazzy/setup.bash"
fi

# =============================================================================
# 8. Manual Detection Test (if snapshot exists)
# =============================================================================
if [ -f "$SNAPSHOT_FILE" ] && [ -s "$SNAPSHOT_FILE" ]; then
    print_section "8️⃣  MANUAL DETECTION TEST (on captured snapshot)"

    MANUAL_TEST=$(python3 <<PY 2>&1
try:
    from dt_apriltags import Detector
    import cv2

    # Load snapshot
    img = cv2.imread("$SNAPSHOT_FILE", cv2.IMREAD_GRAYSCALE)
    if img is None:
        print("ERROR:Cannot read image")
        exit(1)

    print(f"IMAGE_OK:{img.shape[1]}x{img.shape[0]}")

    # Create detector
    detector = Detector(
        families="tag36h11",
        nthreads=2,
        quad_decimate=2.0,
        quad_sigma=0.0,
        refine_edges=True,
        decode_sharpening=0.25
    )

    # Detect
    detections = detector.detect(img, estimate_tag_pose=False)
    print(f"DETECTED:{len(detections)}")

    for det in detections:
        print(f"TAG_ID:{det.tag_id}:MARGIN:{det.decision_margin:.2f}:HAMMING:{det.hamming}")

except Exception as e:
    print(f"ERROR:{e}")
PY
)

    if [[ "$MANUAL_TEST" == *"IMAGE_OK"* ]]; then
        IMAGE_SIZE=$(echo "$MANUAL_TEST" | grep -o "IMAGE_OK:[0-9]*x[0-9]*" | cut -d: -f2)
        print_pass "Image loaded successfully ($IMAGE_SIZE)"

        if [[ "$MANUAL_TEST" == *"DETECTED:0"* ]]; then
            print_warn "NO AprilTags detected in snapshot"
            echo ""
            echo "   ┌─────────────────────────────────────────────────────────┐"
            echo "   │  ROOT CAUSE IDENTIFIED: NO APRILTAG IN CAMERA VIEW     │"
            echo "   └─────────────────────────────────────────────────────────┘"
            echo ""
            echo "   Your system is working correctly, but there is no AprilTag"
            echo "   visible to the camera. To fix:"
            echo ""
            echo "   1. Download AprilTag (tag36h11 family):"
            echo "      wget https://github.com/AprilRobotics/apriltag-imgs/raw/master/tag36h11/tag36_11_00000.png"
            echo ""
            echo "   2. Print it on white paper (at least 16cm x 16cm)"
            echo ""
            echo "   3. Place it in front of camera:"
            echo "      • Distance: 0.5m - 3m"
            echo "      • Flat and well-lit"
            echo "      • Perpendicular to camera"
            echo ""
            echo "   4. Check again:"
            echo "      ros2 topic echo /detected_tags"
        elif [[ "$MANUAL_TEST" == *"DETECTED:"* ]]; then
            TAG_COUNT=$(echo "$MANUAL_TEST" | grep -o "DETECTED:[0-9]*" | cut -d: -f2)
            print_pass "AprilTag(s) detected: $TAG_COUNT"
            echo ""
            echo "$MANUAL_TEST" | grep "TAG_ID" | while IFS=: read -r _ id _ margin _ hamming; do
                echo "   • Tag ID: $id, Decision Margin: $margin, Hamming: $hamming"
            done
        fi
    else
        print_fail "Manual detection test failed"
        echo "$MANUAL_TEST"
    fi
fi

# =============================================================================
# Summary
# =============================================================================
print_section "📊 DIAGNOSTIC SUMMARY"

echo ""
echo "Total Checks Passed: $pass_count"
echo "Total Checks Failed: $fail_count"
echo ""

if [ $fail_count -eq 0 ]; then
    print_pass "ALL CHECKS PASSED"
    echo ""
    echo "If you still don't see AprilTag detections, ensure:"
    echo "  • AprilTag is printed (tag36h11 family)"
    echo "  • Tag is visible to camera (0.5m - 3m)"
    echo "  • Good lighting, flat surface"
else
    echo -e "${RED}╔═══════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${RED}║  FIX FAILED CHECKS ABOVE, THEN RUN THIS SCRIPT AGAIN             ║${NC}"
    echo -e "${RED}╚═══════════════════════════════════════════════════════════════════╝${NC}"
fi

echo ""
echo "Detailed logs:"
echo "  pm2 logs nexus-robot-camera --lines 50"
echo "  pm2 logs nexus-robot-vision --lines 50"
echo ""
echo "Quick fixes:"
echo "  # Restart nodes"
echo "  pm2 restart nexus-robot-camera && sleep 3 && pm2 restart nexus-robot-vision"
echo ""
echo "  # Fix camera permissions"
echo "  sudo chmod 666 /dev/video0"
echo ""
echo "  # Reinstall dependencies"
echo "  pip install --break-system-packages --force-reinstall dt-apriltags"
echo ""
echo "Full guide: services/robot/APRILTAG_TROUBLESHOOTING.md"
echo ""
