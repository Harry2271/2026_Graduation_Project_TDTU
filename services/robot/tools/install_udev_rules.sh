#!/usr/bin/env bash
# install_udev_rules.sh — cài udev rules cố định tên port cho robot.
#
# Sau khi chạy:
#   /dev/robot-esp32  luôn trỏ tới ESP32-S3 USB CDC
#   /dev/robot-lidar  luôn trỏ tới RPLidar adapter
#   /dev/robot-camera luôn trỏ tới camera Logitech
#
# Symlinks persist qua reboot + qua việc cắm lại USB.

set -euo pipefail

RULES_SRC="$(dirname "$0")/../config/udev/99-robot-ports.rules"
RULES_DST="/etc/udev/rules.d/99-robot-ports.rules"

if [[ ! -f "$RULES_SRC" ]]; then
    echo "Không tìm thấy $RULES_SRC"
    exit 1
fi

echo ">> Sao chép rules vào $RULES_DST"
sudo cp "$RULES_SRC" "$RULES_DST"
sudo chmod 644 "$RULES_DST"

echo ">> Reload udev"
sudo udevadm control --reload-rules
sudo udevadm trigger

echo ""
echo ">> Rules đã cài. Cắm lại ESP32 và LiDAR để test."
echo ""
echo "Sau khi cắm, kiểm tra:"
echo "   ls -l /dev/robot-*"
echo ""
echo "Sẽ thấy một dòng kiểu:"
echo "   lrwxrwxrwx ... /dev/robot-esp32 -> /dev/ttyACM0"
echo "   lrwxrwxrwx ... /dev/robot-lidar -> /dev/ttyUSB0"

echo ""
echo ">> Tip: nếu symlink không xuất hiện, kiểm tra VID:PID thiết bị:"
echo "   udevadm info -a -n /dev/ttyACM0 | grep -E 'idVendor|idProduct'"
echo ""
echo "   Nếu VID:PID khác với rule (vd WCH CH9102 1A86:7523 vs CH340 1A86:7523),"
echo "   sửa rule và chạy lại script."