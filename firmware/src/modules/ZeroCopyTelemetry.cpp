#include "JsonStatus.h"
#include "SafetyController.h"
#include "ModeManager.h"
#include "BTS7960Driver.h"
#include "Encoder.h"
#include "BNO055Sensor.h"
#include "ImuSafetyEvaluator.h"
#include "INA226Sensor.h"
#include "FrontTofSensor.h"
#include "IRProximitySensor.h"
#include "VL53L0XSensor.h"
#include "CylinderActuator.h"
#include "config.h"

using namespace ArduinoJson;

// ============================================================
// ZeroCopyTelemetry — Direct-to-stream serialization
// ============================================================

void ZeroCopyTelemetry::emitFullStatus(Stream& stream, uint32_t now_ms,
    ModeManager* modeManager, MecanumDrive* mecanum,
    Encoder encoders[], PIDController pids[],
    BTS7960Driver motors[],
    BNO055Sensor* imu, INA226Sensor* power,
    IRProximitySensor* ir, FrontTofSensor* front_tof,
    VL53L0XSensor* tof, CylinderActuator* cylinder,
    SafetyController* safety,
    int16_t nav_vx, int16_t nav_vy, int16_t nav_omega,
    uint8_t max_pct)
{
    (void)mecanum; (void)pids; (void)tof; (void)cylinder;

    JsonDocument doc;
    doc["ts"] = now_ms;
    doc["type"] = 131;
    doc["mode"] = Watchdog::modeName(modeManager->getMode());
    doc["safety"] = (uint8_t)safety->getLevel();
    doc["pid"] = modeManager->isPIDEnabled();
    doc["max_pct"] = max_pct;

    JsonObject nav = doc["nav"].to<JsonObject>();
    nav["vx"] = nav_vx;
    nav["vy"] = nav_vy;
    nav["omega"] = nav_omega;

    JsonArray motorsArr = doc["motors"].to<JsonArray>();
    const int16_t* tgt = modeManager->getRampedSpeeds();
    for (int i = 0; i < MOTOR_COUNT; i++) {
        JsonObject m = motorsArr.add<JsonObject>();
        m["id"] = i;
        m["name"] = MOTOR_NAMES[i];
        m["enabled"] = motors[i].isEnabled();
        m["target"] = tgt[i];
        m["rpm"] = encoders[i].getFilteredRPM() * MOTOR_PINS[i].dir;
        m["count"] = (long)(encoders[i].getCumulativeCount() * MOTOR_PINS[i].dir);
    }

    JsonObject ir_obj = doc["ir"].to<JsonObject>();
    ir_obj["mask"] = ir->detectedMask();

    JsonObject front = doc["front_tof"].to<JsonObject>();
    front["distance_mm"] = front_tof->getDistanceMm();
    front["too_close"] = front_tof->isTooClose(now_ms);
    front["present"] = front_tof->isPresent();

    JsonObject imu_obj = doc["imu"].to<JsonObject>();
    imu_obj["ok"] = imu->isOperational();
    if (imu->isOperational()) {
        imu_obj["heading"] = imu->getHeading();
    }

    JsonObject pwr = doc["power"].to<JsonObject>();
    pwr["ok"] = power->isOperational();
    if (power->isOperational()) {
        pwr["voltage_v"] = power->getBusVoltage();
        pwr["battery_pct"] = power->getBatteryPct();
    }

    // Direct serialization to stream — zero intermediate buffer
    serializeJson(doc, stream);
    stream.println();
}

void ZeroCopyTelemetry::emitTickStatus(Stream& stream, uint32_t now_ms,
    ModeManager* modeManager,
    Encoder encoders[],
    BTS7960Driver motors[],
    SafetyController* safety,
    int16_t nav_vx, int16_t nav_vy, int16_t nav_omega,
    uint8_t max_pct)
{
    JsonDocument doc;
    doc["ts"] = now_ms;
    doc["type"] = 143;
    doc["mode"] = Watchdog::modeName(modeManager->getMode());
    doc["safety"] = (uint8_t)safety->getLevel();

    JsonArray nav = doc["nav"].to<JsonArray>();
    nav.add(nav_vx);
    nav.add(nav_vy);
    nav.add(nav_omega);

    JsonArray motorsArr = doc["motors"].to<JsonArray>();
    const int16_t* tgt = modeManager->getRampedSpeeds();
    for (int i = 0; i < MOTOR_COUNT; i++) {
        JsonObject m = motorsArr.add<JsonObject>();
        m["t"] = tgt[i];  // Compact: target only
        m["r"] = (int)(encoders[i].getFilteredRPM() * MOTOR_PINS[i].dir);
        m["e"] = motors[i].isEnabled() ? 1 : 0;
    }

    serializeJson(doc, stream);
    stream.println();
}

