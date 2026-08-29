#pragma once

#include <stdint.h>
#include "config.h"

class VL53L1X;

/**
 * Front-mounted TOF400C/VL53L1X wrapper.
 *
 * The sensor is fail-closed: absent, invalid, timed-out, and stale readings
 * are all treated as front obstacles.
 */
class FrontTofSensor {
public:
    FrontTofSensor();

    bool begin();
    bool update(uint32_t now_ms);

    [[nodiscard]] uint16_t getDistanceMm() const { return distance_mm_; }
    [[nodiscard]] float getDistanceCm() const;
    [[nodiscard]] bool isPresent() const { return sensor_present_; }
    [[nodiscard]] bool isReadingValid() const { return reading_valid_; }
    [[nodiscard]] bool isStale(uint32_t now_ms) const;
    [[nodiscard]] bool isTooClose(uint32_t now_ms = 0) const;
    [[nodiscard]] bool isSlowing(uint32_t now_ms = 0) const;

    // Type 136; the legacy Sharp-compatible fields remain present.
    void printStatusJson() const;

private:
    VL53L1X* sensor_;
    uint16_t distance_mm_;
    uint16_t prev_distance_mm_;
    uint32_t last_read_ms_;
    bool sensor_present_;
    bool reading_valid_;
};
