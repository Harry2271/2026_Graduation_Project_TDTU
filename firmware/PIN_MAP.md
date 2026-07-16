# ESP32-S3 WeAct N16R8 — Pin Map & Wiring Reference

## Overview

```
                          ┌──────────────────────────────┐
                          │      Raspberry Pi 5          │
                          │   ROS2 + SLAM + Nav2         │
                          │   RPLIDAR A1M8-R6 (USB)     │
                          │   Logitech BRIO 100 (USB)   │
                          └──────────────┬───────────────┘
                                         │
                              UART 115200 8N1 (GPIO 43/44)
                              JSON: move, heartbeat,
                                    obstacle_*, status, imu, power
                                         │
                          ┌──────────────▼───────────────┐
                          │      ESP32-S3 WeAct          │
                          │      N16R8 (16MB Flash)      │
                          │      (8MB Octal PSRAM)       │
                          └──────────────────────────────┘
```

---

## Motor Drivers — 4× BTS7960

| Motor | Role | RPWM | LPWM | EN | Direction | LEDC Ch |
|-------|------|------|------|----|-----------|---------|
| **FL** | Front-Left | GPIO **12** | GPIO **13** | GPIO **3** | +1 (normal) | RPWM=ch0, LPWM=ch4 |
| **FR** | Front-Right | GPIO **14** | GPIO **15** | GPIO **7** | -1 (reversed) | RPWM=ch1, LPWM=ch5 |
| **RL** | Rear-Left | GPIO **16** | GPIO **17** | GPIO **48** | +1 (normal) | RPWM=ch2, LPWM=6 |
| **RR** | Rear-Right | GPIO **38** | GPIO **39** | GPIO **47** | -1 (reversed) | RPWM=ch3, LPWM=7 |

### BTS7960 Wiring Per Driver

```
          ESP32-S3
            │
  RPWM ◄────┤ GPIO (PWM, 20kHz, 10-bit)
  LPWM ◄────┤ GPIO (PWM, 20kHz, 10-bit)
  R_EN ◄────┤ GPIO (HIGH = enabled)   ← R_EN + L_EN merged
  L_EN ◄────┘
            │
          BTS7960 Driver Board
            │
  B+  ◄─────┤ 21V supply rail (via VM terminal)
  GND ◄─────┤ Common ground  ⚠ MUST share with ESP32, Pi, all drivers
  VCC ◄─────┤ 5V buck converter (logic)
            │
  OUT+ ─────► JGB37-520 Motor M1
  OUT- ─────► JGB37-520 Motor M2
```

**Control Logic:**
- Forward: `RPWM = PWM value, LPWM = LOW, EN = HIGH`
- Reverse: `RPWM = LOW, LPWM = PWM value, EN = HIGH`
- Brake: `RPWM = HIGH, LPWM = HIGH` (both high-side FETs on)
- Coast: `RPWM = LOW, LPWM = LOW` (both low-side FETs on)
- Disabled: `EN = LOW`

---

## Encoders — 4× JGB37-520 Hall Effect Quadrature

| Motor | Encoder CHA | Encoder CHB | PCNT Unit |
|-------|-------------|-------------|-----------|
| **FL** | GPIO **40** | GPIO **41** | PCNT_UNIT_0 |
| **FR** | GPIO **42** | GPIO **6** | PCNT_UNIT_1 |
| **RL** | GPIO **4** | GPIO **5** | PCNT_UNIT_2 |
| **RR** | GPIO **20** | GPIO **21** | PCNT_UNIT_3 |

### Encoder Wiring

```
          JGB37-520 Encoder
            │
  VCC ◄─────┤ 3.3V or 5V (check motor spec)
  GND ◄─────┤ Common ground
  CHA ──────► ESP32 GPIO (INPUT_PULLUP, x2 decoding)
  CHB ──────► ESP32 GPIO (INPUT_PULLUP, x2 decoding)
```

- Hardware PCNT counters — zero CPU overhead
- 11 PPR on motor shaft × 30:1 gear ratio = 330 pulses/rev at output shaft
- x2 decoding → 660 counts/rev at output shaft

---

## IR Proximity Sensors — 4× E18-D80NK

| Position | GPIO | Description | Detect Range |
|----------|------|-------------|-------------|
| **REAR_LEFT** | GPIO **1** | Behind-left corner | ~8 cm (tunable) |
| **REAR_RIGHT** | GPIO **8** | Behind-right corner | ~8 cm (tunable) |
| **LEFT** | GPIO **45** | Left side | ~5 cm (tunable) |
| **RIGHT** | GPIO **46** | Right side | ~5 cm (tunable) |

