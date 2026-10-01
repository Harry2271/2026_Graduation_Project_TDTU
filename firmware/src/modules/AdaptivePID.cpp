#include "AdaptivePID.h"
#include "config.h"

AdaptivePID::AdaptivePID()
    : m_load_compensation(1.0f)
    , m_battery_compensation(1.0f)
    , m_slip_factor(1.0f)
    , m_surface_type(SurfaceType::NORMAL)
    , m_oscillation_detected(false)
    , m_last_adaptation_ms(0)
{
    // Initialize all motors with base gains
    for (int i = 0; i < 4; i++) {
        m_gains[i].kp = BASE_KP;
        m_gains[i].ki = BASE_KI;
        m_gains[i].kd = BASE_KD;
    }
}

void AdaptivePID::begin()
{
    Serial.println("  [ADAPTIVE] PID auto-tuning enabled");
    Serial.printf("             Base gains: Kp=%.2f Ki=%.2f Kd=%.3f\n",
                  BASE_KP, BASE_KI, BASE_KD);
    Serial.println("             Adaptations: load + battery + slip");
}

void AdaptivePID::update(uint32_t now_ms,
                        bool cargo_loaded,
                        float battery_voltage,
                        int16_t target_rpm,
                        float actual_rpm,
                        float error_history[10])
{
    // Limit adaptation rate to avoid oscillation
    if (now_ms - m_last_adaptation_ms < ADAPTATION_INTERVAL_MS) {
        return;
    }
    m_last_adaptation_ms = now_ms;

    // 1. Detect oscillation from error history
    m_oscillation_detected = detectOscillation(error_history);

    // 2. Detect wheel slip
    bool slip_detected = detectSlip(target_rpm, actual_rpm);
    if (slip_detected) {
        m_surface_type = SurfaceType::SLIPPERY;
        m_slip_factor = 0.8f;  // Reduce Kp by 20%
    } else {
        m_surface_type = SurfaceType::NORMAL;
        m_slip_factor = 1.0f;
    }

    // 3. Adapt gains
    adaptGains(cargo_loaded, battery_voltage);

    // Log adaptation events
    if (m_oscillation_detected) {
        Serial.println("[ADAPTIVE] Oscillation detected — reducing Kp");
    }
    if (slip_detected) {
        Serial.println("[ADAPTIVE] Wheel slip detected — surface=SLIPPERY");
    }
}

PIDGains AdaptivePID::getGains(uint8_t motor_id) const
{
    if (motor_id >= 4) {
        motor_id = 0;
    }
    return m_gains[motor_id];
}

bool AdaptivePID::detectOscillation(float error_history[10])
{
    // Oscillation detection: check if error alternates sign frequently
    // Count sign changes in last 10 samples
    int sign_changes = 0;
    for (int i = 1; i < 10; i++) {
        if ((error_history[i] > 0) != (error_history[i-1] > 0)) {
            sign_changes++;
        }
    }

    // More than 6 sign changes in 10 samples = oscillating
    return (sign_changes > 6);
}

bool AdaptivePID::detectSlip(int16_t target_rpm, float actual_rpm)
{
    // Slip detection: target significantly > actual for extended period
    // This simple version just checks current snapshot
    // Real implementation would track this over time
    if (abs(target_rpm) < 50) {
        return false;  // Too slow to detect slip
    }

    float error_pct = abs(target_rpm - actual_rpm) / abs(target_rpm);
    return (error_pct > 0.3f);  // 30% tracking error = slip
}

void AdaptivePID::adaptGains(bool cargo_loaded, float battery_voltage)
{
    // 1. Load compensation (cargo → increase Ki to maintain speed)
    if (cargo_loaded) {
        m_load_compensation = 1.3f;  // +30% Ki
    } else {
        m_load_compensation = 1.0f;
    }

    // 2. Battery compensation (low voltage → increase feed-forward)
    // Voltage range: 20.5V (full) → 16.0V (20% SOC)
    if (battery_voltage < 16.0f) {
        m_battery_compensation = 1.15f;
    } else if (battery_voltage < 18.0f) {
        // Linear interpolation between 18V and 16V
        m_battery_compensation = 1.0f + (18.0f - battery_voltage) * 0.075f;
    } else {
        m_battery_compensation = 1.0f;
    }

    // 3. Apply adaptations to all motors
    for (int i = 0; i < 4; i++) {
        m_gains[i].kp = BASE_KP * m_slip_factor;

        // Reduce Kp if oscillating
        if (m_oscillation_detected) {
            m_gains[i].kp *= 0.85f;
        }

        m_gains[i].ki = BASE_KI * m_load_compensation;
        m_gains[i].kd = BASE_KD;

        // Feed-forward is not part of PID struct — applied separately in main.cpp
    }
}
