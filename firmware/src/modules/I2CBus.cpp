#include "I2CBus.h"
#include "config.h"
#include <Arduino.h>
#include <Wire.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

namespace {
SemaphoreHandle_t g_i2c_mutex = nullptr;

bool lockBus()
{
    if (g_i2c_mutex == nullptr) {
        g_i2c_mutex = xSemaphoreCreateMutex();
        if (g_i2c_mutex == nullptr) return false;
    }
    return xSemaphoreTake(g_i2c_mutex, pdMS_TO_TICKS(I2C_TRANSACTION_TIMEOUT_MS)) == pdTRUE;
}

void unlockBus()
{
    if (g_i2c_mutex != nullptr) xSemaphoreGive(g_i2c_mutex);
}
}

// =====================================================================
// I2CBus — central I2C bus recovery + safe transaction layer.
//
// Ownership contract:
//   • On first boot, use initialize() — it calls Wire.begin() WITHOUT
//     Wire.end(), which matches the proven test_i2c_sensors project.
//   • After that, use reinitializeBus() for recovery — it performs a
//     complete STOP + Wire.end()/Wire.begin() cycle.
//   • linesIdle() is passive: it never calls pinMode(), so it is safe
//     to call while the I2C peripheral owns GPIO10/11.
//
// External pull-up requirement:
//   2.2k-4.7kΩ from SDA → 3.3V and SCL → 3.3V.
//   Internal pull-ups (~45kΩ) are too weak for BNO055 + VL53L0X + INA226.
// =====================================================================

// ── Human-readable error name ──────────────────────────────────────

const char* I2CBus::errorName(int err)
{
    switch (err) {
        case 0: return "OK";
        case 1: return "data-too-long";
        case 2: return "NACK-addr";
        case 3: return "NACK-data";
        case 4: return "other-err";
        case 5: return "timeout";
        default: return "unknown";
    }
}

// ── Passive level check ────────────────────────────────────────────
//
// IMPORTANT: Do NOT call pinMode() here.  After Wire.begin() the
// I2C peripheral owns GPIO10/11 via the GPIO matrix.  Calling
// pinMode(INPUT_PULLUP) can detach the peripheral and prevent all
// subsequent transactions, matching the err=5 boot failure.

bool I2CBus::linesIdle(uint8_t sda_pin, uint8_t scl_pin)
{
    // Small settle so a recent driver transition is visible
    delayMicroseconds(5);
    return (digitalRead(sda_pin) == HIGH && digitalRead(scl_pin) == HIGH);
}

// ── Bus-level reset ────────────────────────────────────────────────
//
// Generates up to 9 SCL clock pulses to release any slave holding SDA
// low, then creates a valid I²C STOP condition:
//   SDA LOW → SCL HIGH → SDA HIGH (while SCL remains HIGH)
//
// After STOP, both pins are returned to INPUT so Wire can re-attach.

void I2CBus::busReset(uint8_t sda_pin, uint8_t scl_pin)
{
    Serial.printf("[I2C] Bus reset on SDA=%u SCL=%u\n", sda_pin, scl_pin);

    // Release both lines
    pinMode(sda_pin, INPUT);
    pinMode(scl_pin, INPUT);
    delayMicroseconds(10);

    // 9-clock pulse — release stuck slaves, stop early when SDA goes high
    pinMode(scl_pin, OUTPUT);
    digitalWrite(scl_pin, HIGH);
    for (int i = 0; i < 9; i++) {
        digitalWrite(scl_pin, LOW);
        delayMicroseconds(5);
        digitalWrite(scl_pin, HIGH);
        delayMicroseconds(5);

        // If SDA is already high, slave released — no need for more clocks
        pinMode(sda_pin, INPUT);
        if (digitalRead(sda_pin) == HIGH) break;
    }

    // Generate STOP: SDA LOW → HIGH while SCL is HIGH
    pinMode(sda_pin, OUTPUT);
    digitalWrite(sda_pin, LOW);
    delayMicroseconds(5);
    digitalWrite(scl_pin, HIGH);
    delayMicroseconds(5);
    digitalWrite(sda_pin, HIGH);
    delayMicroseconds(5);

    // Leave both as inputs (Wire will re-configure them)
    pinMode(sda_pin, INPUT);
    pinMode(scl_pin, INPUT);
    delay(I2C_RECOVERY_SETTLE_MS);
}

