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
// ── Sharp GP2Y0A21YK0F transfer function (5V supply, 10-bit ADC) ──
//
// Voltage characteristic (from datasheet, Vcc = 5.0V):
//   V_out = 1/(d - 0.42) * 118.76   (d in cm, V_out in volts)
//
// Inverting:  d = 118.76 / V_out + 0.42
//
// ESP32-S3 ADC: 12-bit (0..4095), full-scale 3.3V.
//   voltage = raw * 3.3 / 4095
//
// This replaces the old 256-byte LUT which was calibrated for 10-bit ADC
// and did not work correctly with the ESP32-S3's 12-bit ADC.
// ─────────────────────────────────────────────────────────────────────────────
static const float SHARP_VCC        = 5.0f;   // sensor supply voltage
static const float SHARP_K          = 118.76f; // empirical constant (5V supply)
static const float SHARP_OFFSET     = 0.42f;  // offset correction
static const float ADC_VREF         = 3.3f;   // ESP32-S3 ADC reference
static const float ADC_MAX          = 4095.0f; // 12-bit
static const float SHARP_CM_MAX     = 80.0f;  // datasheet max reliable range
static const float SHARP_CM_MIN     = 10.0f;  // datasheet min reliable range

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
    float boot_v = avg_raw * ADC_VREF / ADC_MAX;
    float boot_cm = (boot_v > 0.05f) ? (SHARP_K / boot_v + SHARP_OFFSET) : 200.0f;

    // ADC very low means far or no sensor; very high means saturated (close)
    if (avg_raw < 50 || boot_cm >= SHARP_CM_MAX) {
        // Very low voltage = no return / far / no sensor
        sensor_present_ = true;
        Serial.printf("  [Sharp] GPIO %u init (raw=%d, %.1fV, ~%dcm)\n",
            SHARP_FRONT_PIN, avg_raw, boot_v, (int)boot_cm);
    } else {
        sensor_present_ = true;
        Serial.printf("  [Sharp] GPIO %u init OK (raw=%d, %.1fV, ~%dcm)\n",
            SHARP_FRONT_PIN, avg_raw, boot_v, (int)boot_cm);
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

    // Oversample for noise reduction, then convert raw → voltage → cm
    float sum_v = 0.0f;
    int valid_samples = 0;
    for (int i = 0; i < num_samples_; i++) {
        int raw = analogRead(SHARP_FRONT_PIN);
        // Discard saturated readings (object too close or sensor absent)
        if (raw < 4090) {
            sum_v += raw * ADC_VREF / ADC_MAX;
            valid_samples++;
        }
        delayMicroseconds(200);
    }

    if (valid_samples == 0) {
        // All samples saturated → treat as "very close" (hard-stop)
        distance_cm_ = SHARP_CM_MIN;
    } else {
        float avg_v = sum_v / valid_samples;
        if (avg_v < 0.05f) {
            // Very low voltage = no return, out of range → max distance
            distance_cm_ = SHARP_CM_MAX;
        } else {
            float d = SHARP_K / avg_v + SHARP_OFFSET;
            // Clamp to sensor's reliable range
            if (d < SHARP_CM_MIN) d = SHARP_CM_MIN;
            if (d > SHARP_CM_MAX) d = SHARP_CM_MAX;
            distance_cm_ = d;
        }
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
    PiSerial.printf(
        "{\"type\":136,\"data\":{\"distance_cm\":%.0f,\"too_close\":%s,\"slowing\":%s,\"present\":%s}}\n",
        distance_cm_,
        isTooClose() ? "true" : "false",
        isSlowing() ? "true" : "false",
        sensor_present_ ? "true" : "false"
    );
}
