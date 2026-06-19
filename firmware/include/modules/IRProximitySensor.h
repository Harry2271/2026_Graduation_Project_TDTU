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
    uint32_t changed_ms;
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
    bool prev_any_;
};
