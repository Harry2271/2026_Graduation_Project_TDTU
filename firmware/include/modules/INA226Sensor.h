#pragma once

#include <stdint.h>

/**
 * INA226 — High-Side Current / Voltage / Power Monitor
 *
 * Default I2C address is 0x40 (A0 = A1 = GND).
 * The CJMCU-226 breakout has solder-pad options:
 *   0x40 (default), 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47
 */
#define INA226_I2C_ADDR_DEFAULT  0x40

// Configuration register value for continuous averaging
// AVG=4 samples (0001) | VBUSCT=2.048ms (011) | VSHCT=2.048ms (011) | Mode=cont shunt+bus (111)
#define INA226_CONF_CONTINUOUS  0x016F

class INA226Sensor {
public:
    INA226Sensor();

    /// Initialize I2C and verify device ID.
    bool begin(uint8_t address = INA226_I2C_ADDR_DEFAULT);

    /// Read voltage, current, and power registers.
    bool read();

    // --- Accessors (from last read()) ---
    float getBusVoltage()   const { return bus_voltage_; }    // V
    float getShuntVoltage() const { return shunt_voltage_; }  // mV
    float getCurrent()      const { return current_; }        // A
    float getPower()        const { return power_; }          // W
    uint16_t getBusMillivolts() const { return bus_mv_; }
    int16_t  getShuntMicrovolts() const { return shunt_uv_; }

    /// Battery state-of-charge (0-100 %) via voltage lookup
    float getBatteryPct()     const { return battery_pct_; }
    uint8_t getBatteryStatus() const { return battery_status_; } // 0=ok, 1=low, 2=critical

    /// Print JSON telemetry (type 133 — battery/system power).
    void printTelemetry() const;

    bool isOperational() const { return operational_; }
    uint32_t getLastReadMs() const { return last_read_ms_; }

    // Diagnostics: readable raw registers
    uint16_t readRegRaw(uint8_t reg);

private:
    uint16_t readRegister(uint8_t reg);
    bool writeRegister(uint8_t reg, uint16_t val);
    static float voltageToSoc(float voltage_v);

    float bus_voltage_;     // V
    float shunt_voltage_;   // mV
    float current_;         // A
    float power_;           // W
    uint16_t bus_mv_;       // raw bus voltage in mV
    int16_t  shunt_uv_;     // raw shunt voltage in µV

    float battery_pct_;     // 0-100 %
    uint8_t battery_status_; // 0=ok, 1=low, 2=critical

    bool operational_;
    uint8_t addr_;
    uint32_t last_read_ms_;

    static constexpr float SHUNT_RESISTOR = 0.01f;   // 10 mΩ
    // Current_LSB = MaxExpectedCurrent / 32767
    // With max ~16 A range: LSB = 16.384 / 32767 ≈ 0.5 mA
    static constexpr float CURRENT_LSB    = 0.5e-3f;  // 0.5 mA per bit
    // Power_LSB = 25 × Current_LSB (INA226 datasheet formula)
    static constexpr float POWER_LSB      = 12.5e-3f; // 12.5 mW per bit
}; 