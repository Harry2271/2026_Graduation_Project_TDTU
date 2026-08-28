#include "ImuSafetyEvaluator.h"
#include "config.h"

#include <math.h>

namespace {

bool elapsed(uint32_t now_ms, uint32_t since_ms, uint32_t duration_ms)
{
    return since_ms != 0 && (uint32_t)(now_ms - since_ms) >= duration_ms;
}

float magnitude3(float x, float y, float z)
{
    return sqrtf(x * x + y * y + z * z);
}

}  // namespace

ImuSafetyEvaluator::ImuSafetyEvaluator()
    : snapshot_{0.0f, 0.0f, 0.0f, false, false, false, false, false, false, 0, EVENT_NONE}
    , tilt_warning_since_ms_(0)
    , tilt_trip_since_ms_(0)
    , tilt_clear_since_ms_(0)
    , first_shock_candidate_ms_(0)
    , shock_peak_seen_(false)
{
}

ImuSafetyEvaluator::Event ImuSafetyEvaluator::update(
    uint32_t now_ms, float roll_deg, float pitch_deg,
    float accel_x_mps2, float accel_y_mps2, float accel_z_mps2,
    float gyro_x_dps, float gyro_y_dps, float gyro_z_dps,
    bool sample_valid, bool heading_calibrated)
{
    snapshot_.event = EVENT_NONE;
    snapshot_.sample_valid = sample_valid;
    snapshot_.heading_calibrated = heading_calibrated;
    snapshot_.shock_candidate = false;

    if (!sample_valid) {
        tilt_warning_since_ms_ = 0;
        tilt_trip_since_ms_ = 0;
        tilt_clear_since_ms_ = 0;
        first_shock_candidate_ms_ = 0;
        shock_peak_seen_ = false;
        return snapshot_.event;
    }

    snapshot_.tilt_deg = fmaxf(fabsf(roll_deg), fabsf(pitch_deg));
    snapshot_.linear_accel_mps2 = magnitude3(
        accel_x_mps2, accel_y_mps2, accel_z_mps2);
    snapshot_.gyro_dps = magnitude3(gyro_x_dps, gyro_y_dps, gyro_z_dps);

    if (snapshot_.tilt_deg >= IMU_TILT_WARNING_DEG) {
        tilt_clear_since_ms_ = 0;
        if (tilt_warning_since_ms_ == 0) tilt_warning_since_ms_ = now_ms;
        if (!snapshot_.tilt_warning &&
            elapsed(now_ms, tilt_warning_since_ms_, IMU_TILT_WARNING_DWELL_MS)) {
            snapshot_.tilt_warning = true;
            snapshot_.event = EVENT_TILT_WARNING_ENTERED;
        }
    } else {
        tilt_warning_since_ms_ = 0;
        if (snapshot_.tilt_warning) {
            if (snapshot_.tilt_deg <= IMU_TILT_CLEAR_DEG) {
                if (tilt_clear_since_ms_ == 0) tilt_clear_since_ms_ = now_ms;
                if (elapsed(now_ms, tilt_clear_since_ms_, IMU_TILT_CLEAR_DWELL_MS)) {
                    snapshot_.tilt_warning = false;
                    snapshot_.event = EVENT_TILT_WARNING_CLEARED;
                }
            } else {
                tilt_clear_since_ms_ = 0;
            }
        }
    }

    if (snapshot_.tilt_deg >= IMU_TILT_OBSERVE_DEG) {
        if (tilt_trip_since_ms_ == 0) tilt_trip_since_ms_ = now_ms;
        if (!snapshot_.tilt_observed &&
            elapsed(now_ms, tilt_trip_since_ms_, IMU_TILT_OBSERVE_DWELL_MS)) {
            snapshot_.tilt_observed = true;
            snapshot_.observed_at_ms = now_ms;
            snapshot_.event = EVENT_TILT_OBSERVED;
        }
    } else {
        tilt_trip_since_ms_ = 0;
    }

    if (snapshot_.linear_accel_mps2 >= IMU_SHOCK_CANDIDATE_MPS2) {
        snapshot_.shock_candidate = true;
        if (first_shock_candidate_ms_ == 0 ||
            (uint32_t)(now_ms - first_shock_candidate_ms_) > IMU_SHOCK_CONFIRM_WINDOW_MS) {
            first_shock_candidate_ms_ = now_ms;
            shock_peak_seen_ = snapshot_.linear_accel_mps2 >= IMU_SHOCK_PEAK_MPS2;
        } else {
            shock_peak_seen_ = shock_peak_seen_ ||
                               snapshot_.linear_accel_mps2 >= IMU_SHOCK_PEAK_MPS2;
            if (!snapshot_.shock_observed && shock_peak_seen_) {
                snapshot_.shock_observed = true;
                snapshot_.observed_at_ms = now_ms;
                snapshot_.event = EVENT_SHOCK_OBSERVED;
            }
            first_shock_candidate_ms_ = 0;
            shock_peak_seen_ = false;
        }
    } else if (first_shock_candidate_ms_ != 0 &&
               (uint32_t)(now_ms - first_shock_candidate_ms_) > IMU_SHOCK_CONFIRM_WINDOW_MS) {
        first_shock_candidate_ms_ = 0;
        shock_peak_seen_ = false;
    }

    return snapshot_.event;
}

bool ImuSafetyEvaluator::enforcementEnabled() const
{
    return IMU_SAFETY_ENFORCEMENT_ENABLED;
}

const char* ImuSafetyEvaluator::eventName(Event event) const
{
    switch (event) {
        case EVENT_TILT_WARNING_ENTERED: return "tilt_warning";
        case EVENT_TILT_WARNING_CLEARED: return "tilt_warning_cleared";
        case EVENT_TILT_OBSERVED: return "tilt_observed";
        case EVENT_SHOCK_OBSERVED: return "shock_observed";
        case EVENT_NONE:
        default: return "none";
    }
}
