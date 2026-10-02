#include "PathLearner.h"
#include "config.h"

PathLearner::PathLearner()
    : m_enabled(false)
    , m_phase(TuningPhase::IDLE)
    , m_last_update_ms(0)
    , m_no_improvement_count(0)
{
    // Initialize with safe defaults (1.0 = no adjustment)
    m_learned.kp_multiplier = 1.0f;
    m_learned.ki_multiplier = 1.0f;
    m_learned.kd_multiplier = 1.0f;
    m_learned.accel_ramp_rate = ACCEL_RAMP_RATE;  // From config.h (default 50)
    m_learned.learn_epoch = 0;
    m_learned.best_score = 999999.0f;  // Worst possible score

    resetMetrics(m_current_metrics);
    resetMetrics(m_baseline_metrics);
    resetMetrics(m_test_metrics);
}

void PathLearner::begin()
{
    Serial.println("  [PATH_LEARNER] Lightweight on-device optimization");

    // Load learned params from EEPROM
    loadFromEEPROM();

    Serial.printf("             Epoch: %lu, Best Score: %.2f\n",
                  m_learned.learn_epoch, m_learned.best_score);
    Serial.printf("             PID multipliers: Kp=%.3f Ki=%.3f Kd=%.3f\n",
                  m_learned.kp_multiplier,
                  m_learned.ki_multiplier,
                  m_learned.kd_multiplier);
    Serial.printf("             Accel ramp rate: %.0f PWM/tick\n",
                  m_learned.accel_ramp_rate);
}

void PathLearner::update(uint32_t now_ms)
{
    // No-op if disabled or update too soon
    if (!m_enabled || (now_ms - m_last_update_ms < 1000)) {
        return;
    }
    m_last_update_ms = now_ms;

    // State machine: advance phase when batch is complete
    if (m_current_metrics.sample_count >= 10) {
        advancePhase();
    }
}

void PathLearner::setEnabled(bool enabled)
{
    if (enabled && !m_enabled) {
        Serial.println("[PATH_LEARNER] Auto-tuning ENABLED");
        m_phase = TuningPhase::BASELINE;
        resetMetrics(m_current_metrics);
    } else if (!enabled && m_enabled) {
        Serial.println("[PATH_LEARNER] Auto-tuning DISABLED");
        m_phase = TuningPhase::IDLE;
    }
    m_enabled = enabled;
}

void PathLearner::recordDelivery(float time_s, bool collision, float energy_wh, float distance_m, float jerk_sum)
{
    if (!m_enabled || distance_m < 0.1f) {
        return;  // Ignore invalid or micro-moves
    }

    // Accumulate metrics
    m_current_metrics.avg_time_to_waypoint_s += time_s;
    m_current_metrics.collision_rate += (collision ? 1.0f : 0.0f);
    m_current_metrics.energy_per_meter_wh += (energy_wh / distance_m);
    m_current_metrics.jerk_integral += jerk_sum;
    m_current_metrics.sample_count++;

    Serial.printf("[PATH_LEARNER] Delivery #%lu: time=%.1fs, collision=%d, energy/m=%.2f, jerk=%.1f\n",
                  m_current_metrics.sample_count, time_s, collision,
                  energy_wh / distance_m, jerk_sum);
}

void PathLearner::loadFromEEPROM()
{
    EEPROM.begin(1024);  // Initialize EEPROM (1KB)

    EEPROMData data;
    EEPROM.get(EEPROM_BASE_ADDR, data);

    // Validate magic + version + checksum
    if (data.magic != EEPROM_MAGIC || data.version != EEPROM_VERSION) {
        Serial.println("  [PATH_LEARNER] No valid EEPROM data, using defaults");
        return;
    }

    uint16_t expected_checksum = computeChecksum(data.params);
    if (data.checksum != expected_checksum) {
        Serial.println("  [PATH_LEARNER] EEPROM checksum mismatch, using defaults");
        return;
    }

    // Load validated params
    m_learned = data.params;
    Serial.println("  [PATH_LEARNER] Loaded learned params from EEPROM");
}

void PathLearner::saveToEEPROM()
{
    EEPROMData data;
    data.magic = EEPROM_MAGIC;
    data.version = EEPROM_VERSION;
    data.params = m_learned;
    data.checksum = computeChecksum(m_learned);

    EEPROM.put(EEPROM_BASE_ADDR, data);
    EEPROM.commit();

    Serial.printf("[PATH_LEARNER] Saved to EEPROM: epoch=%lu, score=%.2f\n",
                  m_learned.learn_epoch, m_learned.best_score);
}

uint16_t PathLearner::computeChecksum(const LearnedParams& p)
{
    // Simple XOR checksum over all bytes
    uint16_t sum = 0;
    const uint8_t* bytes = reinterpret_cast<const uint8_t*>(&p);
    for (size_t i = 0; i < sizeof(LearnedParams); i++) {
        sum ^= bytes[i];
        sum = (sum << 1) | (sum >> 15);  // Rotate left
    }
    return sum;
}

