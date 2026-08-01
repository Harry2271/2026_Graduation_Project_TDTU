# Motor Control System — Firmware → Pi → Web

> **Date:** 2026-07-31  
> **Status:** Firmware fixed, hardware bring-up in progress  
> **Source of truth:** `firmware/`, `services/robot/`, `apps/web/`

---

## 1. System Overview

The warehouse robot has 4 mecanum wheels, each driven by a JGB37-520 motor through a BTS7960 driver. All real-time motor control runs on the ESP32-S3 at 50 Hz (20 ms cycle). The Raspberry Pi 5 sends velocity commands and receives telemetry via a JSON-over-UART protocol. The web frontend visualizes motor state and trajectory.

```
┌─────────────────────────────────────────────────────────────┐
│  ESP32-S3 (real-time, firmware/src/)                        │
│  - PID loop: target RPM → encoder feedback → PWM output     │
│  - Mecanum kinematics: (vx,vy,ω) → (FL,FR,RL,RR)          │
│  - Sensors: BNO055, INA226, VL53L0X, Sharp, 4× IR          │
│  - UART JSON protocol → Pi 5                                │
└───────────────────────────┬─────────────────────────────────┘
                            │ USB CDC (115200 baud, JSON)
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  Raspberry Pi 5 (services/robot/)                           │
│  - esp32_telemetry_node.py: UART → ROS 2 topics            │
│  - web_bridge.py: ROS 2 → WebSocket :9091                  │
│  - brain_node.py: state machine, Nav2, SLAM                │
└───────────────────────────┬─────────────────────────────────┘
                            │ WebSocket :9091 (JSON)
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  Web Frontend (apps/web/)                                   │
│  - /map: SLAM 2D visualization                              │
│  - /trajectory: 3D BNO055 orientation trail                 │
│  - /telemetry: live motor/sensor data                       │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Motor & Driver Architecture

### 2.1 Hardware

| Component | Qty | Role |
|-----------|-----|------|
| JGB37-520 DC motor | 4 | 12 V, 333 RPM (no-load), 30:1 gearbox |
| JGB37-520 encoder | 4 | Hall-effect quadrature, 11 PPR motor shaft → 660 CPR output |
| BTS7960 driver board | 4 | 43 A peak, 20 kHz PWM, forward/reverse/brake |
| Mecanum wheel | 4 | 97 mm, X-pattern layout |

### 2.2 Pin Map (ESP32-S3 → BTS7960 → Motor)

| Motor | RPWM | LPWM | EN | Encoder CHA | Encoder CHB | PCNT Unit |
|-------|------|------|----|-------------|-------------|-----------|
| FL | GPIO 12 | GPIO 13 | GPIO 3 | GPIO 40 | GPIO 41 | 0 |
| FR | GPIO 14 | GPIO 15 | GPIO 7 | GPIO 42 | GPIO 6 | 1 |
| RL | GPIO 16 | GPIO 17 | GPIO 48 | GPIO 4 | GPIO 5 | 2 |
| RR | GPIO 38 | GPIO 39 | GPIO 47 | GPIO 20 | GPIO 21 | 3 |

### 2.3 Signal Path (one command tick, 20 ms)

```
F80 command received
  → handleForward(80)
      g_nav_vx = 80, g_nav_vy = 0, g_nav_omega = 0

loop() PID tick (every 20 ms):
  → computeNavTargets()
      g_obstacle.applyToCommand(vx,vy,ω)  // IR/Sharp obstacle override
      g_mecanum.compute(vx,vy,ω, target[])  // kinematics → 4 wheel targets

  → applySpeeds()   [per wheel i = 0..3]
      ramp: target → ramped (Δ ≤ 50 per tick)
      scale: max_speed_pct / 100
      kick boost: +255 PWM for first 15 ticks if motor just started
      target_rpm = limited × 333 / 511              ← FIXED (was 333/255)
      PID: err = target_rpm − actual_rpm
           corr = Kp·err + Ki·∫err + Kd·d(err)/dt
      final_pwm = clamp(limited + corr, ±511)
      motor_cmd = final_pwm × dir
      → g_motors[i].setSpeed(motor_cmd)
          BTS7960: RPWM = duty (speed > 0) / LPWM = duty (speed < 0)
                   EN = HIGH always
