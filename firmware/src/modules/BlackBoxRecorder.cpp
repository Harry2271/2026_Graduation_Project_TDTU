#include "BlackBoxRecorder.h"
#include "Encoder.h"
#include "BNO055Sensor.h"
#include "SafetyController.h"
#include <esp_heap_caps.h>

BlackBoxRecorder::BlackBoxRecorder()
    : m_buffer(nullptr)
    , m_write_index(0)
    , m_sample_count(0)
    , m_frozen(false)
    , m_trigger(BlackBoxTrigger::NONE)
    , m_trigger_reason("")
    , m_freeze_timestamp_ms(0)
{
}

void BlackBoxRecorder::begin()
{
    Serial.println("  [BLACKBOX] PSRAM recorder initializing...");

    // Check PSRAM availability (ESP32-S3 uses esp_spiram_* API)
    size_t psram_size = esp_spiram_get_size();
    if (psram_size == 0) {
        Serial.println("           ERROR: PSRAM not detected");
        return;
    }

    Serial.printf("           PSRAM: %u bytes available\n", psram_size);

    // Allocate buffer
    if (allocateBuffer()) {
        Serial.printf("           Buffer: %u samples (%.1f KB, 30s @ 10Hz)\n",
                     BUFFER_SIZE,
                     (BUFFER_SIZE * sizeof(BlackBoxSample)) / 1024.0f);
        Serial.println("           Ready for crash dump recording");
    } else {
        Serial.println("           ERROR: Buffer allocation failed");
    }
}

bool BlackBoxRecorder::allocateBuffer()
{
    size_t buffer_size = BUFFER_SIZE * sizeof(BlackBoxSample);

    // Allocate in PSRAM (external RAM, not DRAM)
    m_buffer = (BlackBoxSample*)heap_caps_malloc(buffer_size, MALLOC_CAP_SPIRAM);

    if (m_buffer == nullptr) {
        Serial.println("[BLACKBOX] PSRAM allocation failed");
        return false;
    }

    // Zero-initialize
    memset(m_buffer, 0, buffer_size);
    return true;
}

void BlackBoxRecorder::record(uint32_t now_ms,
                              int16_t nav_vx, int16_t nav_vy, int16_t nav_omega,
                              const int16_t motor_targets[4],
                              Encoder encoders[4],
                              BNO055Sensor* imu,
                              SafetyController* safety,
                              uint8_t ir_mask,
                              uint16_t front_tof_mm)
{
    if (m_buffer == nullptr || m_frozen) {
        return;  // Not initialized or frozen
    }

    // Write sample to circular buffer
    BlackBoxSample& sample = m_buffer[m_write_index];

    sample.timestamp_ms = now_ms;
    sample.nav_vx = nav_vx;
    sample.nav_vy = nav_vy;
    sample.nav_omega = nav_omega;

    for (uint8_t i = 0; i < 4; i++) {
        sample.motor_targets[i] = motor_targets[i];
        sample.motor_rpms[i] = encoders[i].getFilteredRPM();
        sample.encoder_counts[i] = encoders[i].getCumulativeCount();
    }

    if (imu->isOperational()) {
        sample.imu_heading = imu->getHeading();
        sample.imu_accel_x = imu->getLinearAccelX();
        sample.imu_accel_y = imu->getLinearAccelY();
    } else {
        sample.imu_heading = 0.0f;
        sample.imu_accel_x = 0.0f;
        sample.imu_accel_y = 0.0f;
    }

    sample.safety_level = (uint8_t)safety->getLevel();
    sample.ir_mask = ir_mask;
    sample.front_tof_mm = front_tof_mm;

    // Advance circular buffer
    m_write_index = (m_write_index + 1) % BUFFER_SIZE;
    if (m_sample_count < BUFFER_SIZE) {
        m_sample_count++;
    }
}

void BlackBoxRecorder::freeze(BlackBoxTrigger trigger, const char* reason)
{
    if (m_buffer == nullptr || m_frozen) {
        return;
    }

    m_frozen = true;
    m_trigger = trigger;
    m_trigger_reason = reason;
    m_freeze_timestamp_ms = millis();

    const char* trigger_names[] = {
        "NONE", "MOTION_STUCK", "HARD_STOP", "EMERGENCY", "IMU_SHOCK", "MANUAL"
    };

    Serial.println("======================================");
    Serial.printf("[BLACKBOX] FROZEN (trigger: %s)\n",
                  trigger_names[(uint8_t)trigger]);
    Serial.printf("           Reason: %s\n", reason);
    Serial.printf("           Samples: %lu (%.1fs history)\n",
                  m_sample_count, m_sample_count / 10.0f);
    Serial.println("           Use 'get_blackbox' to retrieve");
    Serial.println("======================================");
}

void BlackBoxRecorder::streamToSerial(Stream& stream)
{
    if (m_buffer == nullptr) {
        stream.println("{\"type\":147,\"error\":\"Buffer not allocated\"}");
        return;
    }

    if (!m_frozen) {
        stream.println("{\"type\":147,\"error\":\"Buffer not frozen\"}");
        return;
    }

    // Emit entire JSON as a single line to match Python's line-delimited parser.
    // Multi-line output breaks esp32_bridge.py's json.loads() per-line dispatch.
    stream.print("{\"type\":147,\"trigger\":");
    stream.print((uint8_t)m_trigger);
    stream.print(",\"reason\":\"");
    stream.print(m_trigger_reason);
    stream.print("\",\"samples\":");
    stream.print(m_sample_count);
    stream.print(",\"freeze_ts\":");
    stream.print(m_freeze_timestamp_ms);
    stream.print(",\"data\":[");

    // Stream samples (oldest to newest)
    uint32_t read_index = (m_sample_count < BUFFER_SIZE) ? 0 : m_write_index;
    for (uint32_t i = 0; i < m_sample_count; i++) {
        const BlackBoxSample& s = m_buffer[read_index];

        stream.print("{\"ts\":");
        stream.print(s.timestamp_ms);
        stream.print(",\"nav\":[");
        stream.print(s.nav_vx); stream.print(",");
        stream.print(s.nav_vy); stream.print(",");
        stream.print(s.nav_omega);
        stream.print("],\"mt\":[");
        for (uint8_t j = 0; j < 4; j++) {
            stream.print(s.motor_targets[j]);
            if (j < 3) stream.print(",");
        }
        stream.print("],\"mr\":[");
        for (uint8_t j = 0; j < 4; j++) {
            stream.print(s.motor_rpms[j], 1);
            if (j < 3) stream.print(",");
        }
        stream.print("],\"imu\":[");
        stream.print(s.imu_heading, 1); stream.print(",");
        stream.print(s.imu_accel_x, 2); stream.print(",");
        stream.print(s.imu_accel_y, 2);
        stream.print("],\"sl\":");
        stream.print(s.safety_level);
        stream.print(",\"ir\":");
        stream.print(s.ir_mask);
        stream.print(",\"tof\":");
        stream.print(s.front_tof_mm);
        stream.print("}");

        if (i < m_sample_count - 1) {
            stream.print(",");
        }

        read_index = (read_index + 1) % BUFFER_SIZE;
    }

    stream.println("]}");
}

void BlackBoxRecorder::clear()
{
    m_frozen = false;
    m_trigger = BlackBoxTrigger::NONE;
    m_trigger_reason = "";
    m_write_index = 0;
    m_sample_count = 0;

    if (m_buffer != nullptr) {
        memset(m_buffer, 0, BUFFER_SIZE * sizeof(BlackBoxSample));
    }

    Serial.println("[BLACKBOX] Cleared, resuming recording");
}
