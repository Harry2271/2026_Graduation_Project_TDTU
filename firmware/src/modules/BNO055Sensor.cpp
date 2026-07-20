#include "BNO055Sensor.h"
#include "config.h"
#include <Arduino.h>
#include <Wire.h>

extern "C" {
#include "bno055.h"

// I2C transport — implemented in bno055_wire_support.cpp
s8 BNO055_I2C_bus_write(u8 dev_addr, u8 reg_addr, u8 *reg_data, u8 cnt);
s8 BNO055_I2C_bus_read(u8 dev_addr, u8 reg_addr, u8 *reg_data, u8 cnt);
void BNO055_delay_msek(u32 msek);
}

static struct bno055_t gs_bno;
static bool gs_bno_inited = false;

BNO055Sensor::BNO055Sensor()
    : heading_deg_(0.0f), heading_error_deg_(0.0f)
    , target_heading_deg_(0.0f), has_target_(false)
    , linear_accel_x_(0.0f), linear_accel_y_(0.0f)
    , gyro_z_dps_(0.0f)
    , temperature_(0)
    , cal_sys_(0), cal_gyro_(0), cal_accel_(0), cal_mag_(0)
    , operational_(false), addr_(0x28), last_read_ms_(0)
{
}

// ------------------------------------------------------------------
// Helper: probe a single I2C address — returns true if ACK received
// ------------------------------------------------------------------
static bool i2c_probe(uint8_t addr)
{
    Wire.beginTransmission(addr);
    return (Wire.endTransmission() == 0);
}

// ------------------------------------------------------------------
// Helper: hard-reset the I2C bus (toggles SDA/SCL 9 times)
// ------------------------------------------------------------------
static void i2c_bus_reset(uint8_t sda, uint8_t scl)
{
    // If any slave holds SDA low, clock it out
    pinMode(scl, OUTPUT_OPEN_DRAIN);
    pinMode(sda, OUTPUT_OPEN_DRAIN);
    for (int i = 0; i < 9; i++) {
        digitalWrite(scl, HIGH);
        delayMicroseconds(5);
        digitalWrite(scl, LOW);
        delayMicroseconds(5);
    }
    // Release SDA high (idle)
    digitalWrite(sda, HIGH);
    digitalWrite(scl, HIGH);
    delay(5);
}