```

### 2.4 Mecanum Kinematics

```
FL = vx − vy + ω
FR = vx + vy − ω
RL = vx + vy + ω
RR = vx − vy − ω

normalize: if any |speed[i]| > 255, all scaled proportionally
dir: FL/RL = +1, FR/RR = −1 (reversed wiring)
```

### 2.5 Encoder → RPM

```
counts/output rev = 11 PPR × 2 (x2 decode) × 30 (gearbox) = 660
RPM = (delta_counts / dt_ms) × (60000 / 660)
filter: EMA alpha = 0.3
```

---

## 3. UART JSON Protocol (ESP32 ↔ Pi)

### 3.1 Pi → ESP32 (commands)

| JSON | ASCII equivalent | Effect |
|------|-----------------|--------|
| `{"cmd":"move","vx":N,"vy":N,"omega":N}` | F/B/L/R/Q/E | Set navigation velocity |
| `{"cmd":"individual","speeds":[fl,fr,rl,rr]}` | M fl fr rl rr | Direct per-wheel PWM |
| `{"cmd":"stop"}` | S | Brake all motors |
| `{"cmd":"e_stop"}` | D | Emergency stop (disable drivers) |
| `{"cmd":"heartbeat"}` | Z | Reset 2 s watchdog |
| `{"cmd":"get_encoder"}` | — | Request encoder snapshot (type 130) |
| `{"cmd":"get_imu"}` | I | Request IMU reading (type 134) |

### 3.2 ESP32 → Pi (telemetry)

| Type | Name | Rate | Content |
|------|------|------|---------|
| 130 | Encoder snapshot | 10 Hz | 4× {id, name, tgt, rpm, cnt} |
| 131 | Status | 2 Hz | mode, e_stop, nav, motors, ir, sharp, tof, cyl |
| 132 | Move ACK | on cmd | seq, accepted/rejected |
| 133 | Power | 1 Hz | voltage, current, power, battery_pct, status |
| 134 | IMU | 20 Hz | heading, accel_xyz, gyro_z, quaternion, cal |
| 135 | IR proximity | 20 Hz | rear_left, rear_right, left, right |
| 136 | Sharp distance | 20 Hz | distance_cm, too_close, slowing |
| 138 | TOF distance | 10 Hz | distance_mm, at_unload, present |
| 141 | Alive | 2 Hz | uptime, alive counter, e_stop, mode |
| 142 | Health | 1 Hz | all module states (ONLINE/WARNING/FAILED) |

### 3.3 Mode State Machine

```
         ┌──── Pi heartbeat ────┐
         │                      │
    ┌────▼────┐            ┌────▼────┐
    │  NAV    │◄──timeout──│  SAFE   │
    └────┬────┘   (2 s)    └─────────┘
         │
    Pi sends move()
         │
    ┌────▼────┐
    │ RUNNING │
    └────┬────┘
         │
    Pi disconnects > 10 s
         │
    ┌────▼─────┐
    │ AUTO_ROAM│ (sensor-only, no Pi)
    └──────────┘
