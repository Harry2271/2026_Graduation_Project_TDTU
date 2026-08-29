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
                              USB CDC (native USB)
                              /dev/ttyACM0 on Raspberry Pi 5
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
| **FL** | Front-Left | GPIO **12** | GPIO **13** | GPIO **3** | -1 (reversed) | RPWM=ch0, LPWM=ch4 |
| **FR** | Front-Right | GPIO **14** | GPIO **15** | GPIO **7** | +1 (normal) | RPWM=ch1, LPWM=ch5 |
| **RL** | Rear-Left | GPIO **16** | GPIO **17** | GPIO **48** | -1 (reversed) | RPWM=ch2, LPWM=ch6 |
| **RR** | Rear-Right | GPIO **38** | GPIO **39** | GPIO **47** | +1 (normal) | RPWM=ch3, LPWM=ch7 |

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
| **REAR_RIGHT** | GPIO **37** | Behind-right corner | ~8 cm (tunable) |
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

## Front ToF400C — VL53L1X Laser Distance Sensor (I2C)

The analog Sharp GP2Y0A21YK0F has been removed. The front sensor is now a
VL53L1X/TOF400C and is the authoritative close-range forward safety sensor.

| Function | Connection | Notes |
|----------|------------|-------|
| **VIN** | 3.3V or 5V | Follow the carrier-board rating |
| **GND** | Common ground | Must share ground with ESP32 and all I2C devices |
| **SDA** | GPIO **10** | Shared I2C bus |
| **SCL** | GPIO **11** | Shared I2C bus |
| **XSHUT** | GPIO **9** | Active-LOW hardware shutdown/address sequencing; strapping pin, safe after boot |

| Parameter | Value |
|-----------|-------|
| **Boot/default I2C address** | **0x29** |
| **Runtime assigned address** | **0x31** |
| **Range** | Up to approximately 4000 mm (carrier/target dependent) |
| **Poll rate** | 20 Hz (every 50 ms) |
| **Stop threshold** | 15 cm |
| **Slow-down zone** | 60 cm |
| **Safety behavior** | Missing, invalid, timed-out, or stale data blocks forward travel |
| **Telemetry** | Type 136; canonical `front_tof`, legacy `sharp` alias retained |

---

## VL53L0X V2 — TOF Laser Distance Sensor (Rear, I2C)

| Function | Connection | Notes |
|----------|------------|-------|
| **VIN** | 3.3V or 5V | Follow the carrier-board rating |
| **GND** | Common ground | Must share ground with ESP32 and all I2C devices |
| **SDA** | GPIO **10** | Shared I2C bus |
| **SCL** | GPIO **11** | Shared I2C bus |
| **XSHUT** | GPIO **8** | Active-LOW hardware shutdown/address sequencing |

| Parameter | Value |
|-----------|-------|
| **Boot/default I2C address** | **0x29** |
| **Runtime assigned address** | **0x30** |
| **I2C bus** | GPIO 10/11 at 100 kHz |
| **Range** | 30 mm – 2000 mm |
| **Poll rate** | 20 Hz (every 50 ms) |
| **Target distance** | 40 mm (runtime configurable) |
| **Mounting** | Rear of vehicle, pointing at dock surface |
| **Telemetry** | Type 138; docking/alignment only |

### Shared I2C ToF Wiring and XSHUT Sequencing

```
  ESP32-S3 WeAct                         Shared I2C bus
  ┌──────────────┐                 ┌──────────────────────┐
  │ GPIO 10 SDA ─┼─────────────────┼─ BNO055       0x28  │
  │ GPIO 11 SCL ─┼─────────────────┼─ VL53L0X rear 0x30  │
  │ GPIO 8  ─────┼── XSHUT rear    ├─ VL53L1X front 0x31 │
  │ GPIO 9  ─────┼── XSHUT front   └─ INA226       0x40  │
  └──────────────┘
```