bool BNO055Sensor::begin(uint8_t address)
{
    addr_ = address;
    gs_bno_inited = false;
    operational_ = false;

    // ================================================================
    // 1. Wait for BNO055 to fully boot after power-on.
    //    Datasheet: VDD power-up → chip ready takes ~1 s.
    // ================================================================
    Serial.println("[BNO055] Waiting for power-up (500 ms)...");
    delay(500);

    // ================================================================
    // 2. Hard-reset I2C bus in case a previous crashed transfer
    //    left SDA held low (common after ESP32 reset without BNO055 reset).
    // ================================================================
    i2c_bus_reset(BNO055_SDA_PIN, BNO055_SCL_PIN);

    // ================================================================
    // 3. Re-init Wire (ensure SDA/SCL are correctly configured after
    //    bus reset toggled the pins).
    // ================================================================
    Wire.end();
    Wire.begin(BNO055_SDA_PIN, BNO055_SCL_PIN);
    Wire.setClock(BNO055_I2C_FREQ_HZ);
    delay(50);

    // ================================================================
    // 4. Scan I2C bus to find BNO055 (try 0x28 first, then 0x29).
    //    The address depends on the SDO/ADR pin: LOW = 0x28, HIGH = 0x29.
    // ================================================================
    bool found = false;
    const uint8_t addrs[] = {0x28, 0x29};

    Serial.print("[BNO055] I2C scan: ");
    for (uint8_t a : addrs) {
        if (i2c_probe(a)) {
            Serial.printf("0x%02X FOUND ", a);
            addr_ = a;
            found = true;
            break;
        } else {
            Serial.printf("0x%02X -- ", a);
        }
    }

    // Also scan all 127 addresses for debugging
    if (!found) {
        Serial.println("\n[BNO055] Full I2C scan:");
        int count = 0;
        for (uint8_t a = 1; a < 127; a++) {
            if (i2c_probe(a)) {
                Serial.printf("  addr 0x%02X ACK\n", a);
                count++;
            }
        }
        Serial.printf("[BNO055] Found %d device(s) on I2C bus\n", count);
        if (count == 0) {
            Serial.println("[BNO055] NO DEVICES — check SDA/SCL wiring + power");
        }
        Serial.println("[BNO055] Init FAILED — no BNO055 found");
        return false;
    }
    Serial.printf("\n[BNO055] Device found at 0x%02X\n", addr_);

    // ================================================================
    // 5. Wait additional time after probe — the BNO055 may still be
    //    in its internal boot sequence.  Some clones take up to 1.2 s.
    // ================================================================
    delay(750);

    // ================================================================
    // 6. Set up Bosch bno055 driver I2C function pointers
    // ================================================================
    gs_bno.bus_write   = BNO055_I2C_bus_write;
    gs_bno.bus_read    = BNO055_I2C_bus_read;
    gs_bno.delay_msec  = BNO055_delay_msek;
    gs_bno.dev_addr    = addr_;

    // ================================================================
    // 7. Initialise the Bosch driver (reads chip ID, rev IDs, etc.)
    // ================================================================
    s8 res = bno055_init(&gs_bno);
    if (res != BNO055_SUCCESS) {
        Serial.printf("[BNO055] bno055_init returned %d — retrying...\n", res);
        delay(500);
        res = bno055_init(&gs_bno);
        if (res != BNO055_SUCCESS) {
            Serial.printf("[BNO055] bno055_init FAILED after retry (%d)\n", res);
            return false;
        }
    }

    // ================================================================
    // 8. Verify chip ID (must be 0xA0 for BNO055)
    // ================================================================
    u8 chip_id = 0;
    bno055_read_chip_id(&chip_id);
    Serial.printf("[BNO055] Chip ID: 0x%02X (expected 0xA0)\n", chip_id);
    if (chip_id != 0xA0) {
        Serial.printf("[BNO055] Bad chip ID — not a real BNO055?\n");
        return false;
    }

    // ================================================================
    // 9. Switch to CONFIG mode (required before changing power/clk)
    //    Must succeed before any further configuration.
    // ================================================================
    int config_attempts = 0;
    while (config_attempts < 5) {
        bno055_set_operation_mode(BNO055_OPERATION_MODE_CONFIG);
        delay(30);  // datasheet min 19 ms, we use 30 ms for safety

        // Verify we're in CONFIG mode
        u8 mode = 0;
        bno055_get_operation_mode(&mode);
        if (mode == BNO055_OPERATION_MODE_CONFIG) {
            Serial.printf("[BNO055] CONFIG mode OK (attempt %d)\n", config_attempts + 1);
            break;
        }
        config_attempts++;
        Serial.printf("[BNO055] CONFIG mode switch attempt %d failed (mode=0x%02X)\n",
            config_attempts, mode);
        delay(100);
    }
    if (config_attempts >= 5) {
        Serial.println("[BNO055] Could not enter CONFIG mode");
        return false;
    }

    // ================================================================
    // 10. Set power mode to NORMAL
    // ================================================================
    bno055_set_power_mode(BNO055_POWER_MODE_NORMAL);
    delay(10);

    // ================================================================
    // 11. Set clock source to external oscillator (bit 7 of SYS_TRIGGER)
    //     Some boards need this, some don't — try but don't fail.
    // ================================================================
    u8 clk = 1;
    s8 clk_res = bno055_set_clk_src(clk);
    if (clk_res != BNO055_SUCCESS) {
        Serial.println("[BNO055] set_clk_src failed — using internal oscillator");
    }
    delay(10);

    // ================================================================
    // 12. Use degrees, m/s², °/s, Celsius (all zeros in unit sel reg)
    //     Defaults are already correct — no write needed.
    // ================================================================

    // ================================================================
    // 13. Enter NDOF fusion mode (absolute orientation, all 9 axes)
    //     This can take up to 600 ms to stabilise.
    // ================================================================
    bno055_set_operation_mode(BNO055_OPERATION_MODE_NDOF);
    delay(700);  // give fusion time to start

    // Verify NDOF mode
    u8 final_mode = 0;
    bno055_get_operation_mode(&final_mode);
    if (final_mode != BNO055_OPERATION_MODE_NDOF) {
        Serial.printf("[BNO055] NDOF mode verify failed (mode=0x%02X)\n", final_mode);
        return false;
    }

    gs_bno_inited = true;
    operational_ = true;
    Serial.printf("[BNO055] Ready — NDOF mode, addr 0x%02X\n", addr_);
    return true;
}