```

---

## 4. Sensor Fusion (all on shared I2C bus GPIO 10/11)

| Sensor | Address | Bus freq | Output | Used by |
|--------|---------|----------|--------|---------|
| BNO055 | 0x28 | 100 kHz | heading, accel_xyz, gyro_z, quaternion | Heading gate (docking), SLAM pose correction, 3D trajectory |
| VL53L0X | 0x29 | 100 kHz | distance_mm (rear, 30–2000 mm) | Unload alignment (target 40 mm) |
| INA226 | 0x40 | 100 kHz | voltage, current, power | Battery SOC, low-battery e-stop |

### I2C bus requirements
- **External pull-ups: REQUIRED** — ESP32-S3 internal (~45 kΩ) are too weak for 3 devices
- Pull 2.2 kΩ–4.7 kΩ from SDA → 3.3V and SCL → 3.3V (one pair, shared)
- BNO055 CJMCU-055 clones clock-stretch — keep bus at 100 kHz (not 400 kHz)
- ADR/COM3 pin on BNO055 must be LOW (0x28) to avoid VL53L0X address collision

---

## 5. Power System

```
21V PSU (or 3S 18650 battery)
  ├─ Buck → 12V (BTS7960 VM, motor windings)
  ├─ Buck → 5V (logic: BTS7960 VCC, E18-D80NK, Sharp)
  └─ INA226 (CJMCU-226): shunt 10 mΩ in series with load
       VIN+ ── positive rail
       VIN− ── load side
       SDA/SCL ── shared I2C bus

ESP32-S3 3.3V (internal regulator)
  └─ BNO055, VL53L0X, INA226 logic
```

**INA226 note:** The INA226 shunt resistor must be wired IN SERIES with the load (between VIN+ and VIN−). If VIN+/VIN− are shorted or not connected to the actual power rail, the current reading will show a false offset (~8 A ghost current). Firmware now checks `bus_voltage < 0.05 V` and reports 0/0 in that case.

---

## 6. Firmware Modules (all in `firmware/src/modules/`)

| Module | File | Purpose |
|--------|------|---------|
| Motor driver | BTS7960Driver.cpp | PWM output via LEDC, forward/reverse/brake/coast/e-stop |
| Encoder | Encoder.cpp | PCNT hardware counter, RPM calculation, overflow handling |
| PID | PIDController.cpp | Speed PID with anti-windup, configurable gains |
| Mecanum | MecanumDrive.cpp | Inverse kinematics: (vx,vy,ω) → 4 wheel speeds |
| BNO055 | BNO055Sensor.cpp | I2C driver, NDOF fusion, heading/accel/gyro/quaternion |
| INA226 | INA226Sensor.cpp | I2C driver, bus voltage/current/power, battery SOC |
| VL53L0X | VL53L0XSensor.cpp | I2C driver (Pololu library), continuous distance |
| Sharp | SharpFrontSensor.cpp | ADC 12-bit, voltage-based distance formula |
| IR | IRProximitySensor.cpp | 4× E18-D80NK, debounce, absent-sensor detection |
| Cylinder | CylinderActuator.cpp | L298N extend/retract, 8 s safety timeout |
| Watchdog | Watchdog.cpp | Mode state machine (NAV/SAFE/AUTO_ROAM/MANUAL) |
| ModeManager | ModeManager.cpp | Coordinates mode, sensor reads, motor outputs |
| HealthMonitor | HealthMonitor.cpp | Per-module staleness, type 142 JSON emission |
| CommandParser | CommandParser.cpp | ASCII + JSON command parsing |
| JsonStatus | JsonStatus.cpp | All type-N JSON serialization |
| I2C bus | I2CBus.cpp | 9-clock bus recovery, hung-bus detection |

---

## 7. PID Tuning & Motor Control Details

### Current PID gains (default)
```
Kp = 2.5,  Ki = 0.2,  Kd = 0.05
Update rate: 50 Hz (20 ms)
Integral limit: ±400
Output limit: ±511 (MOTOR_MAX_DUTY)
```

### PWM → RPM conversion (fixed)
```cpp
// BEFORE (bug — used 255):
float target_rpm = limited * (333.0f / 255.0f);   // ← PWM 305 → 398 RPM (wrong)

