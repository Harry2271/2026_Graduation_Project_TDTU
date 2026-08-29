#include "VL53L0XSensor.h"
#include "I2CBus.h"
#include <Arduino.h>
#include <Wire.h>
#include <VL53L0X.h>   // Pololu library
#include <algorithm>    // std::sort for median

// =====================================================================
// VL53L0X TOF Laser Distance Sensor — rear-mounted for unloading
//
// I2C address: 0x29 (default, shared bus with BNO055 0x28 + INA226 0x40)
// Range: 30 mm – 2000 mm (good for 4 cm unloading precision)
// Continuous reading mode with 5-sample median filter to reduce jitter.
// =====================================================================

// Ring buffer for median filter — 5 samples smooths ±35mm jitter
// down to ±5mm while keeping latency to 5 × 50ms = 250ms.
static const int VL53L0X_MEDIAN_LEN = 5;
static uint16_t s_tof_ring[VL53L0X_MEDIAN_LEN];
static int      s_tof_ring_idx = 0;
static int      s_tof_ring_count = 0;

VL53L0XSensor::VL53L0XSensor()
    : sensor_(nullptr)
    , distance_mm_(9999)
    , last_read_ms_(0)
    , sensor_present_(false)
{
}

bool VL53L0XSensor::initializeAtDefaultAndAssign(uint8_t runtime_address)
{
    if (sensor_ != nullptr) return false;
    sensor_ = new VL53L0X();
    sensor_->setBus(&Wire);
    sensor_->setTimeout(500);
    if (!sensor_->init()) {
        delete sensor_;
        sensor_ = nullptr;
        return false;
    }
    sensor_->setAddress(runtime_address);
    delay(10);
    return I2CBus::probe(VL53L0X_SDA_PIN, VL53L0X_SCL_PIN, runtime_address) == 0;
}

bool VL53L0XSensor::begin()
{
    // The XSHUT coordinator initializes this persistent object at 0x29 and
    // changes it to 0x30 before begin() is called.
    if (sensor_ == nullptr) {
        Serial.println("  [WARN] VL53L0X was not initialized by XSHUT sequence");
        return false;
    }

    sensor_->setBus(&Wire);
    constexpr uint16_t VL53L0X_LIB_TIMEOUT_MS = 200;
    sensor_->setTimeout(VL53L0X_LIB_TIMEOUT_MS);

    // High accuracy + reasonable speed (33 ms budget)
    sensor_->setMeasurementTimingBudget(33000);
    sensor_->startContinuous();

    sensor_present_ = true;
    Serial.printf("  [OK]   VL53L0X TOF sensor ready (I2C 0x%02X)\n", VL53L0X_I2C_ADDR);
    return true;
}

bool VL53L0XSensor::update(uint32_t now_ms)
{
    if (!sensor_present_ || !sensor_) return false;
    if (now_ms - last_read_ms_ < VL53L0X_POLL_MS) return false;
    last_read_ms_ = now_ms;

    // Guard: skip read if bus is busy (another device mid-transaction).
    // Pololu VL53L0X library does NOT use linesIdle() internally — it calls
    // Wire.endTransmission() directly, which can block if bus is busy.
    if (!I2CBus::linesIdle(VL53L0X_SDA_PIN, VL53L0X_SCL_PIN)) return false;

    uint16_t raw = sensor_->readRangeContinuousMillimeters();

    // VL53L0X returns 8190/8191 on timeout or out-of-range
    if (raw >= 8000) {
        raw = 9999;
    }

    // Push into median ring buffer
    s_tof_ring[s_tof_ring_idx] = raw;
    s_tof_ring_idx = (s_tof_ring_idx + 1) % VL53L0X_MEDIAN_LEN;
    if (s_tof_ring_count < VL53L0X_MEDIAN_LEN) s_tof_ring_count++;

    // Need at least 3 samples before median is meaningful
    if (s_tof_ring_count < 3) {
        distance_mm_ = raw;  // warm-up: pass through
        return true;
    }

    // Median of the ring (copy + sort — small buffer, cheap)
    uint16_t sorted[VL53L0X_MEDIAN_LEN];
    memcpy(sorted, s_tof_ring, sizeof(sorted));
    std::sort(sorted, sorted + s_tof_ring_count);
    distance_mm_ = sorted[s_tof_ring_count / 2];  // middle element

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
    PiSerial.printf(
        "{\"type\":138,\"data\":{\"distance_mm\":%u,\"distance_cm\":%.1f,\"at_unload\":%s,\"present\":%s}}\n",
        distance_mm_,
        getDistanceCm(),
        isAtUnloadingDistance() ? "true" : "false",
        sensor_present_ ? "true" : "false"
    );
}
