#pragma once

#include <Arduino.h>

// ============================================================
// DynamicAcceleration — Adaptive acceleration profiles
// ============================================================
// 3 profiles:
//   SMOOTH (cargo loaded): Ramp 30, no kick-boost
//   NORMAL (empty): Ramp 50, kick 255×15
//   AGGRESSIVE (emergency): Ramp 100, kick 255×20
// ============================================================

enum class AccelProfile : uint8_t {
    SMOOTH = 0,      // Cargo loaded — không làm đổ hàng
    NORMAL = 1,      // Default — empty robot
    AGGRESSIVE = 2   // Emergency dodge — phản ứng nhanh
};

struct AccelParams {
    uint8_t ramp_rate;      // PWM change per 20ms tick
    uint8_t kick_boost_pwm; // Kick-start PWM
    uint8_t kick_boost_ticks; // Duration in ticks
};

class DynamicAcceleration {
public:
    DynamicAcceleration();

    void begin();

    // Profile selection
    void setProfile(AccelProfile profile);
    AccelProfile getProfile() const { return m_current_profile; }

    // Auto profile selection based on conditions
    void updateProfile(bool cargo_loaded,
                      bool front_tof_critical,
                      int16_t current_speed);

    // Get current params
    const AccelParams& getParams() const { return m_params; }
    uint8_t getRampRate() const { return m_params.ramp_rate; }
    uint8_t getKickBoostPWM() const { return m_params.kick_boost_pwm; }
    uint8_t getKickBoostTicks() const { return m_params.kick_boost_ticks; }

    // Logging
    const char* profileToString() const;

private:
    AccelProfile m_current_profile;
    AccelParams m_params;

    // Profile definitions
    static constexpr AccelParams SMOOTH_PARAMS = {
        .ramp_rate = 30,
        .kick_boost_pwm = 180,   // Reduced kick for loaded starts (vs 255)
        .kick_boost_ticks = 20   // Longer duration for gentler breakaway
    };

    static constexpr AccelParams NORMAL_PARAMS = {
        .ramp_rate = 50,
        .kick_boost_pwm = 255,
        .kick_boost_ticks = 15
    };

    static constexpr AccelParams AGGRESSIVE_PARAMS = {
        .ramp_rate = 120,        // Snappier dodge (was 100); unloaded + emergency only
        .kick_boost_pwm = 255,
        .kick_boost_ticks = 20
    };

    void applyProfile(AccelProfile profile);
};
