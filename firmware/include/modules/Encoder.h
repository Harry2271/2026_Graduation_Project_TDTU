#pragma once

#include <driver/pcnt.h>
#include <stdint.h>

class Encoder {
public:
    Encoder(pcnt_unit_t unit, uint8_t cha_pin, uint8_t chb_pin, const char* name);

    void begin();
    void reset();
    void pause();
    void resume();

    int32_t readCount();
    float calculateRPM(uint32_t dt_ms);
    [[nodiscard]] float  getFilteredRPM() const { return last_filtered_rpm_; }
    [[nodiscard]] int32_t getCumulativeCount() const { return cumulative_count_; }

private:
    pcnt_unit_t unit_;
    uint8_t     cha_pin_;
    uint8_t     chb_pin_;
    const char* name_;
    int16_t     last_count_;
    int32_t     cumulative_count_;
    float       last_filtered_rpm_;
};
