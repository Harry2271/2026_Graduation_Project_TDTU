#pragma once

#include <stdint.h>
#include "config.h"

/**
 * CylinderActuator — controls a 12VDC electric cylinder via L298N motor driver.
 *
 * The L298N provides bidirectional control:
 *   IN1=HIGH, IN2=LOW  → extend (lift dump body)
 *   IN1=LOW,  IN2=HIGH → retract (lower dump body)
 *   IN1=LOW,  IN2=LOW  → stop / coast
 *
 * ENA is tied HIGH (5V) — no PWM speed control, full speed on/off.
 * Safety timeout: auto-stop after CYLINDER_MAX_RUN_MS to prevent damage.
 *
 * Flowchart integration:
 *   ExtendActuator  — Đẩy/Nâng xy lanh điện
 *   DropItem        — Đổ hàng (wait after extend)
 *   RetractActuator — Thu xy lanh điện
 */
enum CylinderState : uint8_t {
    CYL_IDLE     = 0,   // not moving, retracted
    CYL_EXTENDING = 1,  // currently extending
    CYL_RETRACTING = 2, // currently retracting
    CYL_EXTENDED  = 3,  // fully extended
};

class CylinderActuator {
public:
    CylinderActuator();

    /// Set GPIO pins. Call once in setup.
    void begin();

    /// Extend the cylinder (lift dump body for unloading)
    void extend();

    /// Retract the cylinder (lower dump body after unloading)
    void retract();

    /// Emergency stop — immediately halt cylinder
    void stop();

    /// Call periodically to enforce timeout safety
    void update(uint32_t now_ms);

    [[nodiscard]] CylinderState getState() const { return state_; }
    [[nodiscard]] bool isExtended() const { return state_ == CYL_EXTENDED || state_ == CYL_EXTENDING; }
    [[nodiscard]] bool isMoving() const { return state_ == CYL_EXTENDING || state_ == CYL_RETRACTING; }
    [[nodiscard]] bool isIdle() const { return state_ == CYL_IDLE; }

    /// Debug print (type 139 JSON)
    void printStatusJson() const;

    /// Human-readable state name
    static const char* stateName(CylinderState s);

private:
    CylinderState state_;
    uint32_t      move_start_ms_;
};
