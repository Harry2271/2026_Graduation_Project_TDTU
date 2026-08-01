#include "IRProximitySensor.h"
#include <Arduino.h>

// GPIO pin table, indexed by IRPosition enum
const uint8_t IRProximitySensor::PINS_[] = {
    IR_REAR_LEFT_PIN,   // REAR_LEFT
    IR_REAR_RIGHT_PIN,  // REAR_RIGHT
    IR_LEFT_PIN,        // LEFT
    IR_RIGHT_PIN,       // RIGHT
};

// After this many ms with the same digital reading, trust that the pin is
// healthy.  Used to recover from a false "sensor absent" verdict on the
// ESP32-S3 strapping pins (GPIO 45/46) which float LOW briefly during boot.
static const uint32_t IR_TRUST_SETTLE_MS = 2000;

// How long a pin must stay stuck LOW (or HIGH) with no transitions before we
// decide the sensor is genuinely absent.  5 s is long enough to rule out a
// persistent object in front of the sensor.
static const uint32_t IR_ABSENT_TRIGGER_MS = 5000;

IRProximitySensor::IRProximitySensor() : prev_any_(false)
{
    for (int i = 0; i < 4; i++) {
        readings_[i].detected   = false;
        readings_[i].changed_ms = 0;
        readings_[i].level_ms   = 0;
        sensor_present_[i]      = true;  // optimistic — runtime decides
    }
}

void IRProximitySensor::begin()
{
    for (int i = 0; i < 4; i++) {
        pinMode(PINS_[i], INPUT_PULLUP);
        readings_[i].detected   = false;
        readings_[i].changed_ms = 0;
        readings_[i].level_ms   = millis();
    }
    Serial.printf("  [OK]   IR Proximity: %d sensors (pins %d,%d,%d,%d)\n",
        IR_SENSOR_COUNT,
        IR_REAR_LEFT_PIN, IR_REAR_RIGHT_PIN,
        IR_LEFT_PIN, IR_RIGHT_PIN);

    // Read raw GPIO states at boot for wiring verification only.
    // Do NOT mark a sensor as absent here — GPIO 45/46 are ESP32-S3 strapping
    // pins that float LOW during the brief boot window, even when the E18-D80NK
    // is correctly wired.  Absent detection happens in update() below after the
    // strapping pin state has settled.
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
                readings_[i].level_ms   = now_ms;
                changed = true;
            }
        } else {
            readings_[i].changed_ms = now_ms;
            // Track how long this pin has held its current digital level.
            // A real sensor on a moving robot sees many transitions per second.
            // An absent or stuck sensor holds one level indefinitely.
            if (now_ms - readings_[i].level_ms >= IR_ABSENT_TRIGGER_MS) {
                if (sensor_present_[i]) {
                    sensor_present_[i] = false;
                    Serial.printf("  [WARN] IR[%d] (GPIO %d) stuck for %lu ms — marking absent\n",
                                  i, PINS_[i], (unsigned long)(now_ms - readings_[i].level_ms));
                }
            }
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
        if (!sensor_present_[i]) continue;  // treat absent sensor as "no obstacle"
        if (readings_[i].detected) mask |= (1 << i);
    }
    return mask;
}

void IRProximitySensor::printStatusJson() const
{
    PiSerial.printf(
        "{\"type\":135,\"data\":{\"rear_left\":%s,\"rear_right\":%s,\"left\":%s,\"right\":%s}}\n",
        isDetected(IRPosition::REAR_LEFT)  ? "true" : "false",
        isDetected(IRPosition::REAR_RIGHT) ? "true" : "false",
        isDetected(IRPosition::LEFT)       ? "true" : "false",
        isDetected(IRPosition::RIGHT)      ? "true" : "false"
    );
}
