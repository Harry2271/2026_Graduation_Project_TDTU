#!/bin/bash
# =============================================================================
# debug_apriltag_pi.sh — Deep Debug for AprilTag on Pi 5
# =============================================================================
# So sánh environment Pi 5 vs Laptop để tìm điểm khác biệt

echo "╔═══════════════════════════════════════════════════════════════════╗"
echo "║     APRILTAG DEEP DEBUG — RASPBERRY PI 5 ENVIRONMENT             ║"
echo "╚═══════════════════════════════════════════════════════════════════╝"
echo ""

# =============================================================================
# 1. Capture logs từ PM2
# =============================================================================
echo "━━━ 1. PM2 CAMERA NODE LOGS (last 100 lines) ━━━"
pm2 logs nexus-robot-camera --lines 100 --nostream 2>&1 | tail -50
echo ""

echo "━━━ 2. PM2 VISION NODE LOGS (last 100 lines) ━━━"
pm2 logs nexus-robot-vision --lines 100 --nostream 2>&1 | tail -50
echo ""

# =============================================================================
# 2. Test camera snapshot quality
# =============================================================================
echo "━━━ 3. CAMERA SNAPSHOT TEST ━━━"
SNAPSHOT_FILE="/tmp/pi_apriltag_debug_$$.jpg"
curl -s -m 5 -o "$SNAPSHOT_FILE" http://127.0.0.1:9092/snapshot 2>&1

if [ -f "$SNAPSHOT_FILE" ]; then
    SIZE=$(stat -c%s "$SNAPSHOT_FILE" 2>/dev/null)
    echo "✅ Snapshot captured: ${SIZE} bytes"
    echo "   Location: $SNAPSHOT_FILE"

    # Get image info using ffprobe if available
    if command -v ffprobe &> /dev/null; then
        echo ""
        echo "Image details:"
        ffprobe -v error -select_streams v:0 -show_entries stream=width,height,pix_fmt -of default=noprint_wrappers=1 "$SNAPSHOT_FILE" 2>&1
    fi

    # Try to detect tags on this snapshot
    echo ""
    echo "━━━ 4. MANUAL DETECTION TEST ON SNAPSHOT ━━━"
    python3 <<PY
import sys
try:
    from dt_apriltags import Detector
    import cv2
    import numpy as np

    # Load image
    img_path = "$SNAPSHOT_FILE"
    print(f"Loading image: {img_path}")

    # Try color load first
    img_color = cv2.imread(img_path)
    if img_color is None:
        print("❌ ERROR: Cannot read image file")
        sys.exit(1)

    print(f"✅ Image loaded (color): {img_color.shape}")

    # Convert to grayscale
    img_gray = cv2.cvtColor(img_color, cv2.COLOR_BGR2GRAY)
    print(f"✅ Converted to grayscale: {img_gray.shape}")

    # Check image statistics
    print(f"   Pixel value range: min={img_gray.min()}, max={img_gray.max()}, mean={img_gray.mean():.1f}")

    # Check if image is too dark or too bright
    if img_gray.mean() < 20:
        print("⚠️  WARNING: Image is very dark (mean brightness < 20)")
    elif img_gray.mean() > 235:
        print("⚠️  WARNING: Image is very bright (mean brightness > 235)")
    else:
        print(f"✅ Image brightness OK (mean={img_gray.mean():.1f})")

    # Create detector with VERBOSE settings
    print("")
    print("Creating AprilTag detector...")
    detector = Detector(
        families="tag36h11",
        nthreads=2,
        quad_decimate=2.0,
        quad_sigma=0.0,
        refine_edges=True,
        decode_sharpening=0.25
    )
    print("✅ Detector created")

    # Try detection
    print("")
    print("Running detection...")
    detections = detector.detect(img_gray, estimate_tag_pose=False)

    print(f"")
    print(f"{'='*70}")
    print(f"DETECTION RESULT: {len(detections)} tag(s) found")
    print(f"{'='*70}")

    if len(detections) == 0:
        print("")
        print("❌ NO APRILTAG DETECTED")
        print("")
        print("Possible reasons:")
        print("  1. AprilTag not visible or too small in frame")
        print("  2. Image is blurry/out of focus")
        print("  3. Poor lighting conditions")
        print("  4. AprilTag is not tag36h11 family")
        print("")
        print(f"Please examine the snapshot manually:")
        print(f"  scp pi@raspberry-pi-ip:$SNAPSHOT_FILE ./pi_snapshot.jpg")
        print(f"  Then open pi_snapshot.jpg on your laptop to verify AprilTag is visible")
    else:
        print("")
        for i, det in enumerate(detections):
            print(f"Tag #{i+1}:")
            print(f"  ID: {det.tag_id}")
            print(f"  Family: {det.tag_family.decode() if hasattr(det.tag_family, 'decode') else det.tag_family}")
            print(f"  Decision margin: {det.decision_margin:.2f}")
            print(f"  Hamming distance: {det.hamming}")
            print(f"  Center: ({det.center[0]:.1f}, {det.center[1]:.1f})")
            print(f"  Corners: {det.corners}")
            print("")

except ImportError as e:
    print(f"❌ IMPORT ERROR: {e}")
    print("")
    print("Missing dependencies. Install with:")
    print("  pip install --break-system-packages dt-apriltags opencv-python-headless numpy")
