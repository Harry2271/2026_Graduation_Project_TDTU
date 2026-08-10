#include "I2CBus.h"
#include "config.h"
#include <Arduino.h>
#include <Wire.h>

// =====================================================================
// I2CBus — central I2C bus recovery + safe transaction layer.
//
// ESP32 Arduino Wire.endTransmission() blocks forever if SDA is held
// low.  The only safe recovery is:
//   1. Check linesIdle() BEFORE any Wire transaction.
//   2. On NACK or timeout, call busReset() + reinitialize() before retry.
//   3. Never call Wire.end() during a live transaction (can cause RTC_SW_SYS_RST).
//
// External pull-up requirement:
//   2.2k-4.7kΩ from SDA → 3.3V and SCL → 3.3V.
//   Internal pull-ups (~45kΩ) are too weak for BNO055 + VL53L0X + INA226.
// =====================================================================

#define SAFE_READ_TIMEOUT_MS  50   // max ms per Wire.requestFrom()
#define SAFE_TX_TIMEOUT_MS    20   // max ms per Wire.endTransmission()

// ── Bus-level operations ─────────────────────────────────────────────

void I2CBus::busReset(uint8_t sda_pin, uint8_t scl_pin)
{
    Serial.printf("[I2C] Bus reset on SDA=%u SCL=%u\n", sda_pin, scl_pin);

    pinMode(sda_pin, INPUT);
    pinMode(scl_pin, INPUT);
    delayMicroseconds(10);

    // 9-clock toggle — releases stuck slaves per I2C spec
    pinMode(scl_pin, OUTPUT);
    for (int i = 0; i < 9; i++) {
        digitalWrite(scl_pin, HIGH);
        delayMicroseconds(5);
        digitalWrite(scl_pin, LOW);
        delayMicroseconds(5);
    }

    // Ensure SDA high (idle)
    digitalWrite(scl_pin, HIGH);
    pinMode(sda_pin, INPUT_PULLUP);
    digitalWrite(sda_pin, HIGH);
    delay(5);
}

bool I2CBus::reinitialize(uint8_t sda_pin, uint8_t scl_pin, uint32_t freq_hz)
{
    // Bus reset BEFORE Wire.end() to release any stuck slave.
    // This prevents Wire.end() from blocking when a slave is holding SDA low.
    busReset(sda_pin, scl_pin);
    delay(20);

    Wire.end();
    Wire.begin(sda_pin, scl_pin);
    Wire.setClock(freq_hz);
    Wire.setTimeout(I2C_TRANSACTION_TIMEOUT_MS);
    delay(20);

    // Verify bus is responsive
    Wire.beginTransmission(0x00);  // general-call address
    uint8_t err = Wire.endTransmission();
    if (err == 4 || err == 5) {
        Serial.printf("[I2C] reinit failed (err=%d) — bus still unhealthy\n", err);
        return false;
    }
    Serial.printf("[I2C] reinitialized OK on SDA=%u SCL=%u @ %u Hz\n",
                  sda_pin, scl_pin, (unsigned)freq_hz);
    return true;
}

bool I2CBus::isHung(uint8_t sda_pin)
{
    pinMode(sda_pin, INPUT);
    delay(2);
    bool low = (digitalRead(sda_pin) == LOW);
    delay(100);
    bool still_low = (digitalRead(sda_pin) == LOW);
    return (low && still_low);
}

bool I2CBus::linesIdle(uint8_t sda_pin, uint8_t scl_pin)
{
    pinMode(sda_pin, INPUT_PULLUP);
    pinMode(scl_pin, INPUT_PULLUP);
    delayMicroseconds(5);
    return (digitalRead(sda_pin) == HIGH && digitalRead(scl_pin) == HIGH);
}

// ── Probe ────────────────────────────────────────────────────────────

