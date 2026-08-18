#pragma once

#include <stdint.h>

/**
 * Observation-first BNO055 safety signal evaluator.
 *
 * This class never controls motors. It classifies fresh BNO055 samples into
 * tilt and shock observations for telemetry and bench threshold tuning. A
 * later, separately approved enforcement path may consume the retained flags
 * and route a confirmed hazard through the existing hardware E-stop path.
 */
class ImuSafetyEvaluator {
public:
    enum Event : uint8_t {
        EVENT_NONE = 0,
        EVENT_TILT_WARNING_ENTERED,
        EVENT_TILT_WARNING_CLEARED,
        EVENT_TILT_OBSERVED,
        EVENT_SHOCK_OBSERVED,
    };

    struct Snapshot {
        float tilt_deg;
        float linear_accel_mps2;
        float gyro_dps;
        bool sample_valid;
        bool heading_calibrated;
        bool tilt_warning;
        bool tilt_observed;
        bool shock_candidate;
        bool shock_observed;
        uint32_t observed_at_ms;
        Event event;
    };

    ImuSafetyEvaluator();

    /**
     * Evaluate a successful, fresh BNO055 sample. `sample_valid` must include
     * sensor availability and quaternion validity; invalid samples do not
     * advance debounce windows or create hazard events.
     */
    Event update(uint32_t now_ms, float roll_deg, float pitch_deg,
                 float accel_x_mps2, float accel_y_mps2, float accel_z_mps2,
                 float gyro_x_dps, float gyro_y_dps, float gyro_z_dps,
                 bool sample_valid, bool heading_calibrated);

    [[nodiscard]] const Snapshot& snapshot() const { return snapshot_; }
    [[nodiscard]] bool enforcementEnabled() const;
    [[nodiscard]] const char* eventName(Event event) const;

private:
    Snapshot snapshot_;
    uint32_t tilt_warning_since_ms_;
    uint32_t tilt_trip_since_ms_;
    uint32_t tilt_clear_since_ms_;
    uint32_t first_shock_candidate_ms_;
    bool shock_peak_seen_;
};
