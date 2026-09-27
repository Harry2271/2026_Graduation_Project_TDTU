#!/bin/bash
# =============================================================================
# setup-ai-features.sh — MỘT FILE cài toàn bộ tính năng AI trên Raspberry Pi 5
#
# Chạy sau khi mở Pi lên (đứng ở services/robot):
#     cd ~/2026_Graduation_Project_TDTU/services/robot   # (hoặc đường dẫn repo của bạn)
#     ./setup-ai-features.sh
#
# Mặc định: cài YOLOv8n + Motor-health + Voice control, rồi rebuild workspace.
# An toàn để chạy lại nhiều lần (idempotent). Lỗi 1 phần KHÔNG chặn phần khác.
#
# Tùy chọn:
#     ./setup-ai-features.sh --no-voice      # bỏ qua voice (nếu chưa có micro)
#     ./setup-ai-features.sh --yolo          # chỉ cài YOLO
#     ./setup-ai-features.sh --deploy        # cài xong chạy luôn deploy.sh (khởi động cả robot)
#     ./setup-ai-features.sh --help
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROS_WS="${ROS_WS:-$HOME/robot_ws}"
MODEL_DIR="${YOLO_MODEL_DIR:-$HOME/robot_ws/models}"
WHISPER_MODEL="${WHISPER_MODEL:-$HOME/whisper.cpp/models/ggml-small.bin}"

DO_YOLO=1; DO_MOTOR=1; DO_VOICE=1; DO_DEPLOY=0; EXPLICIT=0

usage() { awk 'NR>=2{ if($0 ~ /^#/){ sub(/^# ?/,""); print } else exit }' "$0"; exit 0; }

# ── Parse flags ────────────────────────────────────────────────────────
for arg in "$@"; do
    case "$arg" in
        --help|-h) usage ;;
        --yolo)          [ "$EXPLICIT" = 0 ] && { DO_YOLO=0; DO_MOTOR=0; DO_VOICE=0; EXPLICIT=1; }; DO_YOLO=1 ;;
        --motor-health)  [ "$EXPLICIT" = 0 ] && { DO_YOLO=0; DO_MOTOR=0; DO_VOICE=0; EXPLICIT=1; }; DO_MOTOR=1 ;;
        --voice)         [ "$EXPLICIT" = 0 ] && { DO_YOLO=0; DO_MOTOR=0; DO_VOICE=0; EXPLICIT=1; }; DO_VOICE=1 ;;
        --no-yolo)          DO_YOLO=0 ;;
        --no-motor-health)  DO_MOTOR=0 ;;
        --no-voice)         DO_VOICE=0 ;;
        --deploy)           DO_DEPLOY=1 ;;
        --no-deploy)        DO_DEPLOY=0 ;;
        *) echo "Không hiểu tùy chọn: $arg (dùng --help)"; exit 2 ;;
    esac
done

RESULTS=()
run_step() {  # run_step "Tên" "lệnh installer"
    local label="$1"; shift
    echo ""
    echo "══════════════════════════════════════════════════════════════"
    echo "▶ $label"
    echo "══════════════════════════════════════════════════════════════"
    if "$@"; then RESULTS+=("✅ $label"); else RESULTS+=("❌ $label (xem log ở trên)"); fi
}
# __APPEND_MARKER__
echo "=== 🤖 CÀI ĐẶT TÍNH NĂNG AI — Robot for Nguyen ==="
echo "  Repo:        $SCRIPT_DIR"
echo "  ROS ws:      $ROS_WS"
echo "  YOLO:        $([ $DO_YOLO = 1 ] && echo BẬT || echo bỏ qua)"
echo "  Motor-health:$([ $DO_MOTOR = 1 ] && echo ' BẬT' || echo ' bỏ qua')"
echo "  Voice:       $([ $DO_VOICE = 1 ] && echo BẬT || echo bỏ qua)"

# ── Kiểm tra môi trường (cảnh báo, không chặn) ─────────────────────────
if ! command -v apt-get >/dev/null 2>&1; then
    echo "⚠️  Không thấy apt-get — script này dành cho Pi 5 (Ubuntu). Vẫn tiếp tục."
