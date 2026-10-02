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
│  │  ROS2 Jazzy + Nav2 + slam_toolbox                       │   │
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
| GPIO | ESP32-S3-WROOM-1U-N16R8 — pads 1-21, 38-48 (22-25 NOT on module) |
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
| MCU-055 BNO055 | 9-axis accelerometer module (9DOF IMU), integrated with an intelligent sensor processor, supports I2C/UART communication |
| Sharp GP2Y0A21YK0F | Analog infrared distance sensor (10-80cm range), used for close-range obstacle detection and redundancy backup |
| VL53L0X TOF Sensor | Time-of-flight distance sensor (50–2000mm), I2C, used for cargo presence detection at dock |
| INA226 (CJMCU-226) | High-accuracy I2C power monitor for bus voltage, shunt current, and calculated SOC |
| L298N Motor Driver | Dual H-Bridge for the electric cylinder actuator (dock/unload sequence) |
| 4× E18-D80NK IR Proximity | Digital IR obstacle sensors (rear-left, rear-right, left, right), debounced inputs for ObstacleAvoidance |

### Power System
| Component | Detail |
|-----------|--------|
| Current Supply | 21VDC external PSU |
| Battery (Planned) | 3S3P 18650 (11.1V nom / 12.6V full) with 40A BMS |
| Regulation | Buck converters: 21V→12V (motors), 21V→5V (logic) |
| INA226 (CJMCU-226) | Low-error current and voltage sensor, supports I2C communication (for power/battery voltage monitoring) |

### Warehouse Dock / Cylinder System
| Component | Detail |
|-----------|--------|
| L298N H-Bridge | Controls a 12V electric cylinder (extend/retract/stop) |
| VL53L0X TOF | Mounted near the dock; measures distance to determine cargo presence at dock station |
| CargoSensor | I2C digital sensor; `high` when cargo is on the dock platform |

---

## Pin Mapping — ESP32-S3-WROOM-1U-N16R8

