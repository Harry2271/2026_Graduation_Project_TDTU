# Autonomous Warehouse Robot — Graduation Project

## Project Overview

An autonomous warehouse logistics robot capable of:
- Autonomous indoor navigation (SLAM)
- Real-time LiDAR-based obstacle detection and avoidance
- Warehouse mapping via SLAM
- QR code scanning for shelf/task identification
- Autonomous item transportation between shelves
- 5DOF robotic arm object manipulation
- Omnidirectional movement via 4 mecanum wheels

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                   RASPBERRY PI 5 (Main Computer)                │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  ROS2 Humble + Nav2 + slam_toolbox                      │   │
│  │  • SLAM Mapping (occupancy grid)                        │   │
│  │  • Path Planning & Navigation                           │   │
│  │  • QR Code Processing (webcam)                          │   │
│  │  • LiDAR Data Processing (obstacle detection)           │   │
│  │  • High-level Task Coordination                         │   │
│  └──────────────────────────┬───────────────────────────────┘   │
│                             │ UART (115200 baud)                │
│                             │ JSON protocol                     │
│                             ▼                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  ESP32-S3 (Real-Time Motor Controller)                   │   │
│  │  • PWM Generation (20kHz, 10-12 bit)                    │   │
│  │  • Encoder Reading (PCNT hardware counter)               │   │
│  │  • PID Speed Control (50Hz update)                      │   │
│  │  • Mecanum Wheel Kinematics                             │   │
│  │  • Servo Control (robotic arm)                          │   │
│  └──────────┬──────────┬──────────┬──────────┬──────────────┘   │
│             │          │          │          │                   │
│         ┌───▼──┐  ┌───▼──┐  ┌───▼──┐  ┌───▼──┐                │
│         │BTS7960│  │BTS7960│  │BTS7960│  │BTS7960│              │
│         │ FL   │  │ FR   │  │ RL   │  │ RR   │              │
│         └──┬───┘  └──┬───┘  └──┬───┘  └──┬───┘              │
│            │         │         │         │                    │
│         ┌──▼──┐  ┌──▼──┐  ┌──▼──┐  ┌──▼──┐                │
│         │JGB37│  │JGB37│  │JGB37│  │JGB37│                │
│         │520  │  │520  │  │520  │  │520  │                │
│         └─────┘  └─────┘  └─────┘  └─────┘                │
│                                                             │
│  SENSORS:                                                   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                 │
│  │ RPLiDAR  │  │  Webcam  │  │ 5DOF Arm │                 │
│  │ A1M8-R6  │  │  (QR)    │  │  (Servos)│                 │
│  └──────────┘  └──────────┘  └──────────┘                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Hardware Components

### Main Computing — Raspberry Pi 5 (8GB RAM)
| Spec | Detail |
|------|--------|
| CPU | Broadcom BCM2712, quad-core ARM Cortex-A76 @ 2.4GHz |
| RAM | 8GB LPDDR4X-4267 |
| Storage | 512GB Gen4x4 NVMe SSD |
| OS | Ubuntu 22.04 LTS |
| Framework | ROS2 Humble |
| Interfaces | UART (GPIO 14/15), USB 3.0 (LiDAR, Webcam), WiFi/BT |

### Real-Time Controller — ESP32-S3 (WeAct N16R8)
| Spec | Detail |
|------|--------|
| SoC | Xtensa LX7 dual-core |
| Flash | 16MB |
| PSRAM | 8MB Octal PSRAM |
| GPIO | Carefully selected to avoid conflicts (no GPIO 6-11, 18-19, 26-37, 43-46) |
| Interfaces | USB CDC (native), UART, I2C, SPI |

### Motor System
| Component | Qty | Spec |
|-----------|-----|------|
| BTS7960 Motor Driver | 4 | 6-27VDC, 43A peak, 20kHz PWM |
| JGB37-520 DC Geared Motor | 4 | 12VDC, 333RPM no-load, 30:1 gear ratio |
| JGB37-520 Encoder | 4 | Hall-effect quadrature, 11 PPR on motor shaft |
| Mecanum Wheel | 4 | Standard 60mm (X-pattern layout) |

