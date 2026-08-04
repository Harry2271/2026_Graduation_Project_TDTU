#include "BNO055Sensor.h"
#include "BNO055_SPI.h"
#include "config.h"
#include "I2CBus.h"
#include <Arduino.h>
#include <Wire.h>

// =====================================================================
// BNO055Sensor — Bosch 9-DOF IMU (SPI primary, I2C fallback)
//
// Initialization strategy:
//   1. Attempt SPI mode first (requires PS1=HIGH on CJMCU-055 module).
//   2. If SPI fails, fallback to I2C mode (requires pull-ups on SDA/SCL).
//
// SPI vs I2C: SPI frees the I2C bus for VL53L0X and INA226, which
// eliminates the bus contention issues caused by BNO055's long I2C
// transactions (>100 ms for Bosch fusion mode reads).
//
// PS0/PS1 pin configuration (per Bosch BNO055 datasheet):
//   I2C mode: PS0=LOW, PS1=LOW
//   SPI mode: PS0=LOW, PS1=HIGH
//   UART mode: PS0=HIGH, PS1=LOW (not used here)
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

// --- I2C primitives (fallback, used when SPI not available) ---

static bool writeReg(uint8_t addr, uint8_t reg, uint8_t value) {
    Wire.beginTransmission(addr);
    Wire.write((uint8_t)reg);
    Wire.write(value);
    Wire.endTransmission();           // STOP (not repeated START)
    return true;
}

// BUG FIX: replaced uint8_t wrap bug with explicit timeout + retry counter.
static bool readRegs(uint8_t addr, uint8_t reg, uint8_t* buf, uint8_t cnt) {
    uint32_t start = millis();
    const uint8_t MAX_I2C_RETRY = 3;

    for (uint8_t retry = 0; retry < MAX_I2C_RETRY; retry++) {
        Wire.beginTransmission(addr);
        Wire.write((uint8_t)reg);
        Wire.endTransmission();           // STOP (not repeated START)
        Wire.requestFrom(addr, (byte)cnt);

        uint8_t got = 0;
        while (got < cnt && (millis() - start) < 50) {
            if (Wire.available()) {
                buf[got++] = Wire.read();
            }
        }
        if (got == cnt) return true;
        delay(5);
    }
    return false;
}

static uint8_t readReg(uint8_t addr, uint8_t reg) {
    uint8_t val = 0xFF;
    readRegs(addr, reg, &val, 1);
    return val;
}

// --- Constructor ---

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

// =====================================================================
// begin() — Detect SPI vs I2C and initialize accordingly
//
// SPI mode is attempted first.  SPI eliminates bus contention on the
// shared I2C bus, freeing it for VL53L0X and INA226.  If SPI fails
// (PS0 not tied HIGH, missing MOSI/MISO/SCK/CS wiring), fallback
// to I2C mode.
// =====================================================================

bool BNO055Sensor::begin(uint8_t address)
{
    addr_ = address;
    operational_ = false;

    Serial.println("[BNO055] Init — trying SPI first, then I2C fallback...");

    // Wait for power-on (Bosch datasheet: 650 ms before first I2C/SPI transaction)
    delay(650);

    // ── 1. Attempt SPI mode (via BNO055_SPI.cpp) ──
    bool spi_ok = BNO055_SPI_init(addr_);
    if (spi_ok) {
        operational_ = true;
        Serial.printf("[BNO055] Ready via SPI — NDOF mode, CS=GPIO%d\n",
            BNO055_SPI_CS_PIN);
        return true;
    }

    // ── 2. SPI failed → fallback to I2C ──
    Serial.println("[BNO055] SPI init failed — falling back to I2C...");

    if (I2CBus::probeWithRecovery(BNO055_SDA_PIN, BNO055_SCL_PIN,
                                    addr_, BNO055_I2C_FREQ_HZ)) {
        Serial.printf("[BNO055] ACK at 0x%02X via I2C\n", addr_);

        uint8_t chipId = readReg(addr_, BNO055_CHIP_ID_ADDR);
        if (chipId != BNO055_CHIP_ID_VALUE) {
            delay(1000);
            chipId = readReg(addr_, BNO055_CHIP_ID_ADDR);
        }
        if (chipId != BNO055_CHIP_ID_VALUE) {
            Serial.println("[BNO055] Bad chip ID — not a real BNO055 or still booting?");
            Serial.println("[BNO055] For SPI mode: solder PS0 pin HIGH on CJMCU-055 module");
            return false;
        }

        writeReg(addr_, BNO055_OPR_MODE_ADDR, BNO055_MODE_CONFIG);
        delay(30);
        uint8_t mode = readReg(addr_, BNO055_OPR_MODE_ADDR);
        if (mode != BNO055_MODE_CONFIG) {
            Serial.printf("[BNO055] CONFIG mode verify failed (mode=0x%02X)\n", mode);
            return false;
        }
        Serial.println("[BNO055] CONFIG mode OK");

        writeReg(addr_, BNO055_PWR_MODE_ADDR, BNO055_POWER_NORMAL);
        delay(10);
        writeReg(addr_, BNO055_PAGE_ID_ADDR, 0);
        delay(10);
        writeReg(addr_, BNO055_SYS_TRIGGER, 0x00);
        delay(10);

        writeReg(addr_, BNO055_OPR_MODE_ADDR, BNO055_MODE_NDOF);
        delay(500);

        mode = readReg(addr_, BNO055_OPR_MODE_ADDR);
        if (mode != BNO055_MODE_NDOF) {
            Serial.printf("[BNO055] NDOF verify failed (mode=0x%02X)\n", mode);
            return false;
        }

        operational_ = true;
        Serial.printf("[BNO055] Ready via I2C — NDOF mode, addr 0x%02X\n", addr_);
        return true;
    }

    // Both SPI and I2C failed
    Serial.println("[BNO055] FAILED: neither SPI nor I2C available");
    Serial.println("[BNO055] SPI checklist:");
    Serial.println("[BNO055]   PS1 = HIGH (3.3V), PS0 = LOW or floating");
    Serial.println("[BNO055]   SDO/SDA → GPIO36 (MISO), SDA/SDI → GPIO4 (MOSI)");
    Serial.println("[BNO055]   SCL/SCK → GPIO15 (SCK), CS → GPIO21");
    Serial.println("[BNO055] I2C checklist:");
    Serial.println("[BNO055]   SDA = GPIO10, SCL = GPIO11");
    Serial.println("[BNO055]   ADR = GND (0x28), PS1 = LOW (I2C mode)");
    Serial.println("[BNO055]   Pull-ups 2.2k-4.7k on SDA/SCL to 3.3V");
    return false;
}

// =====================================================================
// BNO055_SPI_init — full SPI initialization sequence
// =====================================================================

// (Implementation moved to BNO055_SPI.cpp)

// =====================================================================
// read() — Read all BNO055 sensor data
// =====================================================================

bool BNO055Sensor::read()
{
    if (!operational_) return false;

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

    // Calibration status (4 × 2-bit fields)
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
