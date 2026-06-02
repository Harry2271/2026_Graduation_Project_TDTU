#pragma once

#include <stdint.h>

class PIDController {
public:
    explicit PIDController(const char* name);

    void reset();
    void setGains(float kp, float ki, float kd);
    int16_t compute(float target_rpm, float actual_rpm, uint32_t dt_us);
    void getGains(float& kp, float& ki, float& kd) const;
    [[nodiscard]] float getTargetRPM() const { return target_rpm_; }
    void setTargetRPM(float rpm) { target_rpm_ = rpm; }

private:
    const char* name_;
    float kp_;
    float ki_;
    float kd_;
    float integral_;
    float prev_error_;
    float target_rpm_;
    uint32_t last_update_us_;
};
