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

    static const char* ir_names[] = {"rear_left", "rear_right", "left", "right"};

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

            // ---- Sustained-detect warning ----
            // A sensor stuck LOW for >15 s continuously is almost certainly
            // a wiring fault, not a real obstacle.  Real obstacles move.
            // Surface this so the user can diagnose and fix it, rather than
            // silently locking the robot into perpetual evasion.
            static uint32_t last_ir_warn_ms[4] = {0, 0, 0, 0};
            if (readings_[i].detected &&
                (now_ms - readings_[i].level_ms) > 15000 &&
                (now_ms - last_ir_warn_ms[i]) >= 30000) {
                Serial.printf("[IR] WARNING: %s stuck LOW for %lu s — check wiring, potentiometer, or physically clear path\n",
                    ir_names[i], (unsigned long)(now_ms - readings_[i].level_ms) / 1000);
                last_ir_warn_ms[i] = now_ms;
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
        // Always trust the configured GPIO.  The previous auto-disable
        // marked healthy sensors as absent after five seconds of "no
        // transition" — including a stationary robot with no obstacle —
        // and disabled the hard-stop protection that this method exists
        // to provide.
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
