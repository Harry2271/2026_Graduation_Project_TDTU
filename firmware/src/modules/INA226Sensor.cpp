#include "INA226Sensor.h"
#include "config.h"
#include "I2CBus.h"
#include <Arduino.h>
#include <Wire.h>

extern "C" {
#include "driver_ina226.h"
#include "driver_ina226_basic.h"
}

INA226Sensor::INA226Sensor()
    : bus_voltage_(0.0f), shunt_voltage_(0.0f)
    , current_(0.0f), power_(0.0f)
    , battery_pct_(0.0f), battery_status_(0)
    , operational_(false), noload_(true), addr_(0x40), last_read_ms_(0)
{
}

bool INA226Sensor::begin(uint8_t address)
{
    // A failed reinitialization must never leave the previous healthy state
    // visible to safety/telemetry code.
    operational_ = false;
    addr_ = address;
    delay(50);

    int probe_err = I2CBus::probeWithRecovery(INA226_SDA_PIN, INA226_SCL_PIN,
                                               address, INA226_I2C_FREQ_HZ);
    if (probe_err != 0) {
        Serial.printf("[INA226] No device at 0x%02X (%s)\n",
                      address, I2CBus::errorName(probe_err));
        Serial.println("[INA226] Check: SDA/SCL wiring, 3.3V power, address jumper (A0/A1)");
        Serial.println("[INA226] Add 4.7kΩ pull-ups on SDA and SCL to 3.3V");
        return false;
    }
    Serial.printf("[INA226] Device ACK at 0x%02X\n", address);

    ina226_address_t addr_pin = INA226_ADDRESS_0;
    switch (address & 0x07) {
        case 0x00: addr_pin = INA226_ADDRESS_0; break;
        case 0x01: addr_pin = INA226_ADDRESS_1; break;
        case 0x02: addr_pin = INA226_ADDRESS_2; break;
        case 0x03: addr_pin = INA226_ADDRESS_3; break;
        case 0x04: addr_pin = INA226_ADDRESS_4; break;
        case 0x05: addr_pin = INA226_ADDRESS_5; break;
        default:   addr_pin = INA226_ADDRESS_0; break;
    }

    uint8_t res = ina226_basic_init(addr_pin, 0.010);
    if (res != 0) {
        Serial.printf("[INA226] LibDriver init failed (err=%u)\n", res);
        return false;
    }

    float v = 0.0f, i_ = 0.0f, p = 0.0f;
    uint8_t rres = ina226_basic_read(&v, &i_, &p);
    if (rres != 0) {
        Serial.printf("[INA226] First read failed (err=%u)\n", rres);
        return false;
    }

    operational_ = true;
    noload_ = (v < 0.05f);
    Serial.printf("[INA226] Ready at 0x%02X | shunt=10mR | V=%.3f\n", address, v / 1000.0f);
    return true;
}

bool INA226Sensor::read()
{
    if (!operational_) return false;
    last_read_ms_ = millis();

    if (!I2CBus::linesIdle(INA226_SDA_PIN, INA226_SCL_PIN)) return false;

    float mv = 0.0f, ma = 0.0f, mw = 0.0f;
    uint8_t res = ina226_basic_read(&mv, &ma, &mw);
    if (res != 0) {
        Serial.printf("[INA226] Read err=%u — bus may need recovery\n", res);
        return false;
    }

    bus_voltage_   = mv / 1000.0f;
    shunt_voltage_ = 0.0f;
    current_       = ma / 1000.0f;
    power_         = mw / 1000.0f;

    // Zero voltage means the INA226 is not connected to the pack. Do not
    // expose this as an empty battery, and do not use stale current/power.
    if (bus_voltage_ < 0.05f) {
        current_ = 0.0f;
        power_ = 0.0f;
        battery_pct_ = 0.0f;
        battery_status_ = 3;  // unknown / no-load
        noload_ = true;

        static uint32_t last_zero_log_ms = 0;
        uint32_t now = millis();
        if (now - last_zero_log_ms >= 5000) {
            last_zero_log_ms = now;
            Serial.printf("[INA226] WARNING: bus voltage=%.3f V — no pack voltage detected; check VIN+→battery+, VIN−→battery−, shunt path and common GND\n",
                          bus_voltage_);
        }
        return true;
    }

    // Recover automatically when the pack is connected after boot or after
    // a bench test. The next code block recalculates SOC immediately.
    if (noload_ && bus_voltage_ > 1.0f) {
        noload_ = false;
        Serial.printf("[INA226] Pack voltage detected (%.2f V) — SOC recalculation enabled\n",
                      bus_voltage_);
    } else if (bus_voltage_ > 0.5f) {
        noload_ = false;
    }

    // Piecewise linear lookup for the pack. A single linear formula is
    // inaccurate because the Li-ion discharge curve is not linear. Keep the
    // configured endpoints in this table so telemetry and SOC limits agree.
    static const float soc_table[][2] = {
        { BATTERY_VOLTAGE_FULL, 100.0f }, { 20.0f, 90.0f },
        { 19.2f, 80.0f }, { 18.6f, 70.0f }, { 18.0f, 60.0f },
        { 17.4f, 50.0f }, { 16.8f, 40.0f }, { 16.2f, 30.0f },
        { 15.6f, 20.0f }, { 14.8f, 10.0f },
        { BATTERY_VOLTAGE_EMPTY, 0.0f },
    };
    constexpr int SOC_TABLE_LEN = sizeof(soc_table) / sizeof(soc_table[0]);

    float pct = 0.0f;
    if (bus_voltage_ >= soc_table[0][0]) {
        pct = soc_table[0][1];
    } else if (bus_voltage_ <= soc_table[SOC_TABLE_LEN - 1][0]) {
        pct = soc_table[SOC_TABLE_LEN - 1][1];
    } else {
        for (int i = 0; i < SOC_TABLE_LEN - 1; i++) {
            float v_hi = soc_table[i][0];
            float v_lo = soc_table[i + 1][0];
            if (bus_voltage_ <= v_hi && bus_voltage_ >= v_lo) {
                float frac = (v_hi - bus_voltage_) / (v_hi - v_lo);
                pct = soc_table[i][1] + frac * (soc_table[i + 1][1] - soc_table[i][1]);
                break;
            }
        }
    }
    if (pct < 0.0f) pct = 0.0f;
    if (pct > 100.0f) pct = 100.0f;
    battery_pct_ = pct;

    if (battery_pct_ <= (float)BATTERY_CRITICAL_PCT)      battery_status_ = 2;
    else if (battery_pct_ <= (float)BATTERY_LOW_WARN_PCT) battery_status_ = 1;
    else                                                   battery_status_ = 0;

    return true;
}

void INA226Sensor::printTelemetry() const
{
    const char* status = noload_ ? "unknown" :
                         battery_status_ == 2 ? "critical" :
                         battery_status_ == 1 ? "low" : "ok";
    PiSerial.printf("{\"type\":133,\"data\":{"
                  "\"voltage_v\":%.2f,"
                  "\"current_a\":%.3f,"
                  "\"power_w\":%.3f,"
                  "\"battery_pct\":%.0f,"
                  "\"battery_status\":\"%s\","
                  "\"noload\":%s,"
                  "\"battery_full_v\":%.1f,"
                  "\"battery_empty_v\":%.1f"
                  "}}\n",
                  bus_voltage_, current_, power_, battery_pct_, status,
                  noload_ ? "true" : "false",
                  (double)BATTERY_VOLTAGE_FULL,
                  (double)BATTERY_VOLTAGE_EMPTY);
}
