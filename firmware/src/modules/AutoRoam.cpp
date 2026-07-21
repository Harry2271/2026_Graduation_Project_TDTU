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

void AutoRoam::startDock(uint16_t tag_id, uint16_t target_distance_mm)
{
    if (unload_state_ != UNLOAD_IDLE) return;

    Serial.printf("[UNLOAD] startDock tag_id=%u target_mm=%u\n", tag_id, target_distance_mm);
    dock_tag_id_      = tag_id;
    dock_target_mm_   = target_distance_mm;
    heading_err_deg_  = 0.0f;
    heading_ok_       = false;
    unload_state_     = UNLOAD_ADJUSTING;
    unload_start_ms_  = millis();
    adjust_start_ms_  = millis();
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
                if ((now_ms - unload_start_ms_) >= CYLINDER_MAX_RUN_MS) {
                    Serial.println("[UNLOAD] Cylinder retracted → unloading complete");
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
                out_vx = out_vy = out_omega = 0;
                // Fall through to normal roaming below
                break;
            }

            default:
                break;
        }
    }

    // ========================================================================
    // NORMAL ROAMING (heading-hold + obstacle avoidance)
    // ========================================================================

    // Mark the first time we enter the driving loop so we can skip Sharp for
    // the first SHARP_BOOT_SKIP_MS (lets the ADC settle and any warm-up noise
    // dissipate before trusting the reading for a hard-stop).
    if (drive_start_ms_ == 0) drive_start_ms_ = now_ms;
    bool sharp_warmup = (now_ms - drive_start_ms_) < SHARP_BOOT_SKIP_MS;

    // ----- 2) Sharp-front hard stop -----
    if (sharp_ && !sharp_warmup) {
        sharp_->update(now_ms);
        if (sharp_->isTooClose()) {
            if (!hard_stop_) {
                Serial.println("[AUTO_ROAM] Sharp < threshold — ALL 4 wheels STOP");
            }
            hard_stop_      = true;
            sharp_clear_ms_ = now_ms;
            return false;
        }
        if (hard_stop_ && (now_ms - sharp_clear_ms_) >= SHARP_HOLD_MS) {
            Serial.println("[AUTO_ROAM] Sharp cleared — resume");
            hard_stop_ = false;
        }
        if (hard_stop_) return false;
    }

    // ----- 3) Decide base forward speed -----
    int16_t vx = BASE_FWD_SPEED;
    if (sharp_ && sharp_->isSlowing()) {
        vx = SLOW_FWD_SPEED;
    }
    if (power_ && power_->isOperational() && power_->getBatteryPct() <= 20.0f) {
        vx /= 2;
    }

    int16_t vy    = 0;
    int16_t omega = 0;

    // ----- 4) IR proximity — ANY sensor detected → STOP ALL 4 WHEELS -----
    if (ir_) {
        uint8_t mask = ir_->detectedMask();
        if (mask != 0) {
            if (mask != last_ir_mask_) {
                Serial.printf("[AUTO_ROAM] IR mask=0x%02X — BRAKE\n", mask);
                last_ir_mask_ = mask;
            }
            return false;
        }
        if (last_ir_mask_ != 0) {
            Serial.println("[AUTO_ROAM] IR clear — resume forward");
        }
        last_ir_mask_ = 0;
    }

    // ----- 5) Heading hold (PI on BNO055) -----
    if (imu_ && imu_->isOperational() && has_heading_) {
        float err = headingError(hold_heading_, imu_->getHeading());
        if (err > -60.0f && err < 60.0f) {
            heading_integral_ += err * 0.02f;
            if (heading_integral_ >  100.0f) heading_integral_ =  100.0f;
            if (heading_integral_ < -100.0f) heading_integral_ = -100.0f;
        }
        float omega_f = heading_kp_ * err + heading_ki_ * heading_integral_;
        if (vy == 0) {
            omega = (int16_t)constrain(omega_f, -120.0f, 120.0f);
        }
    }

    out_vx    = vx;
    out_vy    = vy;
    out_omega = omega;
    return true;
}
