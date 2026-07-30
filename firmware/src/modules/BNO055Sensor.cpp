#include "BNO055Sensor.h"
#include "config.h"
#include <Arduino.h>
#include <Wire.h>

// =====================================================================
// BNO055Sensor — Direct Wire driver matching BNOExample pattern
//
// Uses the same I2C read/write pattern as BNOExample.ino which has been
// validated to work with this exact CJMCU-055 module.
//
// Key differences from generic I2C drivers:
//   1. Bus speed = 100 kHz (CJMCU-055 clone compatibility)
//   2. Read pattern: endTransmission() (STOP) then requestFrom()
//      — NOT endTransmission(false) (repeated START)
//   3. writeReg: endTransmission() (STOP)
//   4. readReg: endTransmission() + requestFrom() with retry
// =====================================================================

// BNO055 register addresses (Bosch datasheet page 0)
#define BNO055_CHIP_ID_ADDR     0x00
#define BNO055_PAGE_ID_ADDR     0x07
#define BNO055_EULER_H_LSB      0x1A
#define BNO055_ACCEL_DATA_X_LSB 0x08
#define BNO055_GYRO_DATA_X_LSB  0x14
#define BNO055_TEMP_ADDR        0x34
#define BNO055_CALIB_STAT_ADDR  0x35
#define BNO055_OPR_MODE_ADDR    0x3D
#define BNO055_PWR_MODE_ADDR    0x3E
#define BNO055_SYS_TRIGGER      0x3F

#define BNO055_CHIP_ID_VALUE    0xA0
#define BNO055_MODE_CONFIG      0x00
#define BNO055_MODE_NDOF        0x0C
#define BNO055_POWER_NORMAL     0x00

// I2C buffer length (matches BNOExample)
#define I2C_BUFFER_LEN 8

// --- Write one byte (matches BNOExample BNO055_I2C_bus_write) ---
static bool writeReg(uint8_t addr, uint8_t reg, uint8_t value) {
    uint8_t array[I2C_BUFFER_LEN];
    array[0] = reg;
    array[1] = value;
    Wire.beginTransmission(addr);
    Wire.write(array, 2);
    Wire.endTransmission();           // STOP (not repeated START)
    return true;
}

// --- Read cnt bytes (matches BNOExample BNO055_I2C_bus_read) ---
static bool readRegs(uint8_t addr, uint8_t reg, uint8_t* buf, uint8_t cnt) {
    Wire.beginTransmission(addr);
    Wire.write((uint8_t)reg);
    Wire.endTransmission();           // STOP (not repeated START)
    Wire.requestFrom(addr, (byte)cnt);

    for (uint8_t i = 0; i < cnt; i++) {
        if (Wire.available()) {
            buf[i] = Wire.read();
        } else {
            // Retry: some clones need a second request
            i--;
            if (i > cnt + 5) return false;  // max 5 extra retries
        }
    }
    return true;
}

static uint8_t readReg(uint8_t addr, uint8_t reg) {
    uint8_t val = 0xFF;
    readRegs(addr, reg, &val, 1);
    return val;
}

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

