#include "MotorHealthMonitor.h"
#include "Encoder.h"
#include <math.h>

MotorHealthMonitor::MotorHealthMonitor()
{
    for (uint8_t i = 0; i < MOTOR_HEALTH_COUNT; i++) {
        m_state[i].status = MotorHealthStatus::HEALTHY;
        m_state[i].jitter_pct = 0.0f;
        m_state[i].current_efficiency = 0.0f;
        m_state[i].warning_count = 0;
        m_state[i].last_warning_ms = 0;

        m_baseline_current_per_rpm[i] = 0.0f;
        m_baseline_learned[i] = false;
        m_learn_start_ms[i] = 0;
        m_sample_index[i] = 0;
        m_sample_count[i] = 0;

        for (uint8_t j = 0; j < SAMPLE_COUNT; j++) {
            m_encoder_deltas[i][j] = 0;
        }
    }
}

void MotorHealthMonitor::begin()
{
    Serial.println("  [MOTOR_HEALTH] Vibration-based health monitor initialized");
    Serial.printf("                 Jitter threshold: %.0f%% warn, %.0f%% degraded\n",
                  JITTER_WARNING_PCT, JITTER_DEGRADED_PCT);
    Serial.printf("                 Efficiency degradation: %.0f%%\n",
                  EFFICIENCY_DEGRADATION_PCT);
}

void MotorHealthMonitor::update(uint8_t motor_id,
                               uint32_t now_ms,
                               int16_t target_rpm,
                               float actual_rpm,
                               float current_a,
                               Encoder* encoder)
{
    if (motor_id >= MOTOR_HEALTH_COUNT) return;

    // Collect encoder delta sample
    int32_t current_count = encoder->getCumulativeCount();
    static int32_t last_count[MOTOR_HEALTH_COUNT] = {0};
    int32_t delta = current_count - last_count[motor_id];
    last_count[motor_id] = current_count;

    // Store in circular buffer
    m_encoder_deltas[motor_id][m_sample_index[motor_id]] = delta;
    m_sample_index[motor_id] = (m_sample_index[motor_id] + 1) % SAMPLE_COUNT;
    if (m_sample_count[motor_id] < SAMPLE_COUNT) {
        m_sample_count[motor_id]++;
    }

    // Calculate jitter (only when motor is moving)
    if (abs(target_rpm) > 50 && m_sample_count[motor_id] >= SAMPLE_COUNT) {
        m_state[motor_id].jitter_pct = calculateJitter(motor_id);
    }

    // Update efficiency baseline
    updateEfficiencyBaseline(motor_id, actual_rpm, current_a, now_ms);

    // Check efficiency degradation
    if (m_baseline_learned[motor_id] && abs(actual_rpm) > 50) {
        if (isEfficiencyDegraded(motor_id, actual_rpm, current_a)) {
            m_state[motor_id].warning_count++;
            m_state[motor_id].last_warning_ms = now_ms;
            Serial.printf("[MOTOR_HEALTH] M%u efficiency degraded (%.1f mA/RPM, baseline %.1f)\n",
                         motor_id,
                         (current_a * 1000.0f) / abs(actual_rpm),
                         m_baseline_current_per_rpm[motor_id]);
        }
    }

    // Update overall status
    updateStatus(motor_id, now_ms);
}

float MotorHealthMonitor::calculateJitter(uint8_t motor_id)
{
    if (m_sample_count[motor_id] < SAMPLE_COUNT) {
        return 0.0f;
    }

    // Calculate mean and standard deviation of encoder deltas
    float sum = 0.0f;
    for (uint8_t i = 0; i < SAMPLE_COUNT; i++) {
        sum += m_encoder_deltas[motor_id][i];
    }
    float mean = sum / SAMPLE_COUNT;

    if (mean < 1.0f) {
        return 0.0f;  // Motor not moving
    }

    float variance = 0.0f;
    for (uint8_t i = 0; i < SAMPLE_COUNT; i++) {
        float diff = m_encoder_deltas[motor_id][i] - mean;
        variance += diff * diff;
    }
    float std_dev = sqrt(variance / SAMPLE_COUNT);

    // Jitter as percentage of mean
    float jitter_pct = (std_dev / mean) * 100.0f;

    return jitter_pct;
}