### Sensors & Actuators
| Component | Detail |
|-----------|--------|
| RPLIDAR A1M8-R6 | 360° scan, 0.15-12m range, 8kHz sample rate, UART 115200bps |
| Webcam | USB camera for QR code scanning |
| 5DOF Robotic Arm | 3× MG996R + 3× SG90 servos, ~40cm reach |

### Power System
| Component | Detail |
|-----------|--------|
| Current Supply | 21VDC external PSU |
| Battery (Planned) | 3S3P 18650 (11.1V nom / 12.6V full) with 40A BMS |
| Regulation | Buck converters: 21V→12V (motors), 21V→5V (logic) |

---

## Pin Mapping — ESP32-S3 (WeAct N16R8)

```
Safe GPIOs: 1-5, 7-8, 12-17, 20-25, 38-42, 47-48
AVOID:  0 (BOOT), 6-11 (Flash SPI), 18-19 (USB D±),
        26-37 (PSRAM), 43-44 (UART0), 45-46 (Native USB)
```


### ESP32-S3 ↔ Raspberry Pi 5 UART Connection

**Note on ESP32-S3 Native USB CDC:** The ESP32-S3's Type-C port is configured as a native USB CDC device (not UART). It appears as `/dev/ttyACM0` on the Raspberry Pi 5. This separate USB-C connection is used for firmware flashing/debugging, while the physical UART2 (GPIO 43/44) pins carry the real-time motor control protocol.

### BTS7960 Motor Driver Pin Functions

| BTS7960 Pin | Connection | Function |
|-------------|-----------|----------|
| RPWM | ESP32 GPIO (PWM) | Forward PWM (high-side drive) |
| LPWM | ESP32 GPIO (PWM) | Reverse PWM (high-side drive) |
| R_EN + L_EN | ESP32 GPIO (merged) | Enable (active high, both halves) |
| B+ (VM) | 21V supply rail | Motor power |
| GND | Common ground | Power ground |
| OUT+ / OUT- | JGB37-520 M1/M2 | Motor terminals |
| VCC | 5V buck converter | Logic power |

**Control Logic:**
- Forward: RPWM = PWM, LPWM = LOW, EN = HIGH
- Reverse: RPWM = LOW, LPWM = PWM, EN = HIGH
- Brake: RPWM = HIGH, LPWM = HIGH (both high-side FETs on)
- Coast: RPWM = LOW, LPWM = LOW (both low-side FETs on)

---

## Communication Protocol — UART (ESP32-S3 ↔ Raspberry Pi 5)

### Physical Layer
- **Interface:** UART2 on ESP32-S3 (GPIO 43 TX / GPIO 44 RX) ↔ Raspberry Pi 5 GPIO (UART)
- **Baud Rate:** 115200
- **Format:** 8N1 (8 data bits, no parity, 1 stop bit)
- **Framing:** JSON-based text protocol, terminated by `\n`

### Protocol — Raspberry Pi 5 → ESP32-S3 (Commands)

| JSON Command | Description |
|-------------|-------------|
| `{"cmd":"set_speed","motor_id":0,"speed":150}` | Set individual motor speed (-255 to 255) |
| `{"cmd":"set_all_speed","speeds":[100,100,100,100]}` | Set all 4 motor speeds simultaneously |
| `{"cmd":"stop"}` | Stop all motors (brake) |
| `{"cmd":"e_stop"}` | Emergency stop (disables all drivers) |
| `{"cmd":"get_encoder"}` | Request encoder data (counts + RPM) |
| `{"cmd":"reset_encoder","motor_id":-1}` | Reset encoder counter (-1 = all) |
| `{"cmd":"set_pid","motor_id":0,"kp":1.0,"ki":0.1,"kd":0.01}` | Set PID gains for a motor |

