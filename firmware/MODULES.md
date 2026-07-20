# ESP32-S3 Mecanum Controller — Modular Firmware

## Module Architecture

The firmware is organized into independent modules under `src/modules/` and `include/modules/`.

### Hardware Layer (drivers/)

| Module | File | Responsibility |
|--------|------|---------------|
| BTS7960Driver | `modules/BTS7960Driver.{h,cpp}` | PWM generation, motor enable/disable, brake/coast, E-stop |
| Encoder | `modules/Encoder.{h,cpp}` | PCNT hardware counter, RPM calculation, x2 decoding |
| PIDController | `modules/PIDController.{h,cpp}` | PID speed control loop with anti-windup |

### Motor Direction Config

Each motor has a `dir` field (+1 or -1) in `MOTOR_PINS[]` that compensates for reversed wiring. This lets the software use a single "positive = forward" convention while the hardware may have RPWM/LPWM swapped on certain motors.

| Motor | dir | Reason |
|-------|-----|--------|
| FL (0) | +1 | Normal wiring |
| FR (1) | -1 | Reversed — RPWM/LPWM physically swapped |
| RL (2) | +1 | Normal wiring |
| RR (3) | -1 | Reversed — RPWM/LPWM physically swapped |

Applied at 3 points: PWM output, encoder RPM, and telemetry display. If a motor spins the wrong way after wiring changes, flip its `dir` value.

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

### Sensor Layer

| Module | File | Responsibility |
|--------|------|---------------|
| BNO055Sensor | `modules/BNO055Sensor.{h,cpp}` | 9-DOF IMU over I2C. Reads Euler angles (yaw/pitch/roll), temperature, calibration status. Type 134 @ 20Hz |
| INA226Sensor | `modules/INA226Sensor.{h,cpp}` | Bus voltage, shunt voltage, current, power, and battery SOC (0-100%) over I2C. 3S Li-ion voltage-to-SOC lookup with low/critical alerts. Type 133 @ 0.2Hz |
| IRProximitySensor | `modules/IRProximitySensor.{h,cpp}` | 4× E18-D80NK digital IR proximity sensors (rear-left, rear-right, left, right). Debounced digital reads feeding ObstacleAvoidance. Type 135 on-demand |
| SharpFrontSensor | `modules/SharpFrontSensor.{h,cpp}` | Sharp GP2Y0A21YK0F analog front distance sensor (10-80 cm). ADC oversampling, distance-to-obstacle mapping for close-range front detection. Type 136 on-demand |

### Communication

| Module | File | Responsibility |
|--------|------|---------------|
| CommandParser | `modules/CommandParser.{h,cpp}` | JSON + ASCII command parsing from UART (Pi) and WebSocket |

## System Modes

```
+--------------------------------------------------------------+
|                        MODE: NAV                             |
|  Pi5 sends heartbeat + move commands via UART               |
|  ObstacleAvoidance intercepts LiDAR events                  |
|  Robot navigates autonomously                               |
+--------------------------------------------------------------+
          | Pi disconnects (2s timeout)
          v
+--------------------------------------------------------------+
|                       MODE: MANUAL                           |
|  No Pi signal, but web control is active                     |
|  Robot waits for manual commands via web UI                 |
|  All motors still respond to PID control                     |
+--------------------------------------------------------------+
          | No web connection either
          v
+--------------------------------------------------------------+
|                        MODE: SAFE                            |
|  No Pi heartbeat and no web control                          |
|  All motors BRAKED, PID disabled                            |
|  Robot waits for any command to resume                       |
+--------------------------------------------------------------+
          | E-stop pressed (any mode)
          v
+--------------------------------------------------------------+
|                       MODE: E-STOP                          |
|  ALL motors DISABLED via hardware enable pin               |
|  Only "clear e-stop" command can recover                    |
+--------------------------------------------------------------+
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

### Sensor Query Commands (JSON)
```json
{"cmd":"get_imu"}     // Request IMU heading (type 134 response)
{"cmd":"get_power"}   // Request power telemetry (type 133 response)
```

### Periodic Telemetry (ESP32 -> Pi, autonomous)

| Type | Interval | Content |
|------|----------|---------|
| `{"type":133,...}` | 5000 ms | Power: bus voltage, shunt voltage, current, power |
| `{"type":134,...}` | 50 ms | IMU: yaw, pitch, roll, temperature, calibration status |

### Obstacle Avoidance Commands (JSON)
```json
{"cmd":"obstacle_left"}    // LiDAR detected obstacle on left -> dodge right
{"cmd":"obstacle_right"}   // LiDAR detected obstacle on right -> dodge left
{"cmd":"obstacle_front"}   // LiDAR detected obstacle ahead -> rotate to clear side
{"cmd":"obstacle_clear"}   // Path is clear -- resume normal navigation
```

### ASCII Commands
```
F 150    -> Forward 150
B 100    -> Backward 100
L 80     -> Strafe left 80
R 80     -> Strafe right 80
Q 60     -> Rotate CCW 60
E 60     -> Rotate CW 60
M 100 100 100 100  -> Direct motor [FL FR RL RR]
Z        -> Heartbeat
S        -> Stop (brake)
D        -> E-stop
K        -> Clear E-stop
V        -> Status JSON
I        -> Read IMU heading (type 134)
W        -> Read power telemetry (type 133)
P 2.5 0.8 0.15  -> Set PID gains
X 75     -> Max speed 75%
T        -> Test sequence
? / H    -> Help
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
| `BNO055_SDA_PIN` / `BNO055_SCL_PIN` | 10 / 11 | I2C bus for BNO055 + INA226 |
| `IMU_PUBLISH_MS` | 50 | IMU heading publish interval (20 Hz) |
| `POWER_PUBLISH_MS` | 5000 | Power telemetry publish interval (0.2 Hz) |

## Building

```bash
pio run          # Build firmware
pio run --target upload    # Upload to ESP32
pio device monitor         # View serial output
```
