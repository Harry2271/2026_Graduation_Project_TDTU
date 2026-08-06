#include "BNO055Sensor.h"
#include "BNO055_SPI.h"
#include "config.h"
#include "I2CBus.h"
#include <Arduino.h>
#include <Wire.h>

// =====================================================================
// BNO055Sensor — Bosch 9-DOF IMU (SPI primary, I2C fallback)
//
// Coordinate frame (Android / REP-103 inspired):
//   X = forward
//   Y = left
//   Z = up
// Euler convention: heading (Z), roll (Y), pitch (X)
// Unit: 1 LSB = 1/16° (divide by 16.0)
//
// Mounting on warehouse robot:
//   BNO055 chip X-axis must point forward (+X of robot frame)
//   If mounted differently, edit BNO055_AXIS_REMAP_* constants below.
// =====================================================================

// BNO055 register map (page 0 — main)
#define BNO055_CHIP_ID_ADDR        0x00
#define BNO055_PAGE_ID_ADDR        0x07
#define BNO055_DATA_START_ADDR     0x08   // ACC, MAG, GYR, EUL start
#define BNO055_GYRO_DATA_X_LSB     0x14   // Gyro X LSB (6 bytes: X, Y, Z)
#define BNO055_EULER_H_LSB         0x1A   // 6 bytes (H, R, P) little-endian
#define BNO055_EULER_H_MSB         0x1B
#define BNO055_EULER_R_LSB         0x1C
#define BNO055_EULER_R_MSB         0x1D
#define BNO055_EULER_P_LSB         0x1E
#define BNO055_EULER_P_MSB         0x1F
#define BNO055_QUATERNION_W_LSB    0x20   // 8 bytes
#define BNO055_LIA_DATA_X_LSB      0x28   // Linear accel (gravity-comp) 6 bytes
#define BNO055_GRAVITY_X_LSB       0x2E   // Gravity vector 6 bytes
#define BNO055_TEMP_ADDR           0x34
#define BNO055_CALIB_STAT_ADDR     0x35
#define BNO055_OPR_MODE_ADDR       0x3D
#define BNO055_PWR_MODE_ADDR       0x3E
#define BNO055_SYS_TRIGGER         0x3F

#define BNO055_CHIP_ID_VALUE       0xA0
#define BNO055_MODE_CONFIG         0x00
#define BNO055_MODE_NDOF           0x0C
#define BNO055_POWER_NORMAL        0x00

// Sensor data block start addresses (page 0)
#define BNO055_GYRO_DATA_X_LSB     0x14   // Gyro X/Y/Z: 6 bytes
#define BNO055_LIA_DATA_X_LSB      0x28   // Linear accel X/Y/Z: 6 bytes
#define BNO055_GRAVITY_X_LSB       0x2E   // Gravity vector X/Y/Z: 6 bytes

// Page 1 (Axis remap)
#define BNO055_AXIS_MAP_CONFIG     0x41
#define BNO055_AXIS_MAP_SIGN       0x42

// --- Mounting remap for robot frame (X=forward, Y=left, Z=up) ---
// AJUST ONLY if BNO055 is mounted in a different orientation on the PCB.
// Default (0x24, 0x00) = X→forward, Y→left, Z→up. Compatible with most car frames.
#define BNO055_AXIS_REMAP          0x24
#define BNO055_AXIS_SIGN           0x00

// --- I2C primitives (fallback, used when SPI not available) ---
//
// All I2C transactions go through I2CBus::safeReadReg/safeReadBurst/safeWriteReg
// which add:
//   1. linesIdle() guard (no transaction if SDA stuck)
//   2. Time-bounded read loop (max 50 ms, returns false instead of block)
//   3. No Wire.end() / Wire.begin() mid-flight (causes RTC_SW_SYS_RST)
//
// BNO055 has the longest I2C transactions in the system (Euler 6 bytes
// at startup, single-byte reads at runtime) — wireGuard prevents the
// VL53L0X/INA226 from racing with BNO055 and vice versa.

static bool writeReg(uint8_t addr, uint8_t reg, uint8_t value) {
    return I2CBus::safeWriteReg(BNO055_SDA_PIN, BNO055_SCL_PIN,
                                  BNO055_I2C_FREQ_HZ, addr, reg, value);
}

