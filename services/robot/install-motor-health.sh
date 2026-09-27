#!/bin/bash
# =============================================================================
# install-motor-health.sh — TensorFlow Lite runtime for motor_health_node
#
# The rule-based detector in motor_health_node needs NO extra deps.  This
# script only adds the TFLite runtime so the (optional) LSTM autoencoder can
# run.  Safe to re-run.
#
#   cd services/robot && ./install-motor-health.sh
#
# After training a model (see docs/MOTOR_HEALTH_TRAINING.md), point the node at
# it:  ENABLE_MOTOR_HEALTH=1 MOTOR_HEALTH_MODEL=~/robot_ws/models/motor_ae.tflite
# =============================================================================

set -e

PY="${PYTHON:-python3}"

echo "=== [1/2] pip + numpy ==="
if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y python3-pip
fi
$PY -m pip install --break-system-packages --upgrade numpy

echo "=== [2/2] TFLite runtime ==="
# tflite-runtime is the lightweight inference-only package (no full TF).
# Fall back to full tensorflow if the runtime wheel is unavailable for this
# platform/Python version.
if $PY -m pip install --break-system-packages --upgrade tflite-runtime; then
    echo "  Installed tflite-runtime"
else
    echo "  tflite-runtime wheel unavailable — installing full tensorflow (CPU)"
    $PY -m pip install --break-system-packages --upgrade tensorflow
fi

echo ""
echo "✅ Motor-health inference deps installed."
echo "   Collect a healthy baseline:"
echo "     ros2 run my_robot_controller motor_health_node --ros-args -p collection_mode:=true"
echo "   Train offline, then run with the model:"
echo "     ros2 run my_robot_controller motor_health_node --ros-args -p model_path:=~/robot_ws/models/motor_ae.tflite"
echo "   Alerts topic:  ros2 topic echo /motor_health_alerts"
