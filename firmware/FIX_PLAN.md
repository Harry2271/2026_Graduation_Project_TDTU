# VL53L0X/VL53L1X Dual-Sensor Fix Plan

## Problem Summary

Current firmware fails to initialize two ToF sensors (VL53L0X rear + VL53L1X front) sharing I2C bus at GPIO10/11, with separate XSHUT control at GPIO8/9.

Log evidence:
```
BNO055 0x28: OK
INA226 0x40: OK
VL53L0X probe 0x29: NACK
VL53L1X probe 0x29: NACK
```

Both sensors boot at `0x29`. Current sequence uses temp objects, does not call `init()`, and wrappers recreate objects.

## Root Cause

1. Sequence creates temp `VL53L0X rear_probe` / `VL53L1X front_probe` but never calls `init()`.
2. `setAddress()` alone does NOT initialize sensor; it only changes I2C address register.
3. Wrappers delete/recreate objects, then call `init()` at runtime address `0x30`/`0x31`.
4. Reference driver (Pololu `ContinuousMultipleSensors.ino`) requires:
   - `init()` at default `0x29`
   - `setAddress(new_addr)` 
   - Use same object for later reads
5. Baseline does not match reference sequence.

## Correct Sequence (per Pololu reference)

```cpp
// Hold both LOW
pinMode(VL53L0X_XSHUT_PIN, OUTPUT); digitalWrite(VL53L0X_XSHUT_PIN, LOW);
pinMode(VL53L1X_XSHUT_PIN, OUTPUT); digitalWrite(VL53L1X_XSHUT_PIN, LOW);
delay(100);

// Release VL53L0X only
pinMode(VL53L0X_XSHUT_PIN, INPUT);  // let carrier pull-up raise it
delay(100);

// Init rear at 0x29
g_tof_rear_driver.setTimeout(500);
if (!g_tof_rear_driver.init()) FAIL;
g_tof_rear_driver.setAddress(0x30);

// Release VL53L1X
pinMode(VL53L1X_XSHUT_PIN, INPUT);
delay(100);

// Init front at 0x29
g_tof_front_driver.setTimeout(500);
if (!g_tof_front_driver.init()) FAIL;
g_tof_front_driver.setAddress(0x31);

// Verify
probe(0x30) == ACK
probe(0x31) == ACK
```

Wrappers must NOT delete/recreate; they attach the persistent objects.

## Implementation Steps

1. **Add persistent driver objects** to `VL53L0XSensor` and `FrontTofSensor` classes.
2. **Rewrite `sequenceTofAddresses()`** to call `init()` + `setAddress()` on wrapper-owned objects.
3. **Simplify wrapper `begin()`** to only configure timing/continuous mode, not init.
4. **Test standalone** dual-sensor sketch using GPIO8/9 before production.
5. **Build production**, verify no object lifecycle conflicts, then flash once.

## Files to Change

- `include/modules/VL53L0XSensor.h` — make driver pointer public or add `initAtDefault()` method
- `include/modules/FrontTofSensor.h` — same
- `src/modules/VL53L0XSensor.cpp` — split init into sequence + wrapper config
- `src/modules/FrontTofSensor.cpp` — same
- `src/main.cpp` — rewrite `sequenceTofAddresses()` to call wrapper init methods

## Test Plan

1. Create `test_dual_tof/` using GPIO8/9 XSHUT, GPIO10/11 I2C, reference sequence.
2. Flash test; confirm ACK at `0x29` then `0x30` / `0x31`.
3. Only after test passes, apply same pattern to production firmware.
4. Flash production once; capture boot log.

## Expected Addresses

- VL53L0X rear: `0x30` (fixed runtime after init at `0x29`)
- VL53L1X front: `0x31` (fixed runtime after init at `0x29`)
- BNO055: `0x28`
- INA226: `0x40`

No address conflicts after sequence completes.
