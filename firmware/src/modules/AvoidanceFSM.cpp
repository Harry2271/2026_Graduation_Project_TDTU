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
// E_STOPPED is now a latch: once entered, the FSM stays stopped forever
// until an explicit reset() call from Pi.  No auto-clear timeout.
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
// At 11 PPR motor + 30:1 gear + 60mm wheel, x2 quadrature decode:
//   pulses_per_output_rev = 11 * 2 * 30 = 660
//   wheel_circumference = π * 60mm ≈ 188mm
//   mm_per_pulse = 188/660 ≈ 0.285 mm/pulse
//   30cm = 300mm / 0.285 ≈ 1053 pulses
// We use a conservative 1000 pulses as target.
static const int32_t REVERSE_PULSE_TARGET     = 1000;

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

    // ── Decode ALL sensors ──
    // IR mask bits: 0=RL, 1=RR, 2=LEFT, 3=RIGHT
    bool rl   = (ir_mask_ & 0x01) != 0;
    bool rr   = (ir_mask_ & 0x02) != 0;
    bool left = (ir_mask_ & 0x04) != 0;
    bool right= (ir_mask_ & 0x08) != 0;
    bool front= sharp_slowing_;  // Sharp < 60cm

    // Rear sensors (RL, RR) matter when reversing.
    // During forward dodge, rear is ignored — robot is moving forward.

    // ── Determine which side has more free space ──
    bool prefer_right = !right;        // if right is free, prefer it
    if (right && !left) prefer_right = false;  // left is free → go left
    // if both free → prefer right (user preference)
    // if both blocked → handled separately

    // ── CASE: Front only (no side IR) ──
    if (front && !left && !right) {
        // Front clear sides → reverse slightly then strafe to open side
        a.vx = -SPEED_REVERSE_SLOW;
        a.vy = prefer_right ? +SPEED_STRAFE_FULL : -SPEED_STRAFE_FULL;
        a.description = prefer_right ? "front: rev+strafe R" : "front: rev+strafe L";
        return a;
    }

    // ── CASE: Front + one side blocked ──
    if (front && left && !right) {
        // FRONT+LEFT → reverse + strafe right (only open side).
        // Safety: if rear also blocked, replace reverse with rotate only
        // to avoid backing into a rear obstacle.
        if (rl || rr) {
            // Rear blocked → cannot reverse; strafe right in-place
            a.vx = 0;
            a.vy = +SPEED_STRAFE_FULL;
            a.description = "F+L+rear → strafe R (no rev)";
        } else {
            a.vx = -SPEED_REVERSE_FROM_FRONT;
            a.vy = +SPEED_STRAFE_FULL;
            a.description = "F+L → reverse+strafe R";
        }
        return a;
    }
    if (front && right && !left) {
        // FRONT+RIGHT → reverse + strafe left.
        // Same rear-safety check.
        if (rl || rr) {
            a.vx = 0;
            a.vy = -SPEED_STRAFE_FULL;
            a.description = "F+R+rear → strafe L (no rev)";
        } else {
            a.vx = -SPEED_REVERSE_FROM_FRONT;
            a.vy = -SPEED_STRAFE_FULL;
            a.description = "F+R → reverse+strafe L";
        }
        return a;
    }

    // ── CASE: Front + BOTH sides blocked (corner trap) ──
    if (front && left && right) {
        // If rear is also blocked → TRUE corner trap: e-stop (hard_stop).
        // Robot cannot move in any direction safely.
        if (rl || rr) {
            a.hard_stop = true;
            a.vx = 0;
            a.vy = 0;
            a.omega = 0;
            a.description = "F+L+R+rear → E_STOP trapped";
            enterState(STATE_E_STOPPED, now_ms);
            return a;
        }
        // Front + both sides, rear clear → reverse hard, then rotate
        a.vx = -SPEED_REVERSE_NORMAL;
        a.vy = 0;
        a.description = "F+L+R → reverse hard";
        return a;
    }

    // ── CASE: Side only (no front) ──
    if (left && !right && !front) {
        // LEFT only → strafe RIGHT + slow forward (case 1)
        a.vx = SPEED_STRAFE_SLOW;
        a.vy = +SPEED_STRAFE_FULL;
        a.description = "L only → strafe R+fwd";
        return a;
    }
    if (right && !left && !front) {
        // RIGHT only → strafe LEFT + slow forward (case 1)
        a.vx = SPEED_STRAFE_SLOW;
        a.vy = -SPEED_STRAFE_FULL;
        a.description = "R only → strafe L+fwd";
        return a;
    }

    // ── CASE: Both sides blocked (no front) — corridor ──
    if (left && right && !front) {
        // If all 4 IR sensors are triggered → robot is fully surrounded
        // at close range (IR ~20cm).  Hard stop — no maneuver is safe.
        if (rl && rr) {
            a.hard_stop = true;
            a.description = "all-IR → E_STOP surrounded";
            enterState(STATE_E_STOPPED, now_ms);
            return a;
        }
        // Both sides only → slow forward (squeeze through if narrow) or reverse
        a.vx = SPEED_SLOW_FORWARD;
        a.vy = 0;
        a.description = "L+R → slow fwd squeeze";
        return a;
    }

    // ── CASE: No obstacles anymore → done ──
    if (!front && !left && !right) {
        enterState(STATE_EVALUATING, now_ms);
        return a;
    }

    // ── Fallback: strafe toward open side ──
    a.vx = SPEED_STRAFE_SLOW;
    a.vy = prefer_right ? +SPEED_STRAFE_FULL : -SPEED_STRAFE_FULL;
    a.description = "fallback: strafe";
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
        if (rotate_attempts_ >= MAX_ROTATE_ATTEMPTS) {
            Serial.println("[AVOID] rotate attempts exhausted — E_STOP");
            enterState(STATE_E_STOPPED, now_ms);
            a.hard_stop = true;
            return a;
        }
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

    // A zero target means this state was entered without a valid baseline;
    // fail closed instead of completing a reverse maneuver immediately.
    if (reverse_target_pulse_ <= 0) {
        Serial.println("[AVOID] reverse has no encoder target — E_STOP");
        enterState(STATE_E_STOPPED, now_ms);
        a.hard_stop = true;
        return a;
    }

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

    // Decode ALL IR sensors from mask (4-bit: bit0=RL, bit1=RR, bit2=L, bit3=R)
    bool rear_left  = (ir_mask_ & 0x01) != 0;
    bool rear_right = (ir_mask_ & 0x02) != 0;
    bool left       = (ir_mask_ & 0x04) != 0;
    bool right      = (ir_mask_ & 0x08) != 0;
    bool front      = sharp_slowing_;  // Sharp < 60cm = front obstacle
    bool any_ir     = (ir_mask_ != 0);
    bool any_rear   = (rear_left || rear_right);

    // ── Count free sides ──
    // During forward driving, rear sensors are ignored (behind us).
    // We only consider front + left + right for dodge decisions.
    int free_count = 0;
    if (!left)  free_count++;
    if (!right) free_count++;

    // ── Decision matrix ──

    // CASE 1: Nothing blocked → resume roaming
    if (!any_ir && !front) {
        enterState(STATE_ROAMING, now_ms);
        return a;
    }

    // CASE 2: Sharp slowing only (no IR) → strafe to the clearer side
    if (front && !any_ir) {
        // The front-only case has no side IR report; use the short bounded
        // strafe first.  A subsequent evaluation can escalate to reverse/
        // rotate once a rear-safe route is known.
        enterState(STATE_STRAFING, now_ms);
        return a;
    }

    // ── Front trap with rear clearance: reverse using encoder distance,
    // then rotate.  This makes the documented escape path reachable while
    // preserving the hard-stop case when both sides/rear are blocked.
    if (front && !any_rear && left && right) {
        reverse_start_pulse_ = reverse_pulse_now_;
        reverse_target_pulse_ = REVERSE_PULSE_TARGET;
        enterState(STATE_REVERSING, now_ms);
        return doReversing();
    }

    // Front with one open side: bounded lateral escape first.  If it fails
    // to clear, the next evaluation can enter the reverse/rotate path.
    enterState(STATE_STRAFING, now_ms);
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

    // ── 4. Process E_STOPPED: LATCH — stay stopped until explicit reset() ──
    if (state_ == STATE_E_STOPPED) {
        // No auto-clear: the robot is physically surrounded or exhausted
        // all escape attempts.  Only an explicit reset() call from Pi
        // (via UART command) can release this state.
        AvoidanceAction a = {0, 0, 0, true, "e_stopped"};
        return a;
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