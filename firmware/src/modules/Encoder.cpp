#include "Encoder.h"
#include "config.h"
#include <driver/pcnt.h>
#include <driver/gpio.h>
#include <math.h>

Encoder::Encoder(pcnt_unit_t unit, uint8_t cha_pin, uint8_t chb_pin, const char* name)
    : unit_(unit), cha_pin_(cha_pin), chb_pin_(chb_pin), name_(name)
    , last_count_(0), cumulative_count_(0), last_filtered_rpm_(0.0f)
{
}

void Encoder::begin()
{
    gpio_config_t io_conf = {0};
    io_conf.pin_bit_mask = (1ULL << cha_pin_) | (1ULL << chb_pin_);
    io_conf.mode        = GPIO_MODE_INPUT;
    io_conf.pull_up_en   = GPIO_PULLUP_ENABLE;
    io_conf.pull_down_en = GPIO_PULLDOWN_DISABLE;
    io_conf.intr_type    = GPIO_INTR_DISABLE;
    gpio_config(&io_conf);

    pcnt_config_t pcnt_conf = {};
    pcnt_conf.pulse_gpio_num = (gpio_num_t)cha_pin_;
    pcnt_conf.ctrl_gpio_num  = (gpio_num_t)chb_pin_;
    pcnt_conf.channel        = PCNT_CHANNEL_0;
    pcnt_conf.unit          = unit_;
    pcnt_conf.pos_mode      = PCNT_COUNT_INC;
    pcnt_conf.neg_mode      = PCNT_COUNT_DEC;
    pcnt_conf.lctrl_mode    = PCNT_MODE_REVERSE;
    pcnt_conf.hctrl_mode    = PCNT_MODE_KEEP;
    pcnt_conf.counter_h_lim = 32767;
    pcnt_conf.counter_l_lim = -32768;
    pcnt_unit_config(&pcnt_conf);

    pcnt_set_filter_value(unit_, 1000);  // ~12.5 µs @ 80 MHz, rejects motor-brush ringing
    pcnt_filter_enable(unit_);

    pcnt_counter_pause(unit_);
    pcnt_counter_clear(unit_);
    pcnt_counter_resume(unit_);
}

void Encoder::reset()
{
    pcnt_counter_pause(unit_);
    pcnt_counter_clear(unit_);
    last_count_ = 0;
    cumulative_count_ = 0;
    last_filtered_rpm_ = 0.0f;
    pcnt_counter_resume(unit_);
}

void Encoder::pause()
{
    pcnt_counter_pause(unit_);
}

void Encoder::resume()
{
    pcnt_counter_pause(unit_);
    pcnt_counter_clear(unit_);
    last_count_ = 0;
    cumulative_count_ = 0;
    last_filtered_rpm_ = 0.0f;
    pcnt_counter_resume(unit_);
}

int32_t Encoder::readCount()
{
    int16_t raw;
    pcnt_get_counter_value(unit_, &raw);

    int16_t delta = raw - last_count_;
    last_count_ = raw;

    if (delta < -30000) {
        cumulative_count_ += (int32_t)delta + 65536;
    } else if (delta > 30000) {
        cumulative_count_ += (int32_t)delta - 65536;
    } else {
        cumulative_count_ += delta;
    }

    return cumulative_count_;
}

float Encoder::calculateRPM(uint32_t dt_ms)
{
    int16_t raw;
    pcnt_get_counter_value(unit_, &raw);

    int16_t delta = raw - last_count_;
    last_count_ = raw;

    if (delta < -30000) delta += 65536;
    if (delta > 30000)  delta -= 65536;

    cumulative_count_ += delta;

    if (dt_ms == 0) {
        last_filtered_rpm_ = 0.0f;
        return 0.0f;
    }

    // counts/rev on OUTPUT SHAFT = encoder CPR × gear ratio
    // JGB37-520: 11 PPR × 2 (x2 decode) × 30 (gearbox) = 660 counts/output rev
    constexpr float OUTPUT_CPR = (float)MOTOR_ENCODER_CPR * MOTOR_GEAR_RATIO;
    float rpm = ((float)delta / (float)dt_ms) * (60000.0f / OUTPUT_CPR);

    // Guard against bogus spikes (e.g. first tick after boot, or wiring noise)
    if (rpm >  500.0f) rpm =  500.0f;
    if (rpm < -500.0f) rpm = -500.0f;

    const float alpha = 0.3f;
    rpm = last_filtered_rpm_ * (1.0f - alpha) + rpm * alpha;
    if (fabsf(rpm) < 0.1f) rpm = 0.0f;   // floor: kill denormals / noise floor
    last_filtered_rpm_ = rpm;

    return rpm;
}
