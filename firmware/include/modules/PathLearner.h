#pragma once

#include <Arduino.h>
#include <EEPROM.h>

// ============================================================
// PathLearner — Lightweight On-Device Parameter Optimization
// ============================================================
// Bayesian optimization of PID + ramp params based on task performance.
// NOT full RL training (Pi 5 too slow for PPO updates).
//
// Tracks metrics:
//   - Average time-to-waypoint
//   - Collision rate
//   - Energy per meter
//   - Jerk integral (smoothness)
//
// Every 10 deliveries: adjust PID gains ±10%, test, keep if improvement.
// Learned params saved to EEPROM (survive reboot).
// ============================================================

struct TaskMetrics {
    float avg_time_to_waypoint_s;   // Lower is better
    float collision_rate;            // Collisions per delivery (0.0-1.0)
    float energy_per_meter_wh;       // Watt-hours per meter traveled
    float jerk_integral;             // Accumulated |jerk| over task (smoothness)
    uint32_t sample_count;           // Number of deliveries in this batch
};

struct LearnedParams {
    float kp_multiplier;    // Applied on top of AdaptivePID base gains (0.9-1.1)
    float ki_multiplier;    // Applied on top of AdaptivePID base gains (0.9-1.1)
    float kd_multiplier;    // Applied on top of AdaptivePID base gains (0.9-1.1)
    float accel_ramp_rate;  // PWM change per tick (30-70, default 50)
    uint32_t learn_epoch;   // Increments each tuning cycle
    float best_score;       // Lower is better (composite metric)
};

enum class TuningPhase : uint8_t {
    IDLE = 0,           // Auto-tuning disabled
    BASELINE = 1,       // Collecting baseline metrics with current params
    TEST_VARIANT = 2,   // Testing perturbed params
    EVALUATE = 3,       // Compare test vs baseline, decide keep/revert
    CONVERGED = 4       // No improvement for N cycles, stop tuning
};

class PathLearner {
public:
    PathLearner();

    void begin();
    void update(uint32_t now_ms);

    // Enable/disable auto-tuning (CMD_TUNE_AUTO)
    void setEnabled(bool enabled);
    bool isEnabled() const { return m_enabled; }

    // Record task performance data (called after each delivery)
    void recordDelivery(float time_s, bool collision, float energy_wh, float distance_m, float jerk_sum);

    // Get current learned params to apply to PID/ramp
    LearnedParams getParams() const { return m_learned; }

    // Diagnostics
    TuningPhase getPhase() const { return m_phase; }
    TaskMetrics getCurrentMetrics() const { return m_current_metrics; }
    TaskMetrics getBaselineMetrics() const { return m_baseline_metrics; }
    float getBestScore() const { return m_learned.best_score; }
    uint32_t getEpoch() const { return m_learned.learn_epoch; }

private:
    bool m_enabled;
    TuningPhase m_phase;
    uint32_t m_last_update_ms;

    // Current learned parameters (loaded from EEPROM at boot)
    LearnedParams m_learned;

    // Metrics accumulation
    TaskMetrics m_current_metrics;    // Current batch being collected
    TaskMetrics m_baseline_metrics;   // Baseline performance (before perturbation)
    TaskMetrics m_test_metrics;       // Test performance (with perturbed params)

    // Variant params (during TEST_VARIANT phase)
    LearnedParams m_test_params;

    // Convergence tracking
    uint32_t m_no_improvement_count;
    static constexpr uint32_t CONVERGENCE_THRESHOLD = 5;  // Stop after 5 cycles with no gain

    // EEPROM storage
    static constexpr uint16_t EEPROM_MAGIC = 0x4C50;  // "LP" (PathLearner)
    static constexpr uint16_t EEPROM_VERSION = 1;
    static constexpr uint16_t EEPROM_BASE_ADDR = 512;  // Offset in EEPROM (avoid collision with other modules)

    struct EEPROMData {
        uint16_t magic;
        uint16_t version;
        LearnedParams params;
        uint16_t checksum;
    };

    // Load/save learned params from/to EEPROM
    void loadFromEEPROM();
    void saveToEEPROM();
    uint16_t computeChecksum(const LearnedParams& p);

    // Compute composite score from metrics (lower is better)
    float computeScore(const TaskMetrics& m);

    // Generate perturbed params (Bayesian optimization step)
    LearnedParams perturbParams(const LearnedParams& base);

    // Transition between tuning phases
    void advancePhase();

    // Reset metrics accumulator
    void resetMetrics(TaskMetrics& m);
};
