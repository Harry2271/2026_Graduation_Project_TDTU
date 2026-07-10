#include "INA226Sensor.h"
#include "config.h"
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
    , operational_(false), addr_(0x40), last_read_ms_(0)
{
}

bool INA226Sensor::begin(uint8_t address)
{
    addr_ = address;

    // 1. Power-on settle delay — INA226 needs ~1 ms after power-up,
    //    plus a generous margin for shared I2C bus to stabilise.
    delay(50);

    // 2. Probe I2C first — gives a clear "device missing" message
    //    instead of a cryptic LibDriver init error code.
    Wire.beginTransmission(addr_);
    if (Wire.endTransmission() != 0) {
        Serial.printf("[INA226] No device at 0x%02X\n", address);
        Serial.println("[INA226] Check: SDA/SCL wiring, 3.3V power, address jumper (A0/A1)");
        return false;
    }
    Serial.printf("[INA226] Device ACK at 0x%02X\n", address);

    // 3. Map 7-bit address to the LibDriver enum.
    //    LibDriver enum values are left-shifted: INA226_ADDRESS_0 = 0x40 << 1 = 0x80.
    ina226_address_t addr_pin = INA226_ADDRESS_0;  // default: 0x40
    switch (address & 0x07) {
        case 0x00: addr_pin = INA226_ADDRESS_0; break;
        case 0x01: addr_pin = INA226_ADDRESS_1; break;
        case 0x02: addr_pin = INA226_ADDRESS_2; break;
        case 0x03: addr_pin = INA226_ADDRESS_3; break;
        case 0x04: addr_pin = INA226_ADDRESS_4; break;
        case 0x05: addr_pin = INA226_ADDRESS_5; break;
        default:   addr_pin = INA226_ADDRESS_0; break;
    }

    // LibDriver expects shunt resistance in ohms (double).
    double r = 0.010;  // 10 mΩ on CJMCU-226

    uint8_t res = ina226_basic_init(addr_pin, r);
    if (res != 0) {
        Serial.printf("[INA226] LibDriver init failed (err=%u)\n", res);
        return false;
    }

    // 4. Sanity read — try to read bus voltage once
    float v = 0.0f, i_ = 0.0f, p = 0.0f;
    uint8_t rres = ina226_basic_read(&v, &i_, &p);
    if (rres != 0) {
        Serial.printf("[INA226] First read failed (err=%u)\n", rres);
        return false;
    }

    operational_ = true;
    Serial.printf("[INA226] Ready at 0x%02X | shunt=10mR | V=%.3f\n", address, v / 1000.0f);
    return true;
}

bool INA226Sensor::read()
{
    if (!operational_) return false;
    last_read_ms_ = millis();

    float mv = 0.0f, ma = 0.0f, mw = 0.0f;
    uint8_t res = ina226_basic_read(&mv, &ma, &mw);
    if (res != 0) {
        Serial.println("[INA226] Read failed");
        return false;
    }

    // ina226_basic_read returns millivolts and milliamps
    bus_voltage_   = mv / 1000.0f;   // V
    shunt_voltage_ = 0.0f;           // not directly from basic_read
    current_       = ma / 1000.0f;   // A
    power_         = mw / 1000.0f;   // W

    // Battery SOC: linear interpolation over 3S Li-ion range
    // Empty = 9.0V (3.0V/cell), Full = 12.6V (4.2V/cell)
    float pct = (bus_voltage_ - BATTERY_VOLTAGE_EMPTY) /
                (BATTERY_VOLTAGE_FULL - BATTERY_VOLTAGE_EMPTY) * 100.0f;
    if (pct < 0.0f)   pct = 0.0f;
    if (pct > 100.0f) pct = 100.0f;
    battery_pct_ = pct;

    if (battery_pct_ <= (float)BATTERY_CRITICAL_PCT)      battery_status_ = 2;  // critical
    else if (battery_pct_ <= (float)BATTERY_LOW_WARN_PCT) battery_status_ = 1;  // low
    else                                                    battery_status_ = 0;  // ok

    return true;
}

void INA226Sensor::printTelemetry() const
{
    Serial.printf("{\"type\":133,\"data\":{"
                  "\"bus_v\":%.3f,"
                  "\"current_a\":%.3f,"
                  "\"power_w\":%.3f,"
                  "\"battery_pct\":%.1f,"
                  "\"battery_status\":\"%s\""
                  "}}\n",
                  bus_voltage_,
                  current_, power_,
                  battery_pct_,
                  battery_status_ == 2 ? "critical" :
                  battery_status_ == 1 ? "low" : "ok");
}