static bool readRegs(uint8_t addr, uint8_t reg, uint8_t* buf, uint8_t cnt) {
    return I2CBus::safeReadBurst(BNO055_SDA_PIN, BNO055_SCL_PIN,
                                   BNO055_I2C_FREQ_HZ, addr, reg, buf, cnt);
}

static uint8_t readReg(uint8_t addr, uint8_t reg) {
    uint8_t val = 0xFF;
    I2CBus::safeReadReg(BNO055_SDA_PIN, BNO055_SCL_PIN,
                          BNO055_I2C_FREQ_HZ, addr, reg, &val);
    return val;
}

// --- Constructor ---

BNO055Sensor::BNO055Sensor()
    : heading_deg_(0.0f), heading_error_deg_(0.0f)
    , roll_deg_(0.0f), pitch_deg_(0.0f)
    , target_heading_deg_(0.0f), has_target_(false)
    , linear_accel_x_(0.0f), linear_accel_y_(0.0f)
    , gyro_x_dps_(0.0f), gyro_y_dps_(0.0f), gyro_z_dps_(0.0f)
    , gravity_x_(0.0f), gravity_y_(0.0f), gravity_z_(0.0f)
    , temperature_(0)
    , cal_sys_(0), cal_gyro_(0), cal_accel_(0), cal_mag_(0)
    , operational_(false), addr_(0x28), last_read_ms_(0)
    , read_seq_(0), read_failures_(0)
{
}

// =====================================================================
// begin() — Initialize BNO055 in NDOF fusion mode
//
// Steps:
//   1. SPI first (free I2C bus for VL53L0X + INA226)
//   2. I2C fallback (when SPI not wired)
//   3. Wait 650ms power-on delay
//   4. Probe chip ID
//   5. CONFIG mode → set axis remap → NDOF mode
//   6. Verify all settings (chip ID, mode, axis remap)
// =====================================================================

