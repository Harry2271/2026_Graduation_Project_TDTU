#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>
#include <stdint.h>

class BTS7960Driver;
class Encoder;
class BNO055Sensor;
class INA226Sensor;
class IRProximitySensor;
class SharpFrontSensor;
class VL53L0XSensor;
class CylinderActuator;
class PIDController;
class MecanumDrive;
class ModeManager;
class AutoRoam;

// JSON message type IDs (matches CLAUDE.md protocol: 130 / 131 / 133 / 134 / 135 / 136)
// 130 = encoder snapshot
// 131 = full status
// 132 = move-ack (unused in JSON status stream)
// 133 = power telemetry
// 134 = IMU telemetry
// 135 = IR proximity
// 136 = Sharp front
// 137 = obstacle (IR + Sharp merged)
// 138 = TOF distance
// 139 = cylinder actuator state
// 140 = unload / docking state (transition notify + query response)
class JsonStatus {
public:
    /// Emit the full status bundle as a single multi-line JSON
    /// document, separated by a marker so the Pi can split easily.
    /// Returns number of bytes written.
    static size_t emitFullStatus(char* buf, size_t bufsize, uint32_t now_ms,
        ModeManager* modeManager, MecanumDrive* mecanum,
        Encoder encoders[], PIDController pids[],
        BTS7960Driver motors[],
        BNO055Sensor* imu, INA226Sensor* power,
        IRProximitySensor* ir, SharpFrontSensor* sharp,
        VL53L0XSensor* tof, CylinderActuator* cylinder,
        int16_t nav_vx, int16_t nav_vy, int16_t nav_omega,
        bool e_stop, uint8_t max_pct);

    /// Emit one compact per-tick JSON status (single object).
    static size_t emitTickStatus(char* buf, size_t bufsize, uint32_t now_ms,
        ModeManager* modeManager,
        Encoder encoders[],
        BTS7960Driver motors[],
        BNO055Sensor* imu, INA226Sensor* power,
        IRProximitySensor* ir, SharpFrontSensor* sharp,
        VL53L0XSensor* tof, CylinderActuator* cylinder,
        int16_t nav_vx, int16_t nav_vy, int16_t nav_omega,
        bool e_stop, uint8_t max_pct);

    /// Emit encoder snapshot (type 130)
    static size_t emitEncoderSnapshot(char* buf, size_t bufsize,
        const int16_t* ramped_speeds, Encoder encoders[]);

    /// Emit obstacle state (types 135 + 136 merged)
    static size_t emitObstacle(char* buf, size_t bufsize,
        IRProximitySensor* ir, SharpFrontSensor* sharp);

    /// Emit IMU telemetry (type 134)
    static size_t emitIMU(char* buf, size_t bufsize, BNO055Sensor* imu);

    /// Emit power telemetry (type 133)
    static size_t emitPower(char* buf, size_t bufsize, INA226Sensor* power);

    /// Emit unload / docking state (type 140)
    static size_t emitUnloadState(char* buf, size_t bufsize, uint32_t now_ms,
        const AutoRoam* auto_roam, VL53L0XSensor* tof,
        BNO055Sensor* imu, CylinderActuator* cylinder);
};
