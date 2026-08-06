#include "AvoidanceFSM.h"
#include "IRProximitySensor.h"
#include "SharpFrontSensor.h"
#include "config.h"
#include <Arduino.h>

// =====================================================================
// AvoidanceFSM implementation
// =====================================================================

// Timing constants for state machine
static const uint32_t EVALUATE_DURATION_MS    = 60;    // scan + decide
static const uint32_t STRAFE_DURATION_MS     = 1000;  // strafe 1s
static const uint32_t FRONT_STOP_TIMEOUT_MS  = 2000;  // max wait for clear
static const uint32_t E_STOPPED_TIMEOUT_MS   = 5000;  // 5s before requiring reset
static const uint32_t REVERSE_TIMEOUT_MS     = 4000;  // max reverse time
static const uint32_t ROAM_RECHECK_MS        = 100;    // recheck sensors while roaming

// Motor speeds for obstacle avoidance
static const int16_t SPEED_SLOW_FORWARD       = 50;    // slow advance
static const int16_t SPEED_NORMAL_FORWARD     = 80;    // normal roam
static const int16_t SPEED_STRAFE_FULL        = 100;   // full strafe
static const int16_t SPEED_STRAFE_SLOW        = 60;    // slow strafe (with forward)
static const int16_t SPEED_REVERSE_NORMAL     = 80;    // reverse
static const int16_t SPEED_REVERSE_SLOW       = 40;    // slow reverse (while strafing)
static const int16_t SPEED_REVERSE_FROM_FRONT = 80;    // reverse when front hit
static const int16_t SPEED_ROTATE_NORMAL      = 70;    // rotate CW/CCW

// Reverse distance target (in encoder pulses).
// At 11 PPR motor + 30:1 gear + 60mm wheel:
//   pulses_per_rev = 11 * 30 = 330 PPR
//   wheel_circumference = π * 60mm ≈ 188mm
//   mm_per_pulse = 188/330 ≈ 0.57 mm/pulse
//   30cm = 300mm / 0.57 ≈ 525 pulses
// We use a conservative 500 pulses as target.
static const int32_t REVERSE_PULSE_TARGET     = 500;

// Rotation angle targets (degrees)
static const float   ROTATE_TARGET_DEG_90     = 90.0f;
static const float   ROTATE_TARGET_DEG_180    = 180.0f;

// Max rotation attempts before E_STOP
static const int      MAX_ROTATE_ATTEMPTS     = 4;
static const int      MAX_REVERSE_ATTEMPTS    = 3;

// Heading tolerance for rotation end
static const float   ROTATE_HEADING_TOL_DEG   = 8.0f;

// ── Helper: wrap heading to [0, 360) ──
static float wrap360_local(float h)
{
    while (h < 0.0f)    h += 360.0f;
    while (h >= 360.0f) h -= 360.0f;
    return h;
}

// ── Helper: shortest signed angle between two headings (returns -180..180) ──
static float shortestAngle(float target, float current) {
    float diff = target - current;
    while (diff >  180.0f) diff -= 360.0f;
    while (diff <= -180.0f) diff += 360.0f;
    return diff;
}

// ── IR sensor mask bit positions ──
// Matches IRProximitySensor.h enum IRPosition:
//   REAR_LEFT = 0, REAR_RIGHT = 1, LEFT = 2, RIGHT = 3
//
// For decision matrix, group as:
//   bit 0: any IR (any obstacle)
//   bit 1: IR_LEFT only
//   bit 2: IR_RIGHT only
//   bit 3: both IR_LEFT + IR_RIGHT
//   bit 4: any rear IR
uint8_t AvoidanceFSM::irMaskBit(uint8_t pos) {
    (void)pos;  // unused
    return 0;   // placeholder, see decode below
}

AvoidanceFSM::AvoidanceFSM()
    : state_(STATE_IDLE), state_enter_ms_(0)
    , ir_mask_(0), sharp_too_close_(false), sharp_slowing_(false)
    , heading_deg_(0.0f), rotate_start_heading_(0.0f)
    , rotate_target_heading_(0.0f), rotate_heading_valid_(false)
    , reverse_start_pulse_(0), reverse_pulse_now_(0)
    , reverse_target_pulse_(0)
    , reverse_attempts_(0), rotate_attempts_(0)
{
}