// AFTER (fixed — uses MOTOR_MAX_DUTY = 511):
float target_rpm = limited * (333.0f / 511.0f);   // ← PWM 305 → 199 RPM (correct)
```

### Kick-start boost
- Applied for first 15 PID ticks (~300 ms) after motor starts from zero
- Adds 255 PWM to overcome static friction of JGB37-520 gearbox
- Prevents PID from fighting against zero actual RPM at startup

### Acceleration ramp
- Max PWM change per tick: 50 units
- Full 0→511 ramp in ~10 ticks (200 ms)
- Prevents sudden mechanical shock

---

## 8. Obstacle Avoidance (local sensors)

### Sharp GP2Y0A21YK0F (front, analog)
- Distance: 10–80 cm (reliable range)
- Formula: `d = 118.76 / V_out + 0.42` cm (5V supply characteristic)
- ADC: ESP32-S3 12-bit @ 3.3V reference
- Hard-stop: < 15 cm → `isTooClose()`
- Slow-down: < 60 cm → `isSlowing()`
- Rate: 50 Hz (20 ms poll)

### E18-D80NK IR proximity (4×)
| Position | GPIO | Detect range | Polarity |
|----------|------|-------------|----------|
| Rear-left | 1 | ~8 cm | LOW = obstacle |
| Rear-right | 8 | ~8 cm | LOW = obstacle |
| Left | 45 | ~5 cm | LOW = obstacle |
| Right | 46 | ~5 cm | LOW = obstacle |

- Debounce: 50 ms
- Boot-time absent-sensor detection: if GPIO reads LOW at boot, sensor marked absent for entire session
- Obstacle direction logic: l|r → FRONT, rl|rr → REAR, l only → LEFT, r only → RIGHT

### Reactive dodge (ObstacleAvoidance module)
- If obstacle detected, `g_obstacle.applyToCommand()` modifies the nav velocity:
  - Strafe away from obstacle direction
  - Duration: 800 ms (DODGE_DURATION_MS)
  - Strafe speed: 100 PWM (DODGE_STRAFE_SPEED)

---

## 9. Known Issues & Fixes (this session)

### ✅ Fixed — PWM→RPM scale (255 → 511)
- **File:** `firmware/src/main.cpp:365`, `firmware/src/modules/ModeManager.cpp:173`
- **Before:** `target_rpm = limited * (333.0f / 255.0f)` — PWM 305 → 398 RPM (2× too high)
- **After:** `target_rpm = limited * (333.0f / (float)MOTOR_MAX_DUTY)` — PWM 305 → 199 RPM (correct)
- **Impact:** PID was always saturated at max correction, integral wind-up, motor running uncontrolled

### ✅ Fixed — Sharp sensor LUT (10-bit 5V → 12-bit 3.3V)
- **File:** `firmware/src/modules/SharpFrontSensor.cpp`
- **Before:** 256-byte LUT calibrated for 10-bit ADC at 5V supply
- **After:** Voltage-based formula: `d = 118.76 / V_out + 0.42`, ADC raw → voltage conversion for 12-bit @ 3.3V
- **Impact:** 8 cm false detection when sensor is actually 30+ cm away

### ✅ Fixed — INA226 ghost current (0 V but 8 A)
- **File:** `firmware/src/modules/INA226Sensor.cpp:84-90`
- **Before:** `current_ = 8.19A` reported even when `bus_voltage_ = 0V` (shunt disconnected)
- **After:** Sanity check: if `bus_voltage_ < 0.05V`, zero out current/power/SOC
- **Impact:** Pi dashboard shows "critical" battery when INA226 is not wired

### ⚠️ Documented — HealthMonitor stale thresholds
- IMU stale threshold increased from 500 ms → 2000 ms (matches 1 Hz read cycle)
- Other modules (encoders, IR, sharp, TOF) kept at 200 ms — correct for their actual read rates

---

## 10. Hardware Bring-up Checklist

> **This section covers what firmware CANNOT fix — physical wiring/assembly issues.**

### 10.1 Motor does not run (all 4)

| Check | Tool | Expected | Fix |
|-------|------|----------|-----|
| BTS7960 VM ↔ GND | Multimeter | 12V | Connect 12V rail to BTS7960 VM |
| BTS7960 VCC ↔ GND | Multimeter | 5V | Connect 5V logic supply |
| ESP32 3.3V ↔ GND | Multimeter | 3.3V | Verify ESP32 power |
| RPWM signal (bottest) | Oscilloscope | 20 kHz, duty > 0% | Check GPIO→BTS7960 wiring |
| EN pin HIGH | Multimeter | 3.3V | ESP32 GPIO should be HIGH |
| Motor wires (OUT+/OUT−) | Multimeter (continuity) | Beep | Re-solder loose wires |

### 10.2 One motor not running

| Check | Tool | Expected | Fix |
|-------|------|----------|-----|
| Motor wire continuity | Multimeter | ~10–50 Ω coil | Replace motor or re-solder |
| BTS7960 enable | Multimeter | HIGH at EN pin | Check GPIO → EN trace |
| Encoder CHA pulse | Oscilloscope (while spinning by hand) | Square wave | Re-check encoder wiring |

### 10.3 RPM reads 0 but motor runs

| Check | Tool | Expected | Fix |
|-------|------|----------|-----|
| Encoder VCC | Multimeter | 3.3V or 5V | Power encoder supply |
| Encoder GND | Multimeter | 0V (shared with ESP32) | Ensure common ground |
| CHA/CHB swap | Oscilloscope | Two square waves 90° offset | Swap CHA↔CHB if inverted |

### 10.4 INA226 shows 0 V but battery is connected

| Check | Tool | Expected | Fix |
|-------|------|----------|-----|
| INA226 VIN+ | Multimeter | Battery voltage | Wire VIN+ to positive rail |
| INA226 VIN− | Multimeter | 0V (load side) | Wire VIN− after shunt |
| Shunt resistor | Visual | 10 mΩ in series | Ensure shunt is between VIN+ and VIN− |

---

## 11. UART Mode vs USB CDC

The ESP32-S3 WeAct N16R8 has **no USB-UART bridge chip**. The USB-C port is native USB CDC (CDC on boot). UART0 (GPIO 43/44) is free hardware UART.

Current firmware uses:
```cpp
#define PiSerial Serial    // = USB CDC (when CONFIG_ARDUINO_USB_CDC_ON_BOOT=1)
```

To switch to hardware UART2 (GPIO 43/44):
```cpp
#define PiSerial Serial1   // UART2 on GPIO 43 (TX) / GPIO 44 (RX)
// AND set CONFIG_ARDUINO_USB_CDC_ON_BOOT=0 in platformio.ini
```

Both Pi 5 and PC/USB monitor share the same serial — non-JSON lines are ignored by the Pi parser. The Pi reads this as `/dev/ttyACM0` (USB CDC) or `/dev/ttyUSB0` (UART via CH343 bridge).

---

## 12. Safety & Watchdog

| Feature | Behavior |
|---------|----------|
| Heartbeat timeout | 2 s — if Pi stops sending, ESP32 enters SAFE mode (keeps last command) |
| E-stop | Immediate: all EN pins LOW, all PWM 0. Requires explicit "clear" command |
| Cylinder timeout | 8 s max extension — auto-stops to prevent mechanical damage |
| Motor kick boost | 15 ticks (~300 ms) — prevents stalling at startup without overheating |
| Health monitor | Per-module staleness: ONLINE → WARNING → RECOVERING → FAILED. Critical modules (IMU, encoders, motors) trigger e-stop on FAILED |

---

## 13. Test Procedure (bench, no Pi)

1. Flash firmware via PlatformIO (`pio run --target upload`)
2. Open serial monitor (COM8, 115200 baud)
3. Verify boot: 3 I2C devices found, BNO055 NDOF mode OK
4. Send `F100` → motors should run forward at ~100/255 PWM
5. Send `I` → verify heading/accel/gyro JSON
6. Send `V` → full status JSON
7. Send `S` → stop
8. Send `T` → auto test sequence (forward 50→200→0)
9. Check: encoders increment when motor runs
10. Check: Sharp distance responds to objects in front

### What to expect in the serial log after PID fix:
```
[FL] tgt=100 ramp=50 lim=268 tgtRPM=173 actRPM=168 corr=+12 pwm=280 cmd=280 dir=1
```
- `tgtRPM=173` (correct, was 346 before fix)
- `corr=+12` (PID making small correction, not saturated at ±511)
