#include "SharpFrontSensor.h"
#include <Arduino.h>

// =====================================================================
// Sharp GP2Y0A21YK0F — LUT-based distance conversion
// Adapted from reference code (works correctly on ESP32-S3 12-bit ADC).
//
// Key insight: the analog formula 123438.5/(adc-11) is inaccurate on
// ESP32-S3 because ADC linearity degrades at low/high ends.  The LUT
// approach bins raw 12-bit values (0..4095) into 256 buckets (÷16)
// and looks up a pre-calibrated cm value.  Much more reliable.
//
// Supply: 5V (sensor rated 4.5–5.5V).  ADC ref: 3.3V (ADC_11db).
// Range: 10–80 cm.
// =====================================================================

// 5V-supply transfer function (cm) for 10-bit ADC values 0..1023.
// Indexing: raw12bit / 16 = index 0..255
static const uint8_t LUT_5V[256] PROGMEM = {
    255,127, 93, 77, 67, 60, 54, 50, 47, 44, 42, 40, 38, 36, 35, 34,
     32, 31, 30, 30, 29, 28, 27, 27, 26, 26, 25, 25, 24, 22, 20, 19,
     19, 18, 18, 17, 17, 17, 16, 16, 16, 15, 15, 15, 14, 14, 14, 13,
     13, 13, 13, 13, 12, 12, 12, 12, 12, 11, 11, 11, 11, 11, 11, 10,
     10, 10, 10, 10, 10, 10, 10,  9,  9,  9,  9,  9,  9,  9,  9,  9,
      8,  8,  8,  8,  8,  8,  8,  8,  8,  8,  8,  8,  8,  7,  7,  7,
      7,  7,  7,  7,  7,  7,  7,  7,  7,  7,  7,  7,  7,  6,  6,  6,
      6,  6,  6,  6,  6,  6,  6,  6,  6,  6,  6,  6,  6,  6,  6,  6,
      6,  6,  6,  6,  6,  5,  5,  5,  5,  5,  5,  5,  5,  5,  5,  5,
      5,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,
      0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,
      0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,
      0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,
      0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,
      0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,
      0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0
};

// ---------------------------------------------------------------------------
SharpFrontSensor::SharpFrontSensor()
    : distance_cm_(80.0f)
    , prev_distance_cm_(80.0f)
    , last_read_ms_(0)
    , sensor_present_(true)
    , num_samples_(5)
{
}

// ---------------------------------------------------------------------------
void SharpFrontSensor::begin()
{
    analogReadResolution(12);           // 0..4095
    analogSetAttenuation(ADC_11db);     // full-scale ~3.3V
    pinMode(SHARP_FRONT_PIN, INPUT);

    // Boot check: take a few reads to see if sensor is wired
    long sum = 0;
    for (int i = 0; i < 8; i++) {
        sum += analogRead(SHARP_FRONT_PIN);
        delayMicroseconds(500);
    }
    int avg_raw = sum / 8;
    int boot_cm = (avg_raw / 16 < 256) ? pgm_read_byte(&LUT_5V[avg_raw / 16]) : 0;

    if (boot_cm == 0 || boot_cm >= 80) {
        // Could be no sensor (floating = high ADC) or object very far / absent
        sensor_present_ = true;   // assume present (can't tell from floating pin)
        Serial.printf("  [Sharp] GPIO %u init (raw=%d, ~%dcm)\n",
            SHARP_FRONT_PIN, avg_raw, boot_cm);
    } else {
        sensor_present_ = true;
        Serial.printf("  [Sharp] GPIO %u init OK (raw=%d, %dcm)\n",
            SHARP_FRONT_PIN, avg_raw, boot_cm);
    }
}

// ---------------------------------------------------------------------------
// Read sensor: average N samples, look up LUT → cm
// ---------------------------------------------------------------------------
bool SharpFrontSensor::update(uint32_t now_ms)
{
    if (now_ms - last_read_ms_ < SHARP_FRONT_POLL_MS) return false;
    last_read_ms_ = now_ms;

    prev_distance_cm_ = distance_cm_;

    // Oversample for noise reduction
    long sum = 0;
    for (int i = 0; i < num_samples_; i++) {
        int raw = analogRead(SHARP_FRONT_PIN);
        // ESP32-S3 12-bit (0..4095) → LUT index 0..255
        int idx = raw / 16;
        if (idx > 255) idx = 255;
        sum += pgm_read_byte(&LUT_5V[idx]);
        delayMicroseconds(200);
    }
    int cm = (int)(sum / num_samples_);

    // LUT returns 0 for very low ADC (no return / out of range) and
    // 255 for saturated (very close).  Map both to safe bounds.
    if (cm == 0) {
        distance_cm_ = 80.0f;   // out of range = max distance
    } else if (cm >= 255) {
        distance_cm_ = 5.0f;    // saturated = very close
    } else {
        distance_cm_ = (float)cm;
    }

    // Only report change if > 1 cm delta
    return fabsf(distance_cm_ - prev_distance_cm_) > 1.0f;
}

// ---------------------------------------------------------------------------
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
        "{\"type\":136,\"data\":{\"distance_cm\":%.0f,\"too_close\":%s,\"slowing\":%s,\"present\":%s}}\n",
        distance_cm_,
        isTooClose() ? "true" : "false",
        isSlowing() ? "true" : "false",
        sensor_present_ ? "true" : "false"
    );
}
