#include "AutoRoam.h"
#include "BNO055Sensor.h"
#include "IRProximitySensor.h"
#include "SharpFrontSensor.h"
#include "INA226Sensor.h"
#include "VL53L0XSensor.h"
#include "CylinderActuator.h"
#include "Encoder.h"
#include "config.h"
#include <Arduino.h>

// =====================================================================
// AutoRoam — autonomous sensor-based driving + dock/unload sequence
//
// Two modes of operation:
//   1. NORMAL ROAMING: forward drive + heading-hold + IR/Sharp avoidance
//   2. UNLOADING: Pi-triggered sequence (begin_dock → adjust → extend →
//      hold → retract → done → leave → complete)
//
// The unloading sequence blocks normal roaming until completion or cancel.
// =====================================================================

AutoRoam::AutoRoam()
    : hold_heading_(0.0f)
    , has_heading_(false)
    , heading_integral_(0.0f)
    , heading_kp_(2.5f)
    , heading_ki_(0.3f)
    , last_obstacle_ms_(0)
    , sharp_clear_ms_(0)
    , hard_stop_(false)
    , last_ir_mask_(0)
    , imu_(nullptr), ir_(nullptr), sharp_(nullptr), power_(nullptr)
    , tof_(nullptr), cylinder_(nullptr)
    , unload_state_(UNLOAD_IDLE)
    , unload_start_ms_(0)
    , adjust_start_ms_(0)
    , dock_tag_id_(0)
    , dock_target_mm_(VL53L0X_UNLOAD_DISTANCE_MM)
    , heading_err_deg_(0.0f)
    , heading_ok_(false)
    , leave_start_count_(0)
    , leave_start_ms_(0)
    , leave_target_heading_(0.0f)
    , last_encoder_count_(0)
{
}

void AutoRoam::attachSensors(BNO055Sensor* imu,
                             IRProximitySensor* ir,
                             SharpFrontSensor* sharp,
                             INA226Sensor* power,
                             VL53L0XSensor* tof,
                             CylinderActuator* cylinder)
{
    imu_      = imu;
    ir_       = ir;
    sharp_    = sharp;
    power_    = power;
    tof_      = tof;
    cylinder_ = cylinder;
}

void AutoRoam::reset()
{
    has_heading_       = false;
    heading_integral_  = 0.0f;
    hard_stop_         = false;
    last_obstacle_ms_  = 0;
    sharp_clear_ms_    = 0;
    drive_start_ms_    = 0;  // re-arm Sharp boot-skip on next AUTO_ROAM entry

    // Reset unloading sequence
    unload_state_ = UNLOAD_IDLE;
    heading_err_deg_ = 0.0f;
    heading_ok_ = false;
    if (cylinder_) cylinder_->stop();
}

// =====================================================================
// Docking / unloading API
// =====================================================================

void AutoRoam::startDock(uint16_t tag_id, uint16_t target_distance_mm,
                         float facing_theta_deg, const char* operation_id)
{
    // Idempotency: if an unload is already in progress and the operation_id
    // matches, silently ignore (no double-unload).  If it differs, warn
    // but still reject (only one unload at a time).
    if (unload_state_ != UNLOAD_IDLE) {
        if (operation_id && operation_id[0] != '\0' &&
            strcmp(operation_id, current_operation_id_) == 0) {
            Serial.printf("[UNLOAD] Duplicate operation_id '%s' — ignoring\n",
                          operation_id);
            return;
        }
        Serial.printf("[UNLOAD] busy (state=%d) — rejecting new dock\n",
                      unload_state_);
        return;
    }

    // Store idempotency key for future duplicate detection
    if (operation_id) {
        strncpy(current_operation_id_, operation_id, sizeof(current_operation_id_) - 1);
        current_operation_id_[sizeof(current_operation_id_) - 1] = '\0';
    } else {
        current_operation_id_[0] = '\0';
    }

    Serial.printf("[UNLOAD] startDock tag_id=%u target_mm=%u facing=%.1f opId=%s\n",
                  tag_id, target_distance_mm, facing_theta_deg,
                  current_operation_id_[0] ? current_operation_id_ : "-");
    dock_tag_id_      = tag_id;
    dock_target_mm_   = target_distance_mm;
    heading_err_deg_  = 0.0f;
    heading_ok_       = false;
    unload_state_     = UNLOAD_ADJUSTING;
    unload_start_ms_  = millis();
    adjust_start_ms_  = millis();

    // If a facing_theta was provided (valid range 0-360), use it as the
    // heading gate target instead of the captured hold_heading_.
    if (facing_theta_deg >= 0.0f && facing_theta_deg < 360.0f) {
        hold_heading_ = facing_theta_deg;
        has_heading_  = true;
        Serial.printf("[UNLOAD] heading gate: target=%.1f (from cmd)\n", facing_theta_deg);
    }
}