// ── First-time Wire bring-up ───────────────────────────────────────
//
// Call once during setup(). Does NOT call Wire.end() — that would crash
// if Wire was never initialised on ESP32-S3.

bool I2CBus::initialize(uint8_t sda_pin, uint8_t scl_pin, uint32_t freq_hz)
{
    Serial.printf("[I2C] Initializing Wire on SDA=%u SCL=%u @ %u kHz...\n",
                  sda_pin, scl_pin, (unsigned)(freq_hz / 1000));

    // Wire is not attached yet, so GPIO ownership is safe here. A sensor can
    // retain SDA LOW after a brownout/reset; clock it out before Wire.begin()
    // rather than attaching a controller to an already-stuck bus.
    if (!linesIdle(sda_pin, scl_pin)) {
        Serial.printf("[I2C] Bus not idle before Wire.begin (SDA=%d SCL=%d); resetting...\n",
                      digitalRead(sda_pin), digitalRead(scl_pin));
        busReset(sda_pin, scl_pin);
        if (!linesIdle(sda_pin, scl_pin)) {
            Serial.printf("[I2C] Bus remains stuck before Wire.begin (SDA=%d SCL=%d)\n",
                          digitalRead(sda_pin), digitalRead(scl_pin));
            return false;
        }
    }

    bool ok = Wire.begin(sda_pin, scl_pin);
    if (!ok) {
        Serial.println("[I2C] Wire.begin FAILED — check pin mapping / peripheral");
        return false;
    }

    Wire.setClock(freq_hz);
    Wire.setTimeout(I2C_TRANSACTION_TIMEOUT_MS);
    delay(I2C_BOOT_SETTLE_MS);

    // Verify bus idle after settle
    bool idle = linesIdle(sda_pin, scl_pin);
    Serial.printf("[I2C] Wire.begin=ok | settle=%u ms | idle=%s\n",
                  (unsigned)I2C_BOOT_SETTLE_MS, idle ? "yes" : "no");
    return idle;
}

// ── Full bus recovery (for runtime) ────────────────────────────────
//
// Performs a complete STOP, detaches Wire, re-attaches, and verifies.
// Use when a sensor recovery needs the bus re-initialized.

bool I2CBus::reinitializeBus(uint8_t sda_pin, uint8_t scl_pin, uint32_t freq_hz)
{
    Serial.printf("[I2C] Bus recovery on SDA=%u SCL=%u\n", sda_pin, scl_pin);

    // Detach the peripheral before taking GPIO ownership.  Calling pinMode()
    // while Wire still owns the pins can detach the GPIO matrix mid-transfer
    // and leave the ESP32-S3 I2C controller wedged.
    Wire.end();
    delay(2);

    // Clock out a possibly stuck slave and emit a STOP.  Do not issue a
    // general-call (0x00): that address can have side effects on devices.
    busReset(sda_pin, scl_pin);

    // Verify lines are released before re-attaching
    //    If SDA is still stuck LOW after Wire.end(), the bus has a
    //    hardware-level problem (missing pull-up, slave fault) — abort.
    pinMode(sda_pin, INPUT);
    pinMode(scl_pin, INPUT);
    delayMicroseconds(10);
    if (digitalRead(sda_pin) == LOW) {
        Serial.printf("[I2C] SDA stuck LOW after Wire.end() — check pull-ups / slave fault\n");
        // Attempt one more aggressive reset before giving up
        busReset(sda_pin, scl_pin);
        delay(50);
        if (digitalRead(sda_pin) == LOW) {
            Serial.println("[I2C] SDA still stuck — bus recovery FAILED");
            return false;
        }
    }

    // 5. Re-attach Wire
    bool ok = Wire.begin(sda_pin, scl_pin);
    if (!ok) {
        Serial.println("[I2C] Recovery Wire.begin FAILED");
        return false;
    }
    Wire.setClock(freq_hz);
    Wire.setTimeout(I2C_TRANSACTION_TIMEOUT_MS);
    delay(I2C_RECOVERY_SETTLE_MS);

    bool idle = linesIdle(sda_pin, scl_pin);
    Serial.printf("[I2C] Reinit ok | idle=%s\n", idle ? "yes" : "NO — lines stuck");
    return ok && idle;
}

// ── Legacy reinit (kept for ABI compat) ────────────────────────────

bool I2CBus::reinitialize(uint8_t sda_pin, uint8_t scl_pin, uint32_t freq_hz)
{
    return reinitializeBus(sda_pin, scl_pin, freq_hz);
}

