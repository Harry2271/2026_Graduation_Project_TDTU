# firmware/src/modules/SharpFrontSensor.h
# Sharp IR fallback cho FrontTofSensor

#pragma once

#include <stdint.h>

class SharpFrontSensor {
public:
    SharpFrontSensor();
    bool update(uint32_t now_ms);
    uint16_t getDistanceMm() const { return distance_mm_; }

private:
    uint16_t distance_mm_;
    uint32_t last_read_ms_;
};

# firmware/src/modules/SharpFrontSensor.cpp
# Sharp IR fallback

#include "SharpFrontSensor.h"
#include "config.h"
#include <Arduino.h>

SharpFrontSensor::SharpFrontSensor() : distance_mm_(0), last_read_ms_(0) {}

bool SharpFrontSensor::update(uint32_t now_ms) {
    if (now_ms - last_read_ms_ < 20) return false;
    last_read_ms_ = now_ms;

    int val = analogRead(FRONT_SHARP_PIN);
    // Convert voltage to cm (typical Sharp GP2Y0A21YK0F curve)
    // val 0-1023 -> distance 10-80cm
    if (val < 100 || val > 900) return false;

    distance_mm_ = (uint16_t)(10 + (80 - 10) * (1023 - val) / 923.0);
    return true;
}