void AutoRoam::startLeaveDock()
{
    if (unload_state_ != UNLOAD_IDLE && unload_state_ != UNLOAD_DONE) return;

    Serial.println("[UNLOAD] startLeaveDock");
    leave_start_count_    = 0;
    leave_start_ms_       = millis();
    leave_target_heading_ = has_heading_ ? hold_heading_ : 0.0f;
    unload_state_         = UNLOAD_LEAVE;
    unload_start_ms_      = millis();
}

void AutoRoam::cancelUnloading()
{
    if (unload_state_ == UNLOAD_IDLE) return;
    Serial.println("[UNLOAD] Sequence cancelled");
    unload_state_ = UNLOAD_IDLE;
    heading_err_deg_ = 0.0f;
    heading_ok_ = false;
    current_operation_id_[0] = '\0';  // clear idempotency key
    if (cylinder_) cylinder_->stop();
}

// =====================================================================
// Heading helpers
// =====================================================================

static float wrap360(float h)
{
    while (h < 0.0f)    h += 360.0f;
    while (h >= 360.0f) h -= 360.0f;
    return h;
}

static float headingError(float target, float current)
{
    float err = target - current;
    if (err >  180.0f) err -= 360.0f;
    if (err <= -180.0f) err += 360.0f;
    return err;
}

// =====================================================================
// Tick computation
// =====================================================================