bool BNO055Sensor::read()
{
    if (!operational_ || !gs_bno_inited) return false;
    last_read_ms_ = millis();

    // --- Euler angles (degrees) ---
    double euler_h = 0.0, euler_r = 0.0, euler_p = 0.0;
    bno055_convert_double_euler_h_deg(&euler_h);
    bno055_convert_double_euler_r_deg(&euler_r);
    bno055_convert_double_euler_p_deg(&euler_p);

    float heading = (float)euler_h;
    if (heading < 0.0f)  heading += 360.0f;
    if (heading >= 360.0f) heading -= 360.0f;
    heading_deg_ = heading;

    // --- Heading error: target − current, normalised to ±180° ---
    if (has_target_) {
        float err = target_heading_deg_ - heading_deg_;
        // Normalise to (-180, 180]
        if (err > 180.0f)  err -= 360.0f;
        if (err <= -180.0f) err += 360.0f;
        heading_error_deg_ = err;
    } else {
        heading_error_deg_ = 0.0f;
    }

    // --- Linear acceleration (m/s²) ---
    double la_x = 0.0, la_y = 0.0;
    bno055_convert_double_linear_accel_x_msq(&la_x);
    bno055_convert_double_linear_accel_y_msq(&la_y);
    linear_accel_x_ = (float)la_x;
    linear_accel_y_ = (float)la_y;

    // --- Gyro Z (°/s) ---
    double gz = 0.0;
    bno055_convert_double_gyro_z_dps(&gz);
    gyro_z_dps_ = (float)gz;

    // --- Temperature (°C) ---
    s8 temp_raw = 0;
    bno055_read_temp_data(&temp_raw);
    temperature_ = temp_raw;

    // --- Calibration ---
    u8 cs = 0, cg = 0, ca = 0, cm = 0;
    bno055_get_sys_calib_stat(&cs);
    bno055_get_gyro_calib_stat(&cg);
    bno055_get_accel_calib_stat(&ca);
    bno055_get_mag_calib_stat(&cm);
    cal_sys_   = cs;
    cal_gyro_  = cg;
    cal_accel_ = ca;
    cal_mag_   = cm;

    return true;
}

float BNO055Sensor::getHeadingRad() const
{
    return heading_deg_ * DEG_TO_RAD;
}

void BNO055Sensor::setTargetHeading(float target_deg)
{
    target_heading_deg_ = target_deg;
    has_target_ = true;
}

void BNO055Sensor::printTelemetry() const
{
    Serial.printf("{\"type\":134,\"data\":{"
                  "\"heading\":%.2f,"
                  "\"heading_error\":%.2f,"
                  "\"linear_accel_x\":%.2f,"
                  "\"linear_accel_y\":%.2f,"
                  "\"gyro_z\":%.2f,"
                  "\"temp\":%d,"
                  "\"cal\":{\"sys\":%u,\"gyro\":%u,\"accel\":%u,\"mag\":%u}"
                  "}}\n",
                  heading_deg_, heading_error_deg_,
                  linear_accel_x_, linear_accel_y_,
                  gyro_z_dps_,
                  temperature_,
                  cal_sys_, cal_gyro_, cal_accel_, cal_mag_);
}

void BNO055Sensor::printReadable() const
{
    Serial.printf("Heading: (%.2f deg)\n", heading_deg_);
    Serial.printf("Heading Error: (%.2f deg)\n", heading_error_deg_);
    Serial.printf("Linear Accel X: (%.2f m/s2)\n", linear_accel_x_);
    Serial.printf("Linear Accel Y: (%.2f m/s2)\n", linear_accel_y_);
    Serial.printf("Gyro Z: (%.2f deg/s)\n", gyro_z_dps_);
    Serial.printf("Temp: %d C\n", temperature_);
    Serial.printf("Cal: sys=%u gyro=%u accel=%u mag=%u\n",
                  cal_sys_, cal_gyro_, cal_accel_, cal_mag_);
}
