#include "DynamicAcceleration.h"

// Out-of-line definitions for the constexpr profile tables.  Required under
// C++11/14 (arduino-esp32's default is gnu++11): applyProfile() ODR-uses them
// via struct copy-assignment, so without a definition the linker reports
// "undefined reference to DynamicAcceleration::NORMAL_PARAMS".
constexpr AccelParams DynamicAcceleration::SMOOTH_PARAMS;
constexpr AccelParams DynamicAcceleration::NORMAL_PARAMS;
constexpr AccelParams DynamicAcceleration::AGGRESSIVE_PARAMS;

DynamicAcceleration::DynamicAcceleration()
    : m_current_profile(AccelProfile::NORMAL)
    , m_params(NORMAL_PARAMS)
{
}

void DynamicAcceleration::begin()
{
    Serial.println("  [ACCEL] Dynamic acceleration controller initialized");
    Serial.printf("         SMOOTH: ramp=%u kick=0\n", SMOOTH_PARAMS.ramp_rate);
    Serial.printf("         NORMAL: ramp=%u kick=%u×%u\n",
                  NORMAL_PARAMS.ramp_rate,
                  NORMAL_PARAMS.kick_boost_pwm,
                  NORMAL_PARAMS.kick_boost_ticks);
    Serial.printf("         AGGRESSIVE: ramp=%u kick=%u×%u\n",
                  AGGRESSIVE_PARAMS.ramp_rate,
                  AGGRESSIVE_PARAMS.kick_boost_pwm,
                  AGGRESSIVE_PARAMS.kick_boost_ticks);
}

void DynamicAcceleration::setProfile(AccelProfile profile)
{
    if (profile != m_current_profile) {
        const char* old_name = profileToString();  // Capture before mutation
        applyProfile(profile);
        Serial.printf("[ACCEL] Profile changed: %s -> %s\n",
                     old_name, profileToString());
    }
}

void DynamicAcceleration::updateProfile(bool cargo_loaded,
                                       bool front_tof_critical,
                                       int16_t current_speed)
{
    AccelProfile new_profile;

    // Priority 1: Cargo loaded → SMOOTH (không làm đổ hàng)
    if (cargo_loaded) {
        new_profile = AccelProfile::SMOOTH;
    }
    // Priority 2: Emergency dodge (front < 30cm + high speed)
    else if (front_tof_critical && abs(current_speed) > 150) {
        new_profile = AccelProfile::AGGRESSIVE;
    }
    // Default: NORMAL
    else {
        new_profile = AccelProfile::NORMAL;
    }

    setProfile(new_profile);
}

const char* DynamicAcceleration::profileToString() const
{
    switch (m_current_profile) {
        case AccelProfile::SMOOTH:     return "SMOOTH";
        case AccelProfile::NORMAL:     return "NORMAL";
        case AccelProfile::AGGRESSIVE: return "AGGRESSIVE";
        default: return "UNKNOWN";
    }
}

void DynamicAcceleration::applyProfile(AccelProfile profile)
{
    m_current_profile = profile;

    switch (profile) {
        case AccelProfile::SMOOTH:
            m_params = SMOOTH_PARAMS;
            break;
        case AccelProfile::NORMAL:
            m_params = NORMAL_PARAMS;
            break;
        case AccelProfile::AGGRESSIVE:
            m_params = AGGRESSIVE_PARAMS;
            break;
    }
}
