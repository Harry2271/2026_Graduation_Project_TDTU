#pragma once

#include <stdint.h>
#include "config.h"

class BTS7960Driver {
public:
    BTS7960Driver(uint8_t rpwm_pin, uint8_t lpwm_pin, uint8_t en_pin,
                   int8_t rpwm_channel, int8_t lpwm_channel);

    void begin();
    void enable();
    void disable();
    void setSpeed(int16_t speed);   // -1023 to 1023
    void coast();
    void brake();
    void emergencyStop();

    [[nodiscard]] bool     isEnabled() const { return enabled_; }
    [[nodiscard]] uint16_t getCurrentDuty() const { return current_duty_; }
    [[nodiscard]] MotorState getState() const { return state_; }

private:
    uint8_t  rpwm_pin_;
    uint8_t  lpwm_pin_;
    uint8_t  en_pin_;
    int8_t   rpwm_ch_;
    int8_t   lpwm_ch_;
    MotorState state_;
    uint16_t current_duty_;
    bool     enabled_;
};