Both ToF modules power up at `0x29`, so they **must remain held LOW on
XSHUT during boot**. Firmware enables the rear VL53L0X first and assigns
`0x30`, then enables the front VL53L1X and assigns `0x31`, before normal
sensor initialization. Never connect the two XSHUT lines together.

Use one external pull-up pair of 2.2 kΩ–4.7 kΩ from SDA/SCL to 3.3 V for
the complete bus. Keep the rear VL53L0X dedicated to docking; do not use it
for front obstacle safety decisions.

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

### Cargo Limit Switch — Microswitch on Cargo Bed

| Function | GPIO | Notes |
|----------|------|-------|
| **Signal** | GPIO **36** | ⚠ INPUT-ONLY (no output driver) |

| Parameter | Value |
|-----------|-------|
| Switch type | NO (normally open) |
| Wiring | One side → GPIO 36, other side → GND |
| INPUT_PULLUP | Enabled internally |
| Active state | **LOW = cargo present** (NO switch pressed by package weight → GND) |
| Debounce | 100 ms |
| Poll rate | 50 Hz (every PID tick, 20 ms) |
| Telemetry | Type 131 (compact) + Type 145 (on-demand `get_cargo`) |

### Cargo Limit Switch Wiring

```
          ESP32-S3
            │

  GPIO 36 ◄─┤ INPUT_PULLUP (internal)

            │

          Microswitch (NO)

            │

  Signal ◄───┤ Common (one terminal)

            │

          GND ◄───── Other terminal (shorts to GPIO 36 when pressed)
```

> ⚠️ **GPIO 36 is INPUT-ONLY on ESP32-S3** — cannot drive output. Use only
> as a digital input. The internal pull-up replaces the external one,
> simplifying the wiring to a 2-wire connection (signal + GND).

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

## BNO055 IMU — 9-DOF (I2C)

| Function | GPIO | Notes |
|----------|------|-------|
| **SDA** | GPIO **10** | Shared I2C bus |
| **SCL** | GPIO **11** | Shared I2C bus |

| Parameter | Value |
|-----------|-------|
| I2C Address | **0x28** |
| I2C Frequency | **100 kHz** |
| Publish Rate | **20 Hz** (every 50 ms) |
| Mode | NDOF (sensor fusion) |

### BNO055 Wiring

```
          CJMCU-055 / MCU-055 Module
            │
  VCC ◄─────┤ 3.3V (or 5V on 5V-tolerant variants)
  GND ◄─────┤ Common ground
  GNDIO ◄───┤ I2C ground — must be tied to GND too
  SDA ◄─────► ESP32 GPIO 10 ──┐ (shared I2C bus)
  SCL ◄─────► ESP32 GPIO 11 ──┤
  ADR/COM3 ──┤ GND for 0x28, float/3V3 for 0x29
  PS0  ◄─────┤ float or LOW  (selects I2C mode, not UART)
  PS1  ◄─────┤ float or LOW  (selects I2C mode, not UART)
  RST  ◄─────┤ 3.3V or float (has pull-up on module)
            │
          INA226 (0x40) ─┐
          VL53L0X (0x29)─┴── same bus
```

> ⚠ **External pull-ups required.** The ESP32-S3 internal pull-ups are
> ~45 kΩ — too weak for a shared bus with three devices at 100 kHz.
> Add **2.2 kΩ–4.7 kΩ pull-ups** from SDA → 3.3V and SCL → 3.3V
> (one pair is sufficient for the whole bus). Without them, the BNO055
> will not ACK reliably.

> ⚠ **ADR/COM3 must be tied LOW for 0x28.** Bridging the `ADR/COM3`
> pin to GND selects address 0x28 (default for this project). Leaving
> it floating or tying it to 3.3V switches to 0x29 — which collides
> with the VL53L0X on the same bus.