float PathLearner::computeScore(const TaskMetrics& m)
{
    if (m.sample_count == 0) {
        return 999999.0f;  // Invalid batch
    }

    // Normalize metrics to per-delivery averages
    float avg_time = m.avg_time_to_waypoint_s / m.sample_count;
    float collision_rate = m.collision_rate / m.sample_count;
    float avg_energy = m.energy_per_meter_wh / m.sample_count;
    float avg_jerk = m.jerk_integral / m.sample_count;

    // Weighted composite score (lower is better)
    // Weights chosen empirically: collisions are expensive, time matters most
    float score = (avg_time * 2.0f)            // Time dominates
                + (collision_rate * 50.0f)     // Heavy penalty for collisions
                + (avg_energy * 0.5f)          // Energy efficiency (minor)
                + (avg_jerk * 0.1f);           // Smoothness (minor)

    return score;
}

LearnedParams PathLearner::perturbParams(const LearnedParams& base)
{
    LearnedParams variant = base;

    // Perturb each param by ±10% with 50% probability
    // Simple uniform random perturbation (Bayesian optimization would use Gaussian process here)
    if (random(0, 2) == 1) {
        variant.kp_multiplier += random(-10, 11) / 100.0f;
        variant.kp_multiplier = constrain(variant.kp_multiplier, 0.9f, 1.1f);
    }
    if (random(0, 2) == 1) {
        variant.ki_multiplier += random(-10, 11) / 100.0f;
        variant.ki_multiplier = constrain(variant.ki_multiplier, 0.9f, 1.1f);
    }
    if (random(0, 2) == 1) {
        variant.kd_multiplier += random(-10, 11) / 100.0f;
        variant.kd_multiplier = constrain(variant.kd_multiplier, 0.9f, 1.1f);
    }
    if (random(0, 2) == 1) {
        variant.accel_ramp_rate += random(-10, 11);
        variant.accel_ramp_rate = constrain(variant.accel_ramp_rate, 30.0f, 70.0f);
    }

    return variant;
}

void PathLearner::advancePhase()
{
    switch (m_phase) {
        case TuningPhase::IDLE:
            // No-op, tuning disabled
            break;

        case TuningPhase::BASELINE:
            // Baseline batch complete → compute baseline score
            m_baseline_metrics = m_current_metrics;
            float baseline_score = computeScore(m_baseline_metrics);

            Serial.printf("[PATH_LEARNER] Baseline: score=%.2f (n=%lu)\n",
                          baseline_score, m_baseline_metrics.sample_count);

            // Generate test variant
            m_test_params = perturbParams(m_learned);
            m_phase = TuningPhase::TEST_VARIANT;
            resetMetrics(m_current_metrics);

            Serial.printf("[PATH_LEARNER] Testing variant: Kp×%.3f Ki×%.3f Kd×%.3f ramp=%.0f\n",
                          m_test_params.kp_multiplier,
                          m_test_params.ki_multiplier,
                          m_test_params.kd_multiplier,
                          m_test_params.accel_ramp_rate);
            break;

        case TuningPhase::TEST_VARIANT:
            // Test batch complete → evaluate
            m_test_metrics = m_current_metrics;
            m_phase = TuningPhase::EVALUATE;
            advancePhase();  // Immediately evaluate (no waiting)
            break;

        case TuningPhase::EVALUATE: {
            float baseline_score = computeScore(m_baseline_metrics);
            float test_score = computeScore(m_test_metrics);

            Serial.printf("[PATH_LEARNER] Evaluate: baseline=%.2f, test=%.2f\n",
                          baseline_score, test_score);

            // Keep variant if it improved
            if (test_score < baseline_score && test_score < m_learned.best_score) {
                m_learned = m_test_params;
                m_learned.best_score = test_score;
                m_learned.learn_epoch++;
                m_no_improvement_count = 0;

                Serial.printf("[PATH_LEARNER] ✓ IMPROVED! New best score: %.2f (epoch %lu)\n",
                              m_learned.best_score, m_learned.learn_epoch);
                saveToEEPROM();
            } else {
                m_no_improvement_count++;
                Serial.printf("[PATH_LEARNER] ✗ No improvement (%lu/%lu)\n",
                              m_no_improvement_count, CONVERGENCE_THRESHOLD);
            }

            // Check convergence
            if (m_no_improvement_count >= CONVERGENCE_THRESHOLD) {
                m_phase = TuningPhase::CONVERGED;
                Serial.println("[PATH_LEARNER] CONVERGED — stopping auto-tuning");
            } else {
                // Start new baseline batch
                m_phase = TuningPhase::BASELINE;
                resetMetrics(m_current_metrics);
            }
            break;
        }

        case TuningPhase::CONVERGED:
            // Stay converged until manually re-enabled
            break;
    }
}

void PathLearner::resetMetrics(TaskMetrics& m)
{
    m.avg_time_to_waypoint_s = 0.0f;
    m.collision_rate = 0.0f;
    m.energy_per_meter_wh = 0.0f;
    m.jerk_integral = 0.0f;
    m.sample_count = 0;
}
