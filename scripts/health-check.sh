#!/bin/bash
# =============================================================================
# health-check.sh — one-shot robot health report (run on the Pi 5)
#
#   ./scripts/health-check.sh
#
# Read-only. Prints PASS/WARN/FAIL for hardware, PM2 services, ROS 2 topics,
# TF, and network ports. Never mutates state — safe to run any time.
# =============================================================================

PASS=0; WARN=0; FAIL=0
ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
warn() { echo "  ⚠️  $1"; WARN=$((WARN+1)); }
bad()  { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

# Source ROS so ros2 CLI works even from a bare shell.
[ -f /opt/ros/jazzy/setup.bash ] && source /opt/ros/jazzy/setup.bash 2>/dev/null
[ -f "$HOME/robot_ws/install/setup.bash" ] && source "$HOME/robot_ws/install/setup.bash" 2>/dev/null

echo "=== 1. Hardware devices ==="
for dev in /dev/ttyUSB0 /dev/ttyACM0 /dev/robot-esp32 /dev/video0; do
    if [ -e "$dev" ]; then ok "$dev present"; else warn "$dev not found"; fi
done

echo "=== 2. PM2 services ==="
if command -v pm2 >/dev/null 2>&1; then
    pm2 jlist 2>/dev/null | python3 - <<'PY' 2>/dev/null || warn "could not parse pm2 jlist"
import json, sys
try:
    procs = json.load(sys.stdin)
except Exception:
    sys.exit(1)
for p in procs:
    name = p.get("name")
    st = p.get("pm2_env", {}).get("status")
    restarts = p.get("pm2_env", {}).get("restart_time", 0)
    mark = "✅" if st == "online" else "❌"
    flag = f" (restarts={restarts})" if restarts and restarts > 5 else ""
    print(f"  {mark} {name}: {st}{flag}")
PY
else
    bad "pm2 not installed"
fi

echo "=== 3. ROS 2 topics ==="
if command -v ros2 >/dev/null 2>&1; then
    TOPICS="$(ros2 topic list 2>/dev/null)"
    for t in /scan /odom /esp32/status /esp32/encoder /cmd_vel; do
        if echo "$TOPICS" | grep -qx "$t"; then ok "topic $t"; else warn "topic $t missing"; fi
    done
    # AI topics are optional — report as info only.
    for t in /detected_objects /motor_health_alerts /voice_commands; do
        if echo "$TOPICS" | grep -qx "$t"; then ok "AI topic $t"; else echo "  ·  AI topic $t not active (optional)"; fi
    done
else
    bad "ros2 CLI not available"
fi

echo "=== 4. TF tree (map → odom → base_footprint) ==="
if command -v ros2 >/dev/null 2>&1; then
    if timeout 5 ros2 run tf2_ros tf2_echo odom base_footprint >/dev/null 2>&1; then
        ok "odom → base_footprint TF flowing"
    else
        warn "odom → base_footprint TF not available (odom node up?)"
    fi
fi

echo "=== 5. Network ports ==="
for port in 9091 9092 5000 3000; do
    if (exec 3<>/dev/tcp/127.0.0.1/$port) 2>/dev/null; then ok "port $port open"; exec 3>&- 2>/dev/null; else warn "port $port closed"; fi
done

echo ""
echo "=== SUMMARY:  $PASS pass / $WARN warn / $FAIL fail ==="
[ "$FAIL" -eq 0 ]