```
Module pads available:
  Left:  EN, 4,5,6,7,15,16,17,18,8,19,20,3,46,9,10
  Right: 43,44,2,1,45,46,0,35,36,37,38,39,40,41,42,47,48,21
NOT on module: 22, 23, 24, 25
Strapping: 0 (boot), 9, 45, 46
USB: 18 (D-), 19 (D+) — safe when CDC disabled
UART0: 43 (TX), 44 (RX) — free on WeAct N16R8 (no bridge chip)
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
| `{"cmd":"move","vx":100,"vy":0,"omega":0}` | Mecanum velocity (PWM units) |
| `{"cmd":"set_speed","motor_id":0,"speed":150}` | Set individual motor speed (-255 to 255) |
| `{"cmd":"set_all_speed","speeds":[100,100,100,100]}` | Set all 4 motor speeds simultaneously |
| `{"cmd":"stop"}` | Stop all motors (brake) |
| `{"cmd":"e_stop"}` / `{"cmd":"e_stop_clear"}` | Emergency stop / clear e-stop |
| `{"cmd":"heartbeat"}` | Reset watchdog timer (must send within 2s) |
| `{"cmd":"get_encoder"}` | Request encoder data (counts + RPM) |
| `{"cmd":"reset_encoder","motor_id":-1}` | Reset encoder counter (-1 = all) |
| `{"cmd":"set_pid","motor_id":0,"kp":1.0,"ki":0.1,"kd":0.01}` | Set PID gains for a motor |
| `{"cmd":"get_imu"}` | Request IMU heading (response type 134) |
| `{"cmd":"get_power"}` | Request power telemetry (response type 133) |
| `{"cmd":"cylinder_extend"}` | Extend electric cylinder (dock) |
| `{"cmd":"cylinder_retract"}` | Retract electric cylinder |
| `{"cmd":"cylinder_stop"}` | Stop cylinder immediately |
| `{"cmd":"begin_dock"}` | Start full docking sequence (firmware state machine) |
| `{"cmd":"cancel_dock"}` | Cancel docking sequence |
| `{"cmd":"obstacle_left", "distance_m": 0.9, "severity": 0.4}` | LiDAR obstacle on left; optional distance/severity payload |
| `{"cmd":"obstacle_right", "distance_m": 0.9, "severity": 0.4}` | LiDAR obstacle on right; optional distance/severity payload |
| `{"cmd":"obstacle_front"}` | LiDAR front hard-stop (explicit clear required) |
| `{"cmd":"obstacle_front_left"}` / `obstacle_front_right` | Compound front-corner dodge events |
| `{"cmd":"obstacle_rear"}` / `obstacle_rear_left` / `obstacle_rear_right` | Rear and rear-corner events |
| `{"cmd":"obstacle_clear"}` | Explicitly clear Pi obstacle state and reset avoidance latch |

#### Phase 1-4 Upgrade Commands (Safety / Battery / Motor Health / BlackBox)

| JSON Command | Description |
|-------------|-------------|
| `{"cmd":"clear_soft_stop"}` | Clear SOFT_STOP safety level (SafetyController) |
| `{"cmd":"clear_hard_stop"}` | Clear HARD_STOP safety level (Pi obstacle_clear equivalent) |
| `{"cmd":"clear_emergency"}` | Clear EMERGENCY safety level (requires manual inspect) |
| `{"cmd":"get_blackbox"}` | Stream frozen crash-dump buffer (response type 147, single line) |
| `{"cmd":"clear_blackbox"}` | Clear BlackBox and resume recording |
| `{"cmd":"reset_motor_warnings","speed":N}` | Reset MotorHealthMonitor warnings; `speed`=0..3 for one motor, `-1` for all |
| `{"cmd":"reset_coulomb"}` | Zero the BatteryPredictor coulomb counter |

### Protocol — ESP32-S3 → Raspberry Pi 5 (Responses)

| JSON Response | Type | Description |
|-------------|------|-------------|
| `{"type":128,"data":{"motor_id":0,"speed":150}}` | ACK | Command acknowledged |
| `{"type":129,"data":{"error":"..."}}` | ERROR | Error message |
| `{"type":130,"data":{"encoders":[{...}]}}` | ENCODER | Encoder data for all 4 motors |
| `{"type":131,"data":{...}}` | STATUS | Full status telemetry |
| `{"type":132,"data":{"seq":N,"status":"accepted"}}` | MOVE ACK | Ack for move commands with sequence ID |
| `{"type":133,"data":{"voltage_v":...,"current_a":...,"power_w":...,"battery_pct":...,"battery_status":"..."}}` | POWER | Battery/power telemetry (INA226 + SOC) — 0.2 Hz |
| `{"type":134,"data":{"yaw":...,"pitch":...,"roll":...,"temp":...,"cal":{...}}}` | IMU | IMU heading (BNO055) — published at 20 Hz |
| `{"type":135,"data":{"ir":[false,false,false,false]}}` | IR PROX | IR proximity sensor state (4× digital) |
| `{"type":136,"data":{"distance_mm":...,"obstacle":true}}` | FRONT TOF | Front distance sensor (VL53L1X) |
| `{"type":140,"data":{"state":N,"state_name":"...","error":false,"error_code":0,"error_name":"none"}}` | UNLOAD | Cylinder/unload state: 0=idle, 1=adjusting, 2=extending, 3=holding, 4=retracting, 5=done, 6=leave, 7=complete. On a refused/cancelled/failed dock, state returns to 0 with `error=true`; Pi must abort the route. |
| `{"type":143,"data":{"mode":"...","nav":[...],"motors":[...]}}` | TICK | Compact tick telemetry (500ms) — split from type 131 |
| `{"type":144,"data":{"uptime_ms":N,"alive":N,"e_stop":bool,"mode":"..."}}` | ALIVE | Alive heartbeat every 500 ms; Pi uses this to detect firmware liveness (was type 141 before Aug 2026) |
| `{"type":145,"data":{"present":true,"debounce_ms":N}}` | CARGO | Cargo bed presence query (on-demand via `get_cargo` cmd) |
| `{"type":146,"data":{"level":N,"timestamp_ms":N,"source":"...","reason":"...","old_level":N}}` | SAFETY | Safety state transition (SafetyController). `level`/`old_level`: 0=NORMAL, 1=SOFT_STOP, 2=HARD_STOP, 3=EMERGENCY. Emitted on every transition. |
| `{"type":147,"trigger":N,"reason":"...","samples":N,"freeze_ts":N,"data":[...]}` | BLACKBOX | Crash-dump stream (BlackBoxRecorder), single line. On-demand via `get_blackbox`. `trigger`: 0=NONE,1=MOTION_STUCK,2=HARD_STOP,3=EMERGENCY,4=IMU_SHOCK,5=MANUAL. Each sample: `{ts,nav[3],mt[4],mr[4],imu[3],sl,ir,tof}`. |

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

**Inverse Kinematics** (command → wheel speeds), matching `MecanumDrive.cpp` (forward=vx, strafe=vy, rotate=ω):
```
FL =  forward - strafe + rotate
FR =  forward + strafe - rotate
RL =  forward + strafe + rotate
RR =  forward - strafe - rotate
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
firmware/
├── include/
│   ├── config.h                    # Pin definitions, PID defaults, motor specs, I2C timing
│   ├── modules/
│   │   ├── BNO055Sensor.h
│   │   ├── INA226Sensor.h
│   │   ├── IRProximitySensor.h
│   │   ├── SharpFrontSensor.h
│   │   ├── VL53L0XSensor.h
│   │   ├── CargoSensor.h
│   │   ├── CylinderActuator.h
│   │   ├── HealthMonitor.h
│   │   ├── I2CBus.h               # ← NEW: centralized I2C bus manager
│   │   └── ...
│   ├── BTS7960Driver.h
│   ├── Encoder.h
│   ├── PIDController.h
│   ├── MecanumDrive.h
│   ├── ModeManager.h
│   ├── Watchdog.h
│   └── CommandParser.h
├── src/
│   ├── main.cpp                    # setup() + loop(), module init, UART read/write
│   ├── drivers/
│   │   ├── bno055_wire_support.cpp # Low-level I2C for BNO055 wire-mode (DEPRECATED)
│   │   └── driver_ina226_interface.cpp # INA226 I2C register read (uses I2CBus guards)
│   └── modules/
│       ├── BTS7960Driver.cpp
│       ├── Encoder.cpp
│       ├── PIDController.cpp
│       ├── MecanumDrive.cpp
│       ├── ModeManager.cpp
│       ├── Watchdog.cpp
│       ├── CommandParser.cpp
│       ├── ObstacleAvoidance.cpp
│       ├── AvoidanceFSM.cpp
│       ├── AutoRoam.cpp
│       ├── BNO055Sensor.cpp       # Uses I2CBus::probeWithRecovery + safeRead/write
│       ├── INA226Sensor.cpp       # Uses I2CBus::probeWithRecovery + linesIdle guard
│       ├── IRProximitySensor.cpp
│       ├── SharpFrontSensor.cpp
│       ├── VL53L0XSensor.cpp      # Uses I2CBus::probeWithRecovery + reinitializeBus
│       ├── CargoSensor.cpp
│       ├── CylinderActuator.cpp
│       ├── I2CBus.cpp             # ← NEW: bus init, recovery, safe wrappers
│       ├── HealthMonitor.cpp
│       └── JsonStatus.cpp
├── test_i2c_sensors/               # Standalone I2C diagnostic (for reference)
│   └── src/main.cpp
├── platformio.ini
└── CLAUDE.md
```

---

## I2C Bus Management

The shared I2C bus (GPIO10 SDA / GPIO11 SCL) carries three devices: BNO055 (0x28), VL53L0X (0x29), INA226 (0x40). All I²C traffic on this bus must go through `I2CBus` (`include/modules/I2CBus.h`, `src/modules/I2CBus.cpp`).

### Why direct Wire calls are dangerous on ESP32-S3

The ESP32-S3's `Wire.begin()` claims GPIO10/11 via the GPIO matrix.  After that:
- Calling `pinMode()` on those pins detaches the peripheral → all subsequent transactions fail with err=5 (timeout)
- `Wire.endTransmission()` does NOT honor `Wire.setTimeout()` — it blocks forever if a slave holds SDA low
- Calling `Wire.end()` mid-flight without full reinit can leave the peripheral in an undefined state

### Boot sequence (`main.cpp setupHardware()`)

```
1. Pre-Wire diagnostic:  pinMode(INPUT) → digitalRead(SDA/SCL) → confirms pull-ups
2. I2CBus::initialize(10, 11, 100000)   — Wire.begin() without Wire.end()
   → returns false if Wire.begin() fails or lines stuck after settle