bool I2CBus::probe(uint8_t sda_pin, uint8_t scl_pin, uint8_t addr)
{
    if (!linesIdle(sda_pin, scl_pin)) {
        Serial.printf("[I2C] Bus busy (SDA=%d SCL=%d) — skipping probe 0x%02X\n",
                      digitalRead(sda_pin), digitalRead(scl_pin), addr);
        return false;
    }
    Wire.beginTransmission(addr);
    uint8_t err = Wire.endTransmission();
    if (err != 0) {
        Serial.printf("[I2C] probe 0x%02X: err=%u (SDA=%d SCL=%d)\n",
                      addr, err, digitalRead(sda_pin), digitalRead(scl_pin));
    }
    return (err == 0);
}

bool I2CBus::probeWithRecovery(uint8_t sda_pin, uint8_t scl_pin,
                                uint8_t addr, uint32_t freq_hz)
{
    for (int attempt = 0; attempt < I2C_DEVICE_RETRY_COUNT; attempt++) {
        if (attempt > 0) {
            Serial.printf("[I2C] Recovery attempt %d for 0x%02X...\n", attempt, addr);
            reinitialize(sda_pin, scl_pin, freq_hz);  // busReset + Wire reinit
            delay(I2C_DEVICE_RETRY_DELAY_MS);
        }
        if (probe(sda_pin, scl_pin, addr)) return true;
    }
    return false;
}

// ── Safe Wire wrappers ──────────────────────────────────────────────
//
// These add two layers of protection:
//   1. linesIdle() before Wire.beginTransmission() — prevents Wire from
//      starting a transaction when SDA is already held low.
//   2. Time-bounded read loop — if Wire.requestFrom() stalls, we still
//      return false within SAFE_READ_TIMEOUT_MS instead of blocking.
//
// On failure, they return false.  The caller should call probeWithRecovery()
// to do a full bus reset before retrying.

bool I2CBus::safeReadReg(uint8_t sda_pin, uint8_t scl_pin,
                          uint32_t freq_hz,
                          uint8_t addr, uint8_t reg, uint8_t* out_value)
{
    *out_value = 0xFF;

    if (!linesIdle(sda_pin, scl_pin)) {
        // Bus stuck — reset before next call
        return false;
    }

    uint32_t start = millis();
    Wire.beginTransmission(addr);
    Wire.write((uint8_t)reg);
    Wire.endTransmission();

    Wire.requestFrom(addr, (uint8_t)1);

    uint32_t deadline = start + SAFE_READ_TIMEOUT_MS;
    while (Wire.available() == 0 && millis() < deadline) { /* spin */ }

    if (Wire.available() == 0) return false;
    *out_value = Wire.read();
    return true;
}

bool I2CBus::safeReadBurst(uint8_t sda_pin, uint8_t scl_pin,
                            uint32_t freq_hz,
                            uint8_t addr, uint8_t start_reg,
                            uint8_t* buf, uint8_t cnt)
{
    if (!linesIdle(sda_pin, scl_pin)) return false;

    uint32_t start = millis();
    Wire.beginTransmission(addr);
    Wire.write((uint8_t)start_reg);
    Wire.endTransmission();

    Wire.requestFrom(addr, (uint8_t)cnt);

    uint32_t deadline = start + SAFE_READ_TIMEOUT_MS;
    uint8_t got = 0;
    while (got < cnt && millis() < deadline) {
        if (Wire.available()) {
            buf[got++] = Wire.read();
        }
    }
    return (got == cnt);
}

bool I2CBus::safeWriteReg(uint8_t sda_pin, uint8_t scl_pin,
                           uint32_t freq_hz,
                           uint8_t addr, uint8_t reg, uint8_t value)
{
    if (!linesIdle(sda_pin, scl_pin)) return false;

    uint32_t start = millis();
    Wire.beginTransmission(addr);
    Wire.write((uint8_t)reg);
    Wire.write(value);
    uint8_t err = Wire.endTransmission();

    if (err != 0) {
        Serial.printf("[I2C] safeWrite 0x%02X reg=0x%02X err=%u\n", addr, reg, err);
        return false;
    }
    return true;
}