void MotorHealthMonitor::updateEfficiencyBaseline(uint8_t motor_id,
                                                  float actual_rpm,
                                                  float current_a,
                                                  uint32_t now_ms)
{
    if (m_baseline_learned[motor_id]) {
        return;  // Already learned
    }

    // Start learning period
    if (m_learn_start_ms[motor_id] == 0) {
        m_learn_start_ms[motor_id] = now_ms;
    }

    // Only sample when motor is at steady cruise (>100 RPM)
    if (abs(actual_rpm) > 100) {
        float current_per_rpm = (current_a * 1000.0f) / abs(actual_rpm);

        // Running average
        if (m_baseline_current_per_rpm[motor_id] == 0.0f) {
            m_baseline_current_per_rpm[motor_id] = current_per_rpm;
        } else {
            m_baseline_current_per_rpm[motor_id] =
                m_baseline_current_per_rpm[motor_id] * 0.9f +
                current_per_rpm * 0.1f;
        }
    }

    // Mark baseline as learned after learning period
    if (now_ms - m_learn_start_ms[motor_id] >= BASELINE_LEARN_MS) {
        m_baseline_learned[motor_id] = true;
        Serial.printf("[MOTOR_HEALTH] M%u baseline learned: %.1f mA/RPM\n",
                     motor_id, m_baseline_current_per_rpm[motor_id]);
    }
}

bool MotorHealthMonitor::isEfficiencyDegraded(uint8_t motor_id,
                                              float actual_rpm,
                                              float current_a) const
{
    if (!m_baseline_learned[motor_id] || abs(actual_rpm) < 50) {
        return false;
    }

    float current_per_rpm = (current_a * 1000.0f) / abs(actual_rpm);
    float baseline = m_baseline_current_per_rpm[motor_id];

    // Check if current consumption increased by >25%
    float increase_pct = ((current_per_rpm - baseline) / baseline) * 100.0f;

    return (increase_pct > EFFICIENCY_DEGRADATION_PCT);
}

void MotorHealthMonitor::updateStatus(uint8_t motor_id, uint32_t now_ms)
{
    MotorHealthStatus old_status = m_state[motor_id].status;

    // Rule 1: High jitter → WARNING or DEGRADED
    if (m_state[motor_id].jitter_pct > JITTER_DEGRADED_PCT) {
        m_state[motor_id].status = MotorHealthStatus::DEGRADED;
    } else if (m_state[motor_id].jitter_pct > JITTER_WARNING_PCT) {
        if (m_state[motor_id].status == MotorHealthStatus::HEALTHY) {
            m_state[motor_id].status = MotorHealthStatus::WARNING;
        }
    }

    // Rule 2: Accumulated warnings → DEGRADED
    if (m_state[motor_id].warning_count >= WARNING_THRESHOLD) {
        m_state[motor_id].status = MotorHealthStatus::DEGRADED;
    }

    // Log status changes
    if (m_state[motor_id].status != old_status) {
        const char* status_names[] = {"HEALTHY", "WARNING", "DEGRADED", "FAILED"};
        Serial.printf("[MOTOR_HEALTH] M%u status: %s -> %s (jitter=%.1f%%, warnings=%lu)\n",
                     motor_id,
                     status_names[(uint8_t)old_status],
                     status_names[(uint8_t)m_state[motor_id].status],
                     m_state[motor_id].jitter_pct,
                     m_state[motor_id].warning_count);
    }
}

MotorHealthStatus MotorHealthMonitor::getStatus(uint8_t motor_id) const
{
    if (motor_id >= MOTOR_HEALTH_COUNT) {
        return MotorHealthStatus::FAILED;
    }
    return m_state[motor_id].status;
}

const MotorHealthState& MotorHealthMonitor::getState(uint8_t motor_id) const
{
    if (motor_id >= MOTOR_HEALTH_COUNT) {
        motor_id = 0;
    }
    return m_state[motor_id];
}

bool MotorHealthMonitor::needsMaintenance(uint8_t motor_id) const
{
    if (motor_id >= MOTOR_HEALTH_COUNT) {
        return false;
    }
    return (m_state[motor_id].status == MotorHealthStatus::DEGRADED);
}

void MotorHealthMonitor::resetWarnings(uint8_t motor_id)
{
    // Handle "all motors" sentinel: Python sends -1 which becomes 255 after cast
    if (motor_id == 255) {
        for (uint8_t i = 0; i < MOTOR_HEALTH_COUNT; i++) {
            m_state[i].warning_count = 0;
            m_state[i].status = MotorHealthStatus::HEALTHY;
        }
        Serial.println("[MOTOR_HEALTH] All motor warnings reset (maintenance performed)");
        return;
    }

    if (motor_id >= MOTOR_HEALTH_COUNT) return;

    m_state[motor_id].warning_count = 0;
    m_state[motor_id].status = MotorHealthStatus::HEALTHY;
    Serial.printf("[MOTOR_HEALTH] M%u warnings reset (maintenance performed)\n", motor_id);
}
