#pragma once

#include <Arduino.h>

// Forward declarations
class BNO055Sensor;
class INA226Sensor;
class VL53L0XSensor;
class FrontTofSensor;

// ============================================================
// I2CWatchdog — Bus health monitoring and auto-recovery
// ============================================================
// Features:
//   1. Periodic liveness probe (every 10s)
//   2. Automatic bus reset when 2+ devices timeout
//   3. Degraded mode when critical sensors fail
// ============================================================

enum class I2CDeviceStatus : uint8_t {
    OK = 0,
    TIMEOUT = 1,
    NACK = 2,
    UNKNOWN = 3
};

struct I2CDeviceState {
    uint8_t address;
    const char* name;
    I2CDeviceStatus status;
    uint32_t last_success_ms;
    uint32_t failure_count;
};

class I2CWatchdog {
public:
    I2CWatchdog();

    void begin();
    void update(uint32_t now_ms);

    // Attach sensor pointers for degraded mode control
    void attachSensors(BNO055Sensor* imu,
                      INA226Sensor* power,
                      VL53L0XSensor* rear_tof,
                      FrontTofSensor* front_tof);

    // Query status
    bool isBusHealthy() const { return m_bus_healthy; }
    bool isDegradedMode() const { return m_degraded_mode; }
    uint8_t getFailedDeviceCount() const;

    // Get device state
    const I2CDeviceState& getDeviceState(uint8_t index) const;
    static constexpr uint8_t DEVICE_COUNT = 4;

private:
    I2CDeviceState m_devices[DEVICE_COUNT];
    bool m_bus_healthy;
    bool m_degraded_mode;
    uint32_t m_last_probe_ms;

    // Sensor pointers for degraded mode
    BNO055Sensor* m_imu;
    INA226Sensor* m_power;
    VL53L0XSensor* m_rear_tof;
    FrontTofSensor* m_front_tof;

    // Timing
    static constexpr uint32_t PROBE_INTERVAL_MS = 10000;  // 10s
    static constexpr uint32_t DEVICE_TIMEOUT_MS = 5000;   // 5s no response
    static constexpr uint8_t FAILURE_THRESHOLD = 2;       // 2+ failed → reset

    // Probe all devices
    void probeDevices();

    // Check if bus reset needed
    bool needsBusReset() const;

    // Perform bus reset + reinit
    void performBusRecovery();

    // Enter degraded mode (disable failed sensors)
    void enterDegradedMode();
};
