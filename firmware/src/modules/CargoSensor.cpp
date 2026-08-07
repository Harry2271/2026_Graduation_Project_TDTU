#include "CargoSensor.h"
#include <Arduino.h>

// PiSerial is defined in modules.h as alias for Serial (UART0 GPIO43/44).
// Pull it in here so emitStatusJson can write JSON lines to the Pi link.
#ifndef PiSerial
#define PiSerial Serial
#endif

#define CARGO_SENSOR_PIN         36      // Free GPIO (BNO055 uses I2C, SPI MISO unused)
#define CARGO_SENSOR_DEBOUNCE_MS 100     // 100 ms debounce for vibration rejection
// Limit switch wired as NO (normally open) + INPUT_PULLUP:
//   NO connected between GPIO36 and GND.
//   Switch open (no cargo) → pull-up → HIGH (logic 1)
//   Switch pressed by cargo → shorted to GND → LOW  (logic 0)
// User requires: HIGH = cargo present on bed.
// Therefore cargo_present = (raw == HIGH).
#define CARGO_PRESENT_LEVEL      HIGH

CargoSensor::CargoSensor()
    : pin_(CARGO_SENSOR_PIN),
      raw_(false),
      present_(false),
      last_change_ms_(0),
      last_raw_(false)
{
}

void CargoSensor::begin()
{
    pinMode(pin_, INPUT_PULLUP);
    raw_ = (digitalRead(pin_) == CARGO_PRESENT_LEVEL);
    last_raw_ = raw_;
    present_ = raw_;
    last_change_ms_ = millis();

    Serial.printf("  [OK]   Cargo limit switch: GPIO %d (%s)\n",
                  pin_, present_ ? "cargo detected at boot" : "bed empty at boot");
}

bool CargoSensor::update(uint32_t now_ms)
{
    bool new_raw = (digitalRead(pin_) == CARGO_PRESENT_LEVEL);
    bool changed = false;

    if (new_raw != last_raw_) {
        last_change_ms_ = now_ms;
        last_raw_ = new_raw;
    }

    // Only accept transition if it has been stable for DEBOUNCE_MS
    if ((now_ms - last_change_ms_) >= CARGO_SENSOR_DEBOUNCE_MS && new_raw != present_) {
        present_ = new_raw;
        raw_ = new_raw;
        changed = true;
    }

    return changed;
}

void CargoSensor::emitStatusJson() const
{
    uint32_t debounce_ms = (millis() > last_change_ms_) ?
                           (millis() - last_change_ms_) : 0;
    PiSerial.printf(
        "{\"type\":145,\"data\":{\"present\":%s,\"debounce_ms\":%lu}}\n",
        present_ ? "true" : "false",
        (unsigned long)debounce_ms);
}