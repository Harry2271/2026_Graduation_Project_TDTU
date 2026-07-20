#pragma once

#include <stdint.h>

/**
 * BNO055 — Bosch 9-DOF IMU (Euler, Linear Accel, Gyro)
 *
 * Uses the official Bosch bno055 driver library for init and data conversion.
 * Outputs: Heading, Heading Error, Linear Accel X/Y, Gyro Z.
 */

class BNO055Sensor {
public:
    BNO055Sensor();

    /// Initialize BNO055 via Bosch API (NDOF fusion mode).
    bool begin(uint8_t address = 0x28);

    /// Read all sensor data. Call at >= 20 Hz.
    bool read();

    // --- Accessors (values from last read()) ---
    float getHeading()       const { return heading_deg_; }
    float getHeadingError()  const { return heading_error_deg_; }
    float getLinearAccelX()  const { return linear_accel_x_; }
    float getLinearAccelY()  const { return linear_accel_y_; }
    float getGyroZ()         const { return gyro_z_dps_; }

    // Legacy accessors (backward-compatible with old JSON)
    float getYaw()     const { return heading_deg_; }
    float getPitch()   const { return 0.0f; }
    float getRoll()    const { return 0.0f; }
    float getHeadingRad() const;
    int8_t getTemperature()  const { return temperature_; }

    /// Calibration (0 = uncal, 3 = fully calibrated per sensor)
    uint8_t getCalSys()   const { return cal_sys_; }
    uint8_t getCalGyro()  const { return cal_gyro_; }
    uint8_t getCalAccel() const { return cal_accel_; }
    uint8_t getCalMag()   const { return cal_mag_; }

    /// Set the target heading (degrees). Heading error = target − current.
    void setTargetHeading(float target_deg);

    /// Print JSON telemetry (type 134) over Serial.
    void printTelemetry() const;

    /// Print human-readable heading/accel/gyro (ASCII I command).
    void printReadable() const;

    bool isOperational() const { return operational_; }
    uint32_t getLastReadMs() const { return last_read_ms_; }

private:
    float heading_deg_;
    float heading_error_deg_;   // target − current, normalised ±180°
    float target_heading_deg_;
    float linear_accel_x_;      // m/s²
    float linear_accel_y_;      // m/s²
    float gyro_z_dps_;          // °/s
    int8_t temperature_;
    uint8_t cal_sys_, cal_gyro_, cal_accel_, cal_mag_;
    bool operational_;
    uint8_t addr_;
    uint32_t last_read_ms_;
    bool has_target_;
};