#include "VL53L0XSensor.h"
#include <Arduino.h>
#include <Wire.h>
#include <VL53L0X.h>   // Pololu library

// =====================================================================
// VL53L0X TOF Laser Distance Sensor — rear-mounted for unloading
//
// I2C address: 0x29 (default, shared bus with BNO055 0x28 + INA226 0x40)
// Range: 30 mm – 2000 mm (good for 4 cm unloading precision)
// Continuous reading mode for smooth updates.
// =====================================================================

VL53L0XSensor::VL53L0XSensor()
    : sensor_(nullptr)
    , distance_mm_(9999)
    , last_read_ms_(0)
    , sensor_present_(false)
{
}

bool VL53L0XSensor::begin()
{
    sensor_ = new VL53L0X();
    sensor_->setBus(&Wire);

    if (!sensor_->init()) {
        Serial.println("  [WARN] VL53L0X not found — TOF distance disabled");
        delete sensor_;
        sensor_ = nullptr;
        sensor_present_ = false;
        return false;
    }

    // High accuracy + reasonable speed (33 ms budget)
    sensor_->setMeasurementTimingBudget(33000);
    sensor_->startContinuous();

    sensor_present_ = true;
    Serial.println("  [OK]   VL53L0X TOF sensor ready (I2C 0x29)");
    return true;
}

bool VL53L0XSensor::update(uint32_t now_ms)
{
    if (!sensor_present_ || !sensor_) return false;
    if (now_ms - last_read_ms_ < VL53L0X_POLL_MS) return false;
    last_read_ms_ = now_ms;

    distance_mm_ = sensor_->readRangeContinuousMillimeters();

    // VL53L0X returns 8190/8191 on timeout or out-of-range
    if (distance_mm_ >= 8000) {
        distance_mm_ = 9999;  // out of range
    }

    return true;
}

uint16_t VL53L0XSensor::getDistanceMm() const
{
    return distance_mm_;
}

float VL53L0XSensor::getDistanceCm() const
{
    return distance_mm_ / 10.0f;
}

bool VL53L0XSensor::isAtUnloadingDistance() const
{
    if (!sensor_present_) return false;
    return distance_mm_ <= VL53L0X_UNLOAD_DISTANCE_MM;
}

void VL53L0XSensor::printStatusJson() const
{
    Serial.printf(
        "{\"type\":138,\"data\":{\"distance_mm\":%u,\"distance_cm\":%.1f,\"at_unload\":%s,\"present\":%s}}\n",
        distance_mm_,
        getDistanceCm(),
        isAtUnloadingDistance() ? "true" : "false",
        sensor_present_ ? "true" : "false"
    );
}
