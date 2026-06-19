#include "INA226Sensor.h"
#include "config.h"
#include <Arduino.h>
#include <Wire.h>

// INA226 register map
#define REG_CONFIG        0x00
#define REG_SHUNT_VOLTAGE 0x01
#define REG_BUS_VOLTAGE   0x02
#define REG_POWER         0x03
#define REG_CURRENT       0x04
#define REG_CALIBRATION   0x05
#define REG_MASK_ENABLE   0x06
#define REG_ALERT_LIMIT   0x07
#define REG_DIE_ID        0xFF

// Calibration register value for 10 mΩ shunt, 0.5 mA/LSB current
// CAL = 0.00512 / (CURRENT_LSB * R_SHUNT) = 0.00512 / (0.5e-3 * 0.01) = 1024
#define INA226_CAL_VAL    1024

static const char* TAG = "[INA226]";

INA226Sensor::INA226Sensor()
    : bus_voltage_(0.0f), shunt_voltage_(0.0f)
    , current_(0.0f), power_(0.0f)
    , bus_mv_(0), shunt_uv_(0)
    , battery_pct_(0.0f), battery_status_(0)
    , operational_(false), addr_(INA226_I2C_ADDR_DEFAULT), last_read_ms_(0)
{
}

bool INA226Sensor::begin(uint8_t address)
{
    addr_ = address;

    Wire.beginTransmission(addr_);
    if (Wire.endTransmission() != 0) {
        Serial.printf("%s No device found at 0x%02X\n", TAG, addr_);
        return false;
    }

    // Verify die ID (should be 0x2260)
    uint16_t die_id = readRegRaw(REG_DIE_ID);
    if ((die_id & 0xFFF0) != 0x2260) {
        Serial.printf("%s Unexpected die ID: 0x%04X (expected 0x226X)\n", TAG, die_id);
        // Not fatal — some clones don't implement the die ID register
    }

    // Configure: continuous shunt+bus, average 4, 2.048 ms conv time
    if (!writeRegister(REG_CONFIG, INA226_CONF_CONTINUOUS)) {
        Serial.printf("%s Failed to write config\n", TAG);
        return false;
    }
    delay(5);

    // Set calibration (needed for current and power readings)
    if (!writeRegister(REG_CALIBRATION, INA226_CAL_VAL)) {
        Serial.printf("%s Failed to write calibration\n", TAG);
        return false;
    }
    delay(5);

    operational_ = true;
    Serial.printf("%s Ready at 0x%02X | shunt=%.0fmΩ | Cal=0x%04X\n",
                  TAG, addr_, SHUNT_RESISTOR * 1000.0f, INA226_CAL_VAL);
    return true;
}

bool INA226Sensor::read()
{
    if (!operational_) return false;
    last_read_ms_ = millis();

    // Shunt voltage (raw: signed µV)
    shunt_uv_ = (int16_t)readRegister(REG_SHUNT_VOLTAGE);
    shunt_voltage_ = shunt_uv_ / 1000.0f;  // mV

    // Bus voltage (raw: 0.00125 V per LSB, shifted by 0x00 → 0x7FF8)
    uint16_t bus_raw = readRegister(REG_BUS_VOLTAGE);
    bus_mv_ = bus_raw >> 3;                           // upper 13 bits
    bus_voltage_ = bus_mv_ * 0.00125f;              // V

    // Current (raw: CURRENT_LSB A per bit)
    int16_t cur_raw = (int16_t)readRegister(REG_CURRENT);
    current_ = cur_raw * CURRENT_LSB;               // A

    // Power (raw: POWER_LSB W per bit)
    uint16_t pwr_raw = readRegister(REG_POWER);
    power_ = pwr_raw * POWER_LSB;                   // W

    // Battery SOC from bus voltage
    battery_pct_ = voltageToSoc(bus_voltage_);
    if (battery_pct_ <= BATTERY_CRITICAL_PCT)      battery_status_ = 2;
    else if (battery_pct_ <= BATTERY_LOW_WARN_PCT)  battery_status_ = 1;
    else                                            battery_status_ = 0;

    return true;
}

// ------------------------------------------------------------------
// Battery SOC — 3S Li-ion voltage lookup (piecewise linear)
// ------------------------------------------------------------------
// Cell voltage breakpoints (V) → SOC pairs
// Based on typical 18650 discharge curve under moderate load
static const float SOC_TABLE[][2] = {
    // {voltage_per_cell, soc_percent}
    { 4.20f, 100.0f },
    { 4.03f,  80.0f },
    { 3.86f,  60.0f },
    { 3.83f,  40.0f },
    { 3.79f,  20.0f },
    { 3.70f,  10.0f },
    { 3.30f,   5.0f },
    { 3.00f,   0.0f },
};
static const int SOC_TABLE_SIZE = sizeof(SOC_TABLE) / sizeof(SOC_TABLE[0]);

float INA226Sensor::voltageToSoc(float voltage_v)
{
    // 3S pack: divide by 3 to get per-cell voltage
    float cell_v = voltage_v / 3.0f;

    if (cell_v >= SOC_TABLE[0][0]) return SOC_TABLE[0][1];  // fully charged
    if (cell_v <= SOC_TABLE[SOC_TABLE_SIZE - 1][0]) return SOC_TABLE[SOC_TABLE_SIZE - 1][1];  // empty

    // Linear interpolation between breakpoints
    for (int i = 0; i < SOC_TABLE_SIZE - 1; i++) {
        float v_hi = SOC_TABLE[i][0];
        float v_lo = SOC_TABLE[i + 1][0];
        if (cell_v >= v_lo) {
            float soc_hi = SOC_TABLE[i][1];
            float soc_lo = SOC_TABLE[i + 1][1];
            float t = (cell_v - v_lo) / (v_hi - v_lo);
            return soc_lo + t * (soc_hi - soc_lo);
        }
    }
    return 0.0f;
}

void INA226Sensor::printTelemetry() const
{
    Serial.printf("{\"type\":133,\"data\":{"
                  "\"bus_v\":%.3f,\"shunt_mv\":%.2f,"
                  "\"current_a\":%.3f,\"power_w\":%.3f,"
                  "\"battery_pct\":%.1f,\"battery_status\":\"%s\""
                  "}}\n",
                  bus_voltage_, shunt_voltage_,
                  current_, power_,
                  battery_pct_,
                  battery_status_ == 2 ? "critical" :
                  battery_status_ == 1 ? "low" : "ok");
}

// ------------------------------------------------------------------
// Raw register access (public)
// ------------------------------------------------------------------

uint16_t INA226Sensor::readRegRaw(uint8_t reg)
{
    return readRegister(reg);
}

// ------------------------------------------------------------------
// Private I2C helpers
// ------------------------------------------------------------------

uint16_t INA226Sensor::readRegister(uint8_t reg)
{
    Wire.beginTransmission(addr_);
    Wire.write(reg);
    if (Wire.endTransmission(false) != 0) return 0;

    uint8_t n = Wire.requestFrom(addr_, (uint8_t)2);
    if (n < 2) return 0;

    uint16_t val = ((uint16_t)Wire.read() << 8) | Wire.read();
    return val;
}

bool INA226Sensor::writeRegister(uint8_t reg, uint16_t val)
{
    Wire.beginTransmission(addr_);
    Wire.write(reg);
    Wire.write((uint8_t)(val >> 8));
    Wire.write((uint8_t)(val & 0xFF));
    return Wire.endTransmission() == 0;
}
