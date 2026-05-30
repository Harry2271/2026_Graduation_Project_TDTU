# ESP32-S3 Mecanum Controller — Modular Firmware

## Module Architecture

The firmware is organized into independent modules under `src/modules/` and `include/modules/`.

### Hardware Layer (drivers/)

| Module | File | Responsibility |
|--------|------|---------------|
| BTS7960Driver | `modules/BTS7960Driver.{h,cpp}` | PWM generation, motor enable/disable, brake/coast, E-stop |
| Encoder | `modules/Encoder.{h,cpp}` | PCNT hardware counter, RPM calculation, x2 decoding |
| PIDController | `modules/PIDController.{h,cpp}` | PID speed control loop with anti-windup |

### Kinematics Layer

| Module | File | Responsibility |
|--------|------|---------------|
| MecanumDrive | `modules/MecanumDrive.{h,cpp}` | Inverse kinematics, wheel normalization, acceleration ramp |

### System Layer

| Module | File | Responsibility |
|--------|------|---------------|
| Watchdog | `modules/Watchdog.{h,cpp}` | Heartbeat tracking, mode transitions (SAFE/NAV/MANUAL) |
| ObstacleAvoidance | `modules/ObstacleAvoidance.{h,cpp}` | LiDAR dodge logic, obstacle event processing |
| WebServer | `modules/WebServer.{h,cpp}` | WiFi + WebSocket manual control with embedded HTML UI |
| ModeManager | `modules/ModeManager.{h,cpp}` | Central state machine, routes commands to motor outputs |

### Communication

| Module | File | Responsibility |
|--------|------|---------------|
| CommandParser | `modules/CommandParser.{h,cpp}` | JSON + ASCII command parsing from UART (Pi) and WebSocket |

## System Modes

```
┌──────────────────────────────────────────────────────────────┐
│                        MODE: NAV                             │
│  Pi5 sends heartbeat + move commands via UART               │
│  ObstacleAvoidance intercepts LiDAR events                  │
│  Robot navigates autonomously                               │
└──────────────────────────────────────────────────────────────┘
          │ Pi disconnects (2s timeout)
          ▼
┌──────────────────────────────────────────────────────────────┐
│                       MODE: MANUAL                           │
│  No Pi signal, but web control is active                     │
│  Robot waits for manual commands via web UI                 │
│  All motors still respond to PID control                     │
└──────────────────────────────────────────────────────────────┘
          │ No web connection either
          ▼
┌──────────────────────────────────────────────────────────────┐
│                        MODE: SAFE                            │
│  No Pi heartbeat and no web control                          │
│  All motors BRAKED, PID disabled                            │
│  Robot waits for any command to resume                       │
└──────────────────────────────────────────────────────────────┘
          │ E-stop pressed (any mode)
          ▼
┌──────────────────────────────────────────────────────────────┐
│                       MODE: E-STOP                          │
│  ALL motors DISABLED via hardware enable pin               │
│  Only "clear e-stop" command can recover                    │
└──────────────────────────────────────────────────────────────┘
```

## Pi UART Commands

### Navigation Commands (JSON)
```json
{"cmd":"move","vx":100,"vy":0,"omega":0}       // Forward 100
{"cmd":"move","vx":0,"vy":100,"omega":0}       // Strafe right
{"cmd":"move","vx":0,"vy":0,"omega":100}       // Rotate CW
{"cmd":"individual","speeds":[100,100,100,100]} // Direct motor speeds
{"cmd":"heartbeat"}                            // Reset watchdog timer
```

### Obstacle Avoidance Commands (JSON)
```json
{"cmd":"obstacle_left"}    // LiDAR detected obstacle on left → dodge right
{"cmd":"obstacle_right"}   // LiDAR detected obstacle on right → dodge left
{"cmd":"obstacle_front"}   // LiDAR detected obstacle ahead → rotate to clear side
{"cmd":"obstacle_clear"}   // Path is clear — resume normal navigation
```

### ASCII Commands
```
F 150    → Forward 150
B 100    → Backward 100
L 80     → Strafe left 80
R 80     → Strafe right 80
Q 60     → Rotate CCW 60
E 60     → Rotate CW 60
M 100 100 100 100  → Direct motor [FL FR RL RR]
Z        → Heartbeat
S        → Stop (brake)
D        → E-stop
K        → Clear E-stop
V        → Status JSON
P 2.5 0.8 0.15  → Set PID gains
X 75     → Max speed 75%
T        → Test sequence
```

## Web Manual Control

1. Edit `include/WiFiCredentials.h` with your WiFi SSID/password
2. Flash firmware to ESP32-S3
3. Connect to the same WiFi network
4. Open `http://<esp32-ip>` in a browser
5. Use the on-screen buttons or keyboard (W/A/S/D + Q/E) for manual control

### Web Controls
- **Direction pad**: Forward, backward, strafe left/right, diagonal moves
- **Rotate**: CCW / CW buttons
- **Keyboard**: W=forward, S=backward, A=strafe left, D=strafe right, Q=CCW, E=CW, Space=stop
- **Speed slider**: Limit motor speed (10–100%)
- **E-Stop**: Immediately disables all motors
- **Clear E-Stop**: Re-enables motor control
- **Live telemetry**: Real-time motor RPM display

## Configuration

All system parameters are in `include/config.h`:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `HEARTBEAT_TIMEOUT_MS` | 2000 | Pi signal timeout before switching to MANUAL |
| `OBSTACLE_THRESHOLD_CM` | 100 | LiDAR distance to trigger dodge |
| `DODGE_STRAFE_SPEED` | 100 | Strafe speed during dodge maneuver |
| `DODGE_DURATION_MS` | 800 | How long to maintain dodge before re-evaluating |

## Building

```bash
pio run          # Build firmware
pio run --target upload    # Upload to ESP32
pio device monitor         # View serial output
```
