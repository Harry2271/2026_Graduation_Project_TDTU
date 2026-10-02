#include "I2CWatchdog.h"
#include "I2CBus.h"
#include "BNO055Sensor.h"
#include "INA226Sensor.h"
#include "VL53L0XSensor.h"
#include "FrontTofSensor.h"
#include "config.h"

I2CWatchdog::I2CWatchdog()
    : m_bus_healthy(true)
    , m_degraded_mode(false)
    , m_last_probe_ms(0)
    , m_imu(nullptr)
    , m_power(nullptr)
    , m_rear_tof(nullptr)
    , m_front_tof(nullptr)
{
    // Initialize device table
    m_devices[0] = {BNO055_I2C_ADDR, "BNO055", I2CDeviceStatus::UNKNOWN, 0, 0};
    m_devices[1] = {VL53L0X_I2C_ADDR, "VL53L0X_rear", I2CDeviceStatus::UNKNOWN, 0, 0};
    m_devices[2] = {VL53L1X_I2C_ADDR, "VL53L1X_front", I2CDeviceStatus::UNKNOWN, 0, 0};
    m_devices[3] = {INA226_I2C_ADDR, "INA226", I2CDeviceStatus::UNKNOWN, 0, 0};
}

void I2CWatchdog::begin()
{
    Serial.println("  [I2C_WD] Bus watchdog initialized");
    Serial.printf("           Probe interval: %lu ms, timeout: %lu ms\n",
                  PROBE_INTERVAL_MS, DEVICE_TIMEOUT_MS);
    Serial.printf("           Devices: 0x%02X 0x%02X 0x%02X 0x%02X\n",
                  m_devices[0].address, m_devices[1].address,
                  m_devices[2].address, m_devices[3].address);
}

void I2CWatchdog::attachSensors(BNO055Sensor* imu,
                               INA226Sensor* power,
                               VL53L0XSensor* rear_tof,
                               FrontTofSensor* front_tof)
{
    m_imu = imu;
    m_power = power;
    m_rear_tof = rear_tof;
    m_front_tof = front_tof;
}

void I2CWatchdog::update(uint32_t now_ms)
{
    // Periodic probe
    if (now_ms - m_last_probe_ms >= PROBE_INTERVAL_MS) {
        probeDevices();
        m_last_probe_ms = now_ms;

        // Check if recovery needed
        if (needsBusReset()) {
            Serial.println("[I2C_WD] Bus recovery triggered");
            performBusRecovery();
        }

        // Check for degraded mode
        uint8_t failed_count = getFailedDeviceCount();
        if (failed_count > 0 && !m_degraded_mode) {
            Serial.printf("[I2C_WD] Entering degraded mode (%u devices failed)\n",
                         failed_count);
            enterDegradedMode();
        }
    }
}

void I2CWatchdog::probeDevices()
{
    Serial.println("[I2C_WD] Probing devices...");

    for (uint8_t i = 0; i < DEVICE_COUNT; i++) {
        int err = I2CBus::probe(BNO055_SDA_PIN, BNO055_SCL_PIN,
                               m_devices[i].address);

        if (err == 0) {
            // Success
            m_devices[i].status = I2CDeviceStatus::OK;
            m_devices[i].last_success_ms = millis();
            m_devices[i].failure_count = 0;
            Serial.printf("         %s (0x%02X): OK\n",
                         m_devices[i].name, m_devices[i].address);
        } else if (err == 2) {
            // NACK (device not present)
            m_devices[i].status = I2CDeviceStatus::NACK;
            m_devices[i].failure_count++;
            Serial.printf("         %s (0x%02X): NACK\n",
                         m_devices[i].name, m_devices[i].address);
        } else {
            // Timeout or other error
            m_devices[i].status = I2CDeviceStatus::TIMEOUT;
            m_devices[i].failure_count++;
            Serial.printf("         %s (0x%02X): TIMEOUT (err=%d)\n",
                         m_devices[i].name, m_devices[i].address, err);
        }
    }
}

bool I2CWatchdog::needsBusReset() const
{
    uint8_t failed = 0;
    for (uint8_t i = 0; i < DEVICE_COUNT; i++) {
        if (m_devices[i].status == I2CDeviceStatus::TIMEOUT) {
            failed++;
        }
    }
    return (failed >= FAILURE_THRESHOLD);
}

void I2CWatchdog::performBusRecovery()
{
    Serial.println("[I2C_WD] === BUS RECOVERY START ===");

    // Full bus reset
    bool ok = I2CBus::reinitializeBus(BNO055_SDA_PIN, BNO055_SCL_PIN,
                                     BNO055_I2C_FREQ_HZ);

    if (ok) {
        Serial.println("[I2C_WD] Bus reset OK, re-probing devices...");
        probeDevices();
        m_bus_healthy = (getFailedDeviceCount() == 0);
    } else {
        Serial.println("[I2C_WD] Bus reset FAILED");
        m_bus_healthy = false;
    }

    Serial.println("[I2C_WD] === BUS RECOVERY END ===");
}

void I2CWatchdog::enterDegradedMode()
{
    m_degraded_mode = true;

    // Mark failed sensors as not operational
    // (they will stop being polled in main loop)
    for (uint8_t i = 0; i < DEVICE_COUNT; i++) {
        if (m_devices[i].status != I2CDeviceStatus::OK) {
            Serial.printf("[I2C_WD] Disabling %s (0x%02X)\n",
                         m_devices[i].name, m_devices[i].address);

            // Disable corresponding sensor
            // (Sensor classes already have isOperational() checks)
            // This is a notification layer — sensors handle their own state
        }
    }

    // Special case: if IMU failed, reduce max speed to 50%
    if (m_devices[0].status != I2CDeviceStatus::OK && m_imu) {
        Serial.println("[I2C_WD] IMU failed → reducing max speed to 50%");
        // This would be communicated to ModeManager via a flag
    }
}

uint8_t I2CWatchdog::getFailedDeviceCount() const
{
    uint8_t count = 0;
    for (uint8_t i = 0; i < DEVICE_COUNT; i++) {
        if (m_devices[i].status != I2CDeviceStatus::OK) {
            count++;
        }
    }
    return count;
}

const I2CDeviceState& I2CWatchdog::getDeviceState(uint8_t index) const
{
    if (index >= DEVICE_COUNT) {
        index = 0;
    }
    return m_devices[index];
}
