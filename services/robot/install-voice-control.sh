#!/bin/bash
# =============================================================================
# install-voice-control.sh — offline Vietnamese voice control (whisper.cpp)
#
# Builds whisper.cpp, installs the CLI to /usr/local/bin/whisper-cli, downloads
# a multilingual ggml model (supports Vietnamese), and installs alsa-utils for
# microphone capture.  Safe to re-run.
#
#   cd services/robot && ./install-voice-control.sh          # small model
#   WHISPER_MODEL_SIZE=base ./install-voice-control.sh        # smaller/faster
#
# voice_control_node idles gracefully until this is installed.
# =============================================================================

set -e

WHISPER_DIR="${WHISPER_DIR:-$HOME/whisper.cpp}"
MODEL_SIZE="${WHISPER_MODEL_SIZE:-small}"   # base|small|medium (small = good VI/CPU balance)

echo "=== [1/4] System packages (build tools, ALSA, git) ==="
if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y git build-essential cmake alsa-utils
fi

echo "=== [2/4] Clone / update whisper.cpp ==="
if [ -d "$WHISPER_DIR/.git" ]; then
    git -C "$WHISPER_DIR" pull --ff-only || echo "  pull failed — using existing checkout"
else
    git clone --depth 1 https://github.com/ggerganov/whisper.cpp.git "$WHISPER_DIR"
fi

echo "=== [3/4] Build whisper.cpp (Release) ==="
cmake -S "$WHISPER_DIR" -B "$WHISPER_DIR/build" -DCMAKE_BUILD_TYPE=Release
cmake --build "$WHISPER_DIR/build" -j --config Release
# Locate the CLI (recent whisper.cpp: whisper-cli; older: main) and install it.
CLI_BIN="$(find "$WHISPER_DIR/build" -type f -name 'whisper-cli' -o -type f -name 'main' 2>/dev/null | head -n1)"
if [ -n "$CLI_BIN" ]; then
    sudo install -m 0755 "$CLI_BIN" /usr/local/bin/whisper-cli
    echo "  Installed $(basename "$CLI_BIN") → /usr/local/bin/whisper-cli"
else
    echo "  ⚠️  Could not find built whisper CLI — check the build output above."
fi

echo "=== [4/4] Download ggml model: $MODEL_SIZE ==="
bash "$WHISPER_DIR/models/download-ggml-model.sh" "$MODEL_SIZE"
MODEL_PATH="$WHISPER_DIR/models/ggml-$MODEL_SIZE.bin"

echo ""
echo "✅ Voice control installed."
echo "   Model:  $MODEL_PATH"
echo "   List mics:  arecord -l"
echo "   Enable in deploy.sh:"
echo "     ENABLE_VOICE=1 WHISPER_MODEL=$MODEL_PATH ./deploy.sh"
echo "   Or run directly:"
echo "     ros2 run my_robot_controller voice_control_node --ros-args \\"
echo "       -p model_path:=$MODEL_PATH -p language:=vi -p mic_device:=default"
echo "   Watch recognised commands:  ros2 topic echo /voice_commands"
