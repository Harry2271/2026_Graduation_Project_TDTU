#include "AutoRoam.h"
#include "BNO055Sensor.h"
#include "IRProximitySensor.h"
#include "SharpFrontSensor.h"
#include "INA226Sensor.h"
#include <Arduino.h>

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
{
}

void AutoRoam::attachSensors(BNO055Sensor* imu,
                             IRProximitySensor* ir,
                             SharpFrontSensor* sharp,
                             INA226Sensor* power)
{
    imu_   = imu;
    ir_    = ir;
    sharp_ = sharp;
    power_ = power;
}

void AutoRoam::reset()
{
    has_heading_       = false;
    heading_integral_  = 0.0f;
    hard_stop_         = false;
    last_obstacle_ms_  = 0;
    sharp_clear_ms_    = 0;
}

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

bool AutoRoam::compute(uint32_t now_ms,
                       int16_t& out_vx, int16_t& out_vy, int16_t& out_omega)
{
    out_vx = out_vy = out_omega = 0;

    // ----- 1) Read IMU and capture the reference heading once we have a sample -----
    if (imu_ && imu_->isOperational()) {
        imu_->read();
        float h = imu_->getHeading();
        if (!has_heading_) {
            hold_heading_ = wrap360(h);
            has_heading_  = true;
            heading_integral_ = 0.0f;
        }
    }

    // ----- 2) Sharp-front hard stop -----
    if (sharp_) {
        sharp_->update(now_ms);
        if (sharp_->isTooClose()) {
            if (!hard_stop_) {
                Serial.println("[AUTO_ROAM] Sharp < threshold — ALL 4 wheels STOP");
            }
            hard_stop_      = true;
            sharp_clear_ms_ = now_ms;
            return false;  // hard stop requested
        }
        if (hard_stop_ && (now_ms - sharp_clear_ms_) >= SHARP_HOLD_MS) {
            // Sharp has been clear long enough — release.
            Serial.println("[AUTO_ROAM] Sharp cleared — resume");
            hard_stop_ = false;
        }
        if (hard_stop_) {
            // Still within hold window after Sharp cleared — stay stopped.
            return false;
        }
    }

    // ----- 3) Decide base forward speed -----
    int16_t vx = BASE_FWD_SPEED;
    if (sharp_ && sharp_->isSlowing()) {
        vx = SLOW_FWD_SPEED;
    }

    // Battery low → halve speed
    if (power_ && power_->isOperational() && power_->getBatteryPct() <= 20.0f) {
        vx /= 2;
    }

    int16_t vy    = 0;
    int16_t omega = 0;

    // ----- 4) IR proximity — ANY sensor detected → STOP ALL 4 WHEELS -----
    if (ir_) {
        uint8_t mask = ir_->detectedMask();
        if (mask != 0) {
            // Obstacle detected by at least one IR sensor.
            // Return FALSE → caller calls coast() on ALL motors instantly.
            // No ramp, no PID — immediate full stop.
            if (mask != last_ir_mask_) {
                Serial.printf("[AUTO_ROAM] IR mask=0x%02X (RL=%d RR=%d L=%d R=%d) — BRAKE\n",
                    mask, (mask & 0x01) ? 1 : 0, (mask & 0x02) ? 1 : 0,
                          (mask & 0x04) ? 1 : 0, (mask & 0x08) ? 1 : 0);
                last_ir_mask_ = mask;
            }
            return false;  // → ModeManager coast() all motors
        }
        if (last_ir_mask_ != 0) {
            Serial.println("[AUTO_ROAM] IR clear — resume forward");
        }
        last_ir_mask_ = 0;
    }

    // ----- 5) Heading hold (PI on BNO055 Euler H) -----
    if (imu_ && imu_->isOperational() && has_heading_) {
        float err = headingError(hold_heading_, imu_->getHeading());
        // Integral with anti-windup (±60° window)
        if (err > -60.0f && err < 60.0f) {
            heading_integral_ += err * 0.02f;   // dt ≈ 20 ms PID tick
            if (heading_integral_ >  100.0f) heading_integral_ =  100.0f;
            if (heading_integral_ < -100.0f) heading_integral_ = -100.0f;
        }
        float omega_f = heading_kp_ * err + heading_ki_ * heading_integral_;
        // Apply heading correction as rotation — but only when not in a side-dodge
        if (vy == 0) {
            omega = (int16_t)constrain(omega_f, -120.0f, 120.0f);
        }
    }

    out_vx    = vx;
    out_vy    = vy;
    out_omega = omega;
    return true;
}