bool BNO055Sensor::begin(uint8_t address)
{
    addr_ = address;
    operational_ = false;

    Serial.println("[BNO055] Init — trying SPI first, then I2C fallback...");

    // Bosch datasheet: 650 ms power-on delay before first transaction
    delay(650);

    bool probe_ok = false;

    // ── 1. Attempt SPI ──
    if (BNO055_SPI_init(addr_)) {
        Serial.println("[BNO055] SPI ready — using SPI mode");
        probe_ok = true;
    }
    // ── 2. SPI failed → fallback I2C ──
    else if (I2CBus::probeWithRecovery(BNO055_SDA_PIN, BNO055_SCL_PIN,
                                       addr_, BNO055_I2C_FREQ_HZ)) {
        Serial.println("[BNO055] I2C ready — using I2C fallback");
        probe_ok = true;

        // Verify chip ID via I2C
        uint8_t chipId = readReg(addr_, BNO055_CHIP_ID_ADDR);
        if (chipId != BNO055_CHIP_ID_VALUE) {
            delay(1000);
            chipId = readReg(addr_, BNO055_CHIP_ID_ADDR);
        }
        if (chipId != BNO055_CHIP_ID_VALUE) {
            Serial.println("[BNO055] I2C chip ID wrong — module damaged");
            return false;
        }
    }
    else {
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

    // ── 3. CONFIG mode + set axis remap ──
    uint8_t mode = readReg(addr_, BNO055_OPR_MODE_ADDR);
    if (mode != BNO055_MODE_CONFIG) {
        Serial.printf("[BNO055] Not in CONFIG mode (got 0x%02X) — force-switching\n", mode);
        writeReg(addr_, BNO055_OPR_MODE_ADDR, BNO055_MODE_CONFIG);
        delay(30);
    }

    // Power: NORMAL
    writeReg(addr_, BNO055_PWR_MODE_ADDR, BNO055_POWER_NORMAL);
    delay(10);

    // Page 1 → set axis remap (must be done in CONFIG mode)
    writeReg(addr_, BNO055_PAGE_ID_ADDR, 1);
    delay(10);
    writeReg(addr_, BNO055_AXIS_MAP_CONFIG, BNO055_AXIS_REMAP);
    writeReg(addr_, BNO055_AXIS_MAP_SIGN,  BNO055_AXIS_SIGN);
    delay(10);
    Serial.printf("[BNO055] Axis remap: 0x%02X, sign: 0x%02X\n",
        BNO055_AXIS_REMAP, BNO055_AXIS_SIGN);

    // Back to page 0
    writeReg(addr_, BNO055_PAGE_ID_ADDR, 0);
    delay(10);

    // Clear system trigger (any interrupt)
    writeReg(addr_, BNO055_SYS_TRIGGER, 0x00);
    delay(10);

    // ���─ 4. Switch to NDOF fusion mode ──
    writeReg(addr_, BNO055_OPR_MODE_ADDR, BNO055_MODE_NDOF);
    delay(700);   // Fusion needs longer to stabilize

    mode = readReg(addr_, BNO055_OPR_MODE_ADDR);
    if (mode != BNO055_MODE_NDOF) {
        Serial.printf("[BNO055] NDOF verify FAILED (mode=0x%02X, expected 0x%02X)\n",
            mode, BNO055_MODE_NDOF);
        return false;
    }

    operational_ = true;
    Serial.printf("[BNO055] Ready — NDOF mode, addr 0x%02X, axis remap 0x%02X\n",
        addr_, BNO055_AXIS_REMAP);
    Serial.println("[BNO055] IMPORTANT: Move robot in figure-8 to calibrate magnetometer");
    return true;
}

// =====================================================================
// read() — Read all IMU data
//
// Order (cheap to expensive):
//   1. Calibration status (1 byte)
//   2. Temperature (1 byte)
//   3. Euler angles (6 bytes: H, R, P)
//   4. Gravity vector (6 bytes: X, Y, Z)
//   5. Linear acceleration (6 bytes: X, Y, Z)
//   6. Gyroscope (6 bytes: X, Y, Z)
// =====================================================================

bool BNO055Sensor::read()
{
    if (!operational_) return false;

    last_read_ms_ = millis();
    read_seq_++;

    uint8_t buf[6];

    // ── Calibration status ──
    uint8_t cal = readReg(addr_, BNO055_CALIB_STAT_ADDR);
    cal_sys_   = (cal >> 6) & 0x03;
    cal_gyro_  = (cal >> 4) & 0x03;
    cal_accel_ = (cal >> 2) & 0x03;
    cal_mag_   = cal & 0x03;

    // ── Temperature ──
    temperature_ = (int8_t)readReg(addr_, BNO055_TEMP_ADDR);

    // ── Euler angles: 6 bytes starting at 0x1A ──
    // Format (16-bit signed, little-endian, LSB = 1/16°):
    //   [0..1] = heading (Yaw, Z-axis)
    //   [2..3] = roll   (Y-axis)
    //   [4..5] = pitch  (X-axis)
    if (!readRegs(addr_, BNO055_EULER_H_LSB, buf, 6)) {
        read_failures_++;
        return false;
    }
    int16_t h_raw = (int16_t)((buf[1] << 8) | buf[0]);
    int16_t r_raw = (int16_t)((buf[3] << 8) | buf[2]);
    int16_t p_raw = (int16_t)((buf[5] << 8) | buf[4]);
    // Heading wrapped to [0, 360)
    heading_deg_ = (float)h_raw / 16.0f;
    if (heading_deg_ < 0.0f)    heading_deg_ += 360.0f;
    if (heading_deg_ >= 360.0f) heading_deg_ -= 360.0f;
    roll_deg_  = (float)r_raw / 16.0f;
    pitch_deg_ = (float)p_raw / 16.0f;

    // Heading error (target − current), normalised ±180°
    if (has_target_) {
        float err = target_heading_deg_ - heading_deg_;
        if (err > 180.0f)  err -= 360.0f;
        if (err <= -180.0f) err += 360.0f;
        heading_error_deg_ = err;
    } else {
        heading_error_deg_ = 0.0f;
    }

    // ── Gravity vector (page 0, addr 0x2E, 6 bytes) ──
    // Used to detect tilt — useful for slope detection or safety
    if (readRegs(addr_, BNO055_GRAVITY_X_LSB, buf, 6)) {
        gravity_x_ = (int16_t)((buf[1] << 8) | buf[0]) / 100.0f;
        gravity_y_ = (int16_t)((buf[3] << 8) | buf[2]) / 100.0f;
        gravity_z_ = (int16_t)((buf[5] << 8) | buf[4]) / 100.0f;
    }

    // ── Linear acceleration (gravity-compensated, 6 bytes) ──
    if (readRegs(addr_, BNO055_LIA_DATA_X_LSB, buf, 6)) {
        linear_accel_x_ = (int16_t)((buf[1] << 8) | buf[0]) / 100.0f;
        linear_accel_y_ = (int16_t)((buf[3] << 8) | buf[2]) / 100.0f;
    }

    // ── Gyroscope (6 bytes: X, Y, Z angular velocity in °/s, LSB = 1/16) ──
    // Accelerometer/magnetometer data start at 0x08 in 6-byte blocks:
    //   0x08 = Acc X/Y/Z, 0x0E = Mag X/Y/Z, 0x14 = Gyr X/Y/Z
    if (readRegs(addr_, BNO055_GYRO_DATA_X_LSB, buf, 6)) {
        gyro_x_dps_ = (int16_t)((buf[1] << 8) | buf[0]) / 16.0f;
        gyro_y_dps_ = (int16_t)((buf[3] << 8) | buf[2]) / 16.0f;
        gyro_z_dps_ = (int16_t)((buf[5] << 8) | buf[4]) / 16.0f;
    }

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

void BNO055Sensor::clearTargetHeading()
{
    has_target_ = false;
    heading_error_deg_ = 0.0f;
}

bool BNO055Sensor::isFullyCalibrated() const
{
    return cal_sys_ >= 3 && cal_gyro_ >= 3 && cal_accel_ >= 3 && cal_mag_ >= 3;
}

uint8_t BNO055Sensor::getCalibrationStatus() const
{
    return (cal_sys_ << 6) | (cal_gyro_ << 4) | (cal_accel_ << 2) | cal_mag_;
}

void BNO055Sensor::printTelemetry() const
{
    PiSerial.printf("{\"type\":134,\"data\":{"
                  "\"heading\":%.2f,"
                  "\"roll\":%.2f,"
                  "\"pitch\":%.2f,"
                  "\"heading_error\":%.2f,"
                  "\"linear_accel_x\":%.2f,"
                  "\"linear_accel_y\":%.2f,"
                  "\"gravity_x\":%.2f,\"gravity_y\":%.2f,\"gravity_z\":%.2f,"
                  "\"gyro_x\":%.2f,\"gyro_y\":%.2f,\"gyro_z\":%.2f,"
                  "\"temp\":%d,"
                  "\"cal\":{\"sys\":%u,\"gyro\":%u,\"accel\":%u,\"mag\":%u}"
                  "}}\n",
                  heading_deg_, roll_deg_, pitch_deg_, heading_error_deg_,
                  linear_accel_x_, linear_accel_y_,
                  gravity_x_, gravity_y_, gravity_z_,
                  gyro_x_dps_, gyro_y_dps_, gyro_z_dps_,
                  temperature_,
                  cal_sys_, cal_gyro_, cal_accel_, cal_mag_);
}

void BNO055Sensor::printReadable() const
{
    Serial.printf("Heading: (%.2f deg)\n", heading_deg_);
    Serial.printf("Roll:    (%.2f deg)\n", roll_deg_);
    Serial.printf("Pitch:   (%.2f deg)\n", pitch_deg_);
    Serial.printf("Heading Error: (%.2f deg)\n", heading_error_deg_);
    Serial.printf("Linear Accel X: (%.2f m/s2)\n", linear_accel_x_);
    Serial.printf("Linear Accel Y: (%.2f m/s2)\n", linear_accel_y_);
    Serial.printf("Gravity (X,Y,Z): (%.2f, %.2f, %.2f) m/s2\n",
        gravity_x_, gravity_y_, gravity_z_);
    Serial.printf("Gyro (X,Y,Z): (%.2f, %.2f, %.2f) deg/s\n",
        gyro_x_dps_, gyro_y_dps_, gyro_z_dps_);
    Serial.printf("Temp: %d C\n", temperature_);
    Serial.printf("Cal: sys=%u gyro=%u accel=%u mag=%u\n",
        cal_sys_, cal_gyro_, cal_accel_, cal_mag_);
}