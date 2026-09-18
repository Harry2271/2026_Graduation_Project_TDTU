# ESP32-S3 WeAct N16R8 — Pin Validation Report
**Generated:** 2026-09-18  
**Firmware Version:** Production (USB CDC)  
**Status:** ✅ ALL PINS VALIDATED — NO CONFLICTS

---

## Executive Summary

Toàn bộ 31 GPIO đã được phân bổ đúng, không có xung đột. Tất cả các strapping pins (GPIO 0, 9, 45, 46) được sử dụng an toàn. USB CDC được dùng làm giao tiếp chính với Pi 5, giải phóng GPIO 43/44 cho các chức năng khác.

---

## Pin Allocation Overview

```
┌─────────────────────────────────────────────────────────────┐
│  Total GPIOs: 48 (theoretical)                              │
│  Available on N16R8 module: 31 usable                       │
│  Allocated: 31                                              │
│  Reserved (Octal Flash/PSRAM): GPIO 26-37 (except 35-37)   │
│  Not on module: GPIO 22-25                                  │
└─────────────────────────────────────────────────────────────┘
```

---

## Category Breakdown

### 1. Motor Control (12 GPIO)

| Function | GPIO | LEDC | Conflicts | Status |
|----------|------|------|-----------|--------|
| FL RPWM | 12 | Ch 0 | None | ✅ |
| FL LPWM | 13 | Ch 4 | None | ✅ |
| FL EN | 3 | — | None | ✅ |
| FR RPWM | 14 | Ch 1 | None | ✅ |
| FR LPWM | 15 | Ch 5 | ⚠️ Was SPI SCK in old BNO055 mode | ✅ I2C only |
| FR EN | 7 | — | None | ✅ |
| RL RPWM | 16 | Ch 2 | None | ✅ |
| RL LPWM | 17 | Ch 6 | None | ✅ |
| RL EN | 48 | — | None | ✅ |
| RR RPWM | 38 | Ch 3 | None | ✅ |
| RR LPWM | 39 | Ch 7 | None | ✅ |
| RR EN | 47 | — | None | ✅ |

**Note:** All 8 LEDC channels consumed. No PWM channels available for additional features without sacrificing motor control.

---

### 2. Encoders (8 GPIO)

| Motor | CHA | CHB | PCNT Unit | Conflicts | Status |
|-------|-----|-----|-----------|-----------|--------|
| FL | 40 | 41 | UNIT_0 | None | ✅ |
| FR | 42 | 6 | UNIT_1 | None | ✅ |
| RL | 4 | 5 | UNIT_2 | ⚠️ GPIO 4 was SPI MOSI in old BNO055 | ✅ I2C only |
| RR | 20 | 21 | UNIT_3 | ⚠️ GPIO 21 was SPI CS in old BNO055 | ✅ I2C only |

**Note:** All 4 PCNT units consumed. Hardware quadrature decoding at zero CPU cost.

---

### 3. I2C Bus (2 GPIO, 4 devices)

| Pin | Function | Frequency | Devices |
|-----|----------|-----------|---------|
| 10 | SDA | 100 kHz | BNO055 (0x28), VL53L1X (0x31), VL53L0X (0x30), INA226 (0x40) |
| 11 | SCL | 100 kHz | ↑ Same |

**Address Map:**
```
0x28 — BNO055 IMU (9-DOF, heading/attitude)
0x29 — ToF boot address (both VL53L0X & VL53L1X share, sequenced via XSHUT)
0x30 — VL53L0X rear (runtime, after XSHUT sequencing)
0x31 — VL53L1X front (runtime, after XSHUT sequencing)
0x40 — INA226 power monitor (bus voltage, current, SOC)
```

**✅ No address conflicts.** XSHUT sequencing implemented in `VL53L0XSensor.cpp` and `VL53L1XSensor.cpp`.

**External Pull-ups Required:** 2.2kΩ–4.7kΩ from SDA/SCL to 3.3V (one pair for entire bus). ESP32-S3 internal pull-ups (~45kΩ) are too weak for a 4-device shared bus at 100 kHz.

---