### E18-D80NK Wiring

```
          E18-D80NK Sensor
            │
  VCC ◄─────┤ 5V (or 3.3V — check version)
  GND ◄─────┤ Common ground
  OUT ──────► ESP32 GPIO (INPUT_PULLUP)
            │
  Potentiometer ◄── Adjust detection range (5-80 cm)
```

- Active-LOW: `LOW` = obstacle detected, `HIGH` = clear
- Polled at 50 Hz (`IR_SENSOR_POLL_MS = 20`)
- Debounce: 50 ms (`IR_DEBOUNCE_MS`)

> ⚠️ GPIO 45 & 46 are **strapping pins** — safe as input after boot completes.

---

## Sharp GP2Y0A21YK0F — Front Distance Sensor (Analog)

| Function | GPIO |
|----------|------|
| **Analog Out** | GPIO **9** (ADC1_CH8) |

### Sharp Sensor Wiring

```
          Sharp GP2Y0A21YK0F
            │
  VCC ◄─────┤ 5V
  GND ◄─────┤ Common ground
  Vout ─────► ESP32 GPIO 9 (analog read, 10-bit ADC)
            │
  Output: 0.3V (far) → 3.0V (10cm)
  Range: 10–80 cm
  Hard-stop threshold: < 30 cm
  Slow-down zone: < 60 cm
```

> ⚠️ GPIO 9 is a strapping pin — safe as ADC input after boot.

---

## VL53L0X V2 — TOF Laser Distance Sensor (Rear, I2C)

| Parameter | Value |
|-----------|-------|
| **I2C Address** | **0x29** |
| **I2C Bus** | Shared with BNO055 (0x28) + INA226 (0x40) on GPIO 10/11 |
| **Range** | 30 mm – 2000 mm |
| **Measurement Budget** | 33 ms (high-accuracy mode) |
| **Poll Rate** | 20 Hz (every 50 ms) |
| **Target Distance** | **40 mm** (4 cm — runtime configurable via `target_distance_mm` JSON field) |
| **Tolerance** | ±10 mm (±1 cm) |
| **Mounting** | Rear of vehicle, pointing at warehouse floor / dock surface |

### VL53L0X Wiring

```
          VL53L0X V2 Sensor (Pololu)
            │
  VIN ◄─────┤ 3.3V or 5V (module-dependent)
  GND ◄─────┤ Common ground
  SDA ◄────► ESP32 GPIO 10  ┐ (shared I2C bus)
  SCL ◄────► ESP32 GPIO 11  ┤
            │                ├─ BNO055 (0x28)
          (no new GPIOs)     ├─ INA226 (0x40)
                             └─ VL53L0X (0x29)
```

> The VL53L0X adds zero new GPIOs — uses the existing shared I2C bus. Pin-shield on module lets you re-address if needed; default 0x29 works here.

---

## L298N Motor Driver + 12VDC Electric Cylinder (Dump-Body Lift)

| Function | GPIO | Notes |
|----------|------|-------|
| **IN1** (L298N extend) | GPIO **2** | HIGH = cylinder extends (lifts dump body) |
| **IN2** (L298N retract) | GPIO **35** | HIGH = cylinder retracts (lowers dump body) |
| **ENA** | Tied HIGH on L298N (jumper) | No PWM — full-speed on/off only |

| Parameter | Value |
|-----------|-------|
| Cylinder supply | **12 VDC** (from 21→12V buck) |
| L298N supply | **12 V** (VM) for motor, 5V for logic |
| Max run time | **8 000 ms** (safety auto-stop) |
| Hold-at-top time | **3 000 ms** (dump window) |
| Mounting | Cylinder base on chassis, rod attached to dump body |

### L298N + Cylinder Wiring

```
          ESP32-S3
            │
  IN1  ◄────┤ GPIO 2    (cylinder extend → lift)
  IN2  ◄────┤ GPIO 35   (cylinder retract → lower)
            │
          L298N Driver Board
            │
  ENA ──────┤ Tied HIGH (jumper in place)
            │
  +12V ◄────┤ 12V rail (from 21→12V buck)
  GND ◄─────┤ Common ground  ⚠ MUST share with ESP32
            │
  OUT1 ─────► Electric Cylinder M1 (+)
  OUT2 ─────► Electric Cylinder M2 (−)
```

**Control Logic:**
- **Extend (lift):** `IN1 = HIGH, IN2 = LOW` → cylinder rod pushes out, dump body rises
- **Retract (lower):** `IN1 = LOW, IN2 = HIGH` → cylinder rod pulls in, dump body lowers
- **Stop (brake):** `IN1 = LOW, IN2 = LOW` → both low-side FETs on, motor freewheel

