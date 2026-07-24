#include "I2CBus.h"
#include <Arduino.h>
#include <Wire.h>

// =====================================================================
// I2CBus — central I2C bus recovery
// =====================================================================

void I2CBus::busReset(uint8_t sda_pin, uint8_t scl_pin)
{
    Serial.printf("[I2C] Bus reset on SDA=%u SCL=%u\n", sda_pin, scl_pin);

    // Release any GPIO previously configured by Wire.
    pinMode(sda_pin, OPEN_DRAIN);
    pinMode(scl_pin, OPEN_DRAIN);

    // 9-clock toggle — releases stuck slaves per I2C spec.
    for (int i = 0; i < 9; i++) {
        digitalWrite(scl_pin, HIGH);
        delayMicroseconds(5);
        digitalWrite(scl_pin, LOW);
        delayMicroseconds(5);
    }

    // Ensure SDA high (idle) — slave should release it after the clock cycles.
    digitalWrite(sda_pin, HIGH);
    digitalWrite(scl_pin, HIGH);
    delay(5);
}

bool I2CBus::reinitialize(uint8_t sda_pin, uint8_t scl_pin, uint32_t freq_hz)
{
    Wire.end();
    // Pin assignment is set by Wire.begin() in Arduino ESP32 core.
    Wire.begin(sda_pin, scl_pin);
    Wire.setClock(freq_hz);
    delay(20);

    // Quick probe to verify bus is responsive.
    Wire.beginTransmission(0x00);  // general-call address, expect NACK
    uint8_t err = Wire.endTransmission();
    if (err == 4 || err == 5) {
        Serial.printf("[I2C] reinit failed (err=%d)\n", err);
        return false;
    }
    Serial.printf("[I2C] reinitialized OK on SDA=%u SCL=%u @ %u Hz\n",
                  sda_pin, scl_pin, (unsigned)freq_hz);
    return true;
}

bool I2CBus::isHung(uint8_t sda_pin)
{
    // Briefly configure SDA as input — if a slave is holding it low,
    // we'll read LOW.  Note: this doesn't catch "Wire is mid-transfer"
    // because the Wire peripheral may still be driving SDA low.
    pinMode(sda_pin, INPUT);
    delay(2);
    bool low = (digitalRead(sda_pin) == LOW);
    delay(100);
    bool still_low = (digitalRead(sda_pin) == LOW);
    return (low && still_low);
}