// ── Hung-bus detection ─────────────────────────────────────────────

bool I2CBus::isHung(uint8_t sda_pin)
{
    // This helper may be called while Wire owns the GPIO matrix.  Keep it
    // passive; pinMode() here can detach the I2C peripheral.
    bool low = (digitalRead(sda_pin) == LOW);
    delay(100);
    bool still_low = (digitalRead(sda_pin) == LOW);
    return (low && still_low);
}

// ── Single-address probe ───────────────────────────────────────────
//
// Returns the raw Wire.endTransmission() error code (0 = ACK, 2 = NACK,
// 5 = timeout). The caller decides whether recovery is warranted.

int I2CBus::probe(uint8_t sda_pin, uint8_t scl_pin, uint8_t addr)
{
    if (!linesIdle(sda_pin, scl_pin)) {
        Serial.printf("[I2C] Bus busy (SDA=%d SCL=%d) — skip probe 0x%02X\n",
                      digitalRead(sda_pin), digitalRead(scl_pin), addr);
        return 5;  // treat as timeout so caller can attempt recovery
    }

    if (!lockBus()) return 5;
    Wire.beginTransmission(addr & 0x7F);
    int err = Wire.endTransmission();
    unlockBus();

    if (err != 0) {
        Serial.printf("[I2C] probe 0x%02X: %s (err=%d, SDA=%d SCL=%d)\n",
                      addr, errorName(err), err,
                      digitalRead(sda_pin), digitalRead(scl_pin));
    }
    return err;
}

// ── Probe with controlled recovery ─────────────────────────────────
//
// Policy:
//   err == 0 → present
//   err == 2 → device absent (NACK) — do NOT reset the shared bus,
//              because this is the expected response from an optional
//              device that is simply not populated.
//   err == 5 (timeout) → bus may be stuck — perform ONE controlled
//              recovery, then retry.
//   err == anything else → same as timeout.

int I2CBus::probeWithRecovery(uint8_t sda_pin, uint8_t scl_pin,
                               uint8_t addr, uint32_t freq_hz)
{
    // I2C_DEVICE_RETRY_COUNT is the total attempt budget, including the
    // initial probe.  Recovery is performed only between those attempts.
    for (int attempt = 0; attempt < I2C_DEVICE_RETRY_COUNT; ++attempt) {
        const int err = probe(sda_pin, scl_pin, addr);
        if (err == 0) return err;

        // An address NACK means the optional device is absent. Resetting a
        // shared bus for that expected result can disturb every other sensor.
        if (err == 2) return err;

        if (attempt + 1 < I2C_DEVICE_RETRY_COUNT) {
            Serial.printf("[I2C] Probe 0x%02X failed (%s) — recovery attempt %d...\n",
                          addr, errorName(err), attempt + 1);
            if (!reinitializeBus(sda_pin, scl_pin, freq_hz)) {
                Serial.println("[I2C] Recovery failed; aborting probe retry");
                return err;
            }
            delay(I2C_DEVICE_RETRY_DELAY_MS);
        } else {
            return err;
        }
    }
    return 5;
}

// ── Safe Wire wrappers ──────────────────────────────────────────────
//
// Add two layers of protection:
//   1. linesIdle() before Wire.beginTransmission() — skip if bus stuck.
//   2. Time-bounded read loop — return false on timeout.
//
// These do NOT call Wire.end() — that is the caller's responsibility
// via reinitializeBus() when it decides recovery is needed.

bool I2CBus::safeReadReg(uint8_t sda_pin, uint8_t scl_pin,
                          uint32_t freq_hz,
                          uint8_t addr, uint8_t reg, uint8_t* out_value)
{
    if (out_value == nullptr) return false;
    *out_value = 0xFF;

    if (!linesIdle(sda_pin, scl_pin) || !lockBus()) return false;
    Wire.setClock(freq_hz);

    uint32_t start = millis();
    uint8_t addr7 = addr & 0x7F;

    Wire.beginTransmission(addr7);
    Wire.write(reg);
    if (Wire.endTransmission() != 0) { unlockBus(); return false; }

    Wire.requestFrom(addr7, (uint8_t)1);

    uint32_t deadline = start + I2C_READ_TIMEOUT_MS;
    while (Wire.available() == 0 && millis() < deadline) { }
    if (Wire.available() == 0) { unlockBus(); return false; }
    *out_value = Wire.read();
    unlockBus();
    return true;
}

