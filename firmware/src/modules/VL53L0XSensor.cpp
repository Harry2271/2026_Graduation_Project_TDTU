#include "VL53L0XSensor.h"
#include "I2CBus.h"
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
    // Probe with bus-idle guard + controlled recovery retry on timeout.
    // NACK (err=2) returns immediately — no bus reset, since that would
    // disrupt the BNO055 and INA226 sitting on the same bus.
    int probe_err = I2CBus::probeWithRecovery(VL53L0X_SDA_PIN, VL53L0X_SCL_PIN,
                                               VL53L0X_I2C_ADDR, VL53L0X_I2C_FREQ_HZ);
    if (probe_err != 0) {
        Serial.printf("  [WARN] VL53L0X %s at 0x%02X — sensor absent\n",
                      I2CBus::errorName(probe_err), VL53L0X_I2C_ADDR);
        return false;
    }
    Serial.printf("  [OK]   VL53L0X ACK at 0x%02X\n", VL53L0X_I2C_ADDR);

    sensor_ = new VL53L0X();
    sensor_->setBus(&Wire);
    // Bound the Pololu library's internal read timeout.  Use 200 ms instead
    // of I2C_TRANSACTION_TIMEOUT_MS (100 ms) because the shared I2C bus
    // routinely blocks for the duration of a BNO055 Euler burst read
    // (6-byte + ACK sequence), and a tight 100 ms triggers spurious timeout
    // returns (8190 mm) every time the bus is busy with the IMU.
    constexpr uint16_t VL53L0X_LIB_TIMEOUT_MS = 200;
    sensor_->setTimeout(VL53L0X_LIB_TIMEOUT_MS);

    // Pololu init can hang on ESP32 if the bus is flaky — retry up to
    // I2C_DEVICE_RETRY_COUNT times with a centralized bus recovery
    // between attempts. Only triggers a real recovery when init() fails
    // (which means the bus is misbehaving), never on simple missing sensor.
    bool init_ok = false;
    for (int attempt = 0; attempt < I2C_DEVICE_RETRY_COUNT; attempt++) {
        if (sensor_->init()) { init_ok = true; break; }
        Serial.printf("  [WARN] VL53L0X init attempt %d failed\n", attempt + 1);
        I2CBus::reinitializeBus(VL53L0X_SDA_PIN, VL53L0X_SCL_PIN, VL53L0X_I2C_FREQ_HZ);
        sensor_->setBus(&Wire);
        sensor_->setTimeout(VL53L0X_LIB_TIMEOUT_MS);
        delay(I2C_DEVICE_RETRY_DELAY_MS);
    }
    if (!init_ok) {
        Serial.println("  [WARN] VL53L0X init failed — sensor disabled");
        delete sensor_;
        sensor_ = nullptr;
        sensor_present_ = false;
        return false;
    }

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
    PiSerial.printf(
        "{\"type\":138,\"data\":{\"distance_mm\":%u,\"distance_cm\":%.1f,\"at_unload\":%s,\"present\":%s}}\n",
        distance_mm_,
        getDistanceCm(),
        isAtUnloadingDistance() ? "true" : "false",
        sensor_present_ ? "true" : "false"
    );
}
