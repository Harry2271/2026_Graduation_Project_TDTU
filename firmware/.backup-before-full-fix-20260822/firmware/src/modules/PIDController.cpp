#include "PIDController.h"
#include "config.h"

PIDController::PIDController(const char* name)
    : name_(name)
    , kp_(DEFAULT_KP), ki_(DEFAULT_KI), kd_(DEFAULT_KD)
    , integral_(0.0f), prev_actual_rpm_(0.0f), target_rpm_(0.0f)
    , first_run_(true)
{
}

void PIDController::reset()
{
    integral_      = 0.0f;
    prev_actual_rpm_ = 0.0f;
    first_run_     = true;
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

    // Conditional integration / back-calculation anti-windup.
    // Compute the candidate output, then if it saturates in the direction
    // of the current error, undo the latest integral contribution.  This
    // prevents a stalled wheel from accumulating integral that would
    // overshoot in the opposite direction on recovery.
    integral_ += error * dt_s;
    float i_term = ki_ * integral_;

    // Derivative-on-measurement:  d(error)/dt = d(target)/dt - d(actual)/dt.
    // When the target steps (the usual case) d(target)/dt is a huge spike;
    // using -kd * d(actual)/dt eliminates that "derivative kick" and the
    // resulting overshoot on every speed change.
    float d_term = 0.0f;
    if (first_run_) {
        first_run_ = false;
    } else {
        float dmeas = (actual_rpm - prev_actual_rpm_) / dt_s;
        d_term = -kd_ * dmeas;
    }
    prev_actual_rpm_ = actual_rpm;

    float output = p_term + i_term + d_term;

    if (output >  PID_OUTPUT_LIMIT || output < -PID_OUTPUT_LIMIT) {
        // Saturated — undo this step's integration to prevent windup.
        integral_ -= error * dt_s;
        // Recompute i_term with the rolled-back integral.
        i_term = ki_ * integral_;
        output = p_term + i_term + d_term;
    }

    if (integral_ >  PID_INTEGRAL_LIMIT)  integral_ =  PID_INTEGRAL_LIMIT;
    if (integral_ < -PID_INTEGRAL_LIMIT) integral_ = -PID_INTEGRAL_LIMIT;

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