void AvoidanceFSM::begin()
{
    state_ = STATE_IDLE;
    state_enter_ms_ = millis();
    ir_mask_ = 0;
    sharp_too_close_ = false;
    sharp_slowing_ = false;
    heading_deg_ = 0.0f;
    rotate_heading_valid_ = false;
    reverse_start_pulse_ = 0;
    reverse_pulse_now_ = 0;
    reverse_target_pulse_ = 0;
    reverse_attempts_ = 0;
    rotate_attempts_ = 0;
    Serial.println("[AVOID] FSM initialized");
}

void AvoidanceFSM::reset()
{
    state_ = STATE_IDLE;
    state_enter_ms_ = millis();
    reverse_attempts_ = 0;
    rotate_attempts_ = 0;
}

void AvoidanceFSM::feedHeading(float heading_deg)
{
    heading_deg_ = heading_deg;
}

void AvoidanceFSM::feedEncoderDelta(int32_t fl_delta)
{
    reverse_pulse_now_ += abs(fl_delta);
}

void AvoidanceFSM::enterState(AvoidanceState new_state, uint32_t now_ms)
{
    state_ = new_state;
    state_enter_ms_ = now_ms;
    Serial.printf("[AVOID] → state %s\n", getStateName());
}

const char* AvoidanceFSM::getStateName() const
{
    switch (state_) {
        case STATE_IDLE:        return "IDLE";
        case STATE_ROAMING:     return "ROAMING";
        case STATE_EVALUATING:  return "EVALUATING";
        case STATE_STRAFING:    return "STRAFING";
        case STATE_ROTATING:    return "ROTATING";
        case STATE_REVERSING:    return "REVERSING";
        case STATE_FRONT_STOP:  return "FRONT_STOP";
        case STATE_E_STOPPED:   return "E_STOPPED";
        default:                return "UNKNOWN";
    }
}

bool AvoidanceFSM::isDodgeActive() const
{
    return state_ == STATE_STRAFING || state_ == STATE_ROTATING
        || state_ == STATE_REVERSING || state_ == STATE_EVALUATING;
}

// ── State implementations ──────────────────────────────────────────

AvoidanceAction AvoidanceFSM::doRoaming(int16_t nav_vx, int16_t nav_vy, int16_t nav_omega)
{
    AvoidanceAction a = {nav_vx, nav_vy, nav_omega, false, "roam"};

    // If IR sensors detect anything OR Sharp is slowing us, evaluate
    if (ir_mask_ != 0 || sharp_slowing_) {
        enterState(STATE_EVALUATING, millis());
    }
    return a;
}

AvoidanceAction AvoidanceFSM::doStrafing()
{
    AvoidanceAction a = {0, 0, 0, false, "strafe"};
    uint32_t now_ms = millis();

    if (getElapsed(now_ms) >= STRAFE_DURATION_MS) {
        // Done strafing → re-evaluate
        enterState(STATE_EVALUATING, now_ms);
        return a;
    }

    // Decide direction based on which side(s) blocked.
    // Strategy:
    //   - LEFT blocked alone → strafe RIGHT (+vy)
    //   - RIGHT blocked alone → strafe LEFT (-vy)
    //   - FRONT+LEFT blocked → reverse slightly + strafe right
    //   - FRONT+RIGHT blocked → reverse slightly + strafe left
    //   - All three (incl front) → reverse hard + strafe

    bool left_blocked = (ir_mask_ & 0x04) != 0;
    bool right_blocked = (ir_mask_ & 0x08) != 0;
    bool front_blocked = (ir_mask_ & 0x10) != 0;

    if (front_blocked && left_blocked && !right_blocked) {
        // FRONT + LEFT → reverse + strafe right
        a.vx = -SPEED_REVERSE_FROM_FRONT;
        a.vy = +SPEED_STRAFE_FULL;
        a.description = "strafe: reverse + right (F+L)";
    } else if (front_blocked && right_blocked && !left_blocked) {
        // FRONT + RIGHT → reverse + strafe left
        a.vx = -SPEED_REVERSE_FROM_FRONT;
        a.vy = -SPEED_STRAFE_FULL;
        a.description = "strafe: reverse + left (F+R)";
    } else if (front_blocked && left_blocked && right_blocked) {
        // FRONT + both sides → reverse hard
        a.vx = -SPEED_REVERSE_NORMAL;
        a.vy = 0;
        a.description = "strafe: reverse (F+L+R)";
    } else if (left_blocked && !right_blocked) {
        // LEFT only → strafe right with slow forward
        a.vx = SPEED_STRAFE_SLOW;
        a.vy = +SPEED_STRAFE_FULL;
        a.description = "strafe: right (L)";
    } else if (right_blocked && !left_blocked) {
        // RIGHT only → strafe left with slow forward
        a.vx = SPEED_STRAFE_SLOW;
        a.vy = -SPEED_STRAFE_FULL;
        a.description = "strafe: left (R)";
    } else {
        // No obstacles anymore → done
        enterState(STATE_EVALUATING, now_ms);
    }
    return a;
}

