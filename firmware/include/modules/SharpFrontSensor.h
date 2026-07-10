#pragma once

#include <stdint.h>
#include "config.h"

class SharpFrontSensor {
public:
    SharpFrontSensor();
    void begin();

    // Read ADC and compute distance. Returns true if distance changed significantly.
    bool update(uint32_t now_ms);

    [[nodiscard]] float getDistanceCm() const;
    [[nodiscard]] bool isTooClose() const;   // < SHARP_FRONT_THRESHOLD_CM (false if sensor absent)
    [[nodiscard]] bool isSlowing() const;    // < SHARP_FRONT_SLOW_CM  (false if sensor absent)
    [[nodiscard]] bool isPresent() const { return sensor_present_; }

    void printStatusJson() const;

private:
    float distance_cm_;
    float prev_distance_cm_;
    uint32_t last_read_ms_;
    bool sensor_present_;  // false if ADC reads garbage at boot (sensor absent)
};
