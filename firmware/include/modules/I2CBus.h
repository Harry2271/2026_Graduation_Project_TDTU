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
    /// First-time Wire peripheral bring-up. Does NOT call Wire.end() (which
    /// would crash on an uninitialised Wire on ESP32-S3). Returns true only
    /// if Wire.begin() succeeded and both SDA/SCL read HIGH afterwards.
    static bool initialize(uint8_t sda_pin, uint8_t scl_pin, uint32_t freq_hz);

    /// Full bus recovery + Wire reinit. Calls busReset (with STOP), then
    /// Wire.end()/Wire.begin()/setClock/setTimeout. Returns true if the
    /// controller re-attached cleanly.
    static bool reinitializeBus(uint8_t sda_pin, uint8_t scl_pin, uint32_t freq_hz);

    /// Toggle SCL up to 9 times then emit a STOP to release any slave
    /// holding SDA low. Uses bare GPIO — call only when Wire is NOT driving
    /// the pins.
    static void busReset(uint8_t sda_pin, uint8_t scl_pin);

    /// Re-init Wire peripheral (legacy).  Calls busReset() first, then
    /// Wire.begin(). Returns true on success.
    static bool reinitialize(uint8_t sda_pin, uint8_t scl_pin, uint32_t freq_hz);

    /// Best-effort: digitalRead(SDA)==LOW for >100ms = hung.
    static bool isHung(uint8_t sda_pin);

    /// Passive level check: returns true if both SDA and SCL read HIGH
    /// without modifying their pin mode. Safe to call any time, including
    /// while the I2C peripheral owns the pins.
    static bool linesIdle(uint8_t sda_pin, uint8_t scl_pin);

    /// Single-address probe. Returns the raw Wire error code:
    ///   0 = ACK (device present)
    ///   1 = data too long
    ///   2 = NACK on address (device absent)
    ///   3 = NACK on data
    ///   4 = other controller error
    ///   5 = timeout
    static int probe(uint8_t sda_pin, uint8_t scl_pin, uint8_t addr);

    /// Probe with one controlled bus-recovery retry on timeout. Returns the
    /// final Wire error code. Does NOT reset the bus for ordinary NACK — that
    /// is the expected response from an absent optional device.
    static int probeWithRecovery(uint8_t sda_pin, uint8_t scl_pin,
                                  uint8_t addr, uint32_t freq_hz);

    /// Human-readable name for a Wire error code (for boot logs).
    static const char* errorName(int err);

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

    /// Safe burst read using a 16-bit, big-endian register address.
    static bool safeReadReg16(uint8_t sda_pin, uint8_t scl_pin,
                              uint32_t freq_hz, uint8_t addr, uint16_t reg,
                              uint8_t* buf, uint8_t cnt);

    /// Safe single-byte write.  Returns true on success.
    static bool safeWriteReg(uint8_t sda_pin, uint8_t scl_pin,
                              uint32_t freq_hz,
                              uint8_t addr, uint8_t reg, uint8_t value);

    /// Safe register write with an atomic payload transaction.
    static bool safeWriteBurst(uint8_t sda_pin, uint8_t scl_pin,
                                uint32_t freq_hz,
                                uint8_t addr, uint8_t reg,
                                const uint8_t* buf, uint8_t cnt);

    /// Safe write using a 16-bit, big-endian register address.
    static bool safeWriteReg16(uint8_t sda_pin, uint8_t scl_pin,
                               uint32_t freq_hz, uint8_t addr, uint16_t reg,
                               const uint8_t* buf, uint8_t cnt);
};
