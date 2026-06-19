#pragma once

#include <stdint.h>

#define BNO055_I2C_ADDR  0x28   // ADR = LOW (default)

#define BNO055_CHIP_ID_VAL  0xA0

// Operation modes
#define BNO055_OPR_MODE_CONFIG  0x00
#define BNO055_OPR_MODE_NDOF    0x0C  // Absolute orientation fusion

// Power modes
#define BNO055_PWR_MODE_NORMAL  0x00

class BNO055Sensor {
public:
    BNO055Sensor();

    /// Initialize I2C, verify chip ID, switch to NDOF fusion mode.
    /// Returns true if the chip is detected and configured.
    bool begin(uint8_t address = BNO055_I2C_ADDR);

    /// Read all sensor data (Euler angles, temperature, calibration).
    /// Call at ~10 Hz or faster.
    bool read();

    // --- Accessors (values from last read()) ---
    float  getYaw()     const { return yaw_; }
    float  getPitch()   const { return pitch_; }
    float  getRoll()    const { return roll_; }
    float  getHeadingRad() const;
    int8_t getTemperature()  const { return temperature_; }

    /// Calibration status per sensor (0 = uncalibrated, 3 = fully calibrated)
    uint8_t getCalSys()   const { return cal_sys_; }
    uint8_t getCalGyro()  const { return cal_gyro_; }
    uint8_t getCalAccel() const { return cal_accel_; }
    uint8_t getCalMag()   const { return cal_mag_; }
    bool    isFullyCalibrated() const
        { return cal_sys_ >= 3 && cal_gyro_ >= 3 && cal_accel_ >= 3 && cal_mag_ >= 3; }

    /// Print JSON telemetry (type 134) over Serial.
    void printTelemetry() const;

    bool isOperational() const { return operational_; }
    uint32_t getLastReadMs() const { return last_read_ms_; }

private:
    // Raw I2C register helpers
    bool writeReg(uint8_t reg, uint8_t val);
    bool readReg(uint8_t reg, uint8_t* val);
    bool readRegs(uint8_t reg, uint8_t* buf, uint8_t len);

    bool setMode(uint8_t mode);
    bool setPowerMode(uint8_t mode);

    float yaw_;         // degrees
    float pitch_;       // degrees
    float roll_;        // degrees
    int8_t temperature_;
    uint8_t cal_sys_, cal_gyro_, cal_accel_, cal_mag_;
    bool operational_;
    uint8_t addr_;
    uint32_t last_read_ms_;
};