### Protocol — ESP32-S3 → Raspberry Pi 5 (Responses)

| JSON Response | Type | Description |
|-------------|------|-------------|
| `{"type":128,"data":{"motor_id":0,"speed":150}}` | ACK | Command acknowledged |
| `{"type":129,"data":{"error":"..."}}` | ERROR | Error message |
| `{"type":130,"data":{"encoders":[{...}]}}` | ENCODER | Encoder data for all 4 motors |
| `{"type":131,"data":{...}}` | STATUS | Status telemetry |

### Alternative Command Protocol (Simple Serial)

For firmware versions without JSON, a simpler ASCII protocol is used:
```
F <0-100>   : Forward
B <0-100>   : Backward
L <0-100>   : Strafe Left
R <0-100>   : Strafe Right
Q <0-100>   : Rotate CCW
E <0-100>   : Rotate CW
S           : Stop (brake)
M <fl fr rl rr> : Manual motor control (-100 to 100)
A           : Auto mode (exit manual)
V           : Request detailed status
P <m> <kp> <ki> <kd> : Set PID for motor m (0-3)
G <kp> <ki> <kd> : Set global PID gains
X <0-100>   : Set max speed limit %
D           : Disable all drivers (emergency)
C           : Start auto-calibration
T           : Run test sequence
? / H       : Show help
```

---

## LiDAR-Based Obstacle Detection & Avoidance

### Data Flow

```
┌───────────────────────────────────────────────┐
│            RPLIDAR A1M8-R6                    │
│  (Connected to Pi 5 via USB-UART @ 115200)    │
│  Scans 360° at 5-10Hz, up to 12m range       │
└─────────────────────┬─────────────────────────┘
                      │ /scan topic (ROS2)
                      ▼
┌───────────────────────────────────────────────┐
│         Raspberry Pi 5 (ROS2 Node)            │
│                                                │
│  Obstacle Detector:                            │
│  1. Receives laser scan data (angle + distance)│
│  2. Divides 360° into 4 zones:                │
│     - Front: 315°-0°-45°                      │
│     - Right: 45°-135°                          │
│     - Rear: 135°-225°                          │
│     - Left: 225°-315°                          │
│  3. Finds minimum distance in each zone        │
│  4. Applies obstacle avoidance algorithm:      │
│     - If obstacle < threshold (e.g. 1.0m):    │
│       → Stop forward movement                  │
│       → Turn toward clearest direction        │
│     - If obstacle approaching: slow down      │
│     - If clear: resume cruise speed           │
│  5. Sends velocity commands via UART to ESP32  │
└─────────────────────┬─────────────────────────┘
                      │ {"cmd":"set_all_speed","speeds":[FL,FR,RL,RR]}
                      ▼
┌───────────────────────────────────────────────┐
│              ESP32-S3 Firmware                 │
│                                                │
│  Velocity → Mecanum Kinematics:               │
│    FL =  forward + strafe + rotate             │
│    FR =  forward - strafe - rotate             │
│    RL =  forward - strafe + rotate             │
│    RR =  forward + strafe - rotate             │
│                                                │
│  Normalize → PWM → BTS7960 → Motors           │
│  Read encoders → PID feedback loop (50Hz)     │
│  Send telemetry back to Pi 5                   │
└───────────────────────────────────────────────┘
```

### Obstacle Avoidance Algorithm (Raspberry Pi 5)

