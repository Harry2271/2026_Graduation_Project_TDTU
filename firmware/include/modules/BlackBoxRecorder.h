#pragma once

#include <Arduino.h>

class Encoder;
class BNO055Sensor;
class SafetyController;

// ============================================================
// BlackBoxRecorder — PSRAM-based crash dump recorder
// ============================================================
// Features:
//   1. 30-second circular buffer in PSRAM (8MB available)
//   2. Freeze on crash/stuck/e-stop → emit type 147
//   3. Pi retrieval via `get_blackbox` command
// ============================================================

struct BlackBoxSample {
    uint32_t timestamp_ms;
    int16_t nav_vx;
    int16_t nav_vy;
    int16_t nav_omega;
    int16_t motor_targets[4];
    float motor_rpms[4];
    int32_t encoder_counts[4];
    float imu_heading;
    float imu_accel_x;
    float imu_accel_y;
    uint8_t safety_level;
    uint8_t ir_mask;
    uint16_t front_tof_mm;
};

enum class BlackBoxTrigger : uint8_t {
    NONE = 0,
    MOTION_STUCK = 1,
    HARD_STOP = 2,
    EMERGENCY = 3,
    IMU_SHOCK = 4,
    MANUAL = 5  // Pi requested dump
};

class BlackBoxRecorder {
public:
    BlackBoxRecorder();

    void begin();

    // Record one sample (called every 100ms from main loop)
    void record(uint32_t now_ms,
               int16_t nav_vx, int16_t nav_vy, int16_t nav_omega,
               const int16_t motor_targets[4],
               Encoder encoders[4],
               BNO055Sensor* imu,
               SafetyController* safety,
               uint8_t ir_mask,
               uint16_t front_tof_mm);

    // Freeze buffer on crash (no more writes until retrieval)
    void freeze(BlackBoxTrigger trigger, const char* reason);

    // Check if buffer is frozen
    bool isFrozen() const { return m_frozen; }
    BlackBoxTrigger getTrigger() const { return m_trigger; }
    const char* getTriggerReason() const { return m_trigger_reason; }

    // Stream buffer to serial (for Pi retrieval)
    void streamToSerial(Stream& stream);

    // Clear and resume recording
    void clear();

    // Get buffer info
    uint32_t getSampleCount() const { return m_sample_count; }
    uint32_t getCapacity() const { return BUFFER_SIZE; }

private:
    // PSRAM buffer (30 seconds @ 10 Hz = 300 samples)
    static constexpr uint32_t BUFFER_SIZE = 300;
    BlackBoxSample* m_buffer;  // Allocated in PSRAM

    uint32_t m_write_index;
    uint32_t m_sample_count;
    bool m_frozen;
    BlackBoxTrigger m_trigger;
    const char* m_trigger_reason;
    uint32_t m_freeze_timestamp_ms;

    // Allocate buffer in PSRAM
    bool allocateBuffer();
};
