#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>
#include <stdint.h>

class BTS7960Driver;
class Encoder;
class BNO055Sensor;
class ImuSafetyEvaluator;
class INA226Sensor;
class IRProximitySensor;
class FrontTofSensor;
class VL53L0XSensor;
class CylinderActuator;
class CargoSensor;
class PIDController;
class MecanumDrive;
class ModeManager;
class AutoRoam;
class SafetyController;

// ============================================================
// ZeroCopyTelemetry — Direct-to-stream JSON serialization
// ============================================================
// Replaces char buffer allocation with direct Serial.print()
// Reduces RAM usage by 1200 bytes and eliminates memory copy.
// ============================================================

class ZeroCopyTelemetry {
public:
    /// Emit full status directly to stream (type 131)
    static void emitFullStatus(Stream& stream, uint32_t now_ms,
        ModeManager* modeManager, MecanumDrive* mecanum,
        Encoder encoders[], PIDController pids[],
        BTS7960Driver motors[],
        BNO055Sensor* imu, INA226Sensor* power,
        IRProximitySensor* ir, FrontTofSensor* front_tof,
        VL53L0XSensor* tof, CylinderActuator* cylinder,
        SafetyController* safety,
        int16_t nav_vx, int16_t nav_vy, int16_t nav_omega,
        uint8_t max_pct);

    /// Emit compact tick status (type 143) — 500ms interval
    static void emitTickStatus(Stream& stream, uint32_t now_ms,
        ModeManager* modeManager,
        Encoder encoders[],
        BTS7960Driver motors[],
        SafetyController* safety,
        int16_t nav_vx, int16_t nav_vy, int16_t nav_omega,
        uint8_t max_pct);

    /// Emit encoder snapshot (type 130) — on-demand via get_encoder command
    static void emitEncoderSnapshot(Stream& stream,
        const int16_t* ramped_speeds, Encoder encoders[]);

    /// Emit encoder stream (type 130) — periodic 5Hz telemetry
    static void emitEncoderStream(Stream& stream, uint32_t now_ms,
        Encoder encoders[]);

    /// Emit IMU telemetry (type 134)
    static void emitIMU(Stream& stream, BNO055Sensor* imu,
        const ImuSafetyEvaluator* safety = nullptr);

    /// Emit power telemetry (type 133)
    static void emitPower(Stream& stream, INA226Sensor* power);

    /// Emit safety event (type 146 — new for SafetyController)
    static void emitSafetyEvent(Stream& stream, uint32_t now_ms,
        SafetyController* safety);

    /// Emit alive heartbeat (type 144)
    static void emitAlive(Stream& stream, uint32_t now_ms,
        uint32_t alive_counter, SafetyController* safety,
        ModeManager* modeManager);

    /// Emit ACK (type 128)
    static void emitAck(Stream& stream, const char* command,
        const char* status = "accepted");

    /// Emit error (type 129)
    static void emitError(Stream& stream, const char* code,
        const char* message, const char* severity = "error");

    /// Emit move ACK (type 132)
    static void emitMoveAck(Stream& stream,
        uint16_t seq, const char* status, const char* reason = nullptr);

    /// Emit arm state telemetry (type 148)
    static void emitArmState(Stream& stream, uint32_t now_ms,
        const float joints[5], bool moving);

    /// Emit adaptive PID telemetry (type 149)
    static void emitAdaptivePIDState(Stream& stream, uint32_t now_ms,
        class AdaptivePID* adaptive);
};

// Legacy JsonStatus class — keep for backward compatibility during rollout
// Will be deprecated after Pi migration to ZeroCopyTelemetry
class JsonStatus {
public:
    static size_t emitFullStatus(char* buf, size_t bufsize, uint32_t now_ms,
        ModeManager* modeManager, MecanumDrive* mecanum,
        Encoder encoders[], PIDController pids[],
        BTS7960Driver motors[],
        BNO055Sensor* imu, INA226Sensor* power,
        IRProximitySensor* ir, FrontTofSensor* front_tof,
        VL53L0XSensor* tof, CylinderActuator* cylinder,
        int16_t nav_vx, int16_t nav_vy, int16_t nav_omega,
        bool e_stop, uint8_t max_pct);

    static size_t emitTickStatus(char* buf, size_t bufsize, uint32_t now_ms,
        ModeManager* modeManager,
        Encoder encoders[],
        BTS7960Driver motors[],
        BNO055Sensor* imu, INA226Sensor* power,
        IRProximitySensor* ir, FrontTofSensor* front_tof,
        VL53L0XSensor* tof, CylinderActuator* cylinder,
        CargoSensor* cargo,
        int16_t nav_vx, int16_t nav_vy, int16_t nav_omega,
        bool e_stop, uint8_t max_pct);

    static size_t emitEncoderSnapshot(char* buf, size_t bufsize,
        const int16_t* ramped_speeds, Encoder encoders[]);

    static size_t emitObstacle(char* buf, size_t bufsize,
        IRProximitySensor* ir, FrontTofSensor* front_tof);

    static size_t emitIMU(char* buf, size_t bufsize, BNO055Sensor* imu,
        const ImuSafetyEvaluator* safety = nullptr);

    static size_t emitPower(char* buf, size_t bufsize, INA226Sensor* power);

    static size_t emitUnloadState(char* buf, size_t bufsize, uint32_t now_ms,
        const AutoRoam* auto_roam, VL53L0XSensor* tof,
        BNO055Sensor* imu, CylinderActuator* cylinder);

    static size_t emitAck(char* buf, size_t bufsize, const char* command,
        const char* status = "accepted");

    static size_t emitError(char* buf, size_t bufsize, const char* code,
        const char* message, const char* severity = "error");

    static size_t emitMoveAck(char* buf, size_t bufsize,
        uint16_t seq, const char* status, const char* reason = nullptr);
};