void ZeroCopyTelemetry::emitEncoderSnapshot(Stream& stream,
    const int16_t* ramped_speeds, Encoder encoders[])
{
    JsonDocument doc;
    doc["type"] = 130;

    JsonArray arr = doc["encoders"].to<JsonArray>();
    for (int i = 0; i < MOTOR_COUNT; i++) {
        JsonObject enc = arr.add<JsonObject>();
        enc["id"] = i;
        enc["name"] = MOTOR_NAMES[i];
        enc["count"] = (long)(encoders[i].getCumulativeCount() * MOTOR_PINS[i].dir);
        enc["rpm"] = encoders[i].getFilteredRPM() * MOTOR_PINS[i].dir;
        enc["target"] = ramped_speeds[i];
    }

    serializeJson(doc, stream);
    stream.println();
}

void ZeroCopyTelemetry::emitIMU(Stream& stream, BNO055Sensor* imu,
    const ImuSafetyEvaluator* safety_eval)
{
    (void)safety_eval;
    JsonDocument doc;
    doc["type"] = 134;

    if (imu->isOperational()) {
        doc["yaw"] = imu->getHeading();
        doc["pitch"] = imu->getPitch();
        doc["roll"] = imu->getRoll();
        doc["temp"] = imu->getTemperature();

        // Use single calibration status instead of individual components
        doc["cal_status"] = imu->getCalibrationStatus();
    } else {
        doc["error"] = "IMU not operational";
    }

    serializeJson(doc, stream);
    stream.println();
}

void ZeroCopyTelemetry::emitPower(Stream& stream, INA226Sensor* power)
{
    JsonDocument doc;
    doc["type"] = 133;

    if (power->isOperational()) {
        doc["voltage_v"] = power->getBusVoltage();
        doc["current_a"] = power->getCurrent();
        doc["power_w"] = power->getPower();
        doc["battery_pct"] = power->getBatteryPct();
        doc["battery_status"] = power->getBatteryStatus();
    } else {
        doc["error"] = "Power monitor not operational";
    }

    serializeJson(doc, stream);
    stream.println();
}

void ZeroCopyTelemetry::emitSafetyEvent(Stream& stream, uint32_t now_ms,
    SafetyController* safety)
{
    const SafetyEvent& evt = safety->getLatestEvent();

    JsonDocument doc;
    doc["type"] = 146;  // New type for safety events
    doc["ts"] = now_ms;
    doc["level"] = (uint8_t)evt.level;
    doc["level_name"] = safety->levelToString(evt.level);
    doc["source"] = evt.source;
    doc["reason"] = evt.reason;
    doc["event_ts"] = evt.timestamp_ms;

    serializeJson(doc, stream);
    stream.println();
}

void ZeroCopyTelemetry::emitAlive(Stream& stream, uint32_t now_ms,
    uint32_t alive_counter, SafetyController* safety,
    ModeManager* modeManager)
{
    JsonDocument doc;
    doc["type"] = 144;
    doc["uptime_ms"] = now_ms;
    doc["alive"] = alive_counter;
    doc["safety"] = (uint8_t)safety->getLevel();
    doc["mode"] = Watchdog::modeName(modeManager->getMode());

    serializeJson(doc, stream);
    stream.println();
}

void ZeroCopyTelemetry::emitAck(Stream& stream, const char* command,
    const char* status)
{
    JsonDocument doc;
    doc["type"] = 128;
    doc["command"] = command;
    doc["status"] = status;

    serializeJson(doc, stream);
    stream.println();
}

void ZeroCopyTelemetry::emitError(Stream& stream, const char* code,
    const char* message, const char* severity)
{
    JsonDocument doc;
    doc["type"] = 129;
    doc["error_code"] = code;
    doc["message"] = message;
    doc["severity"] = severity;

    serializeJson(doc, stream);
    stream.println();
}

void ZeroCopyTelemetry::emitMoveAck(Stream& stream,
    uint16_t seq, const char* status, const char* reason)
{
    JsonDocument doc;
    doc["type"] = 132;
    if (seq > 0) {
        doc["seq"] = seq;
    }
    doc["status"] = status;
    if (reason) {
        doc["reason"] = reason;
    }

    serializeJson(doc, stream);
    stream.println();
}