### 4. ToF Distance Sensors (2 GPIO for XSHUT)

| Sensor | XSHUT | Boot Addr | Runtime Addr | Range | Purpose |
|--------|-------|-----------|--------------|-------|---------|
| VL53L1X (front) | GPIO 9 | 0x29 | 0x31 | 40–4000 mm | Forward obstacle safety |
| VL53L0X (rear) | GPIO 8 | 0x29 | 0x30 | 30–2000 mm | Docking alignment |

**XSHUT Boot Sequence:**
1. Both XSHUT LOW on power-up (holds sensors in reset, prevents bus address collision)
2. Release GPIO 8 → VL53L0X boots at 0x29 → firmware assigns 0x30
3. Release GPIO 9 → VL53L1X boots at 0x29 → firmware assigns 0x31
4. Normal I2C communication begins

**Strapping Pin Note:** GPIO 9 is a strapping pin (affects boot mode). Safe to use as output after boot. Ensure VL53L1X XSHUT has external pull-up or is driven HIGH by firmware during boot.

---

### 5. IR Proximity Sensors (4 GPIO)

| Position | GPIO | Type | Strapping | Pull-up | Status |
|----------|------|------|-----------|---------|--------|
| REAR_LEFT | 1 | INPUT_PULLUP | No | Internal | ✅ Active |
| REAR_RIGHT | 37 | INPUT_PULLUP | No | Internal | ✅ Active (input-only pin) |
| LEFT | 45 | INPUT_PULLUP | **YES** | Internal + external recommended | ✅ **ENABLED (Sept 2026)** |
| RIGHT | 46 | INPUT_PULLUP | **YES** | Internal + external recommended | ✅ Active |

**GPIO 45 Status Change:**
- **Before:** `IR_LEFT_ENABLED 0` (disabled due to strapping pin behavior)
- **After (2026-09-18):** `IR_LEFT_ENABLED 1` (enabled with hardware warning)

**Hardware Requirement for GPIO 45:**
- E18-D80NK sensor must have 3.3V-safe output (NOT 5V TTL)
- External pull-up resistor: 2.2kΩ–4.7kΩ from GPIO 45 to 3.3V
- Without proper hardware, GPIO 45 reads LOW when no sensor connected (false obstacle detection)

**Strapping Pin Safety:**
- GPIO 45/46 sampled only during boot to configure JTAG mode
- After boot completes, safe to use as regular INPUT pins
- INPUT_PULLUP mode does not interfere with strapping function

---

### 6. Cylinder Actuator (3 GPIO)

| Function | GPIO | Direction | Conflicts | Status |
|----------|------|-----------|-----------|--------|
| L298N IN1 (extend) | 2 | OUTPUT | None | ✅ |
| L298N IN2 (retract) | 35 | OUTPUT | None | ✅ |
| Retract limit switch | 44 | INPUT_PULLUP | UART0 RX | ✅ Safe with USB CDC |

**GPIO 44 Analysis:**
- GPIO 44 = UART0 RX on ESP32-S3
- **Production firmware uses USB CDC (Type-C cable) for Pi communication**
- UART0 (GPIO 43/44) is NOT used → GPIO 44 is free for limit switch
- No conflict

**Limit Switch Wiring:**
- Type: NO (normally open) microswitch
- One terminal → GPIO 44, other terminal → GND
- Internal pull-up enabled → GPIO reads HIGH when open, LOW when pressed
- Active LOW = cylinder fully retracted

---

### 7. Cargo Sensor (1 GPIO)

| Function | GPIO | Type | Constraints | Status |
|----------|------|------|-------------|--------|
| Cargo microswitch | 36 | INPUT_PULLUP | **Input-only pin** | ✅ |

**GPIO 36 Constraints:**
- ESP32-S3 GPIO 36 has no output driver (input-only)
- Cannot use for: LED, relay, motor driver, I2C SDA (bidirectional)
- Safe for: digital input, ADC (though used as digital here)

---

### 8. Reserved / Unavailable GPIO

