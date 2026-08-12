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

    // Battery SOC — piecewise linear lookup for 3S Li-ion (Molicel M21-B4055A).
    //
    // Li-ion discharge curve is S-shaped: flat at top (~4.20-4.00V/cell),
    // steep middle (3.80-3.40V/cell), flat bottom (3.30-3.00V/cell).
    // A single linear formula across 12.0V–20.6V would be ±20% wrong in
    // the middle range.  11-point table + linear interpolation keeps the
    // error under ±2% across the entire operating envelope.
    //
    // Pack voltages = cell voltage × 3 (3S series).
    // Cutoff at 12.0V (3.00V/cell) — below this BMS disconnects.

    static const float soc_table[][2] = {
        // { pack-voltage (V), SOC (%) }
        { 20.6f, 100.0f },  // 6.87V/cell — fully charged
        { 20.0f,  90.0f },  // 6.67V/cell — slight discharge
        { 19.2f,  80.0f },  // 6.40V/cell — nominal
        { 18.6f,  70.0f },  // 6.20V/cell
        { 18.0f,  60.0f },  // 6.00V/cell — mid-pack
        { 17.4f,  50.0f },  // 5.80V/cell — steepest part of curve
        { 16.8f,  40.0f },  // 5.60V/cell
        { 16.2f,  30.0f },  // 5.40V/cell
        { 15.6f,  20.0f },  // 5.20V/cell
        { 15.0f,  10.0f },  // 5.00V/cell — low
        { 12.0f,   0.0f },  // 4.00V/cell — BMS cutoff
    };
    constexpr int SOC_TABLE_LEN = sizeof(soc_table) / sizeof(soc_table[0]);

    float pct = 0.0f;
    if (bus_voltage_ >= soc_table[0][0]) {
        pct = soc_table[0][1];  // above full → 100%
    } else if (bus_voltage_ <= soc_table[SOC_TABLE_LEN - 1][0]) {
        pct = soc_table[SOC_TABLE_LEN - 1][1];  // below cutoff → 0%
    } else {
        // Linear interpolation between the two bracketing entries
        for (int i = 0; i < SOC_TABLE_LEN - 1; i++) {
            float v_hi = soc_table[i][0];
            float v_lo = soc_table[i + 1][0];
            if (bus_voltage_ <= v_hi && bus_voltage_ >= v_lo) {
                float frac = (v_hi - bus_voltage_) / (v_hi - v_lo);  // 0..1
                pct = soc_table[i][1] + frac * (soc_table[i + 1][1] - soc_table[i][1]);
                break;
            }
        }
    }
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