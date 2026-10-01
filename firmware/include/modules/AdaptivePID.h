#pragma once

#include <Arduino.h>

// ============================================================
// AdaptivePID — Runtime PID auto-tuning
// ============================================================
// Tự động điều chỉnh PID gains dựa trên:
//   1. Load detection (cargo → tăng Ki)
//   2. Surface detection (wheel slip → giảm Kp)
//   3. Battery compensation (low voltage → tăng feed-forward)
// ============================================================

struct PIDGains {
    float kp;
    float ki;
    float kd;
};

enum class SurfaceType : uint8_t {
    NORMAL = 0,    // Concrete/tile — good traction
    SLIPPERY = 1,  // Wheel slip detected
    ROUGH = 2      // High vibration (not implemented yet)
};

class AdaptivePID {
public:
    AdaptivePID();

    void begin();
    void update(uint32_t now_ms,
                bool cargo_loaded,
                float battery_voltage,
                int16_t target_rpm,
                float actual_rpm,
                float error_history[10]);  // Last 10 PID errors

    // Get adapted gains for a motor
    PIDGains getGains(uint8_t motor_id) const;

    // Surface detection
    SurfaceType getSurfaceType() const { return m_surface_type; }

    // Diagnostics
    float getLoadCompensation() const { return m_load_compensation; }
    float getBatteryCompensation() const { return m_battery_compensation; }
    bool isOscillating() const { return m_oscillation_detected; }

private:
    // Base gains (from config.h defaults)
    static constexpr float BASE_KP = 2.5f;
    static constexpr float BASE_KI = 0.2f;
    static constexpr float BASE_KD = 0.05f;

    // Current adapted gains (per-motor)
    PIDGains m_gains[4];

    // Adaptation factors
    float m_load_compensation;      // 1.0 = no load, 1.3 = with cargo
    float m_battery_compensation;   // 1.0 @ 20V, 1.15 @ 16V
    float m_slip_factor;            // 0.8 when slipping (reduce Kp)

    // Detection state
    SurfaceType m_surface_type;
    bool m_oscillation_detected;
    uint32_t m_last_adaptation_ms;

    // Adaptation interval (don't change gains too often)
    static constexpr uint32_t ADAPTATION_INTERVAL_MS = 5000;

    // Detect oscillation from error history
    bool detectOscillation(float error_history[10]);

    // Detect wheel slip (target >> actual for extended period)
    bool detectSlip(int16_t target_rpm, float actual_rpm);

    // Apply adaptations to base gains
    void adaptGains(bool cargo_loaded, float battery_voltage);
};
