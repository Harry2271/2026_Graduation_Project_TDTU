#include "SharpFrontSensor.h"
#include <Arduino.h>

// GP2Y0A21YK0F: inverse relationship between ADC value and distance
// distance_cm = 123438.5 / (adc_value - 11.0)
// Derived from Pololu / Sharp datasheet best-fit curve
static float adcToCm(uint16_t adc)
{
    if (adc <= 11) return 80.0f;   // max range (or no return)
    if (adc >= 1020) return 10.0f; // saturated (too close)
    return 123438.5f / (float)(adc - 11);
}

SharpFrontSensor::SharpFrontSensor()
    : distance_cm_(80.0f)
    , prev_distance_cm_(80.0f)
    , last_read_ms_(0)
{
}

void SharpFrontSensor::begin()
{
    pinMode(SHARP_FRONT_PIN, INPUT);
    Serial.printf("  [OK]   Sharp GP2Y0A21YK0F front sensor (GPIO %u)\n",
        SHARP_FRONT_PIN);
}

bool SharpFrontSensor::update(uint32_t now_ms)
{
    if (now_ms - last_read_ms_ < SHARP_FRONT_POLL_MS) return false;
    last_read_ms_ = now_ms;

    prev_distance_cm_ = distance_cm_;

    // Oversample: average 4 reads for noise reduction
    uint32_t sum = 0;
    for (int i = 0; i < 4; i++) {
        sum += analogRead(SHARP_FRONT_PIN);
    }
    uint16_t avg_adc = sum / 4;

    distance_cm_ = adcToCm(avg_adc);
    distance_cm_ = constrain(distance_cm_, 10.0f, 80.0f);

    // Only report change if > 2 cm delta
    return fabsf(distance_cm_ - prev_distance_cm_) > 2.0f;
}

float SharpFrontSensor::getDistanceCm() const
{
    return distance_cm_;
}

bool SharpFrontSensor::isTooClose() const
{
    return distance_cm_ < SHARP_FRONT_THRESHOLD_CM;
}

bool SharpFrontSensor::isSlowing() const
{
    return distance_cm_ < SHARP_FRONT_SLOW_CM;
}

void SharpFrontSensor::printStatusJson() const
{
    Serial.printf(
        "{\"type\":136,\"data\":{\"distance_cm\":%.1f,\"too_close\":%s,\"slowing\":%s}}\n",
        distance_cm_,
        isTooClose() ? "true" : "false",
        isSlowing() ? "true" : "false"
    );
}
