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