except Exception as e:
    print(f"❌ ERROR: {e}")
    import traceback
    traceback.print_exc()
PY

else
    echo "❌ Failed to capture snapshot from http://127.0.0.1:9092/snapshot"
    echo ""
    echo "This means camera_stream node is not working. Check:"
    echo "  pm2 logs nexus-robot-camera"
fi

# =============================================================================
# 5. Check Python environment
# =============================================================================
echo ""
echo "━━━ 5. PYTHON ENVIRONMENT CHECK ━━━"

echo "Python version:"
python3 --version

echo ""
echo "dt-apriltags info:"
python3 -c "import dt_apriltags; print(f'Version: {getattr(dt_apriltags, \"__version__\", \"unknown\")}'); print(f'Location: {dt_apriltags.__file__}')" 2>&1

echo ""
echo "OpenCV info:"
python3 -c "import cv2; print(f'Version: {cv2.__version__}'); print(f'Location: {cv2.__file__}'); print(f'Build info: {cv2.getBuildInformation()}' if hasattr(cv2, 'getBuildInformation') else 'N/A')" 2>&1 | head -20

echo ""
echo "NumPy info:"
python3 -c "import numpy; print(f'Version: {numpy.__version__}'); print(f'Location: {numpy.__file__}')" 2>&1

# =============================================================================
# 6. Check ROS 2 node status
# =============================================================================
echo ""
echo "━━━ 6. ROS 2 NODE STATUS ━━━"

# Source ROS 2
if [ -f /opt/ros/jazzy/setup.bash ]; then
    source /opt/ros/jazzy/setup.bash
    ROS_WS="$HOME/robot_ws"
    if [ -f "$ROS_WS/install/setup.bash" ]; then
        source "$ROS_WS/install/setup.bash"
    fi
fi

echo "ROS 2 nodes running:"
ros2 node list 2>&1 | grep -E "april|camera|vision" || echo "No relevant nodes found"

echo ""
echo "ROS 2 topics:"
ros2 topic list 2>&1 | grep -E "detected_tags|camera" || echo "No relevant topics found"

echo ""
echo "Topic info for /detected_tags:"
ros2 topic info /detected_tags 2>&1

echo ""
echo "Listening to /detected_tags for 3 seconds..."
timeout 3 ros2 topic echo /detected_tags 2>&1 || echo "(no messages received)"

# =============================================================================
# 7. Check camera stream health endpoint
# =============================================================================
echo ""
echo "━━━ 7. CAMERA STREAM HEALTH CHECK ━━━"
curl -s http://127.0.0.1:9092/ | python3 -m json.tool 2>&1

# =============================================================================
# 8. Environment variables
# =============================================================================
echo ""
echo "━━━ 8. ENVIRONMENT VARIABLES ━━━"
echo "CAMERA_DEVICE: ${CAMERA_DEVICE:-<not set, default /dev/video0>}"
echo "CAMERA_WIDTH: ${CAMERA_WIDTH:-<not set, default 1280>}"
echo "CAMERA_HEIGHT: ${CAMERA_HEIGHT:-<not set, default 720>}"
echo "CAMERA_FPS: ${CAMERA_FPS:-<not set, default 30>}"
echo "CAMERA_PORT: ${CAMERA_PORT:-<not set, default 9092>}"
echo "APRILTAG_FAMILY: ${APRILTAG_FAMILY:-<not set, default tag36h11>}"
echo "APRILTAG_SIZE_M: ${APRILTAG_SIZE_M:-<not set, default 0.166>}"
echo "APRILTAG_HZ: ${APRILTAG_HZ:-<not set, default 10>}"
echo "APRILTAG_MAX_HAMMING: ${APRILTAG_MAX_HAMMING:-<not set, default 1>}"
echo "APRILTAG_DEBUG: ${APRILTAG_DEBUG:-<not set, default 0>}"
echo "CAMERA_SNAPSHOT_URL: ${CAMERA_SNAPSHOT_URL:-<not set, default http://127.0.0.1:9092/snapshot>}"

# =============================================================================
# 9. System info
# =============================================================================
echo ""
echo "━━━ 9. SYSTEM INFO ━━━"
echo "OS: $(cat /etc/os-release | grep PRETTY_NAME | cut -d= -f2)"
echo "Kernel: $(uname -r)"
echo "Architecture: $(uname -m)"
echo "Python: $(python3 --version)"
echo "ROS 2: $(ros2 --version 2>&1 || echo 'Not found')"

# =============================================================================
# Summary
# =============================================================================
echo ""
echo "╔═══════════════════════════════════════════════════════════════════╗"
echo "║                     DEBUG COMPLETE                                ║"
echo "╚═══════════════════════════════════════════════════════════════════╝"
echo ""
echo "IMPORTANT: If 'DETECTION RESULT: 0 tag(s) found' above,"
echo "please copy the snapshot to your laptop and verify:"
echo ""
echo "  scp pi@<pi-ip>:$SNAPSHOT_FILE ./pi_snapshot_debug.jpg"
echo ""
echo "Then compare it with the snapshot from your laptop that WORKS."
echo "Check if the Pi snapshot is:"
echo "  • Blurry / out of focus"
echo "  • Too dark / too bright"
echo "  • Lower resolution"
echo "  • Different field of view"
echo ""