bool I2CBus::safeReadBurst(uint8_t sda_pin, uint8_t scl_pin,
                            uint32_t freq_hz,
                            uint8_t addr, uint8_t start_reg,
                            uint8_t* buf, uint8_t cnt)
{
    if (buf == nullptr || cnt == 0 || cnt > 32 ||
        !linesIdle(sda_pin, scl_pin) || !lockBus()) return false;
    Wire.setClock(freq_hz);
    uint32_t start = millis();
    uint8_t addr7 = addr & 0x7F;
    Wire.beginTransmission(addr7);
    Wire.write(start_reg);
    if (Wire.endTransmission() != 0) { unlockBus(); return false; }
    Wire.requestFrom(addr7, cnt);
    uint32_t deadline = start + I2C_READ_TIMEOUT_MS;
    uint8_t got = 0;
    while (got < cnt && millis() < deadline) {
        if (Wire.available()) buf[got++] = Wire.read();
    }
    const bool ok = got == cnt;
    unlockBus();
    return ok;
}

bool I2CBus::safeWriteReg(uint8_t sda_pin, uint8_t scl_pin,
                           uint32_t freq_hz,
                           uint8_t addr, uint8_t reg, uint8_t value)
{
    if (!linesIdle(sda_pin, scl_pin) || !lockBus()) return false;

    Wire.setClock(freq_hz);
    Wire.beginTransmission(addr & 0x7F);
    Wire.write(reg);
    Wire.write(value);
    uint8_t err = Wire.endTransmission();
    unlockBus();

    if (err != 0) {
        Serial.printf("[I2C] safeWrite 0x%02X reg=0x%02X err=%u\n", addr, reg, err);
        return false;
    }
    return true;
}

bool I2CBus::safeWriteBurst(uint8_t sda_pin, uint8_t scl_pin,
                             uint32_t freq_hz,
                             uint8_t addr, uint8_t reg,
                             const uint8_t* buf, uint8_t cnt)
{
    if (buf == nullptr || cnt == 0 || cnt > 30 ||
        !linesIdle(sda_pin, scl_pin) || !lockBus()) return false;

    Wire.setClock(freq_hz);
    Wire.beginTransmission(addr & 0x7F);
    Wire.write(reg);
    for (uint8_t i = 0; i < cnt; ++i) Wire.write(buf[i]);
    const uint8_t err = Wire.endTransmission();
    unlockBus();
    if (err != 0) {
        Serial.printf("[I2C] safeWriteBurst 0x%02X reg=0x%02X len=%u err=%u\n",
                      addr, reg, cnt, err);
        return false;
    }
    return true;
}

bool I2CBus::safeReadReg16(uint8_t sda_pin, uint8_t scl_pin,
                           uint32_t freq_hz, uint8_t addr, uint16_t reg,
                           uint8_t* buf, uint8_t cnt)
{
    if (buf == nullptr || cnt == 0 || cnt > 32 ||
        !linesIdle(sda_pin, scl_pin) || !lockBus()) return false;
    Wire.setClock(freq_hz);
    Wire.beginTransmission(addr & 0x7F);
    Wire.write((uint8_t)(reg >> 8));
    Wire.write((uint8_t)reg);
    if (Wire.endTransmission(false) != 0) { unlockBus(); return false; }
    Wire.requestFrom((uint8_t)(addr & 0x7F), cnt);
    const uint32_t deadline = millis() + I2C_READ_TIMEOUT_MS;
    uint8_t got = 0;
    while (got < cnt && millis() < deadline) {
        if (Wire.available()) buf[got++] = Wire.read();
    }
    unlockBus();
    return got == cnt;
}

bool I2CBus::safeWriteReg16(uint8_t sda_pin, uint8_t scl_pin,
                            uint32_t freq_hz, uint8_t addr, uint16_t reg,
                            const uint8_t* buf, uint8_t cnt)
{
    if (buf == nullptr || cnt == 0 || cnt > 30 ||
        !linesIdle(sda_pin, scl_pin) || !lockBus()) return false;
    Wire.setClock(freq_hz);
    Wire.beginTransmission(addr & 0x7F);
    Wire.write((uint8_t)(reg >> 8));
    Wire.write((uint8_t)reg);
    for (uint8_t i = 0; i < cnt; ++i) Wire.write(buf[i]);
    const uint8_t err = Wire.endTransmission();
    unlockBus();
    return err == 0;
}
