#include "SharpFrontSensor.h"
#include "config.h"
#include <Arduino.h>

SharpFrontSensor::SharpFrontSensor() : distance_mm_(0), last_read_ms_(0) {}

bool SharpFrontSensor::update(uint32_t now_ms) {
    // Sharp fallback hardware is not installed in the current wiring.
    // Return false immediately without any arithmetic or timestamp updates.
    (void)now_ms;  // Suppress unused parameter warning
    return false;
}