```python
# Simplified obstacle avoidance logic
def process_lidar_data(lidar_points):
    # Classify points into 4 directional zones
    front_dist = min(points in 315°-0°-45° range)
    left_dist  = min(points in 225°-315° range)
    right_dist = min(points in 45°-135° range)

    if front_dist < OBSTACLE_THRESHOLD (1.0m):
        # Obstacle ahead — stop forward, turn toward clear side
        speed = 0
        if left_dist > right_dist:  turn_adjust = +50 (turn left)
        else:                       turn_adjust = -50 (turn right)
    elif front_dist < 2 * OBSTACLE_THRESHOLD:
        # Approaching obstacle — slow down proportionally
        speed = cruise_speed * (front_dist / (2 * threshold))
    else:
        # Clear path — maintain cruise speed
        speed = cruise_speed

    # Apply mecanum kinematics
    # FL = FR = speed + turn_adjust, RL = RR = speed - turn_adjust
    speeds = [FL, FR, RL, RR]
    esp32.set_all_motors(speeds)
```

### LiDAR Connection

| RPLIDAR A1M8-R6 | Raspberry Pi 5 |
|-----------------|----------------|
| UART TX | USB-UART adapter RX |
| UART RX | USB-UART adapter TX |
| 5V | USB 5V |
| GND | USB GND |

The LiDAR is connected to the Raspberry Pi 5 via a USB-to-UART adapter, appearing as `/dev/ttyUSB0` or similar. In ROS2, the `sllidar_ros2` package handles the driver and publishes `/scan` topics.

---

## Software Stack

### Raspberry Pi 5
| Layer | Technology |
|-------|-----------|
| OS | Ubuntu 22.04 LTS |
| Robotics | ROS2 Humble |
| SLAM | slam_toolbox (online_async) |
| Navigation | Nav2 (planned) |
| LiDAR Driver | sllidar_ros2 |
| Serial Comm | pyserial (UART to ESP32) |
| QR Scanner | OpenCV + pyzbar |
| Language | Python 3 |

### ESP32-S3
| Layer | Technology |
|-------|-----------|
| Framework | Arduino via PlatformIO |
| PWM | LEDC (20kHz, 10-bit or 12-bit) |
| Encoder | PCNT (hardware pulse counter, x2 decoding) |
| PID | Custom PID controller with feed-forward |
| JSON | ArduinoJson 7.x |
| WiFi/Web | AsyncWebServer + WebSocket (for debugging dashboard) |

---

## Mecanum Wheel Kinematics

Wheel layout (viewed from top):
```
        FRONT
   ┌─────────────────┐
   │   [FL]   [FR]   │   FL = Forward-Left  (roller: //)
   │                 │   FR = Forward-Right (roller: \\\\)
   │   [RL]   [RR]   │   RL = Rear-Left     (roller: \\\\)
   └─────────────────┘   RR = Rear-Right    (roller: //)
        BACK
```

**Inverse Kinematics** (command → wheel speeds):
```
FL =  forward + strafe + rotate
FR =  forward - strafe - rotate
RL =  forward - strafe + rotate
RR =  forward + strafe - rotate
```

**Normalization:** If any wheel speed exceeds [-1.0, 1.0], all values are proportionally scaled down.

**Acceleration Ramping:** Target speeds are smoothed via a ramp function to prevent jerky motion:
```
if |target - current| > max_change:
    current += sign(diff) * max_change
else:
    current = target
```

---

## PID Motor Control

### Configuration
| Parameter | Default | Description |
|-----------|---------|-------------|
| Kp | 2.0 | Proportional gain |
| Ki | 0.8 | Integral gain |
| Kd | 0.1 | Derivative gain |
| Update Rate | 50 Hz (20ms) | PID computation interval |
| Output Limit | ±1023 | PWM duty cycle limit |
| Integral Limit | 500 | Anti-windup clamp |

### Control Loop (executed every 20ms)
```
1. Read encoder counts (PCNT hardware counter)
2. Calculate actual RPM from pulse delta
3. Compute target RPM from command velocity
4. PID: output = Kp·e + Ki·∫e·dt + Kd·de/dt
5. Clamp output → PWM duty cycle
6. Write PWM to BTS7960 via LEDC
```

---

## Project Structure

