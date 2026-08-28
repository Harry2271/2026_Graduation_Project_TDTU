#include "FrontTofSensor.h"
#include "I2CBus.h"

#include <Arduino.h>
#include <Wire.h>
#include <VL53L1X.h>
#include <algorithm>

namespace {
constexpr uint8_t FRONT_TOF_MEDIAN_LEN = 5;
constexpr uint16_t FRONT_TOF_INVALID_MM = 9999;

bool isAcceptableRangeStatus(VL53L1X::RangeStatus status)
{
    return status == VL53L1X::RangeValid ||
           status == VL53L1X::RangeValidMinRangeClipped ||
           status == VL53L1X::RangeValidNoWrapCheckFail;
}
}

FrontTofSensor::FrontTofSensor()
    : sensor_(nullptr)
    , distance_mm_(FRONT_TOF_INVALID_MM)
    , prev_distance_mm_(FRONT_TOF_INVALID_MM)
    , last_read_ms_(0)
    , sensor_present_(false)
    , reading_valid_(false)
{
}

bool FrontTofSensor::initializeAtDefaultAndAssign(uint8_t runtime_address)
{
    if (sensor_ != nullptr) return false;
    sensor_ = new VL53L1X();
    sensor_->setBus(&Wire);
    sensor_->setTimeout(500);
    if (!sensor_->init()) {
        delete sensor_;
        sensor_ = nullptr;
        return false;
    }
    sensor_->setAddress(runtime_address);
    delay(10);
    return I2CBus::probe(VL53L1X_SDA_PIN, VL53L1X_SCL_PIN, runtime_address) == 0;
}

bool FrontTofSensor::begin()
{
    sensor_present_ = false;
    reading_valid_ = false;
    distance_mm_ = FRONT_TOF_INVALID_MM;
    last_read_ms_ = 0;

    // The XSHUT coordinator initializes this persistent object at 0x29 and
    // changes it to 0x31 before begin() is called.
    if (sensor_ == nullptr) {
        Serial.println("  [WARN] Front VL53L1X was not initialized by XSHUT sequence");
        return false;
    }
    sensor_->setBus(&Wire);
    sensor_->setTimeout(VL53L1X_FRONT_TIMEOUT_MS);

    if (!sensor_->setDistanceMode(VL53L1X::Long) ||
        !sensor_->setMeasurementTimingBudget(50000)) {
        Serial.println("  [WARN] Front VL53L1X configuration failed — forward motion blocked");
        return false;
    }

    sensor_->startContinuous(VL53L1X_FRONT_POLL_MS);
    sensor_present_ = true;
    Serial.printf("  [OK]   Front VL53L1X TOF400C ready (I2C 0x%02X)\n",
                  VL53L1X_I2C_ADDR);
    return true;
}

bool FrontTofSensor::update(uint32_t now_ms)
{
    if (!sensor_present_ || !sensor_) return false;
    if (now_ms - last_read_ms_ < VL53L1X_FRONT_POLL_MS) return false;
    if (!I2CBus::linesIdle(VL53L1X_SDA_PIN, VL53L1X_SCL_PIN)) return false;

    last_read_ms_ = now_ms;
    prev_distance_mm_ = distance_mm_;
    const uint16_t raw = sensor_->readRangeContinuousMillimeters();
    const bool valid = !sensor_->timeoutOccurred() &&
        isAcceptableRangeStatus(sensor_->ranging_data.range_status) &&
        raw >= VL53L1X_FRONT_MIN_MM && raw <= VL53L1X_FRONT_MAX_MM;

    if (!valid) {
        reading_valid_ = false;
        distance_mm_ = FRONT_TOF_INVALID_MM;
        return true;
    }

    reading_valid_ = true;
    distance_mm_ = raw;
    return abs((int32_t)distance_mm_ - (int32_t)prev_distance_mm_) >= 10;
}

float FrontTofSensor::getDistanceCm() const
{
    return distance_mm_ / 10.0f;
}

bool FrontTofSensor::isStale(uint32_t now_ms) const
{
    if (!sensor_present_ || !reading_valid_ || last_read_ms_ == 0) return true;
    if (now_ms == 0) return false;
    return now_ms - last_read_ms_ > VL53L1X_FRONT_STALE_MS;
}

bool FrontTofSensor::isTooClose(uint32_t now_ms) const
{
    if (isStale(now_ms)) return true;
    return distance_mm_ < VL53L1X_FRONT_THRESHOLD_CM * 10;
}

bool FrontTofSensor::isSlowing(uint32_t now_ms) const
{
    if (isStale(now_ms)) return true;
    return distance_mm_ < VL53L1X_FRONT_SLOW_CM * 10;
}

void FrontTofSensor::printStatusJson() const
{
    const bool stale = isStale(millis());
    const bool valid = reading_valid_ && !stale;
    PiSerial.printf(
        "{\"type\":136,\"data\":{\"sensor\":\"vl53l1x\",\"source\":\"front_tof\","
        "\"distance_mm\":%u,\"distance_cm\":%.1f,\"valid\":%s,\"stale\":%s,"
        "\"present\":%s,\"too_close\":%s,\"slowing\":%s}}\n",
        distance_mm_, getDistanceCm(), valid ? "true" : "false",
        stale ? "true" : "false", sensor_present_ ? "true" : "false",
        isTooClose(millis()) ? "true" : "false",
        isSlowing(millis()) ? "true" : "false");
}
