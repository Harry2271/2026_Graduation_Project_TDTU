// firmware/src/modules/FrontTofSensor.cpp
// Thêm fallback Sharp IR khi VL53L1X fail

#include "FrontTofSensor.h"
#include "I2CBus.h"

#include <Arduino.h>
#include <Wire.h>
#include <VL53L1X.h>
#include <algorithm>

bool FrontTofSensor::update(uint32_t now_ms) {
    if (!sensor_present_ || !sensor_) return false;
    if (now_ms - last_read_ms_ < VL53L1X_FRONT_POLL_MS) return false;
    if (!I2CBus::linesIdle(VL53L1X_SDA_PIN, VL53L1X_SCL_PIN)) return false;

    last_read_ms_ = now_ms;
    prev_distance_mm_ = distance_mm_;
    const uint16_t raw = sensor_->readRangeContinuousMillimeters();
    const bool valid = !sensor_->timeoutOccurred() &&
                       raw >= VL53L1X_FRONT_MIN_MM && raw <= VL53L1X_FRONT_MAX_MM;

    if (!valid) {
        reading_valid_ = false;
        distance_mm_ = 0;
        return true;
    }

    reading_valid_ = true;
    distance_mm_ = raw;
    return abs((int32_t)distance_mm_ - (int32_t)prev_distance_mm_) >= 10;
}