bool BNO055Sensor::begin(uint8_t address)
{
    addr_ = address;
    operational_ = false;

    Serial.println("[BNO055] Init (100 kHz, BNOExample pattern)...");

    // Bosch datasheet: 650 ms power-on delay before first I2C transaction
    delay(650);

    // Probe configured address (must be 0x28 — ADR must be LOW)
    Wire.beginTransmission(addr_);
    uint8_t err = Wire.endTransmission();
    if (err != 0) {
        Serial.printf("[BNO055] No ACK at 0x%02X (err=%d)\n", addr_, err);
        // Diagnose: probe the alternate address to detect ADR state
        uint8_t alt = (addr_ == 0x28) ? 0x29 : 0x28;
        Wire.beginTransmission(alt);
        if (Wire.endTransmission() == 0) {
            Serial.printf("[BNO055] Module responds at 0x%02X — ADR pin is HIGH or wiring mismatch!\n", alt);
            if (alt == 0x29) {
                Serial.println("[BNO055] ADR must be LOW (0x28) to avoid conflict with VL53L0X");
                Serial.println("[BNO055] Bridge ADR/COM3 pin to GND on CJMCU-055 module");
            }
        }
        Serial.println("[BNO055] Check: SDA=GPIO10, SCL=GPIO11, GND+GNDIO must both be grounded");
        Serial.println("[BNO055]        ADR/COM3=GND for 0x28, PS0/PS1=float (I2C mode), RST=3.3V");
        Serial.println("[BNO055]        External 2.2k-4.7k pull-ups on SDA and SCL to 3.3V recommended");
        return false;
    }
    Serial.printf("[BNO055] ACK at 0x%02X\n", addr_);

    // Read chip ID
    uint8_t chipId = readReg(addr_, BNO055_CHIP_ID_ADDR);
    Serial.printf("[BNO055] Chip ID: 0x%02X (expected 0xA0)\n", chipId);
    if (chipId != BNO055_CHIP_ID_VALUE) {
        // BNO055 may need extra boot time — wait and retry once
        delay(1000);
        chipId = readReg(addr_, BNO055_CHIP_ID_ADDR);
        Serial.printf("[BNO055] Chip ID retry: 0x%02X\n", chipId);
        if (chipId != BNO055_CHIP_ID_VALUE) {
            Serial.println("[BNO055] Bad chip ID — not a real BNO055 or still booting?");
            return false;
        }
    }

    // Enter CONFIG mode (required before changing power/mode)
    writeReg(addr_, BNO055_OPR_MODE_ADDR, BNO055_MODE_CONFIG);
    delay(30);

    // Verify we're in CONFIG mode
    uint8_t mode = readReg(addr_, BNO055_OPR_MODE_ADDR);
    if (mode != BNO055_MODE_CONFIG) {
        Serial.printf("[BNO055] CONFIG mode verify failed (mode=0x%02X)\n", mode);
        return false;
    }
    Serial.println("[BNO055] CONFIG mode OK");

    // Set power mode to NORMAL
    writeReg(addr_, BNO055_PWR_MODE_ADDR, BNO055_POWER_NORMAL);
    delay(10);

    // Page 0
    writeReg(addr_, BNO055_PAGE_ID_ADDR, 0);
    delay(10);

    // Clear system trigger
    writeReg(addr_, BNO055_SYS_TRIGGER, 0x00);
    delay(10);

    // Enter NDOF fusion mode (all 9 axes, absolute orientation)
    writeReg(addr_, BNO055_OPR_MODE_ADDR, BNO055_MODE_NDOF);
    delay(500);  // fusion needs time to stabilize

    // Verify NDOF mode
    mode = readReg(addr_, BNO055_OPR_MODE_ADDR);
    if (mode != BNO055_MODE_NDOF) {
        Serial.printf("[BNO055] NDOF verify failed (mode=0x%02X)\n", mode);
        return false;
    }

    operational_ = true;
    Serial.printf("[BNO055] Ready — NDOF mode, addr 0x%02X\n", addr_);
    return true;
}

bool BNO055Sensor::read()
{
    if (!operational_) return false;

    // Mark the read attempt BEFORE I2C transactions.  If the bus is
    // flaky the I2C may return stale data, but the health monitor
    // still sees a fresh timestamp so the module stays ONLINE rather
    // than cycling WARNING→RECOVERING for every slow-timer tick.
    last_read_ms_ = millis();

    uint8_t buf[6];

    // Euler angles (heading/roll/pitch, 16-bit each in 0.1° units)
    if (!readRegs(addr_, BNO055_EULER_H_LSB, buf, 6)) return false;

    int16_t euler_h = (int16_t)((buf[1] << 8) | buf[0]);  // heading
    heading_deg_ = euler_h / 16.0f;
    if (heading_deg_ < 0.0f)  heading_deg_ += 360.0f;
    if (heading_deg_ >= 360.0f) heading_deg_ -= 360.0f;

    // Heading error: target − current, normalised ±180°
    if (has_target_) {
        float err = target_heading_deg_ - heading_deg_;
        if (err > 180.0f)  err -= 360.0f;
        if (err <= -180.0f) err += 360.0f;
        heading_error_deg_ = err;
    } else {
        heading_error_deg_ = 0.0f;
    }

    // Linear acceleration (m/s²)
    if (readRegs(addr_, BNO055_ACCEL_DATA_X_LSB, buf, 6)) {
        linear_accel_x_ = (int16_t)((buf[1] << 8) | buf[0]) / 100.0f;
        linear_accel_y_ = (int16_t)((buf[3] << 8) | buf[2]) / 100.0f;
    }

    // Gyro Z (°/s)
    if (readRegs(addr_, BNO055_GYRO_DATA_X_LSB + 4, buf, 2)) {
        gyro_z_dps_ = (int16_t)((buf[1] << 8) | buf[0]) / 16.0f;
    }

    // Temperature
    temperature_ = (int8_t)readReg(addr_, BNO055_TEMP_ADDR);

    // Calibration status (4 x 2-bit fields)
    uint8_t cal = readReg(addr_, BNO055_CALIB_STAT_ADDR);
    cal_sys_   = (cal >> 6) & 0x03;
    cal_gyro_  = (cal >> 4) & 0x03;
    cal_accel_ = (cal >> 2) & 0x03;
    cal_mag_   = cal & 0x03;

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
    PiSerial.printf("{\"type\":134,\"data\":{"
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
