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
    , operational_(false), addr_(0x40), last_read_ms_(0)
{
}

bool INA226Sensor::begin(uint8_t address)
{
    addr_ = address;

    // 1. Power-on settle delay — INA226 needs ~1 ms after power-up,
    //    plus a generous margin for shared I2C bus to stabilise.
    delay(50);

    // 2. Probe I2C with bus-idle guard + one controlled recovery retry
    //    on timeout. NACK (device absent) returns immediately — no reset.
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

    // Guard: skip read if bus is busy.  Prevents Wire.endTransmission()
    // from blocking on shared I2C bus with BNO055.
    if (!I2CBus::linesIdle(INA226_SDA_PIN, INA226_SCL_PIN)) {
        // Don't report failure here — let health monitor handle it
        return false;
    }

    float mv = 0.0f, ma = 0.0f, mw = 0.0f;
    uint8_t res = ina226_basic_read(&mv, &ma, &mw);
    if (res != 0) {
        Serial.printf("[INA226] Read err=%u — bus may need recovery\n", res);
        return false;
    }

    // ina226_basic_read returns millivolts and milliamps
    bus_voltage_   = mv / 1000.0f;   // V
    shunt_voltage_ = 0.0f;           // not directly from basic_read
    current_       = ma / 1000.0f;   // A
    power_         = mw / 1000.0f;   // W

    // Sanity check: if bus voltage is essentially zero, the INA226 is not
    // seeing real power (shunt disconnected or VIN+/VIN- reversed).
    // Without this guard, the calibration zero-offset on the current
    // channel shows up as a "ghost" 8 A reading and the battery SOC math
    // divides by 0 → -INF%.  Treat as "sensor present but no load" and
    // report 0/0 until real power is applied.
    if (bus_voltage_ < 0.05f) {
        current_      = 0.0f;
        power_        = 0.0f;
        battery_pct_  = 0.0f;
        battery_status_ = 0;        // unknown / no-load

        // Do not silently present this as a valid empty battery. A zero
        // bus reading means VIN+/VIN- is not measuring the pack (usually
        // shunt terminals disconnected, reversed, or no common ground).
        static uint32_t last_zero_log_ms = 0;
        uint32_t now = millis();
        if (now - last_zero_log_ms >= 5000) {
            last_zero_log_ms = now;
            Serial.printf("[INA226] WARNING: bus voltage=%.3f V — no pack voltage detected; check VIN+→battery+, VIN−→battery−, shunt path and common GND\n",
                          bus_voltage_);
        }
        return true;
    }

    // Battery SOC: 12.6V = 100%, 15V = 0% (user's 3S Li-ion operational range)
    // Formula: pct = (Vfull - V) / (Vfull - Vempty) × 100
    //   At V = 12.6V → (12.6 - 12.6) / (12.6 - 15.0) × 100 = 0 / (-2.4) × 100 = 0% ← WRONG
    // Correct: when V is between VFULL and VEMPTY, the SOC should be:
    //   pct = (1.0 - (V - VFULL) / (VEMPTY - VFULL)) × 100
    //   At 12.6V → 100%, at 15V → 0%
    float range = BATTERY_VOLTAGE_EMPTY - BATTERY_VOLTAGE_FULL;  // 15.0 - 12.6 = 2.4V
    float pct = (1.0f - (bus_voltage_ - BATTERY_VOLTAGE_FULL) / range) * 100.0f;
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
    PiSerial.printf("{\"type\":133,\"data\":{"
                  "\"voltage_v\":%.2f,"
                  "\"current_a\":%.3f,"
                  "\"power_w\":%.3f,"
                  "\"battery_pct\":%.0f,"
                  "\"battery_status\":\"%s\","
                  "\"battery_full_v\":%.1f,"
                  "\"battery_empty_v\":%.1f"
                  "}}\n",
                  bus_voltage_,
                  current_, power_,
                  battery_pct_,
                  battery_status_ == 2 ? "critical" :
                  battery_status_ == 1 ? "low" : "ok",
                  (double)BATTERY_VOLTAGE_FULL,
                  (double)BATTERY_VOLTAGE_EMPTY);
}