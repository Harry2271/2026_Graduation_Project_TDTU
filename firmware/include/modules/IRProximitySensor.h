#pragma once

#include <stdint.h>
#include "config.h"

enum class IRPosition : uint8_t {
    REAR_LEFT = 0,
    REAR_RIGHT,
    LEFT,
    RIGHT,
    COUNT
};

struct IRReading {
    bool detected;
    uint32_t changed_ms;   // last state-transition timestamp
    uint32_t level_ms;     // when the current level (LOW or HIGH) was first seen
};

class IRProximitySensor {
public:
    IRProximitySensor();
    void begin();

    // Read all 4 sensors, apply debounce. Returns true if any state changed.
    bool update(uint32_t now_ms);

    [[nodiscard]] bool isDetected(IRPosition pos) const;
    [[nodiscard]] bool anyDetected() const;
    [[nodiscard]] uint8_t detectedMask() const;

    void printStatusJson() const;

private:
    static const uint8_t PINS_[4];
    IRReading readings_[4];
    bool sensor_present_[4];   // Always true: hard-stop safety, no auto-disable
    bool prev_any_;
};