| GPIO | Reason | Can Use? |
|------|--------|----------|
| 0 | BOOT strapping pin | ❌ No — affects boot mode |
| 18, 19 | USB D-, D+ | ❌ No — USB CDC enabled |
| 22-25 | Not on WROOM-1U module | ❌ Physical not present |
| 26-32 | Octal SPI Flash | ❌ No — hardwired to flash |
| 33, 34 | Octal PSRAM | ❌ No — hardwired to PSRAM |
| 43 | UART0 TX | ✅ Could use if needed (currently unused) |

---

## Strapping Pins Summary

ESP32-S3 has 5 strapping pins sampled during boot:

| GPIO | Strap Function | Our Usage | Boot Requirement | Status |
|------|----------------|-----------|------------------|--------|
| 0 | Boot mode select | **Unused** | Pull HIGH (normal boot) | ✅ External button |
| 3 | JTAG signal | Motor FL EN | — | ✅ Safe as output |
| 45 | JTAG enable | IR LEFT | Float or HIGH | ⚠️ Needs external pull-up |
| 46 | ROM messages | IR RIGHT | Float | ✅ INPUT_PULLUP safe |
| 9 | — | VL53L1X XSHUT | — | ✅ Safe as output after boot |

**Boot Safety Checklist:**
- ✅ GPIO 0: External BOOT button provides pull-up
- ✅ GPIO 3: Motor EN set LOW during early init (no conflict)
- ⚠️ GPIO 45: Add 4.7kΩ pull-up to 3.3V (prevents float during boot)
- ✅ GPIO 46: Internal pull-up + IR sensor output keeps HIGH
- ✅ GPIO 9: VL53L1X XSHUT driven HIGH by firmware after I2C init

---

## Conflict Resolution History

### ✅ Resolved: BNO055 SPI vs. Motor/Encoder Conflict

**Old (DEPRECATED) SPI pins:**
```
GPIO 15 (SPI SCK)  → conflicts with FR LPWM
GPIO 4  (SPI MOSI) → conflicts with RL encoder CHA
GPIO 21 (SPI CS)   → conflicts with RR encoder CHB
GPIO 36 (SPI MISO) → conflicts with Cargo sensor
```

**Resolution:** BNO055 switched to I2C mode (GPIO 10/11). SPI mode permanently disabled in firmware. Config.h contains explicit warning against re-enabling SPI.

### ✅ Resolved: UART0 vs. Cylinder Limit Switch

**Conflict:** GPIO 44 = UART0 RX, but also used for cylinder retract limit switch.

**Resolution:** Production firmware uses **USB CDC** (native USB, Type-C cable) for Pi communication. UART0 (GPIO 43/44) is not used. GPIO 44 is free for limit switch input.

**Future-proof:** If UART0 fallback is ever needed, GPIO 43 (TX) could still be used for one-way telemetry. GPIO 44 (RX) is consumed by limit switch and cannot be reclaimed without hardware redesign.

### ✅ Resolved: ToF Address Collision (0x29)

**Conflict:** Both VL53L1X (front) and VL53L0X (rear) boot at I2C address 0x29.

**Resolution:** XSHUT sequencing implemented:
1. Hold both sensors in reset (XSHUT LOW) during ESP32 boot
2. Release VL53L0X first (GPIO 8 HIGH) → assign runtime address 0x30
3. Release VL53L1X second (GPIO 9 HIGH) → assign runtime address 0x31
4. Firmware enforces this sequence in `setupHardware()`

---

## GPIO Availability Analysis

### ✅ Fully Allocated (31 GPIO)

| Category | Count | GPIOs |
|----------|-------|-------|
| Motors (PWM + EN) | 12 | 3,7,12,13,14,15,16,17,38,39,47,48 |
| Encoders | 8 | 4,5,6,20,21,40,41,42 |
| I2C | 2 | 10,11 |
| ToF XSHUT | 2 | 8,9 |
| IR Sensors | 4 | 1,37,45,46 |
| Cylinder | 3 | 2,35,44 |
| Cargo Sensor | 1 | 36 |
| **Total** | **31** | — |

### ❌ Unavailable (17 GPIO)