bool AutoRoam::compute(uint32_t now_ms,
                       int16_t& out_vx, int16_t& out_vy, int16_t& out_omega,
                       Encoder* encoders)
{
    out_vx = out_vy = out_omega = 0;

    // ----- 1) Read IMU and capture reference heading once we have a sample -----
    if (imu_ && imu_->isOperational()) {
        imu_->read();
        float h = imu_->getHeading();
        if (!has_heading_) {
            hold_heading_ = wrap360(h);
            has_heading_  = true;
            heading_integral_ = 0.0f;
        }
    }

    // ====================================================================
    // UNLOADING SEQUENCE — full state machine
    //
    // When active, this block takes full control of motors + cylinder.
    // Normal roaming is bypassed until sequence completes or is cancelled.
    // ====================================================================
    if (unload_state_ != UNLOAD_IDLE) {
        out_vx = out_vy = out_omega = 0;

        if (tof_)   tof_->update(now_ms);
        if (cylinder_) cylinder_->update(now_ms);

        switch (unload_state_) {

            // --- ADJUST POSITION (flowchart: AdjustPosition) ---
            // Gate: BOTH dist_ok AND heading_ok must be satisfied.
            case UNLOAD_ADJUSTING: {
                if ((now_ms - adjust_start_ms_) >= ADJUST_TIMEOUT_MS) {
                    Serial.println("[UNLOAD] Adjust timeout — cancelling");
                    cancelUnloading();
                    return false;
                }

                // Compute heading error for the gate
                if (imu_ && imu_->isOperational() && has_heading_) {
                    heading_err_deg_ = headingError(hold_heading_, imu_->getHeading());
                    heading_ok_ = (fabs(heading_err_deg_) <= HEADING_GATE_DEG);
                } else {
                    heading_err_deg_ = 0.0f;
                    heading_ok_ = true;  // no IMU — skip gate
                }

                // Check VL53L0X distance against runtime target
                bool dist_ok = false;
                if (tof_ && tof_->isPresent()) {
                    tof_->update(now_ms);
                    uint16_t dist_mm = tof_->getDistanceMm();
                    dist_ok = (dist_mm <= dock_target_mm_ + VL53L0X_TOLERANCE_MM);
                } else {
                    dist_ok = true;  // no TOF — skip distance check
                }

                // BOTH conditions satisfied → proceed to extend
                if (dist_ok && heading_ok_) {
                    Serial.printf("[UNLOAD] Dist OK + heading OK (%.1f°) → extend cylinder\n",
                        heading_err_deg_);
                    out_vx = 0; out_vy = 0; out_omega = 0;
                    unload_state_ = UNLOAD_EXTENDING;
                    unload_start_ms_ = now_ms;
                    if (cylinder_) cylinder_->extend();
                    return true;
                }

                // Not ready: nudge to adjust position
                if (!dist_ok && tof_ && tof_->isPresent()) {
                    uint16_t dist_mm = tof_->getDistanceMm();
                    if (dist_mm > dock_target_mm_ + VL53L0X_TOLERANCE_MM) {
                        out_vx = ADJUST_FWD_SPEED;    // too far → forward
                    } else {
                        out_vx = -ADJUST_FWD_SPEED;   // too close → reverse
                    }
                } else {
                    out_vx = 0;  // distance OK but heading wrong — hold position
                }
                return true;
            }

            // --- EXTEND CYLINDER (flowchart: ExtendActuator) ---
            case UNLOAD_EXTENDING: {
                out_vx = out_vy = out_omega = 0;
                if ((now_ms - unload_start_ms_) >= CYLINDER_MAX_RUN_MS) {
                    Serial.println("[UNLOAD] Cylinder extended → hold for dumping");
                    unload_state_ = UNLOAD_HOLDING;
                    unload_start_ms_ = now_ms;
                    if (cylinder_) cylinder_->stop();
                }
                return true;
            }

            // --- HOLD — items slide out (flowchart: DropItem) ---
            case UNLOAD_HOLDING: {
                out_vx = out_vy = out_omega = 0;
                if ((now_ms - unload_start_ms_) >= CYLINDER_HOLD_AT_TOP_MS) {
                    Serial.println("[UNLOAD] Hold complete → retract cylinder");
                    unload_state_ = UNLOAD_RETRACTING;
                    unload_start_ms_ = now_ms;
                    if (cylinder_) cylinder_->retract();
                }
                return true;
            }

            // --- RETRACT CYLINDER (flowchart: RetractActuator) ---
            case UNLOAD_RETRACTING: {
                out_vx = out_vy = out_omega = 0;
                // Ưu tiên limit switch: xy lanh chạm công tắc đáy → rút xong ngay.
                // Nếu switch lỗi/không gắn thì timeout 8s vẫn bảo vệ.
                if (cylinder_ && cylinder_->isRetracted()) {
                    Serial.println("[UNLOAD] Cylinder retracted (limit switch) → unloading complete");
                    unload_state_ = UNLOAD_DONE;
                    unload_start_ms_ = now_ms;
                    cylinder_->stop();
                    return true;
                }
                if ((now_ms - unload_start_ms_) >= CYLINDER_MAX_RUN_MS) {
                    Serial.println("[UNLOAD] Cylinder retracted (timeout) → unloading complete");
                    unload_state_ = UNLOAD_DONE;
                    unload_start_ms_ = now_ms;
                    if (cylinder_) cylinder_->stop();
                }
                return true;
            }

            // --- DONE — auto transition to LEAVE DOCK ---
            case UNLOAD_DONE: {
                Serial.println("[UNLOAD] Unload done → leaving dock");
                leave_start_count_    = 0;
                leave_start_ms_       = now_ms;
                leave_target_heading_ = has_heading_ ? hold_heading_ : 0.0f;
                unload_state_         = UNLOAD_LEAVE;
                unload_start_ms_      = now_ms;
                return true;
            }

            // --- LEAVE DOCK — reverse with heading hold + encoder tracking ---
            case UNLOAD_LEAVE: {
                // Safety timeout
                if ((now_ms - leave_start_ms_) >= LEAVE_DOCK_TIMEOUT_MS) {
                    Serial.println("[UNLOAD] Leave-dock timeout → complete");
                    unload_state_ = UNLOAD_COMPLETE;
                    unload_start_ms_ = now_ms;
                    if (cylinder_) cylinder_->stop();
                    out_vx = out_vy = out_omega = 0;
                    return false;
                }

                // Record encoder baseline on first tick
                if (leave_start_count_ == 0 && encoders) {
                    leave_start_count_ = encoders[0].getCumulativeCount();
                }

                // Heading-hold while reversing (PI on leave_target_heading_)
                if (imu_ && imu_->isOperational() && has_heading_) {
                    float err = headingError(leave_target_heading_, imu_->getHeading());
                    heading_err_deg_ = err;
                    if (err > -60.0f && err < 60.0f) {
                        heading_integral_ += err * 0.02f;
                        if (heading_integral_ >  100.0f) heading_integral_ =  100.0f;
                        if (heading_integral_ < -100.0f) heading_integral_ = -100.0f;
                    }
                    float omega_f = heading_kp_ * err + heading_ki_ * heading_integral_;
                    out_omega = (int16_t)constrain(omega_f, -120.0f, 120.0f);
                }

                // Reverse at LEAVE_DOCK_SPEED
                out_vx = -LEAVE_DOCK_SPEED;
                out_vy = 0;

                // Check distance traveled via encoder delta
                if (encoders) {
                    int32_t current = encoders[0].getCumulativeCount();
                    int32_t delta   = current - leave_start_count_;
                    // ticks → cm:  wheel_circum = π × 6.0 cm, CPR = MOTOR_ENCODER_CPR
                    float dist_cm = fabs(delta) * (3.14159f * 6.0f) / (float)MOTOR_ENCODER_CPR;
                    if (dist_cm >= LEAVE_DOCK_DISTANCE_CM) {
                        Serial.printf("[UNLOAD] Leave-dock %.1f cm reached → complete\n", dist_cm);
                        out_vx = out_vy = out_omega = 0;
                        unload_state_ = UNLOAD_COMPLETE;
                        unload_start_ms_ = now_ms;
                        if (cylinder_) cylinder_->stop();
                        return false;
                    }
                }
                return true;
            }

            // --- COMPLETE — return to IDLE, normal roaming resumes ---
            case UNLOAD_COMPLETE: {
                Serial.println("[UNLOAD] Sequence fully complete → IDLE");
                unload_state_ = UNLOAD_IDLE;
                heading_err_deg_ = 0.0f;
                heading_ok_ = false;
                current_operation_id_[0] = '\0';  // clear idempotency key
                out_vx = out_vy = out_omega = 0;
                // Fall through to normal roaming below
                break;
            }

            default:
                break;
        }
    }

    // ========================================================================
    // NORMAL ROAMING (multi-sensor FSM avoidance + heading-hold)
    // ========================================================================

    // Mark the first time we enter the driving loop so we can skip Sharp for
    // the first SHARP_BOOT_SKIP_MS (lets the ADC settle and any warm-up noise
    // dissipate before trusting the reading for a hard-stop).
    if (drive_start_ms_ == 0) drive_start_ms_ = now_ms;

    // Update Sharp so avoidance FSM gets a fresh reading
    if (sharp_) sharp_->update(now_ms);

    // ----- Feed FSM with encoder delta + heading for state decisions -----
    if (encoders && encoders[0].getCumulativeCount() != last_encoder_count_) {
        int32_t delta = encoders[0].getCumulativeCount() - last_encoder_count_;
        avoidance_fsm_.feedEncoderDelta(delta);
        last_encoder_count_ = encoders[0].getCumulativeCount();
    }
    if (imu_ && imu_->isOperational()) {
        avoidance_fsm_.feedHeading(imu_->getHeading());
    }

    // ----- Base forward speed (with battery + Sharp slow-down logic) -----
    int16_t base_vx = BASE_FWD_SPEED;
    bool sharp_warmup = (now_ms - drive_start_ms_) < SHARP_BOOT_SKIP_MS;
    if (sharp_ && !sharp_warmup && sharp_->isSlowing()) {
        base_vx = SLOW_FWD_SPEED;
    }
    if (power_ && power_->isOperational() && power_->getBatteryPct() <= 20.0f) {
        base_vx /= 2;
    }
    if (sharp_warmup) {
        base_vx = 0;  // wait for Sharp to settle before driving
    }

    // ----- Heading-hold PI (produces small omega correction) -----
    int16_t nav_vy = 0, nav_omega = 0;
    if (imu_ && imu_->isOperational() && has_heading_) {
        float err = headingError(hold_heading_, imu_->getHeading());
        if (err > -60.0f && err < 60.0f) {
            heading_integral_ += err * 0.02f;
            if (heading_integral_ >  100.0f) heading_integral_ =  100.0f;
            if (heading_integral_ < -100.0f) heading_integral_ = -100.0f;
        }
        float omega_f = heading_kp_ * err + heading_ki_ * heading_integral_;
        nav_omega = (int16_t)constrain(omega_f, -120.0f, 120.0f);
    }

    // Tick FSM — it can override base motion based on sensors
    AvoidanceAction action;
    if (ir_ && sharp_) {
        action = avoidance_fsm_.tick(now_ms, *ir_, *sharp_, base_vx, nav_vy, nav_omega);
    } else {
        action.vx = base_vx;
        action.vy = nav_vy;
        action.omega = nav_omega;
        action.hard_stop = false;
        action.description = "no sensors";
    }

    // Apply FSM action
    if (action.hard_stop) {
        out_vx = 0;
        out_vy = 0;
        out_omega = 0;
        // Track hard_stop_ for backward compatibility (Sharp hard-stop)
        if (action.description && strstr(action.description, "front_stop")) {
            hard_stop_ = true;
            sharp_clear_ms_ = now_ms;
        }
        return false;
    }

    // Log state transitions for debugging
    static AvoidanceState last_logged_state = STATE_IDLE;
    AvoidanceState cur_state = avoidance_fsm_.getState();
    if (cur_state != last_logged_state) {
        Serial.printf("[AUTO_ROAM] FSM → %s\n", avoidance_fsm_.getStateName());
        last_logged_state = cur_state;
    }

    // Clear legacy hard_stop_ if FSM is no longer in FRONT_STOP
    if (hard_stop_) {
        hard_stop_ = false;
        Serial.println("[AUTO_ROAM] FSM cleared — resume");
    }

    out_vx    = action.vx;
    out_vy    = action.vy;
    out_omega = action.omega;
    return true;
}