```
project-root/
├── AI/
│   ├── esp32 connect/              # Initial ESP32 + Pi integration
│   │   ├── esp32-s3-firmware/      # Basic motor control firmware
│   │   └── raspberry-pi/           # Pi-side Python controller + LiDAR
│   ├── ESP32S3/                    # ESP32 mecanum car firmware
│   ├── esp32s3_full 4 driver_4 motor/  # Full 4-motor firmware with PID/calibration
│   │   ├── include/                # Header files (config, drivers, encoders, PID)
│   │   ├── src/                    # Source files
│   │   ├── pc_control/             # PC monitor + test suite
│   │   └── docs/                   # Wiring diagrams, power analysis
│   ├── Final/                      # Consolidated final version
│   │   ├── ESp32/                  # ESP32 firmware with OLED + ROS2 UART
│   │   └── RASPBERRY PI 5/         # Pi 5 code (Lidar, mecanum robot)
│   │       ├── Lidar/              # ROS2 LiDAR obstacle detection
│   │       └── mecanum_robot/      # Robot driver + navigation
│   ├── ESP32S3 test cánh tay/     # Robotic arm integration
│   └── test motor/                 # Motor testing (BTS7960, PID, WiFi/BT)
├── esp32-mecanum-fw/               # Alternative firmware with Web UI
├── robot-controller/               # ROS2 package (SLAM, mapping)
├── LIdar/                          # LiDAR testing scripts
└── CLAUDE.md                       # This file
```

---

## Development Phases

| Phase | Milestone | Status |
|-------|-----------|--------|
| 1 | Basic motor control + encoder integration | ✅ Complete |
| 2 | UART communication (Pi ↔ ESP32) | ✅ Complete |
| 3 | Mecanum movement + odometry | ✅ Complete |
| 4 | LiDAR integration + obstacle avoidance | ✅ Complete |
| 5 | SLAM mapping (slam_toolbox) | ✅ Complete |
| 6 | Autonomous navigation (Nav2) | 🔄 In Progress |
| 7 | QR code shelf detection | 🔄 In Progress |
| 8 | Robotic arm integration | 🔄 In Progress |
| 9 | Full warehouse automation demo | 📅 Planned |
| 10 | Battery power system | 📅 Planned |

---

## What the ESP32 Needs to Do Next (Brain Integration)

The Pi is getting a new `brain_node.py` that will own the high-level
state machine (autonomous mapping, job dispatch, path planning via
Nav2, AprilTag vision). The brain drives the ESP32 through a clean
abstract interface, but **the ESP32 must implement several new
capabilities** that don't exist in the current firmware. This section
is the contract — what each side has to deliver.

### Current state vs. required state

