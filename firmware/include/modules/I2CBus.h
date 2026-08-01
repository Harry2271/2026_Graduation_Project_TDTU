#pragma once

#include <stdint.h>

// =====================================================================
// I2CBus — central helper for I2C bus recovery.
//
// Background:
//   Arduino Wire.endTransmission() blocks indefinitely if a slave
//   holds SDA low.  The only same-thread escape is to physically
//   release the bus by toggling SCL 9 times (standard I2C recovery
//   sequence), then re-init Wire.
//
// This helper centralizes the recovery and exposes:
//   - busReset(sda, scl) — toggle SCL 9 times to release stuck slaves
//   - reinitialize(sda, scl, freq) — Wire.end() + Wire.begin(sda, scl) + setClock()
//   - isHung() — best-effort: digitalRead(SDA)==LOW for >100ms = hung
//
// Call sequence after a multi-module WARNING storm:
//   1. I2CBus::busReset(sda, scl);
//   2. I2CBus::reinitialize(sda, scl, 400000);
//   3. module.begin() for each I2C sensor
//
// Limitation: if Wire is already mid-transaction when this is called,
//   busReset may not take effect until the next loop().  Hardware
//   watchdog (esp_task_wdt) is the ultimate fallback.
// =====================================================================

class I2CBus {
public:
    /// Toggle SCL 9 times while SDA is open-drain to release any slave
    /// holding SDA low.  After this, SDA/SCL are back to idle HIGH.
    static void busReset(uint8_t sda_pin, uint8_t scl_pin);

    /// Re-init the Wire peripheral on the given pins with the given clock.
    /// Returns true on success.
    static bool reinitialize(uint8_t sda_pin, uint8_t scl_pin, uint32_t freq_hz);

    /// Best-effort bus hang detection.  Reads SDA as input; if LOW
    /// for >100ms after the check, declares the bus hung.
    /// This is a heuristic — the ground-truth "Wire blocked indefinitely"
    /// cannot be detected in software.
    static bool isHung(uint8_t sda_pin);
};
