#pragma once

#include <stdint.h>

class IRProximitySensor;
class FrontTofSensor;

// =====================================================================
// AvoidanceFSM — Multi-sensor obstacle avoidance state machine
//
// Uses 4 IR proximity sensors (digital) + 1 Front ToF sensor (analog)
// + optional BNO055 heading feedback + encoder distance feedback.
//
// Decision priority (highest → lowest):
//   1. Front ToF < 15cm → HARD STOP
//   2. IR sensors → evaluate + dodge (strafe/rotate/reverse)
//   3. Front ToF < 60cm → slow down
//   4. No obstacles → normal roaming
//
// Encoder-based reverse: tracks wheel encoder pulses to stop after 30cm.
// Heading-based rotation: uses BNO055 to rotate exactly 90° or 180°.
// =====================================================================

enum AvoidanceState : uint8_t {
    STATE_IDLE = 0,
    STATE_ROAMING,
    STATE_EVALUATING,
    STATE_STRAFING,
    STATE_ROTATING,
    STATE_REVERSING,
    STATE_FRONT_STOP,
    STATE_E_STOPPED,
};

struct AvoidanceAction {
    int16_t  vx;
    int16_t  vy;
    int16_t  omega;
    bool     hard_stop;
    const char* description;
};

class AvoidanceFSM {
public:
    AvoidanceFSM();

    /// Initialize FSM parameters
    void begin();

    /// Main tick — call every PID cycle (20ms / 50Hz).
    /// Reads IR + Front ToF sensors, runs state machine, returns motor command.
    AvoidanceAction tick(uint32_t now_ms,
                         const IRProximitySensor& ir,
                         const FrontTofSensor& front_tof,
                         int16_t nav_vx,
                         int16_t nav_vy,
                         int16_t nav_omega);

    /// Feed heading from BNO055 (used during STATE_ROTATING to track turn angle)
    void feedHeading(float heading_deg);

    /// Feed encoder wheel delta pulses (used during STATE_REVERSING to track distance)
    /// fl_delta: FL encoder pulse count since last call (positive = forward)
    void feedEncoderDelta(int32_t fl_delta);

    /// Pi LiDAR front-left / front-right events covering the FL/FR wheel
    /// corners that onboard IR + front ToF cannot see. Fail-closed: once
    /// set, the corner stays blocked until an explicit clear.
    void setFrontCornerBlocked(bool left, bool right);
    void clearFrontCorners();

    /// Bounded recovery request from the motion-progress watchdog. Forces
    /// a re-evaluate instead of continuing to push into a jam. Never
    /// invents a reverse vector — evaluate() still refuses reverse when
    /// rear IR is asserted.
    void requestRecovery(uint32_t now_ms);

    // Getters
    AvoidanceState getState() const { return state_; }
    const char* getStateName() const;
    bool isHardStopped() const { return state_ == STATE_E_STOPPED || state_ == STATE_FRONT_STOP; }
    bool isDodgeActive() const;

    /// Reset to idle (e.g. after e-stop clear from Pi)
    void reset();

private:
    // State machine
    AvoidanceState state_;
    uint32_t state_enter_ms_;

    // Decision inputs (latest snapshot)
    uint8_t ir_mask_;
    bool    front_tof_too_close_;
    bool    front_tof_slowing_;
    bool    front_left_blocked_;
    bool    front_right_blocked_;

    // Heading feedback
    float heading_deg_;
    float rotate_start_heading_;
    float rotate_target_heading_;
    bool  rotate_heading_valid_;

    // Encoder feedback (for reverse distance)
    int32_t reverse_start_pulse_;
    int32_t reverse_pulse_now_;
    int32_t reverse_target_pulse_;

    // Anti-stuck counters
    int  reverse_attempts_;
    int  rotate_attempts_;

    // Timing helpers
    uint32_t getElapsed(uint32_t now_ms) const { return now_ms - state_enter_ms_; }
    void enterState(AvoidanceState new_state, uint32_t now_ms);

    // Decision logic
    AvoidanceAction evaluate(uint32_t now_ms);
    AvoidanceAction doRoaming(int16_t nav_vx, int16_t nav_vy, int16_t nav_omega);
    AvoidanceAction doStrafing();
    AvoidanceAction doRotating(uint32_t now_ms);
    AvoidanceAction doReversing();
    AvoidanceAction doFrontStop();

    /// Convert IR position enum to a mask bit
    static uint8_t irMaskBit(uint8_t pos);
};
