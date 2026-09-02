#include "SharpFrontSensor.h"
#include "config.h"
#include <Arduino.h>

SharpFrontSensor::SharpFrontSensor() : distance_mm_(0), last_read_ms_(0) {}

bool SharpFrontSensor::update(uint32_t now_ms) {
    if (now_ms - last_read_ms_ < 20) return false;
    last_read_ms_ = now_ms;

    // Sharp fallback hardware is not installed in the current wiring.
    // Keep this legacy class inert rather than reading an undefined GPIO.
    return false;
}