fi
if [ ! -f /opt/ros/jazzy/setup.bash ]; then
    echo "⚠️  Không thấy /opt/ros/jazzy — ROS 2 Jazzy chưa được cài? Vẫn tiếp tục."
fi

# ── Chạy từng installer (tiếp tục kể cả khi 1 cái lỗi) ─────────────────
[ $DO_YOLO  = 1 ] && run_step "YOLOv8n (nhận diện vật thể)"       bash "$SCRIPT_DIR/install-ai-deps.sh"
[ $DO_MOTOR = 1 ] && run_step "Motor-health (giám sát động cơ)"   bash "$SCRIPT_DIR/install-motor-health.sh"
[ $DO_VOICE = 1 ] && run_step "Voice control (giọng nói Tiếng Việt)" bash "$SCRIPT_DIR/install-voice-control.sh"

# ── Rebuild colcon để đăng ký các node mới (entry points) ──────────────
if command -v colcon >/dev/null 2>&1 && [ -f /opt/ros/jazzy/setup.bash ]; then
    echo ""
    echo "══════════════════════════════════════════════════════════════"
    echo "▶ Rebuild workspace (đăng ký vision_node / motor_health_node / voice_control_node)"
    echo "══════════════════════════════════════════════════════════════"
    source /opt/ros/jazzy/setup.bash
    mkdir -p "$ROS_WS/src"
    rm -rf "$ROS_WS/src/my_robot_controller"
    cp -r "$SCRIPT_DIR/src/my_robot_controller" "$ROS_WS/src/"
    if ( cd "$ROS_WS" && colcon build --merge-install --packages-select my_robot_controller ); then
        RESULTS+=("✅ colcon build (my_robot_controller)")
    else
        RESULTS+=("❌ colcon build — chạy lại ./deploy.sh để build đầy đủ")
    fi
else
    echo "⚠️  Bỏ qua colcon build (thiếu colcon/ROS). Chạy ./deploy.sh trên Pi để build."
fi

# ── (Tùy chọn) chạy deploy.sh để khởi động cả stack ────────────────────
if [ $DO_DEPLOY = 1 ]; then
    export ENABLE_YOLO=$DO_YOLO ENABLE_MOTOR_HEALTH=$DO_MOTOR ENABLE_VOICE=$DO_VOICE
    export YOLO_MODEL="$MODEL_DIR/yolov8n.pt" WHISPER_MODEL="$WHISPER_MODEL"
    run_step "deploy.sh (khởi động toàn bộ node qua PM2)" bash "$SCRIPT_DIR/deploy.sh"
fi

# ── Tổng kết ───────────────────────────────────────────────────────────
echo ""
echo "════════════════════ KẾT QUẢ ════════════════════"
for r in "${RESULTS[@]}"; do echo "  $r"; done
echo "══════════════════════════════════════════════════"
echo ""
if [ $DO_DEPLOY = 0 ]; then
    echo "Bước tiếp theo — khởi động các node AI:"
    echo "  export ENABLE_YOLO=$DO_YOLO ENABLE_MOTOR_HEALTH=$DO_MOTOR ENABLE_VOICE=$DO_VOICE"
    echo "  ENABLE_VOICE=$DO_VOICE WHISPER_MODEL=$WHISPER_MODEL YOLO_MODEL=$MODEL_DIR/yolov8n.pt ./deploy.sh"
    echo ""
fi
echo "Kiểm tra sức khỏe hệ thống:"
echo "  ../../scripts/health-check.sh    # (hoặc: \$(git rev-parse --show-toplevel)/scripts/health-check.sh)"
echo "Xem dữ liệu AI:"
echo "  ros2 topic echo /detected_objects       # YOLO"
echo "  ros2 topic echo /motor_health_alerts    # động cơ"
echo "  ros2 topic echo /voice_commands         # giọng nói"
echo ""
echo "📖 Chi tiết: docs/AI_ENHANCEMENTS_ROADMAP.md"
