#pragma once

#include <stdint.h>
#include <Arduino.h>

// =====================================================================
// I2CBus — central I2C bus recovery + safe transaction layer.
//
// The ESP32 Arduino core's Wire.endTransmission() does NOT honor
// Wire.setTimeout() — it blocks forever if a slave holds SDA low.
//
// ALL callers must use these helpers instead of raw Wire calls when
// bus health matters.  Every transaction goes through linesIdle()
// guard + time-bounded loop + automatic bus reset on failure.
//
// Hardware requirement for stable operation:
//   External 2.2k-4.7kΩ pull-ups on SDA and SCL to 3.3V are mandatory.
//   Internal pull-ups (~45kΩ) are too weak for 3-device I2C buses.
// =====================================================================

class I2CBus {
public:
    /// Toggle SCL 9 times to release any slave holding SDA low.
    static void busReset(uint8_t sda_pin, uint8_t scl_pin);

    /// Re-init Wire peripheral.  Calls busReset() first, then Wire.begin().
    /// Returns true on success.
    static bool reinitialize(uint8_t sda_pin, uint8_t scl_pin, uint32_t freq_hz);

    /// Best-effort: digitalRead(SDA)==LOW for >100ms = hung.
    static bool isHung(uint8_t sda_pin);

    /// Verify SDA + SCL are HIGH before Wire.beginTransmission().
    static bool linesIdle(uint8_t sda_pin, uint8_t scl_pin);

    /// Single-address ACK probe. Does NOT reset the bus.
    static bool probe(uint8_t sda_pin, uint8_t scl_pin, uint8_t addr);

    /// Probe + auto bus reset + retry on NACK.
    static bool probeWithRecovery(uint8_t sda_pin, uint8_t scl_pin,
                                   uint8_t addr, uint32_t freq_hz);

    // ── Safe Wire wrappers ──
    //
    // These bypass the problematic Wire.endTransmission() by checking
    // linesIdle() first and wrapping in a time-bounded loop.  On
    // timeout, they do NOT call Wire.end() (which can crash ESP32-S3);
    // instead they return false and let the caller use probeWithRecovery.

    /// Safe single-byte read.  Returns true on successful read, false on failure.
    static bool safeReadReg(uint8_t sda_pin, uint8_t scl_pin,
                             uint32_t freq_hz,
                             uint8_t addr, uint8_t reg, uint8_t* out_value);

    /// Safe burst read (cnt bytes, auto-increment register address).
    static bool safeReadBurst(uint8_t sda_pin, uint8_t scl_pin,
                               uint32_t freq_hz,
                               uint8_t addr, uint8_t start_reg,
                               uint8_t* buf, uint8_t cnt);

    /// Safe single-byte write.  Returns true on success.
    static bool safeWriteReg(uint8_t sda_pin, uint8_t scl_pin,
                              uint32_t freq_hz,
                              uint8_t addr, uint8_t reg, uint8_t value);
};