AvoidanceAction AvoidanceFSM::doRotating(uint32_t now_ms)
{
    AvoidanceAction a = {0, 0, 0, false, "rotate"};

    if (!rotate_heading_valid_) {
        // No heading available → fall back to encoder-based rotation
        // (use accumulated pulse to estimate 90° turn)
        if (getElapsed(now_ms) >= 1500) {
            enterState(STATE_EVALUATING, now_ms);
            return a;
        }
        a.omega = SPEED_ROTATE_NORMAL;  // rotate CW
        a.description = "rotate: no heading, blind 90°";
        return a;
    }

    float heading_err = shortestAngle(rotate_target_heading_, heading_deg_);
    if (fabsf(heading_err) < ROTATE_HEADING_TOL_DEG) {
        // Done rotating
        Serial.printf("[AVOID] rotate done (err=%.1f°)\n", heading_err);
        rotate_heading_valid_ = false;
        rotate_attempts_ = 0;
        enterState(STATE_EVALUATING, now_ms);
        return a;
    }

    if (getElapsed(now_ms) > 5000) {
        // Timeout — give up, accept current heading
        Serial.println("[AVOID] rotate TIMEOUT");
        rotate_heading_valid_ = false;
        rotate_attempts_++;
        enterState(STATE_EVALUATING, now_ms);
        return a;
    }

    // Rotate CW (positive omega). Sign of heading_err indicates direction.
    if (heading_err > 0) {
        a.omega = +SPEED_ROTATE_NORMAL;
        a.description = "rotate CW";
    } else {
        a.omega = -SPEED_ROTATE_NORMAL;
        a.description = "rotate CCW";
    }
    return a;
}

AvoidanceAction AvoidanceFSM::doReversing()
{
    AvoidanceAction a = {0, 0, 0, false, "reverse"};
    uint32_t now_ms = millis();

    int32_t delta = reverse_pulse_now_ - reverse_start_pulse_;
    if (delta >= reverse_target_pulse_ || getElapsed(now_ms) >= REVERSE_TIMEOUT_MS) {
        // Done reversing → try to evaluate / rotate
        Serial.printf("[AVOID] reverse done (%ld pulses)\n", (long)delta);
        reverse_attempts_++;
        if (reverse_attempts_ >= MAX_REVERSE_ATTEMPTS) {
            enterState(STATE_E_STOPPED, now_ms);
            a.hard_stop = true;
            return a;
        }
        // After reverse, try rotating 90° then evaluate
        rotate_start_heading_ = heading_deg_;
        rotate_target_heading_ = wrap360_local(rotate_start_heading_ + ROTATE_TARGET_DEG_90);
        rotate_heading_valid_ = true;
        enterState(STATE_ROTATING, now_ms);
        return a;
    }

    a.vx = -SPEED_REVERSE_NORMAL;
    a.description = "reverse to escape";
    return a;
}

AvoidanceAction AvoidanceFSM::doFrontStop()
{
    AvoidanceAction a = {0, 0, 0, true, "front_stop"};
    uint32_t now_ms = millis();

    // Hard stop while Sharp < 15cm. After 2s timeout → E-STOP
    if (getElapsed(now_ms) > FRONT_STOP_TIMEOUT_MS) {
        Serial.println("[AVOID] FRONT_STOP timeout — escalating to E-STOP");
        enterState(STATE_E_STOPPED, now_ms);
    }
    return a;
}

