#include "PIDController.h"
#include "config.h"

PIDController::PIDController(const char* name)
    : name_(name)
    , kp_(DEFAULT_KP), ki_(DEFAULT_KI), kd_(DEFAULT_KD)
    , integral_(0.0f), prev_error_(0.0f), target_rpm_(0.0f)
    , first_run_(true)
{
}

void PIDController::reset()
{
    integral_   = 0.0f;
    prev_error_ = 0.0f;
    first_run_  = true;
}

void PIDController::setGains(float kp, float ki, float kd)
{
    kp_ = kp;
    ki_ = ki;
    kd_ = kd;
}

int16_t PIDController::compute(float target_rpm, float actual_rpm, uint32_t dt_us)
{
    if (dt_us == 0) return 0;

    float dt_s = (float)dt_us / 1000000.0f;
    if (dt_s > 0.1f)  dt_s = 0.1f;
    if (dt_s < 0.001f) dt_s = 0.001f;

    float error = target_rpm - actual_rpm;

    float p_term = kp_ * error;

    integral_ += error * dt_s;
    if (integral_ > PID_INTEGRAL_LIMIT)  integral_ =  PID_INTEGRAL_LIMIT;
    if (integral_ < -PID_INTEGRAL_LIMIT) integral_ = -PID_INTEGRAL_LIMIT;
    float i_term = ki_ * integral_;

    float d_term = 0.0f;
    if (first_run_) {
        // Skip D-term on first call (no previous error to diff against).
        first_run_ = false;
    } else {
        float de = error - prev_error_;
        d_term = kd_ * (de / dt_s);
    }

    prev_error_ = error;

    float output = p_term + i_term + d_term;

    if (output >  PID_OUTPUT_LIMIT) output =  PID_OUTPUT_LIMIT;
    if (output < -PID_OUTPUT_LIMIT) output = -PID_OUTPUT_LIMIT;

    return (int16_t)output;
}

void PIDController::getGains(float& kp, float& ki, float& kd) const
{
    kp = kp_;
    ki = ki_;
    kd = kd_;
}
