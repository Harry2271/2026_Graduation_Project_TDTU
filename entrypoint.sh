#!/bin/bash
set -e

LIDAR_MODEL=${LIDAR_MODEL:-a1}
LIDAR_PORT=${LIDAR_PORT:-/dev/ttyUSB0}
ESP32_PORT=${ESP32_PORT:-/dev/ttyUSB1}
CAMERA_DEVICE=${CAMERA_DEVICE:-0}

echo "--- Starting robot-core ---"
echo "  Lidar model  : $LIDAR_MODEL"
echo "  Lidar port   : $LIDAR_PORT"
echo "  ESP32 port   : $ESP32_PORT"
echo "  Camera device: /dev/video$CAMERA_DEVICE"

source /opt/ros/jazzy/setup.bash
source /app/install/setup.bash

# --- Hot-plug monitoring for Lidar ---
start_lidar_monitor() {
    while true; do
        if [ -e "$LIDAR_PORT" ]; then
            chmod 666 "$LIDAR_PORT" 2>/dev/null
            echo "[lidar-monitor] Lidar detected at $LIDAR_PORT"
            # Start the lidar launch in background; when device disappears,
            # the driver will stop and this subshell exits. Then we loop
            # to wait for it again.
            (
                # Give udev a moment to settle permissions
                sleep 0.5
                ros2 launch my_robot_controller lidar_only_launch.py \
                    lidar_model:="$LIDAR_MODEL" \
                    serial_port:="$LIDAR_PORT" \
                    2>&1
                echo "[lidar-monitor] Lidar driver stopped — waiting for reconnect"
            ) &
            LIDAR_PID=$!
            # Wait for the lidar driver to exit (device unplugged or crashed)
            while kill -0 $LIDAR_PID 2>/dev/null; do
                sleep 1
                # Check if device still exists
                if [ ! -e "$LIDAR_PORT" ]; then
                    echo "[lidar-monitor] Lidar disconnected — stopping driver"
                    kill $LIDAR_PID 2>/dev/null
                    break
                fi
            done
            wait $LIDAR_PID 2>/dev/null
            echo "[lidar-monitor] Waiting for lidar to reconnect..."
            sleep 2
        else
            echo "[lidar-monitor] Lidar not found at $LIDAR_PORT — waiting..."
            sleep 3
        fi
    done
}

# --- Set permissions on ESP32 if present ---
if [ -e "$ESP32_PORT" ]; then
    chmod 666 "$ESP32_PORT"
    echo "[esp32-monitor] ESP32 detected at $ESP32_PORT"
else
    echo "[esp32-monitor] ESP32 not detected at $ESP32_PORT — will retry on startup"
fi

# --- Start non-device-dependent nodes ---
echo "--- Launching SLAM + Brain + QR + WebBridge (lidar starts when detected) ---"
ros2 launch my_robot_controller core_launch.py \
    esp32_port:="$ESP32_PORT" \
    camera_device:="$CAMERA_DEVICE" &

CORE_PID=$!

# --- Start lidar hot-plug monitor in background ---
start_lidar_monitor &

# --- Wait for core launch (or container stop) ---
wait $CORE_PID