AvoidanceAction AvoidanceFSM::evaluate(uint32_t now_ms)
{
    AvoidanceAction a = {0, 0, 0, false, "evaluate"};

    // Encode obstacles:
    //   bit 0: any IR
    //   bit 1: IR_LEFT
    //   bit 2: IR_RIGHT
    //   bit 3: any rear IR
    //   bit 4: Sharp slowing (15-60cm)
    //   bit 5: Sharp too close (<15cm) handled separately in tick()
    bool left_blocked  = (ir_mask_ & 0x04) != 0;
    bool right_blocked = (ir_mask_ & 0x08) != 0;
    bool rear_blocked  = (ir_mask_ & 0x03) != 0;

    // --- Decision tree ---
    int ir_count = (left_blocked ? 1 : 0) + (right_blocked ? 1 : 0);
    bool front_slow = sharp_slowing_;

    if (ir_count == 0 && !front_slow) {
        // No obstacles anywhere → resume roaming
        enterState(STATE_ROAMING, now_ms);
        return a;
    }

    // Sharp slowing only (no IR) → advance slowly
    if (front_slow && ir_count == 0) {
        enterState(STATE_STRAFING, now_ms);
        return a;
    }

    // Sharp too close handled in tick() — we shouldn't be here.
    // If Sharp slowing AND IR blocked → strafe
    if (front_slow && ir_count > 0) {
        enterState(STATE_STRAFING, now_ms);
        return a;
    }

    // IR blocked (no front Sharp): decide based on count
    if (ir_count == 1) {
        // Single side blocked → strafe away
        enterState(STATE_STRAFING, now_ms);
        return a;
    }

    if (ir_count == 2) {
        // Both sides blocked → need to reverse + rotate
        Serial.println("[AVOID] both sides blocked — reverse+rotate");
        reverse_pulse_now_ = 0;
        reverse_start_pulse_ = 0;
        reverse_target_pulse_ = REVERSE_PULSE_TARGET;
        enterState(STATE_REVERSING, now_ms);
        return a;
    }

    // Fallback → roam
    enterState(STATE_ROAMING, now_ms);
    return a;
}

// ── Main tick ─────────────────────────────────────────────────────

AvoidanceAction AvoidanceFSM::tick(uint32_t now_ms,
                                    const IRProximitySensor& ir,
                                    const SharpFrontSensor& sharp,
                                    int16_t nav_vx,
                                    int16_t nav_vy,
                                    int16_t nav_omega)
{
    // ── 1. Read sensors ──
    uint8_t mask = ir.detectedMask();
    // IRProximitySensor.detectedMask() returns 4-bit:
    //   bit 0 = REAR_LEFT, bit 1 = REAR_RIGHT, bit 2 = LEFT, bit 3 = RIGHT
    // Repack to a more readable 8-bit field:
    //   bit 0 = REAR_LEFT, bit 1 = REAR_RIGHT, bit 2 = LEFT, bit 3 = RIGHT
    ir_mask_ = mask & 0x0F;

    sharp_too_close_ = sharp.isTooClose();   // < 15cm
    sharp_slowing_   = sharp.isSlowing();     // < 60cm

    // ── 2. PRIORITY 1: Sharp too close → HARD STOP ──
    if (sharp_too_close_) {
        if (state_ != STATE_FRONT_STOP) {
            enterState(STATE_FRONT_STOP, now_ms);
        }
        return doFrontStop();
    }

    // ── 3. If Sharp just became clear, exit FRONT_STOP → ROAMING ──
    if (state_ == STATE_FRONT_STOP) {
        enterState(STATE_ROAMING, now_ms);
    }

    // ── 4. Process E_STOPPED: wait for Pi reset ──
    if (state_ == STATE_E_STOPPED) {
        if (getElapsed(now_ms) > E_STOPPED_TIMEOUT_MS) {
            // Auto-clear after 5s (try to roam again)
            Serial.println("[AVOID] E-STOP auto-clear after 5s — retry");
            reverse_attempts_ = 0;
            rotate_attempts_ = 0;
            enterState(STATE_ROAMING, now_ms);
        } else {
            // Stay stopped
            AvoidanceAction a = {0, 0, 0, true, "e_stopped"};
            return a;
        }
    }

    // ── 5. State machine switch ──
    switch (state_) {
        case STATE_IDLE:
            enterState(STATE_ROAMING, now_ms);
            return doRoaming(nav_vx, nav_vy, nav_omega);

        case STATE_ROAMING:
            return doRoaming(nav_vx, nav_vy, nav_omega);

        case STATE_EVALUATING:
            // Decide next action based on sensor snapshot
            return evaluate(now_ms);

        case STATE_STRAFING:
            return doStrafing();

        case STATE_ROTATING:
            return doRotating(now_ms);

        case STATE_REVERSING:
            return doReversing();

        case STATE_FRONT_STOP:
            // Sharp no longer too close (handled in step 3)
            return doFrontStop();

        default:
            enterState(STATE_ROAMING, now_ms);
            return doRoaming(nav_vx, nav_vy, nav_omega);
    }
}