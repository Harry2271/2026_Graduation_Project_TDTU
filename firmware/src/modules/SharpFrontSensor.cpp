#include "SharpFrontSensor.h"
#include <Arduino.h>

// GP2Y0A21YK0F: inverse relationship between ADC value and distance
// distance_cm = 123438.5 / (adc_10bit - 11.0)
// Derived from Pololu / Sharp datasheet best-fit curve
//
// ESP32-S3 analogRead() returns 12-bit (0-4095).
// We scale down to 10-bit (0-1023) to reuse the original formula.
static float adcToCm(uint16_t raw_adc)
{
    // 12-bit → 10-bit (divide by 4)
    uint16_t adc = raw_adc >> 2;
    if (adc <= 11) return 80.0f;    // max range / no sensor
    if (adc >= 1020) return 10.0f;  // saturated (too close)
    return 123438.5f / (float)(adc - 11);
}

SharpFrontSensor::SharpFrontSensor()
    : distance_cm_(80.0f)
    , prev_distance_cm_(80.0f)
    , last_read_ms_(0)
    , sensor_present_(true)
{
}

void SharpFrontSensor::begin()
{
    pinMode(SHARP_FRONT_PIN, INPUT);
    // Full 0-3.3V range (default is 11dB attenuation which already does this,
    // but make it explicit so the calibration is reproducible).
    analogSetPinAttenuation(SHARP_FRONT_PIN, ADC_11db);

    // Boot check: average 8 rapid reads to see if sensor is present.
    // If all ADC values are near 0 (floating pin) or max (stuck),
    // treat the sensor as absent to avoid false obstacles.
    uint32_t sum = 0;
    for (int i = 0; i < 8; i++) {
        sum += analogRead(SHARP_FRONT_PIN);
        delayMicroseconds(200);
    }
    uint16_t avg_adc = sum / 8;
    float boot_cm = adcToCm(avg_adc);

    if (boot_cm < 5.0f || boot_cm > 120.0f) {
        // ADC reads garbage — sensor is likely not wired
        sensor_present_ = false;
        distance_cm_ = 80.0f;
        Serial.printf("  [WARN] Sharp GP2Y0A21YK0F absent (ADC=%u → %.0fcm) — sensor disabled\n",
            avg_adc, boot_cm);
    } else {
        sensor_present_ = true;
        distance_cm_ = boot_cm;
        Serial.printf("  [OK]   Sharp GP2Y0A21YK0F front (GPIO %u, %.0fcm)\n",
            SHARP_FRONT_PIN, boot_cm);
    }
}

bool SharpFrontSensor::update(uint32_t now_ms)
{
    if (!sensor_present_) return false;
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
    if (!sensor_present_) return false;
    return distance_cm_ < SHARP_FRONT_THRESHOLD_CM;
}

bool SharpFrontSensor::isSlowing() const
{
    if (!sensor_present_) return false;
    return distance_cm_ < SHARP_FRONT_SLOW_CM;
}

void SharpFrontSensor::printStatusJson() const
{
    Serial.printf(
        "{\"type\":136,\"data\":{\"distance_cm\":%.1f,\"too_close\":%s,\"slowing\":%s,\"present\":%s}}\n",
        distance_cm_,
        isTooClose() ? "true" : "false",
        isSlowing() ? "true" : "false",
        sensor_present_ ? "true" : "false"
    );
}
