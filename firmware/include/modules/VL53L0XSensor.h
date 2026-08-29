#pragma once

#include <stdint.h>
#include "config.h"

// Forward declare to avoid pulling the full Pololu library header
class VL53L0X;

/**
 * VL53L0XSensor — wrapper around the Pololu VL53L0X TOF laser distance sensor.
 *
 * Mounted on the rear/bottom of the vehicle, pointing at the ground/shelf,
 * used for precise distance measurement during the unloading sequence.
 * The sensor shares the I2C bus with BNO055 (0x28) and INA226 (0x40).
 *
 * Flowchart integration:
 *   DistanceCheck — VL53L0X đạt khoảng cách đổ hàng?
 *     → Yes (<= threshold): extend cylinder
 *     → No: adjust position (advance/reverse), loop back
 */
class VL53L0XSensor {
public:
    VL53L0XSensor();

    /// Initialize the VL53L0X on the shared I2C bus. Returns true if found.
    bool begin();

    /// Called by the XSHUT coordinator while this device alone is at 0x29.
    bool initializeAtDefaultAndAssign(uint8_t runtime_address);

    /// Read distance. Call periodically (non-blocking). Returns true if new reading.
    bool update(uint32_t now_ms);

    [[nodiscard]] uint16_t getDistanceMm() const;
    [[nodiscard]] float    getDistanceCm() const;
    [[nodiscard]] bool     isAtUnloadingDistance() const;   // <= threshold
    /// True only when a successful sample was received within the freshness window.
    [[nodiscard]] bool     hasFreshReading(uint32_t now_ms) const;
    [[nodiscard]] bool     isPresent() const { return sensor_present_; }

    /// Debug print (type 138 JSON)
    void printStatusJson() const;

private:
    VL53L0X* sensor_;
    uint16_t distance_mm_;
    uint32_t last_read_ms_;
    bool     sensor_present_;
};
