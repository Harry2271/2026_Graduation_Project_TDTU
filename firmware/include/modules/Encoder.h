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
    [[nodiscard]] const char* getName() const { return name_; }
    [[nodiscard]] uint8_t getChaPin() const { return cha_pin_; }
    [[nodiscard]] uint8_t getChbPin() const { return chb_pin_; }

    /// Read raw GPIO levels of CHA/CHB. Used by the boot-time
    /// hardware sanity check — if both lines sit HIGH for the entire
    /// test window but the PCNT counter never moves, the wiring or
    /// pull-up is broken, not the PCNT peripheral.
    void readRawPins(bool& cha_high, bool& chb_high) const;

private:
    pcnt_unit_t unit_;
    uint8_t     cha_pin_;
    uint8_t     chb_pin_;
    const char* name_;
    int16_t     last_count_;
    int32_t     cumulative_count_;
    float       last_filtered_rpm_;
};
