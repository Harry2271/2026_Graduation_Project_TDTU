#include "CylinderActuator.h"
#include <Arduino.h>

// =====================================================================
// CylinderActuator — 12VDC linear actuator via L298N driver
//
// Control logic (direct GPIO, no LEDC PWM):
//   EXTEND:  IN1 = HIGH, IN2 = LOW
//   RETRACT: IN1 = LOW,  IN2 = HIGH
//   STOP:    IN1 = LOW,  IN2 = LOW
//
// ENA pin is tied HIGH on the L298N board (jumper in place),
// so we only need the two direction pins.
//
// Safety: auto-stop after CYLINDER_MAX_RUN_MS to prevent mechanical
// damage if limit switch or feedback is not connected.
// =====================================================================

CylinderActuator::CylinderActuator()
    : state_(CYL_IDLE)
    , move_start_ms_(0)
{
}

void CylinderActuator::begin()
{
    pinMode(CYLINDER_IN1_PIN, OUTPUT);
    pinMode(CYLINDER_IN2_PIN, OUTPUT);

    // Ensure stopped on boot
    digitalWrite(CYLINDER_IN1_PIN, LOW);
    digitalWrite(CYLINDER_IN2_PIN, LOW);

    Serial.printf("  [CYL] IN1=GPIO%d IN2=GPIO%d (max run %lu ms)\n",
        CYLINDER_IN1_PIN, CYLINDER_IN2_PIN, (unsigned long)CYLINDER_MAX_RUN_MS);
}

void CylinderActuator::extend()
{
    if (state_ == CYL_EXTENDING) return;  // already extending

    Serial.println("[CYL] EXTEND");
    digitalWrite(CYLINDER_IN1_PIN, HIGH);
    digitalWrite(CYLINDER_IN2_PIN, LOW);
    state_ = CYL_EXTENDING;
    move_start_ms_ = millis();
}

void CylinderActuator::retract()
{
    if (state_ == CYL_RETRACTING) return;  // already retracting

    Serial.println("[CYL] RETRACT");
    digitalWrite(CYLINDER_IN1_PIN, LOW);
    digitalWrite(CYLINDER_IN2_PIN, HIGH);
    state_ = CYL_RETRACTING;
    move_start_ms_ = millis();
}

void CylinderActuator::stop()
{
    if (state_ == CYL_IDLE) return;

    Serial.println("[CYL] STOP");
    digitalWrite(CYLINDER_IN1_PIN, LOW);
    digitalWrite(CYLINDER_IN2_PIN, LOW);

    if (state_ == CYL_EXTENDING) {
        state_ = CYL_EXTENDED;   // last action was extend → assume extended
    } else {
        state_ = CYL_IDLE;       // last action was retract → assume retracted
    }
}

void CylinderActuator::update(uint32_t now_ms)
{
    if (state_ != CYL_EXTENDING && state_ != CYL_RETRACTING) return;

    // Safety timeout: auto-stop if running too long
    if ((now_ms - move_start_ms_) >= CYLINDER_MAX_RUN_MS) {
        Serial.printf("[CYL] TIMEOUT after %lu ms — auto-stopping\n",
            (unsigned long)CYLINDER_MAX_RUN_MS);
        stop();
    }
}

const char* CylinderActuator::stateName(CylinderState s)
{
    switch (s) {
        case CYL_IDLE:      return "idle";
        case CYL_EXTENDING: return "extending";
        case CYL_RETRACTING: return "retracting";
        case CYL_EXTENDED:  return "extended";
        default:            return "unknown";
    }
}

void CylinderActuator::printStatusJson() const
{
    PiSerial.printf(
        "{\"type\":139,\"data\":{\"state\":\"%s\",\"extended\":%s,\"moving\":%s}}\n",
        stateName(state_),
        isExtended() ? "true" : "false",
        isMoving() ? "true" : "false"
    );
}
