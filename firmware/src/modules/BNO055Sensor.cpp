#include "BNO055Sensor.h"
#include <Arduino.h>
#include <Wire.h>

// Register map (partial — just what we need)
#define REG_CHIP_ID      0x00
#define REG_OPR_MODE     0x3D
#define REG_PWR_MODE     0x3E
#define REG_CALIB_STAT   0x35
#define REG_EULER_YAW_LSB  0x1A
#define REG_TEMP         0x34

static const char* TAG = "[BNO055]";

BNO055Sensor::BNO055Sensor()
    : yaw_(0.0f), pitch_(0.0f), roll_(0.0f)
    , temperature_(0)
    , cal_sys_(0), cal_gyro_(0), cal_accel_(0), cal_mag_(0)
    , operational_(false), addr_(BNO055_I2C_ADDR), last_read_ms_(0)
{
}

bool BNO055Sensor::begin(uint8_t address)
{
    addr_ = address;
    Wire.beginTransmission(addr_);
    if (Wire.endTransmission() != 0) {
        Serial.printf("%s No device found at 0x%02X\n", TAG, addr_);
        return false;
    }

    // Verify chip ID
    uint8_t chip_id = 0;
    if (!readReg(REG_CHIP_ID, &chip_id)) {
        Serial.printf("%s Failed to read chip ID\n", TAG);
        return false;
    }
    if (chip_id != BNO055_CHIP_ID_VAL) {
        Serial.printf("%s Unexpected chip ID: 0x%02X (expected 0x%02X)\n",
                      TAG, chip_id, BNO055_CHIP_ID_VAL);
        return false;
    }
    Serial.printf("%s Chip ID verified: 0x%02X\n", TAG, chip_id);

    // Switch to CONFIG mode before changing anything
    if (!setMode(BNO055_OPR_MODE_CONFIG)) {
        Serial.printf("%s Failed to set CONFIG mode\n", TAG);
        return false;
    }
    delay(25);

    // Normal power mode
    if (!setPowerMode(BNO055_PWR_MODE_NORMAL)) {
        Serial.printf("%s Failed to set normal power mode\n", TAG);
        return false;
    }
    delay(10);

    // NDOF fusion mode (all 9 axes, absolute orientation)
    if (!setMode(BNO055_OPR_MODE_NDOF)) {
        Serial.printf("%s Failed to set NDOF mode\n", TAG);
        return false;
    }
    delay(30);

    operational_ = true;
    Serial.printf("%s Ready — NDOF mode, addr 0x%02X\n", TAG, addr_);
    return true;
}

bool BNO055Sensor::read()
{
    if (!operational_) return false;
    last_read_ms_ = millis();

    uint8_t buf[6];
    if (!readRegs(REG_EULER_YAW_LSB, buf, 6)) return false;

    // Euler angles: 3 × int16 LSB-first, each = 1/16 degree
    int16_t yaw_raw   = (int16_t)((uint16_t)buf[0] | (uint16_t)(buf[1] << 8));
    int16_t roll_raw  = (int16_t)((uint16_t)buf[2] | (uint16_t)(buf[3] << 8));
    int16_t pitch_raw = (int16_t)((uint16_t)buf[4] | (uint16_t)(buf[5] << 8));

    yaw_   = yaw_raw   / 16.0f;
    roll_  = roll_raw  / 16.0f;
    pitch_ = pitch_raw / 16.0f;

    // Normalise yaw to [0, 360)
    if (yaw_ < 0.0f)  yaw_ += 360.0f;
    if (yaw_ >= 360.0f) yaw_ -= 360.0f;

    // Temperature
    uint8_t temp_raw = 0;
    if (readReg(REG_TEMP, &temp_raw)) {
        temperature_ = (int8_t)temp_raw;
    }

    // Calibration status
    uint8_t cal = 0;
    if (readReg(REG_CALIB_STAT, &cal)) {
        cal_sys_   = (cal >> 6) & 0x03;
        cal_gyro_  = (cal >> 4) & 0x03;
        cal_accel_ = (cal >> 2) & 0x03;
        cal_mag_   =  cal       & 0x03;
    }

    return true;
}

float BNO055Sensor::getHeadingRad() const
{
    return yaw_ * DEG_TO_RAD;
}

void BNO055Sensor::printTelemetry() const
{
    // type 134 = IMU telemetry
    Serial.printf("{\"type\":134,\"data\":{"
                  "\"yaw\":%.1f,\"pitch\":%.1f,\"roll\":%.1f,"
                  "\"temp\":%d,"
                  "\"cal\":{\"sys\":%u,\"gyro\":%u,\"accel\":%u,\"mag\":%u}"
                  "}}\n",
                  yaw_, pitch_, roll_,
                  temperature_,
                  cal_sys_, cal_gyro_, cal_accel_, cal_mag_);
}

// ------------------------------------------------------------------
// Private helpers
// ------------------------------------------------------------------

bool BNO055Sensor::writeReg(uint8_t reg, uint8_t val)
{
    Wire.beginTransmission(addr_);
    Wire.write(reg);
    Wire.write(val);
    return Wire.endTransmission() == 0;
}

bool BNO055Sensor::readReg(uint8_t reg, uint8_t* val)
{
    Wire.beginTransmission(addr_);
    Wire.write(reg);
    if (Wire.endTransmission(false) != 0) return false;  // repeated start
    uint8_t n = Wire.requestFrom(addr_, (uint8_t)1);
    if (n < 1) return false;
    *val = Wire.read();
    return true;
}

bool BNO055Sensor::readRegs(uint8_t reg, uint8_t* buf, uint8_t len)
{
    Wire.beginTransmission(addr_);
    Wire.write(reg);
    if (Wire.endTransmission(false) != 0) return false;
    uint8_t n = Wire.requestFrom(addr_, len);
    if (n < len) return false;
    for (uint8_t i = 0; i < len; i++) {
        buf[i] = Wire.read();
    }
    return true;
}

bool BNO055Sensor::setMode(uint8_t mode)
{
    return writeReg(REG_OPR_MODE, mode);
}

bool BNO055Sensor::setPowerMode(uint8_t mode)
{
    return writeReg(REG_PWR_MODE, mode);
}
