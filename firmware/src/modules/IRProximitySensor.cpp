#include "IRProximitySensor.h"
#include <Arduino.h>

// GPIO pin table, indexed by IRPosition enum
const uint8_t IRProximitySensor::PINS_[] = {
    IR_REAR_LEFT_PIN,   // REAR_LEFT
    IR_REAR_RIGHT_PIN,  // REAR_RIGHT
    IR_LEFT_PIN,        // LEFT
    IR_RIGHT_PIN,       // RIGHT
};

IRProximitySensor::IRProximitySensor() : prev_any_(false)
{
    for (int i = 0; i < 4; i++) {
        readings_[i].detected   = false;
        readings_[i].changed_ms = 0;
    }
}

void IRProximitySensor::begin()
{
    for (int i = 0; i < 4; i++) {
        pinMode(PINS_[i], INPUT_PULLUP);
        readings_[i].detected   = false;
        readings_[i].changed_ms = 0;
    }
    Serial.printf("  [OK]   IR Proximity: %d sensors (pins %d,%d,%d,%d)\n",
        IR_SENSOR_COUNT,
        IR_REAR_LEFT_PIN, IR_REAR_RIGHT_PIN,
        IR_LEFT_PIN, IR_RIGHT_PIN);

    // Read raw GPIO states at boot for wiring verification
    Serial.printf("  [INFO] IR GPIO states at boot: ");
    for (int i = 0; i < 4; i++) {
        int raw = digitalRead(PINS_[i]);
        const char* names[] = {"RL", "RR", "L", "R"};
        Serial.printf("%s=%d ", names[i], raw);
    }
    Serial.println("(LOW=detected, HIGH=clear)");
}

bool IRProximitySensor::update(uint32_t now_ms)
{
    bool changed = false;

    for (int i = 0; i < 4; i++) {
        // E18-D80NK: LOW = obstacle detected, HIGH = clear
        bool raw = (digitalRead(PINS_[i]) == LOW);

        if (raw != readings_[i].detected) {
            if (now_ms - readings_[i].changed_ms >= IR_DEBOUNCE_MS) {
                readings_[i].detected   = raw;
                readings_[i].changed_ms = now_ms;
                changed = true;
            }
        } else {
            readings_[i].changed_ms = now_ms;
        }
    }

    return changed;
}

bool IRProximitySensor::isDetected(IRPosition pos) const
{
    if (pos >= IRPosition::COUNT) return false;
    return readings_[static_cast<uint8_t>(pos)].detected;
}

bool IRProximitySensor::anyDetected() const
{
    for (int i = 0; i < 4; i++) {
        if (readings_[i].detected) return true;
    }
    return false;
}

uint8_t IRProximitySensor::detectedMask() const
{
    uint8_t mask = 0;
    for (int i = 0; i < 4; i++) {
        if (readings_[i].detected) mask |= (1 << i);
    }
    return mask;
}

void IRProximitySensor::printStatusJson() const
{
    Serial.printf(
        "{\"type\":135,\"data\":{\"rear_left\":%s,\"rear_right\":%s,\"left\":%s,\"right\":%s}}\n",
        isDetected(IRPosition::REAR_LEFT)  ? "true" : "false",
        isDetected(IRPosition::REAR_RIGHT) ? "true" : "false",
        isDetected(IRPosition::LEFT)       ? "true" : "false",
        isDetected(IRPosition::RIGHT)      ? "true" : "false"
    );
}