> ⚠ **PS0/PS1 must NOT be tied HIGH.** On BNO055 clones the PS0/PS1
> pads select between I2C and UART modes. Tie them LOW or leave them
> floating so the module comes up in I2C mode (the project uses I2C,
> not UART).

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
| Publish Rate | **1 Hz** (every 1 s) |
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
| **8** | VL53L0X rear XSHUT | OUTPUT | Active-LOW shutdown/address sequencing |
| **9** | VL53L1X front XSHUT | OUTPUT | Active-LOW shutdown/address sequencing; strapping pin, safe after boot |
| **10** | I2C SDA | BIDIR | BNO055 + INA226 + VL53L0X + VL53L1X shared bus |
| **11** | I2C SCL | OUTPUT | BNO055 + INA226 + VL53L0X + VL53L1X shared bus |
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
| **36** | Cargo limit switch | INPUT | Microswitch NO (INPUT_PULLUP) |
| **37** | IR REAR_RIGHT | INPUT | Proximity sensor; input-only |
| **38** | Motor RR RPWM | OUTPUT | BTS7960 PWM forward |
| **39** | Motor RR LPWM | OUTPUT | BTS7960 PWM reverse |
| **40** | Encoder FL CHA | INPUT | PCNT unit 0 |
| **41** | Encoder FL CHB | INPUT | PCNT unit 0 |
| **42** | Encoder FR CHA | INPUT | PCNT unit 1 |
| **43** | UART0 TX → CH343/Pi | OUTPUT | Serial telemetry/commands; do not use for XSHUT |
| **44** | Cylinder retract limit | INPUT | INPUT_PULLUP, active LOW, debounced 100 ms; unavailable for UART RX fallback |
| **45** | IR LEFT | INPUT | Strapping pin — safe after boot |
| **46** | IR RIGHT | INPUT | Strapping pin — safe after boot |
| **47** | Motor RR EN | OUTPUT | BTS7960 enable |
| **48** | Motor RL EN | OUTPUT | BTS7960 enable |

**Summary:** GPIO8/9 are dedicated to ToF XSHUT; GPIO37 is IR REAR_RIGHT; GPIO44 is the cylinder retract limit input. Production Pi transport remains native USB CDC, so GPIO44 is not available as a UART RX fallback. GPIO22-25 are unavailable on the module. All 8 LEDC channels are consumed by 4 motors.

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
| Logic 5V | **5V** (bucked from 21V) | BTS7960 VCC, E18-D80NK, ToF carrier boards (module-dependent) |
| Logic 3.3V | **3.3V** (ESP32 internal or buck) | BNO055, INA226, VL53L0X, VL53L1X, encoder pullups |
| Battery (planned) | **11.1V nom** (3S 18650) | Replace 21V PSU |

> ⚠️ **ALL modules MUST share a common ground** — ESP32, Pi, all BTS7960s, all sensors, all power supplies.

---

## Cargo Limit Switch — Microswitch on Cargo Bed

| Function | GPIO | Notes |
|----------|------|-------|
| **Signal** | GPIO **36** | ⚠ INPUT-ONLY (no output driver) |

| Parameter | Value |
|-----------|-------|
| Switch type | NO (normally open) |
| Wiring | One side → GPIO 36, other side → GND |
| INPUT_PULLUP | Enabled internally |
| Active state | **LOW = cargo present** (NO switch pressed by package weight → GND) |
| Debounce | 100 ms |
| Poll rate | 50 Hz (every PID tick, 20 ms) |
| Telemetry | Type 131 (compact) + Type 145 (on-demand `get_cargo`) |

### Cargo Limit Switch Wiring

```
          ESP32-S3
            │
  GPIO 36 ◄─┤ INPUT_PULLUP (internal)
            │
          Microswitch (NO)
            │
  Signal ◄───┤ Common (one terminal)
            │
          GND ◄───── Other terminal (shorts to GPIO 36 when pressed)
```

> ⚠️ **GPIO 36 is INPUT-ONLY on ESP32-S3** — cannot drive output. Use only
> as a digital input. The internal pull-up replaces the external one,
> simplifying the wiring to a 2-wire connection (signal + GND).
