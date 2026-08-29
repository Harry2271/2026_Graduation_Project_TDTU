#pragma once

#include <stdint.h>

/**
 * BNO055 — Bosch 9-DOF IMU (Euler, Linear Accel, Gyro)
 *
 * Supports both SPI mode (PS1=HIGH) and I2C fallback (0x28).
 * Axis remap defaults to: X=forward, Y=left, Z=up.
 * Adjust BNO055_AXIS_REMAP / BNO055_AXIS_SIGN in config.h if BNO055
 * is mounted in a different orientation.
 *
 * Calibration requirement (for accurate heading):
 *   Move the robot in a figure-8 pattern on the ground for ~30s.
 *   System status (cal_sys_) should reach 3 = fully calibrated.
 */

class BNO055Sensor {
public:
    BNO055Sensor();

    /// Initialize BNO055 (SPI first, then I2C fallback). NDOF fusion mode.
    bool begin(uint8_t address = 0x28);

    /// Read all sensor data. Call at ≥ 20 Hz (50 Hz optimal).
    bool read();

    // --- Heading (Yaw, Z-axis) ---
    float getHeading()       const { return heading_deg_; }
    float getHeadingError()  const { return heading_error_deg_; }
    float getHeadingRad()    const;

    // --- Euler: Roll (Y-axis) + Pitch (X-axis) ---
    float getRoll()          const { return roll_deg_; }
    float getPitch()         const { return pitch_deg_; }

    // --- Linear acceleration (gravity-compensated, m/s²) ---
    float getLinearAccelX()  const { return linear_accel_x_; }
    float getLinearAccelY()  const { return linear_accel_y_; }
    float getLinearAccelZ()  const { return linear_accel_z_; }

    // --- Native BNO055 fusion quaternion (w, x, y, z; unit length) ---
    float getQuatW() const { return quat_w_; }
    float getQuatX() const { return quat_x_; }
    float getQuatY() const { return quat_y_; }
    float getQuatZ() const { return quat_z_; }
    bool hasValidQuaternion() const { return quat_valid_; }

    // --- Gyroscope (angular velocity, °/s) ---
    float getGyroX()         const { return gyro_x_dps_; }
    float getGyroY()         const { return gyro_y_dps_; }
    float getGyroZ()         const { return gyro_z_dps_; }

    // --- Gravity vector (m/s², always points to true down) ---
    float getGravityX()      const { return gravity_x_; }
    float getGravityY()      const { return gravity_y_; }
    float getGravityZ()      const { return gravity_z_; }

    // --- Temperature ---
    int8_t getTemperature()  const { return temperature_; }

    // --- Calibration ---
    /// Per-sensor: 0 = uncal, 1 = low, 2 = mid, 3 = fully calibrated
    uint8_t getCalSys()   const { return cal_sys_; }
    uint8_t getCalGyro()  const { return cal_gyro_; }
    uint8_t getCalAccel() const { return cal_accel_; }
    uint8_t getCalMag()   const { return cal_mag_; }
    /// True when all 4 sensors are fully calibrated (level 3)
    bool isFullyCalibrated() const;
    /// Raw combined calibration status byte
    uint8_t getCalibrationStatus() const;

    // --- Target heading for heading-hold PID ---
    void setTargetHeading(float target_deg);
    void clearTargetHeading();

    // --- Telemetry ---
    void printTelemetry() const;
    void printReadable() const;

    bool isOperational() const { return operational_; }
    uint32_t getLastReadMs() const { return last_read_ms_; }

    // --- Read diagnostics ---
    uint32_t getReadSequence() const { return read_seq_; }
    uint32_t getReadFailures() const { return read_failures_; }

private:
    float heading_deg_;
    float heading_error_deg_;   // target − current, normalised ±180°
    float target_heading_deg_;
    float roll_deg_;
    float pitch_deg_;
    float linear_accel_x_;      // m/s²
    float linear_accel_y_;      // m/s²
    float linear_accel_z_;      // m/s²
    float quat_w_, quat_x_, quat_y_, quat_z_;
    bool quat_valid_;
    float gravity_x_;           // m/s²
    float gravity_y_;           // m/s²
    float gravity_z_;           // m/s²
    float gyro_x_dps_;          // °/s
    float gyro_y_dps_;          // °/s
    float gyro_z_dps_;          // °/s
    int8_t temperature_;
    uint8_t cal_sys_, cal_gyro_, cal_accel_, cal_mag_;
    bool operational_;
    uint8_t addr_;
    uint32_t last_read_ms_;
    bool has_target_;
    uint32_t read_seq_;         // monotonic read counter
    uint32_t read_failures_;    // consecutive I2C/SPI read failures
};