3. I2CBus::probe() scan (0x28, 0x29, 0x40)  — prints which devices ACK
4. Sensor begin() in order: BNO055 → VL53L0X → INA226
   — each uses I2CBus::probeWithRecovery() then safe read/write wrappers
```

### `I2CBus` API

| Method | Returns | Purpose |
|--------|---------|---------|
| `initialize(sda, scl, freq)` | `bool` | First-time Wire bring-up. No `Wire.end()` first. |
| `reinitializeBus(sda, scl, freq)` | `bool` | Full recovery: busReset + STOP + Wire.end/begin + verify. |
| `busReset(sda, scl)` | `void` | 9-clock SCL pulse + I²C STOP (SDA LOW→HIGH while SCL HIGH). |
| `probe(sda, scl, addr)` | `int` | Raw Wire error: 0=ACK, 2=NACK, 5=timeout. |
| `probeWithRecovery(sda, scl, addr, freq)` | `int` | Probe with ONE full bus recovery on any failure, then retry. |
| `linesIdle(sda, scl)` | `bool` | Passive level check — `digitalRead()` only, no `pinMode()`. |
| `safeReadReg(...)` | `bool` | linesIdle guard + time-bounded Wire.read. |
| `safeReadBurst(...)` | `bool` | Burst version of safeReadReg. |
| `safeWriteReg(...)` | `bool` | linesIdle guard + Wire write. |
| `errorName(err)` | `const char*` | Human-readable error string for boot logs. |

### Return value convention

`probe()` and `probeWithRecovery()` return `int` — **0 means success (ACK), nonzero means error**. When checking, always use `!= 0`, never `!result` (the `!` operator inverts 0 to true, treating success as failure). This was a critical bug in BNO055 init that was fixed in August 2026.

### Bus recovery policy

- **NACK (err=2):** device absent → do NOT reset bus, other devices are fine
- **Timeout (err=5) or any error:** perform ONE controlled recovery via `reinitializeBus()` then retry
- **Max 2 attempts total** (initial probe + 1 recovery retry)

### Hardware requirements

- External 2.2kΩ–4.7kΩ pull-ups on SDA and SCL to 3.3V (mandatory for 3-device bus)
- Bus clock: 100 kHz (not 400 kHz) — BNO055 CJMCU-055 clones clock-stretch

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

## ESP32 Implementation Status

The ESP32-S3 firmware is **feature-complete** for the AGV warehouse robot contract with the Raspberry Pi 5 brain.

### Implemented capabilities

| Capability | Status | Module |
|---|---|---|
| Accept `(vx, vy, omega)` over UART JSON | ✅ Complete | `CommandParser.cpp`, `main.cpp` |
| Stop / e-stop / heartbeat watchdog | ✅ Complete | `Watchdog.cpp`, `ModeManager.cpp` |
| Reactive obstacle avoidance | ✅ Complete | `ObstacleAvoidance.cpp`, `AvoidanceFSM.cpp` |
| Publish encoder counts to Pi (type 130) | ✅ Complete | `Encoder.cpp`, `JsonStatus::emitEncoderSnapshot()` |
| Publish IMU heading to Pi (type 134) | ✅ Complete | `BNO055Sensor.cpp`, 20 Hz stream |
| Acknowledge move commands (type 132) | ✅ Complete | `JsonStatus::emitMoveAck()` with sequence ID |
| Battery/power telemetry (type 133) | ✅ Complete | `INA226Sensor.cpp` over I2C @ 0x40 |
| IR proximity sensors (type 135) | ✅ Complete | `IRProximitySensor.cpp`, 4× E18-D80NK |
| Front ToF distance (type 136) | ✅ Complete | `FrontTofSensor.cpp`, VL53L1X @ 0x31 |
| Rear ToF for docking (type 138) | ✅ Complete | `VL53L0XSensor.cpp`, VL53L0X @ 0x30 |
| Cylinder actuator control (type 139) | ✅ Complete | `CylinderActuator.cpp`, L298N driver |
| Autonomous dock/unload FSM (type 140) | ✅ Complete | `AutoRoam.cpp`, 8-state sequence |
| Health monitoring (type 142) | ✅ Complete | `HealthMonitor.cpp`, per-module staleness tracking |
| Compact tick telemetry (type 143) | ✅ Complete | `JsonStatus::emitTickStatus()`, 500ms |
| Alive heartbeat (type 144) | ✅ Complete | 500ms keepalive for Pi link detection |
| Cargo presence sensor (type 145) | ✅ Complete | `CargoSensor.cpp`, limit switch debounce |

### Key implementation notes

- **I2C shared bus (GPIO10 SDA / GPIO11 SCL @ 100kHz):** BNO055 IMU @ 0x28, VL53L0X rear ToF @ 0x30 (reassigned via XSHUT), VL53L1X front ToF @ 0x31 (reassigned via XSHUT), INA226 power @ 0x40. Bus recovery + mutex implemented in `I2CBus.cpp`.
- **Battery monitoring:** INA226 reads pack voltage/current over I2C with 10mΩ shunt. Piecewise linear SOC lookup table (20.5V full → 14.0V empty). Type-133 keys: `voltage_v`, `current_a`, `power_w`, `battery_pct`, `battery_status`, `noload`.
- **Mecanum kinematics:** `MecanumDrive.cpp` implements inverse kinematics (vx, vy, ω → 4 wheel speeds) with proportional normalization to MECANUM_MAX_SPEED=255.
- **PID control:** 50Hz closed-loop on all 4 motors (Kp=2.5, Ki=0.2, Kd=0.05), derivative-on-measurement, conditional integration anti-windup. Encoder: PCNT hardware quadrature @ 11 PPR × 30:1 gear × 2 edges = 660 counts/rev output shaft.
- **Safety interlocks:** IR sensors + front ToF are fail-closed (stale → assumes obstacle). Hardware E-stop pulls BTS7960 EN pins LOW. Watchdog timeout 2000ms → MODE_SAFE (coast motors). IMU safety evaluator detects tilt/shock events.
- **Docking sequence:** AutoRoam FSM: IDLE → ADJUSTING (heading + distance gate) → EXTENDING (cylinder out) → HOLDING (wait for cargo load) → RETRACTING (cylinder in) → DONE → LEAVING (reverse from dock) → COMPLETE. Uses VL53L0X rear ToF + BNO055 heading for closed-loop positioning.

### Pin allocation (ESP32-S3 WeAct N16R8)

| Function | Pins | Notes |
|---|---|---|
| Motors (BTS7960) | RPWM: 12,14,16,17 / LPWM: 13,15,18,5 / EN: 3,7,6,4 | LEDC PWM 20kHz 10-bit |
| Encoders (PCNT) | ChA: 47,48,21,42 / ChB: 41,40,39,38 | Hardware quadrature decode |
| I2C shared bus | SDA=10, SCL=11 | 100kHz, 4.7kΩ external pull-ups required |
| ToF XSHUT | VL53L0X=8, VL53L1X=9 | Address sequencing on boot |
| IR proximity | RL=1, RR=0, L=45, R=46 | E18-D80NK, INPUT_PULLUP, active-LOW |
| Cylinder (L298N) | IN1=2, IN2=35, limit=44 | Retract limit switch active-LOW |
| Cargo sensor | 36 | Limit switch, INPUT_PULLUP, active-LOW |
| USB CDC | 19 (D+), 20 (D-) | Serial = PiSerial, 115200 baud |

### Deferred / not implemented

- **Robotic arm control:** 5-DOF arm (3× MG966R + 3× SG90) wiring documented but servo library integration deferred.
- **AprilTag vision:** Handled by Pi's `vision_node.py` + Logitech BRIO 100 camera, not ESP32.
- **On-board waypoint follower:** Nav2 on Pi sends continuous `move` commands at 10-50Hz; ESP32 executes velocity commands only.

---
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
