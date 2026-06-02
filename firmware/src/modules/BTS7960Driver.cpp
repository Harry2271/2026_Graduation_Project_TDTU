#include "BTS7960Driver.h"
#include <driver/ledc.h>
#include <driver/gpio.h>

BTS7960Driver::BTS7960Driver(uint8_t rpwm_pin, uint8_t lpwm_pin, uint8_t en_pin,
                               int8_t rpwm_channel, int8_t lpwm_channel)
    : rpwm_pin_(rpwm_pin), lpwm_pin_(lpwm_pin)
    , en_pin_(en_pin), rpwm_ch_(rpwm_channel), lpwm_ch_(lpwm_channel)
    , state_(MOTOR_COAST), current_duty_(0), enabled_(false)
{
}

void BTS7960Driver::begin()
{
    gpio_reset_pin((gpio_num_t)en_pin_);

    gpio_set_direction((gpio_num_t)en_pin_, GPIO_MODE_OUTPUT);
    gpio_pullup_en((gpio_num_t)en_pin_);
    gpio_pulldown_dis((gpio_num_t)en_pin_);

    ets_delay_us(10);
    gpio_set_level((gpio_num_t)en_pin_, 1);
    enabled_ = true;

    ledc_channel_config_t rpwm_conf = {};
    rpwm_conf.gpio_num    = (gpio_num_t)rpwm_pin_;
    rpwm_conf.speed_mode  = LEDC_LOW_SPEED_MODE;
    rpwm_conf.channel     = (ledc_channel_t)rpwm_ch_;
    rpwm_conf.intr_type   = LEDC_INTR_DISABLE;
    rpwm_conf.timer_sel   = LEDC_TIMER_0;
    rpwm_conf.duty        = 0;
    rpwm_conf.hpoint     = 0;
    ledc_channel_config(&rpwm_conf);

    ledc_channel_config_t lpwm_conf = {};
    lpwm_conf.gpio_num    = (gpio_num_t)lpwm_pin_;
    lpwm_conf.speed_mode  = LEDC_LOW_SPEED_MODE;
    lpwm_conf.channel     = (ledc_channel_t)lpwm_ch_;
    lpwm_conf.intr_type   = LEDC_INTR_DISABLE;
    lpwm_conf.timer_sel   = LEDC_TIMER_0;
    lpwm_conf.duty        = 0;
    lpwm_conf.hpoint     = 0;
    ledc_channel_config(&lpwm_conf);
}

void BTS7960Driver::enable()
{
    enabled_ = true;
    gpio_set_level((gpio_num_t)en_pin_, 1);
}

void BTS7960Driver::disable()
{
    enabled_ = false;
    brake();
    gpio_set_level((gpio_num_t)en_pin_, 0);
}

void BTS7960Driver::setSpeed(int16_t speed)
{
    if (!enabled_) return;

    if (speed == 0) {
        coast();
        return;
    }

    uint16_t duty = (uint16_t)abs(speed);
    if (duty > MOTOR_MAX_DUTY) duty = MOTOR_MAX_DUTY;

    if (speed > 0) {
        state_ = MOTOR_FORWARD;
        current_duty_ = duty;
        ledc_set_duty(LEDC_LOW_SPEED_MODE, (ledc_channel_t)rpwm_ch_, duty);
        ledc_update_duty(LEDC_LOW_SPEED_MODE, (ledc_channel_t)rpwm_ch_);
        ledc_set_duty(LEDC_LOW_SPEED_MODE, (ledc_channel_t)lpwm_ch_, 0);
        ledc_update_duty(LEDC_LOW_SPEED_MODE, (ledc_channel_t)lpwm_ch_);
    } else {
        state_ = MOTOR_BACKWARD;
        current_duty_ = duty;
        ledc_set_duty(LEDC_LOW_SPEED_MODE, (ledc_channel_t)rpwm_ch_, 0);
        ledc_update_duty(LEDC_LOW_SPEED_MODE, (ledc_channel_t)rpwm_ch_);
        ledc_set_duty(LEDC_LOW_SPEED_MODE, (ledc_channel_t)lpwm_ch_, duty);
        ledc_update_duty(LEDC_LOW_SPEED_MODE, (ledc_channel_t)lpwm_ch_);
    }
}

void BTS7960Driver::coast()
{
    state_ = MOTOR_COAST;
    current_duty_ = 0;
    ledc_set_duty(LEDC_LOW_SPEED_MODE, (ledc_channel_t)rpwm_ch_, 0);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, (ledc_channel_t)rpwm_ch_);
    ledc_set_duty(LEDC_LOW_SPEED_MODE, (ledc_channel_t)lpwm_ch_, 0);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, (ledc_channel_t)lpwm_ch_);
}

void BTS7960Driver::brake()
{
    state_ = MOTOR_BRAKE;
    current_duty_ = PWM_MAX_DUTY;
    ledc_set_duty(LEDC_LOW_SPEED_MODE, (ledc_channel_t)rpwm_ch_, PWM_MAX_DUTY);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, (ledc_channel_t)rpwm_ch_);
    ledc_set_duty(LEDC_LOW_SPEED_MODE, (ledc_channel_t)lpwm_ch_, PWM_MAX_DUTY);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, (ledc_channel_t)lpwm_ch_);
}

void BTS7960Driver::emergencyStop()
{
    enabled_ = false;
    gpio_set_level((gpio_num_t)en_pin_, 0);
    ledc_set_duty(LEDC_LOW_SPEED_MODE, (ledc_channel_t)rpwm_ch_, 0);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, (ledc_channel_t)rpwm_ch_);
    ledc_set_duty(LEDC_LOW_SPEED_MODE, (ledc_channel_t)lpwm_ch_, 0);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, (ledc_channel_t)lpwm_ch_);
}