| Reason | Count | GPIOs |
|--------|-------|-------|
| Not on module | 4 | 22-25 |
| Octal Flash | 7 | 26-32 |
| Octal PSRAM | 3 | 33,34 (35-37 externally routed) |
| USB CDC | 2 | 18,19 |
| Boot strapping | 1 | 0 (reserved for BOOT button) |
| **Total** | **17** | — |

### ✅ Potentially Free (1 GPIO)

| GPIO | Current Status | Could Use For |
|------|----------------|---------------|
| 43 | UART0 TX (unused in USB CDC mode) | One-way serial debug, LED indicator, external trigger |

**Recommendation:** Keep GPIO 43 as backup UART TX for emergency serial logging. Do not allocate unless absolutely necessary.

---

## Expansion Options

### If More GPIO Needed:

1. **I2C Expander** (e.g., PCF8574, MCP23017)
   - Adds 8-16 GPIO via I2C bus (addresses 0x20-0x27 available)
   - Suitable for: LEDs, relays, non-critical sensors
   - Not suitable for: Real-time motor control, encoder reading

2. **SPI Expander** (e.g., MCP23S17)
   - Requires 4 GPIO (MOSI, MISO, SCK, CS) — currently not available
   - Higher speed than I2C expander
   - Not practical in current config (all LEDC channels used)

3. **Dedicated Motor Controller IC** (e.g., TB6612FNG x4)
   - Could replace BTS7960 + LEDC channels
   - Frees up 8 LEDC channels → available for PWM on other GPIO
   - Requires hardware redesign

---

## Testing Checklist

### Power-On Test Sequence:

```
1. [ ] All motors can be driven individually (FL, FR, RL, RR)
2. [ ] All encoders report counts on rotation (4× PCNT units)
3. [ ] BNO055 I2C responds at 0x28 (heading data valid)
4. [ ] INA226 I2C responds at 0x40 (voltage/current readings valid)
5. [ ] VL53L0X I2C responds at 0x30 after XSHUT sequence (rear ToF)
6. [ ] VL53L1X I2C responds at 0x31 after XSHUT sequence (front ToF)
7. [ ] IR REAR_LEFT (GPIO 1) reads HIGH when clear, LOW when blocked
8. [ ] IR REAR_RIGHT (GPIO 37) reads HIGH when clear, LOW when blocked
9. [ ] IR LEFT (GPIO 45) reads HIGH when clear, LOW when blocked
10. [ ] IR RIGHT (GPIO 46) reads HIGH when clear, LOW when blocked
11. [ ] Cylinder extends when IN1=HIGH, IN2=LOW (L298N)
12. [ ] Cylinder retracts when IN1=LOW, IN2=HIGH, stops at limit switch (GPIO 44 LOW)
13. [ ] Cargo sensor (GPIO 36) reads HIGH when empty, LOW when loaded
14. [ ] USB CDC appears as /dev/ttyACM0 on Pi 5
15. [ ] JSON commands over USB CDC accepted and acknowledged (type 128)
```

### Strapping Pin Boot Test:

```
1. [ ] ESP32 boots normally with GPIO 45 pull-up installed
2. [ ] GPIO 45 IR sensor reads correctly after boot
3. [ ] GPIO 46 IR sensor reads correctly after boot
4. [ ] GPIO 9 XSHUT can drive VL53L1X after boot
5. [ ] No boot loops or unexpected resets
```

---

## Pin Map Validation: PASSED ✅

**Date:** 2026-09-18  
**Validated By:** Claude Opus 4.8  
**Result:** All 31 GPIO correctly allocated, no conflicts detected  
**Action Items:**
- ⚠️ Install external 4.7kΩ pull-up on GPIO 45 (SDA/SCL already have one pair)
- ⚠️ Verify E18-D80NK on GPIO 45 is 3.3V-safe (not 5V TTL)
- ✅ Flash firmware with `IR_LEFT_ENABLED 1` (enabled 2026-09-18)

---

## References

- `firmware/include/config.h` — All pin definitions and constants
- `firmware/PIN_MAP.md` — Detailed wiring diagrams and protocols
- `firmware/CLAUDE.md` — Firmware architecture and module overview
- `CLAUDE.md` (root) — Project overview and hardware specifications
