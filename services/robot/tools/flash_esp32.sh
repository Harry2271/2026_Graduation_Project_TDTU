#!/usr/bin/env bash
# flash_esp32.sh — flash firmware.bin lên ESP32-S3 qua /dev/ttyACM0
# Run trên Pi 5
#
# Usage:
#   1. Copy firmware.bin vào /tmp/firmware.bin trên Pi 5
#   2. Rút ESP32 ra cắm lại (nếu cần)
#   3. bash flash_esp32.sh [path/to/firmware.bin]
#
# Mặc định: /tmp/firmware.bin

set -euo pipefail

FIRMWARE="${1:-/tmp/firmware.bin}"

if [ ! -f "$FIRMWARE" ]; then
    echo "ERROR: Firmware file not found: $FIRMWARE"
    echo "Usage: $0 [path/to/firmware.bin]"
    exit 1
fi

PORT="/dev/ttyACM0"
BAUD=460800

echo "========================================"
echo "  Flash ESP32-S3"
echo "  Firmware: $FIRMWARE"
echo "  Port: $PORT"
echo "  Baud: $BAUD"
echo "========================================"

# Kill any process holding port
pkill -9 -f rplidar 2>/dev/null || true
pkill -9 -f esp32_telemetry 2>/dev/null || true
pm2 stop nexus-robot-esp32-telemetry 2>/dev/null || true
sleep 2

# Verify port
if [ ! -e "$PORT" ]; then
    echo "ERROR: $PORT not found. Check ESP32 USB connection."
    ls -l /dev/ttyACM* /dev/ttyUSB* 2>/dev/null
    exit 1
fi

# Install esptool if needed
if ! python3 -c "import esptool" 2>/dev/null; then
    echo "Installing esptool..."
    pip3 install esptool --break-system-packages --quiet
fi

# Flash
echo ""
echo "Flashing..."
python3 -m esptool \
    --chip esp32s3 \
    --port "$PORT" \
    --baud "$BAUD" \
    write_flash 0x0 "$FIRMWARE"

echo ""
echo "========================================"
echo "  FLASH COMPLETE"
echo "========================================"
echo ""
echo "Sau khi flash:"
echo "  1. Nhấn RESET trên ESP32"
echo "  2. Rút USB cắm lại Pi"
echo "  3. Monitor:"
echo "     picocom -b 115200 /dev/robot-esp32"
echo "     hoặc: pm2 start nexus-robot-esp32-telemetry"