| Capability | Today | Required |
|---|---|---|
| Accept `(vx, vy, omega)` over UART JSON | ✅ Yes | ✅ Keep |
| Stop / e-stop / heartbeat | ✅ Yes | ✅ Keep |
| `obstacle_*` reactive dodge | ✅ Yes | ✅ Keep |
| Publish encoder counts to Pi | ❌ No | ✅ Add — for Nav2 odometry fusion |
| Publish IMU heading to Pi | ❌ No | ✅ Add — BNO055 init + stream over UART |
| Acknowledge a `move` with status | ❌ No | ✅ Add — type-132 ack with sequence id |
| Receive "go to point (x,y)" | ❌ No | ⏸ Deferred — brain drives with `move` only, no on-board waypoint follower |
| Receive "follow path" | ❌ No | ⏸ Deferred — brain sends `move` continuously at 50 Hz |
| Receive "rotate to heading" | ❌ No | ⏸ Deferred — encoded as `move` with non-zero `omega` |
| Battery voltage publish | ❌ No | ✅ Add — type-133 telemetry |
| Robotic arm control | ❌ No | ⏸ Deferred to firmware phase 8 |
| AprilTag reading | ❌ No (Pi's job) | ✅ Keep on Pi |

### New UART message types (ESP32 → Pi)

The current firmware emits type 128 (ACK), 129 (error), 130 (encoders),
131 (status). Add these:

```json
// 132 — move command acknowledgment
{"type":132,"data":{"seq":N,"status":"accepted"|"rejected","reason":"..."}}

// 133 — battery + system telemetry
{"type":133,"data":{"voltage_mv":12345,"current_ma":250,"uptime_ms":N,"e_stop":false,"watchdog_ok":true}}
```

The `seq` field lets the Pi correlate ACKs with commands and detect
packet loss. The brain increments `seq` on every `move` it sends; the
ESP32 echoes it back in the 132 response.

### Updated UART command (Pi → ESP32)

The existing `{"cmd":"move","vx":N,"vy":N,"omega":N}` is kept, with
one new optional field:

```json
{"cmd":"move","vx":100,"vy":0,"omega":0,"seq":42}
```

If the brain does not include `seq`, the ESP32 must not emit a 132
ack (back-compat for the existing manual-control ASCII path). When
`seq` is present, emit a 132 within 5 ms.

### New required modules

| Module | Purpose | Key APIs |
|---|---|---|
| `firmware/src/modules/brain_bridge.cpp` | Decodes `move` JSON into `MecanumDrive::compute()` calls, emits 132 acks | `on_move_cmd(vx, vy, omega, seq)` |
| `firmware/src/modules/odometry_publisher.cpp` | Reads encoder counts, computes wheel delta, emits 130 every 50 ms | `publish_encoder_snapshot()` |
| `firmware/src/modules/imu_bno055.cpp` | Initializes BNO055 over I2C (address 0x28 or 0x29), reads Euler angles | `imu_read_heading_rad()` |
| `firmware/src/modules/battery_monitor.cpp` | ADC read on a battery-sense pin, emits 133 every 5 s | `read_voltage_mv()` |

### New config.h additions

```cpp
// I2C for BNO055
#define BNO055_I2C_ADDR  0x28
#define I2C_SDA_PIN      8
#define I2C_SCL_PIN      9
#define I2C_FREQ_HZ      400000

// Battery sense
#define BATTERY_ADC_PIN  1
#define BATTERY_DIVIDER  0.2f   // 100k/400k → ~0.2

// Telemetry intervals
#define ENCODER_PUBLISH_MS  50
#define BATTERY_PUBLISH_MS  5000

// Heartbeat (existing)
#define HEARTBEAT_TIMEOUT_MS  2000  // Pi must heartbeat within this
```

### Heartbeat contract (existing, tightened)

- Pi sends `{"cmd":"heartbeat"}` every 50 ms (much faster than the
  current 2 s timeout — gives the brain a 40× safety margin for
  re-sending on transient UART loss).
- ESP32 resets the watchdog timer on every heartbeat.
- If the watchdog expires, ESP32 calls `e_stop()` internally and
  publishes `{"type":133,"data":{"e_stop":true,"watchdog_ok":false}}`
  on next boot cycle.

### Pin allocation check

The existing `config.h` has free pins for I2C and the battery ADC.
Verify before flashing — the current pin list reserves GPIO 43/44
for UART2 (Pi link) which is correct; everything else listed under
"Available GPIOs" is fair game.

### What the ESP32 does NOT need to do

The brain owns the world model. The ESP32 must not:
- ❌ Parse `/cmd_vel` from ROS 2 (it only sees UART JSON from the brain)
- ❌ Track its own pose or do SLAM (the brain does this)
- ❌ Make path-planning decisions (Nav2 on the Pi decides; ESP32
  executes)
- ❌ Read AprilTags (the Pi's `april_tag_node.py` does this; ESP32
  never sees tag data)

The mental model: **ESP32 = fast dumb motors. Pi = slow smart brain.**
The brain sends `move` JSON, the ESP32 obeys.

### Implementation order (matches spec rollout Phase 6)

1. `brain_bridge.cpp` first (smallest, no hardware).
2. `odometry_publisher.cpp` second (uses existing encoders, just
   needs to publish more often).
3. `battery_monitor.cpp` third (ADC + 133 type).
4. `imu_bno055.cpp` last (new hardware bringup, BNO055 has a known
   boot-time quirk where you must read its chip ID before config).

Each module has a stub `loop()` that compiles and emits the right
type-N message with placeholder data, so the brain can be developed
incrementally against the real UART before each module is real.

### See also

- Design spec: `docs/superpowers/specs/2026-06-07-robot-controller-brain-design.md`
- Brain's `Esp32Bridge` interface: `services/robot/src/my_robot_controller/my_robot_controller/esp32_bridge.py` (forthcoming, Phase 2 of rollout)
- Existing UART command reference: `firmware/src/modules/CommandParser.cpp` lines 158-244

---

## Important Design Decisions

1. **Real-time criticality:** ESP32-S3 handles ALL real-time motor control (PWM, encoder, PID). The Raspberry Pi 5 handles ONLY high-level decision-making (SLAM, path planning, obstacle avoidance strategy).

2. **Fail-safe:** A dedicated emergency stop command (`D` or `e_stop`) immediately disables all BTS7960 drivers. No persistent state — the robot always starts stopped and must receive explicit commands to move.

3. **Ground sharing:** ALL modules (RPi 5, ESP32-S3, BTS7960 motors, LiDAR, power supply) MUST share a common ground. This is critical for UART communication to function correctly.

4. **PID auto-calibration:** The system includes an auto-calibration routine that sweeps each motor through PWM steps, performs linear regression (PWM→RPM), and computes optimal PID gains using IMC-based tuning.

5. **UART vs. USB CDC:** The ESP32-S3 exposes both a native USB CDC port (for debugging/flashing) and hardware UART2 pins (for real-time motor control with Pi 5). These are separate interfaces with separate purposes.

6. **Obstacle avoidance strategy:** Simple and reactive (behavior-based) — no complex costmap or global planner needed for basic obstacle avoidance. The LiDAR data is divided into zones and the robot chooses the clearest path. For full SLAM-based navigation, Nav2 provides the global planner.

---

## Key Files

### ESP32-S3 Firmware (Primary — `esp32s3_full 4 driver_4 motor/`)
- `src/main.cpp` — Main control loop, serial command parser
- `include/config.h` — Pin definitions, PID parameters, motor specs
- `src/config.cpp` — Motor configuration array (FL, FR, RL, RR)
- `src/BTS7960Driver.cpp` — BTS7960 motor driver with PWM/brake/coast
- `src/Encoder.cpp` — PCNT-based quadrature encoder reading
- `src/PIDController.cpp` — PID speed controller with feed-forward
- `src/MecanumDrive.cpp` — Mecanum wheel inverse kinematics
- `src/Calibration.cpp` — Auto-calibration (PWM sweep → linear regression)

### Raspberry Pi 5 (Python)
- `AI/esp32 connect/raspberry-pi/uart_comm.py` — UART serial controller class
- `AI/esp32 connect/raspberry-pi/lidar_control.py` — LiDAR-based motor control with obstacle avoidance
- `AI/esp32s3_full 4 driver_4 motor/pc_control/robot_monitor.py` — PC telemetry monitor + calibration GUI

### ROS2
- `robot-controller/src/my_robot_controller/config/slam_params.yaml` — SLAM Toolbox parameters
- `robot-controller/src/my_robot_controller/launch/mapping_launch.py` — SLAM launch file

### Documentation
- `AI/esp32s3_full 4 driver_4 motor/docs/WIRING_DIAGRAM.md` — Full wiring diagram
- `AI/esp32s3_full 4 driver_4 motor/docs/POWER_ANALYSIS.md` — Power system analysis
- `AI/Final/ESp32/esp32_firmware/WIRING.md` — Wiring guide for final version
