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
| **2** | — | Free | — |
| **3** | Motor FL EN | OUTPUT | BTS7960 enable |
| **4** | Encoder RL CHA | INPUT | PCNT unit 2 |
| **5** | Encoder RL CHB | INPUT | PCNT unit 2 |
| **6** | Encoder FR CHB | INPUT | PCNT unit 1 |
| **7** | Motor FR EN | OUTPUT | BTS7960 enable |
| **8** | IR REAR_RIGHT | INPUT | Proximity sensor |
| **9** | Sharp Front | INPUT (ADC) | Strapping pin — safe after boot |
| **10** | I2C SDA | BIDIR | BNO055 + INA226 shared bus |
| **11** | I2C SCL | OUTPUT | BNO055 + INA226 shared bus |
| **12** | Motor FL RPWM | OUTPUT | BTS7960 PWM forward |
| **13** | Motor FL LPWM | OUTPUT | BTS7960 PWM reverse |
| **14** | Motor FR RPWM | OUTPUT | BTS7960 PWM forward |
| **15** | Motor FR LPWM | OUTPUT | BTS7960 PWM reverse |
| **16** | Motor RL RPWM | OUTPUT | BTS7960 PWM forward |
| **17** | Motor RL LPWM | OUTPUT | BTS7960 PWM reverse |
| **18** | USB D- | — | Native USB CDC |
| **19** | USB D+ | — | Native USB CDC |
| **20** | Encoder RR CHA | INPUT | PCNT unit 3 |
| **21** | Encoder RR CHB | INPUT | PCNT unit 3 |
| **22-25** | — | N/A | **Not available on WROOM-1U module** |
| **35** | — | Free | — |
| **36** | — | Free | — |
| **37** | — | Free | — |
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

**Summary:** 28 GPIO used, 3 free (35, 36, 37), 4 unavailable (22-25)

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
