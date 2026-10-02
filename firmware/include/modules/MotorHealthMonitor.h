#pragma once

#include <Arduino.h>

class Encoder;
class INA226Sensor;

// ============================================================
// MotorHealthMonitor — Vibration-based motor health detection
// ============================================================
// Phát hiện:
//   1. Bearing wear (encoder jitter)
//   2. Gear tooth damage (periodic RPM spikes)
//   3. Brush degradation (increasing current for same RPM)
// ============================================================

enum class MotorHealthStatus : uint8_t {
    HEALTHY = 0,
    WARNING = 1,   // Early signs of wear
    DEGRADED = 2,  // Significant wear, schedule maintenance
    FAILED = 3     // Motor not responding
};

struct MotorHealthState {
    MotorHealthStatus status;
    float jitter_pct;           // RPM jitter percentage (0-100)
    float current_efficiency;   // mA per RPM (lower = better)
    uint32_t warning_count;     // Cumulative warnings
    uint32_t last_warning_ms;
};

class MotorHealthMonitor {
public:
    MotorHealthMonitor();

    void begin();

    // Update health metrics for one motor
    void update(uint8_t motor_id,
               uint32_t now_ms,
               int16_t target_rpm,
               float actual_rpm,
               float current_a,
               Encoder* encoder);

    // Query status
    MotorHealthStatus getStatus(uint8_t motor_id) const;
    const MotorHealthState& getState(uint8_t motor_id) const;
    bool needsMaintenance(uint8_t motor_id) const;

    // Reset warnings (after maintenance)
    void resetWarnings(uint8_t motor_id);

private:
    static constexpr uint8_t MOTOR_HEALTH_COUNT = 4;
    MotorHealthState m_state[MOTOR_HEALTH_COUNT];

    // Encoder pulse timing history (for jitter analysis)
    static constexpr uint8_t SAMPLE_COUNT = 10;
    int32_t m_encoder_deltas[MOTOR_HEALTH_COUNT][SAMPLE_COUNT];
    uint8_t m_sample_index[MOTOR_HEALTH_COUNT];
    uint32_t m_sample_count[MOTOR_HEALTH_COUNT];

    // Current efficiency baseline (learned during first 60s)
    float m_baseline_current_per_rpm[MOTOR_HEALTH_COUNT];
    bool m_baseline_learned[MOTOR_HEALTH_COUNT];
    uint32_t m_learn_start_ms[MOTOR_HEALTH_COUNT];

    // Thresholds
    static constexpr float JITTER_WARNING_PCT = 15.0f;
    static constexpr float JITTER_DEGRADED_PCT = 30.0f;
    static constexpr float EFFICIENCY_DEGRADATION_PCT = 25.0f;  // 25% more current
    static constexpr uint32_t WARNING_THRESHOLD = 10;           // 10 warnings → DEGRADED
    static constexpr uint32_t BASELINE_LEARN_MS = 60000;        // 60s learning period

    // Calculate RPM jitter from encoder delta history
    float calculateJitter(uint8_t motor_id);

    // Update current efficiency baseline
    void updateEfficiencyBaseline(uint8_t motor_id, float actual_rpm, float current_a, uint32_t now_ms);

    // Check if efficiency degraded
    bool isEfficiencyDegraded(uint8_t motor_id, float actual_rpm, float current_a) const;

    // Update health status based on metrics
    void updateStatus(uint8_t motor_id, uint32_t now_ms);
};
