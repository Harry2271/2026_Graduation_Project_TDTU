#!/bin/bash
# =============================================================================
# install-ai-deps.sh — YOLOv8n object detection deps for the Pi 5
#
# Installs Ultralytics (YOLOv8), OpenCV, and NumPy, then pre-downloads the
# yolov8n.pt weights so vision_node can run offline.  Safe to re-run.
#
#   cd services/robot && ./install-ai-deps.sh
#
# vision_node degrades to an idle process if these are missing, so the robot
# still runs without this step — this only unlocks the YOLO detector.
# =============================================================================

set -e

PY="${PYTHON:-python3}"
MODEL_DIR="${YOLO_MODEL_DIR:-$HOME/robot_ws/models}"
MODEL_PATH="$MODEL_DIR/yolov8n.pt"

echo "=== [1/3] System packages (OpenCV runtime, pip) ==="
if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y python3-pip libgl1 libglib2.0-0 ffmpeg
fi

echo "=== [2/3] Python packages (ultralytics + torch CPU) ==="
# --break-system-packages: Ubuntu 24.04 marks the system Python as externally
# managed; the robot uses the system interpreter for ROS 2, matching deploy.sh.
$PY -m pip install --break-system-packages --upgrade \
    "numpy" \
    "opencv-python-headless" \
    "ultralytics"

echo "=== [3/3] Pre-download yolov8n weights ==="
mkdir -p "$MODEL_DIR"
if [ -f "$MODEL_PATH" ]; then
    echo "  Already present: $MODEL_PATH"
else
    # YOLO() auto-downloads yolov8n.pt into the CWD on first use; do it here
    # into a stable location so PM2 doesn't re-download on every restart.
    ( cd "$MODEL_DIR" && $PY - <<'PY'
from ultralytics import YOLO
YOLO("yolov8n.pt")   # triggers the download into CWD
print("yolov8n.pt ready")
PY
    )
fi

echo ""
echo "✅ YOLOv8 deps installed."
echo "   Model: $MODEL_PATH"
echo "   Quick test:"
echo "     python3 -c \"from ultralytics import YOLO; YOLO('$MODEL_PATH')('https://ultralytics.com/images/bus.jpg')\""
echo "   Enable in deploy.sh:  ENABLE_YOLO=1 YOLO_MODEL=$MODEL_PATH ./deploy.sh"
echo "   Live topic:           ros2 topic echo /detected_objects"