> ⚠️ On ESP32-S3, GPIO **36 and 37** are input-only (no output driver). GPIO **35 is fine** for L298N IN2 (has output driver). Only use 36/37 for ADC / digital input.

---

## UART — ESP32-S3 ↔ Raspberry Pi 5 (Protocol Update)

## BNO055 IMU — 9-DOF (I2C)

| Function | GPIO | Notes |
|----------|------|-------|
| **SDA** | GPIO **10** | Shared I2C bus |
| **SCL** | GPIO **11** | Shared I2C bus |

| Parameter | Value |
|-----------|-------|
| I2C Address | **0x28** |
| I2C Frequency | **400 kHz** |
| Publish Rate | **20 Hz** (every 50 ms) |
| Mode | NDOF (sensor fusion) |

### BNO055 Wiring

```
          BNO055 Module
            │
  VIN ◄─────┤ 3.3V or 5V (check module)
  GND ◄─────┤ Common ground
  SDA ◄────► ESP32 GPIO 10 ──┐ (shared I2C bus)
  SCL ◄────► ESP32 GPIO 11 ──┤
            │                 │
          INA226 ─────────────┘ (same bus, addr 0x40)
```

---

## INA226 Power Monitor (CJMCU-226, I2C)

| Function | GPIO | Notes |
|----------|------|-------|
| **SDA** | GPIO **10** | Same bus as BNO055 |
| **SCL** | GPIO **11** | Same bus as BNO055 |

| Parameter | Value |
|-----------|-------|
| I2C Address | **0x40** |
| Shunt Resistor | **10 mΩ** |
| Publish Rate | **0.2 Hz** (every 5 s) |
| Measures | Bus voltage, current, power |

---

## UART — ESP32-S3 ↔ Raspberry Pi 5

| Function | GPIO | Notes |
|----------|------|-------|
| **TX** → Pi RX | GPIO **43** | Send telemetry, status, ACKs |
| **RX** ← Pi TX | GPIO **44** | Receive commands |

| Parameter | Value |
|-----------|-------|
| Baud Rate | **115200** |
| Format | **8N1** |
| Framing | JSON, newline-terminated (`\n`) |

> WeAct N16R8 has **no USB-UART bridge chip** — UART0 (43/44) is free.
> USB-C port = native USB CDC (for flashing/debug only, appears as `/dev/ttyACM0` on Pi).

### Docking / Unloading Protocol (added July 2026)

ESP32-side docking state machine triggered by Pi after AprilTag + IR-side alignment.

**Pi → ESP32 (JSON):**

| Command | Purpose | Required Fields | Optional |
|---------|---------|-----------------|----------|
| `begin_dock` | Start docking + unloading sequence | `tag_id` (AprilTag ID Pi verified) | `target_distance_mm` (default 40) |
| `begin_leave_dock` | Skip unloading, just leave | — | — |
| `cancel_dock` | Abort sequence at any state | — | — |
| `get_unload_state` | Query current state (returns type 140) | — | — |

Example trigger:
```json
{"cmd":"begin_dock","tag_id":42,"target_distance_mm":40}
```

**ESP32 → Pi (JSON, line-delimited):**

| Type | Trigger | Fields |
|------|---------|--------|
| **138** | TOF distance query | `distance_mm`, `distance_cm`, `at_unload`, `present` |
| **139** | Cylinder state query | `state`, `extended`, `moving` |
| **140** | On every unload state transition + on query | `state`, `tag_id`, `target_mm`, `current_mm`, `heading_err_deg`, `heading_ok`, `cyl`, `ts` |

State progression in type 140:
```
idle → adjusting → extending → holding → retracting → done →
  leaving → complete → idle
```

**Safety gates (both must hold to advance from `adjusting` to `extending`):**
1. VL53L0X distance ≤ `target_distance_mm` ± tolerance (runtime-targetable)
2. BNO055 heading error ≤ `HEADING_GATE_DEG` (2°)

**Leave-dock reverse:** 30 cm reverse with encoder tracking + heading-hold via BNO055, 8 s safety timeout.

---

## USB-C — Native USB CDC (Flashing & Debug)

| Function | GPIO | Notes |
|----------|------|-------|
| **D-** | GPIO **18** | Safe when CDC disabled |
| **D+** | GPIO **19** | Safe when CDC disabled |

---

## Full GPIO Allocation Table

