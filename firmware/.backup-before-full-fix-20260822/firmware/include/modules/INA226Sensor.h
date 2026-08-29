#pragma once

#include <stdint.h>

/**
 * INA226 — Voltage/Current/Power Monitor via LibDriver
 *
 * Measures pack voltage directly from M21-B4055A pack (VIN+ → + pack, VIN- → GND).
 * Battery SOC: 20.5V = 100%, 14.0V = 0% (pack under-load limit).
 * Also reports current (A) and power (W) through the shunt resistor.
 */

class INA226Sensor {
public:
    INA226Sensor();

    /// Initialize INA226 via LibDriver basic API.
    bool begin(uint8_t address = 0x40);

    /// Read bus voltage, current, and power. Recomputes battery %.
    bool read();

    // --- Accessors ---
    float getBusVoltage()    const { return bus_voltage_; }     // V
    float getCurrent()       const { return current_; }         // A
    float getPower()         const { return power_; }           // W
    float getBatteryPct()    const { return battery_pct_; }     // 0-100 %
    uint8_t getBatteryStatus() const { return battery_status_; } // 0=ok, 1=low, 2=critical, 3=unknown/no-load

    /// True when the sensor reports ~0V (shunt disconnected / not wired).
    bool isNoLoad() const { return noload_; }

    /// Print JSON telemetry (type 133).
    void printTelemetry() const;

    bool isOperational() const { return operational_; }
    uint32_t getLastReadMs() const { return last_read_ms_; }

private:
    float bus_voltage_;    // V
    float shunt_voltage_;  // mV
    float current_;        // A
    float power_;          // W
    float battery_pct_;    // 0-100 %
    uint8_t battery_status_;
    bool operational_;
    bool noload_;          // true when shunt disconnected (voltage ≈ 0)
    uint8_t addr_;
    uint32_t last_read_ms_;
};