| GPIO | Assigned To | Direction | Notes |
|------|-------------|-----------|-------|
| **0** | — | Strapping | BOOT button — do not use |
| **1** | IR REAR_LEFT | INPUT | Proximity sensor |
| **2** | L298N IN1 (cylinder extend) | OUTPUT | Cylinder lift up |
| **3** | Motor FL EN | OUTPUT | BTS7960 enable |
| **4** | Encoder RL CHA | INPUT | PCNT unit 2 |
| **5** | Encoder RL CHB | INPUT | PCNT unit 2 |
| **6** | Encoder FR CHB | INPUT | PCNT unit 1 |
| **7** | Motor FR EN | OUTPUT | BTS7960 enable |
| **8** | IR REAR_RIGHT | INPUT | Proximity sensor |
| **9** | Sharp Front | INPUT (ADC) | Strapping pin — safe after boot |
| **10** | I2C SDA | BIDIR | BNO055 + INA226 + VL53L0X shared bus |
| **11** | I2C SCL | OUTPUT | BNO055 + INA226 + VL53L0X shared bus |
| **12** | Motor FL RPWM | OUTPUT | BTS7960 PWM forward |
| **13** | Motor FL LPWM | OUTPUT | BTS7960 PWM reverse |
| **14** | Motor FR RPWM | OUTPUT | BTS7960 PWM forward |
| **15** | Motor FR LPWM | OUTPUT | BTS7960 PWM reverse |
| **16** | Motor RL RPWM | OUTPUT | BTS7960 PWM forward |
| **17** | Motor RL LPWM | OUTPUT | BTS7960 PWM reverse |
| **18** | USB D- | — | Native USB CDC (safe with `CDC_ON_BOOT=0`) |
| **19** | USB D+ | — | Native USB CDC (safe with `CDC_ON_BOOT=0`) |
| **20** | Encoder RR CHA | INPUT | PCNT unit 3 |
| **21** | Encoder RR CHB | INPUT | PCNT unit 3 |
| **22-25** | — | N/A | **Not available on WROOM-1U module** |
| **35** | L298N IN2 (cylinder retract) | OUTPUT | Cylinder pull down |
| **36** | — | Free | ⚠ INPUT-ONLY (no output driver) |
| **37** | — | Free | ⚠ INPUT-ONLY (no output driver) |
| **38** | Motor RR RPWM | OUTPUT | BTS7960 PWM forward |
| **39** | Motor RR LPWM | OUTPUT | BTS7960 PWM reverse |
| **40** | Encoder FL CHA | INPUT | PCNT unit 0 |
| **41** | Encoder FL CHB | INPUT | PCNT unit 0 |
| **42** | Encoder FR CHA | INPUT | PCNT unit 1 |
| **43** | UART TX | OUTPUT | To Raspberry Pi RX |
| **44** | UART RX | INPUT | From Raspberry Pi TX |
| **45** | IR LEFT | INPUT | Strapping pin — safe after boot |
| **46** | IR RIGHT | INPUT | Strapping pin — safe after boot |
| **47** | Motor RR EN | OUTPUT | BTS7960 enable |
| **48** | Motor RL EN | OUTPUT | BTS7960 enable |

**Summary:** 30 GPIO used, 2 free input-only (36, 37), 4 unavailable (22-25). All 8 LEDC channels consumed by 4 motors.

---

## Power Distribution

```
                    21V External PSU
                         │
                ┌────────┼────────┐
                │        │        │
                ▼        ▼        ▼
          Buck 21→12V  Buck 21→5V  INA226
          (motors)     (logic)    (monitor)
                │        │        │
                ▼        ▼        ▼
          ┌──────────┐  ┌─────┐  ┌─────┐
          │ 4× BTS7960│  │ESP32│  │ I2C │
          │ (VM pins) │  │ 3.3V│  │bus  │
          └──────────┘  └─────┘  └─────┘
                              │      │
                         ┌────┘      └────┐
                         ▼                ▼
                    BNO055            INA226
                    (0x28)            (0x40)
```

| Rail | Voltage | Powers |
|------|---------|--------|
| VM (BTS7960) | **12V** (bucked from 21V) | Motor windings |
| Logic 5V | **5V** (bucked from 21V) | BTS7960 VCC, E18-D80NK, Sharp |
| Logic 3.3V | **3.3V** (ESP32 internal or buck) | BNO055, INA226, encoder pullups |
| Battery (planned) | **11.1V nom** (3S 18650) | Replace 21V PSU |

> ⚠️ **ALL modules MUST share a common ground** — ESP32, Pi, all BTS7960s, all sensors, all power supplies.
