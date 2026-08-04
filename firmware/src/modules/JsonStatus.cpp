#include "JsonStatus.h"
#include "ModeManager.h"
#include "AutoRoam.h"
#include "MecanumDrive.h"
#include "BTS7960Driver.h"
#include "Encoder.h"
#include "PIDController.h"
#include "BNO055Sensor.h"
#include "INA226Sensor.h"
#include "IRProximitySensor.h"
#include "SharpFrontSensor.h"
#include "VL53L0XSensor.h"
#include "CylinderActuator.h"
#include "Watchdog.h"
#include "config.h"

using namespace ArduinoJson;

// =======================================================================
// Full system status — JSON, one line per message.
// =======================================================================
size_t JsonStatus::emitFullStatus(char* buf, size_t bufsize, uint32_t now_ms,
    ModeManager* modeManager, MecanumDrive* mecanum,
    Encoder encoders[], PIDController pids[],
    BTS7960Driver motors[],
    BNO055Sensor* imu, INA226Sensor* power,
    IRProximitySensor* ir, SharpFrontSensor* sharp,
    VL53L0XSensor* tof, CylinderActuator* cylinder,
    int16_t nav_vx, int16_t nav_vy, int16_t nav_omega,
    bool e_stop, uint8_t max_pct)
{
    (void)mecanum; (void)pids;
    JsonDocument doc;

    doc["ts"]   = now_ms;
    doc["type"] = 131;
    doc["mode"] = Watchdog::modeName(modeManager->getMode());
    doc["estop"]= e_stop;
    doc["pid"]  = modeManager->isPIDEnabled();
    doc["max_pct"] = max_pct;

    JsonObject nav = doc.createNestedObject("nav");
    nav["vx"]    = nav_vx;
    nav["vy"]    = nav_vy;
    nav["omega"] = nav_omega;

    JsonArray motorsArr = doc.createNestedArray("motors");
    const int16_t* tgt = modeManager->getRampedSpeeds();
    for (int i = 0; i < MOTOR_COUNT; i++) {
        JsonObject m = motorsArr.createNestedObject();
        m["id"]     = i;
        m["name"]   = MOTOR_NAMES[i];
        m["dir"]    = MOTOR_PINS[i].dir;
        m["enabled"]= motors[i].isEnabled();
        m["target"] = tgt[i];
        float rpm = encoders[i].getFilteredRPM() * MOTOR_PINS[i].dir;
        m["rpm"]    = rpm;
        m["count"]  = (long)(encoders[i].getCumulativeCount() * MOTOR_PINS[i].dir);
    }

    JsonObject ir_obj = doc.createNestedObject("ir");
    ir_obj["mask"] = ir->detectedMask();
    ir_obj["RL"]   = ir->isDetected(IRPosition::REAR_LEFT);
    ir_obj["RR"]   = ir->isDetected(IRPosition::REAR_RIGHT);
    ir_obj["L"]    = ir->isDetected(IRPosition::LEFT);
    ir_obj["R"]    = ir->isDetected(IRPosition::RIGHT);

    JsonObject shp = doc.createNestedObject("sharp");
    shp["dist_cm"]   = sharp->getDistanceCm();
    shp["too_close"] = sharp->isTooClose();
    shp["slowing"]   = sharp->isSlowing();
    shp["present"]   = sharp->isPresent();

    JsonObject imu_obj = doc.createNestedObject("imu");
    if (imu->isOperational()) {
        imu_obj["ok"]      = true;
        imu_obj["heading"] = imu->getHeading();
        imu_obj["err"]     = imu->getHeadingError();
        imu_obj["accel_x"] = imu->getLinearAccelX();
        imu_obj["accel_y"] = imu->getLinearAccelY();
        imu_obj["gyro_z"]  = imu->getGyroZ();
        imu_obj["temp_c"]  = imu->getTemperature();
        imu_obj["cal_sys"]  = imu->getCalSys();
        imu_obj["cal_gyro"] = imu->getCalGyro();
        imu_obj["cal_accel"]= imu->getCalAccel();
        imu_obj["cal_mag"]  = imu->getCalMag();
    } else {
        imu_obj["ok"] = false;
    }

    JsonObject pwr = doc.createNestedObject("pwr");
    if (power->isOperational()) {
        pwr["ok"]        = true;
        pwr["voltage_v"] = power->getBusVoltage();
        pwr["current_a"] = power->getCurrent();
        pwr["power_w"]   = power->getPower();
        pwr["battery_pct"]   = power->getBatteryPct();
        pwr["battery_status"]=
            power->getBatteryStatus() == 2 ? "critical" :
            power->getBatteryStatus() == 1 ? "low" : "ok";
    } else {
        pwr["ok"] = false;
    }

    JsonObject tof_obj = doc.createNestedObject("tof");
    tof_obj["present"]   = tof->isPresent();
    tof_obj["dist_mm"]   = tof->getDistanceMm();
    tof_obj["dist_cm"]   = tof->getDistanceCm();
    tof_obj["at_unload"] = tof->isAtUnloadingDistance();

    JsonObject cyl = doc.createNestedObject("cyl");
    cyl["state"]    = CylinderActuator::stateName(cylinder->getState());
    cyl["extended"] = cylinder->isExtended();
    cyl["moving"]   = cylinder->isMoving();

    size_t n = serializeJson(doc, buf, bufsize);
    if (n < bufsize) {
        buf[n]     = '\n';
        buf[n + 1] = '\0';
        n++;
    }
    return n;
}

// =======================================================================
// Compact tick (type 131, condensed) — every 200 ms.
// =======================================================================
size_t JsonStatus::emitTickStatus(char* buf, size_t bufsize, uint32_t now_ms,
    ModeManager* modeManager,
    Encoder encoders[],
    BTS7960Driver motors[],
    BNO055Sensor* imu, INA226Sensor* power,
    IRProximitySensor* ir, SharpFrontSensor* sharp,
    VL53L0XSensor* tof, CylinderActuator* cylinder,
    int16_t nav_vx, int16_t nav_vy, int16_t nav_omega,
    bool e_stop, uint8_t max_pct)
{
    (void)motors;
    JsonDocument doc;

    doc["ts"]   = now_ms;
    doc["type"] = 131;
    doc["mode"] = Watchdog::modeName(modeManager->getMode());
    doc["estop"]= e_stop;
    doc["max_pct"] = max_pct;

    JsonArray nav = doc.createNestedArray("nav");
    nav.add(nav_vx); nav.add(nav_vy); nav.add(nav_omega);

    JsonArray motorsArr = doc.createNestedArray("motors");
    const int16_t* tgt = modeManager->getRampedSpeeds();
    for (int i = 0; i < MOTOR_COUNT; i++) {
        JsonObject m = motorsArr.createNestedObject();
        m["t"] = tgt[i];
        float rpm = encoders[i].getFilteredRPM() * MOTOR_PINS[i].dir;
        m["r"] = rpm;
        // Encoder count — useful for diagnosing dead motors
        m["c"] = encoders[i].getCumulativeCount();
        // Direction flag from config: +1 = forward-positive, -1 = reversed
        m["d"] = MOTOR_PINS[i].dir;
    }

    JsonArray ir_arr = doc.createNestedArray("ir");
    ir_arr.add(ir->isDetected(IRPosition::REAR_LEFT));
    ir_arr.add(ir->isDetected(IRPosition::REAR_RIGHT));
    ir_arr.add(ir->isDetected(IRPosition::LEFT));
    ir_arr.add(ir->isDetected(IRPosition::RIGHT));

    JsonObject st = doc.createNestedObject("st");
    st["imu"] = imu->isOperational();
    st["pwr"] = power->isOperational();
    st["sharp"] = sharp->getDistanceCm();
    st["obs"] = sharp->isTooClose() || (ir->detectedMask() != 0);
    st["tof_mm"] = tof->getDistanceMm();
    st["cyl"]    = CylinderActuator::stateName(cylinder->getState());

    size_t n = serializeJson(doc, buf, bufsize);
    if (n < bufsize) {
        buf[n] = '\n';
        buf[n + 1] = '\0';
        n++;
    }
    return n;
}

// =======================================================================
// Type 130 — encoder snapshot
// =======================================================================
size_t JsonStatus::emitEncoderSnapshot(char* buf, size_t bufsize,
    const int16_t* ramped_speeds, Encoder encoders[])
{
    JsonDocument doc;
    doc["type"] = 130;
    doc["ts"]   = millis();
    JsonObject data = doc["data"].to<JsonObject>();
    JsonArray arr = data["motors"].to<JsonArray>();
    for (int i = 0; i < MOTOR_COUNT; i++) {
        JsonObject m = arr.createNestedObject();
        m["id"]   = i;
        m["name"] = MOTOR_NAMES[i];
        m["tgt"]  = ramped_speeds[i];
        float rpm = encoders[i].getFilteredRPM() * MOTOR_PINS[i].dir;
        m["rpm"]  = rpm;
        m["cnt"]  = (long)(encoders[i].getCumulativeCount() * MOTOR_PINS[i].dir);
    }
    size_t n = serializeJson(doc, buf, bufsize);
    if (n < bufsize) { buf[n] = '\n'; buf[n + 1] = '\0'; n++; }
    return n;
}

// =======================================================================
// Type 137 — combined IR + Sharp obstacle state
// =======================================================================
size_t JsonStatus::emitObstacle(char* buf, size_t bufsize,
    IRProximitySensor* ir, SharpFrontSensor* sharp)
{
    JsonDocument doc;
    doc["type"] = 137;
    doc["ts"]   = millis();
    doc["sharp_cm"]    = sharp->getDistanceCm();
    doc["sharp_close"] = sharp->isTooClose();
    JsonArray ir_arr = doc.createNestedArray("ir");
    ir_arr.add(ir->isDetected(IRPosition::REAR_LEFT));
    ir_arr.add(ir->isDetected(IRPosition::REAR_RIGHT));
    ir_arr.add(ir->isDetected(IRPosition::LEFT));
    ir_arr.add(ir->isDetected(IRPosition::RIGHT));
    size_t n = serializeJson(doc, buf, bufsize);
    if (n < bufsize) { buf[n] = '\n'; buf[n + 1] = '\0'; n++; }
    return n;
}

// =======================================================================
// Type 134 — IMU
// =======================================================================
size_t JsonStatus::emitIMU(char* buf, size_t bufsize, BNO055Sensor* imu)
{
    JsonDocument doc;
    doc["type"] = 134;
    doc["ts"]   = millis();
    JsonObject data = doc["data"].to<JsonObject>();
    if (imu->isOperational()) {
        data["heading"] = imu->getHeading();
        data["err"]     = imu->getHeadingError();
        data["accel_x"] = imu->getLinearAccelX();
        data["accel_y"] = imu->getLinearAccelY();
        data["gyro_z"]  = imu->getGyroZ();
        data["temp_c"]  = imu->getTemperature();
        JsonObject cal = data["cal"].to<JsonObject>();
        cal["sys"]   = imu->getCalSys();
        cal["gyro"]  = imu->getCalGyro();
        cal["accel"] = imu->getCalAccel();
        cal["mag"]   = imu->getCalMag();
    } else {
        data["ok"] = false;
    }
    size_t n = serializeJson(doc, buf, bufsize);
    if (n < bufsize) { buf[n] = '\n'; buf[n + 1] = '\0'; n++; }
    return n;
}

// =======================================================================
// Type 133 — Power
// =======================================================================
size_t JsonStatus::emitPower(char* buf, size_t bufsize, INA226Sensor* power)
{
    JsonDocument doc;
    doc["type"] = 133;
    doc["ts"]   = millis();
    JsonObject data = doc["data"].to<JsonObject>();
    if (power->isOperational()) {
        data["voltage_v"] = power->getBusVoltage();
        data["current_a"] = power->getCurrent();
        data["power_w"]   = power->getPower();
        data["battery_pct"] = power->getBatteryPct();
        data["battery_status"]=
            power->getBatteryStatus() == 2 ? "critical" :
            power->getBatteryStatus() == 1 ? "low" : "ok";
    } else {
        data["ok"] = false;
    }
    size_t n = serializeJson(doc, buf, bufsize);
    if (n < bufsize) { buf[n] = '\n'; buf[n + 1] = '\0'; n++; }
    return n;
}

// =======================================================================
// Type 140 — unload / docking state
//
// Emitted on every state transition AND on explicit query.
// Lets Pi observe: distance vs target, heading gate, cylinder sub-state.
// =======================================================================
size_t JsonStatus::emitUnloadState(char* buf, size_t bufsize, uint32_t now_ms,
    const AutoRoam* auto_roam, VL53L0XSensor* tof,
    BNO055Sensor* imu, CylinderActuator* cylinder)
{
    JsonDocument doc;
    doc["type"] = 140;
    doc["ts"]   = now_ms;

    // State name lookup (index matches AutoRoam::UnloadState enum)
    static const char* STATE_NAMES[] = {
        "idle", "adjusting", "extending", "holding",
        "retracting", "done", "leaving", "complete"
    };
    uint8_t s = (uint8_t)auto_roam->getUnloadState();
    doc["state"] = (s < sizeof(STATE_NAMES) / sizeof(STATE_NAMES[0]))
                   ? STATE_NAMES[s] : "unknown";

    doc["tag_id"]    = auto_roam->getDockTagId();
    doc["target_mm"] = auto_roam->getDockTargetMm();

    if (tof && tof->isPresent()) {
        doc["current_mm"] = tof->getDistanceMm();
    } else {
        doc["current_mm"] = -1;
    }

    doc["heading_err_deg"] = auto_roam->getHeadingErrDeg();
    doc["heading_ok"]      = auto_roam->isHeadingOk();

    if (cylinder) {
        doc["cyl"] = CylinderActuator::stateName(cylinder->getState());
    } else {
        doc["cyl"] = "unknown";
    }

    size_t n = serializeJson(doc, buf, bufsize);
    if (n < bufsize) { buf[n] = '\n'; buf[n + 1] = '\0'; n++; }
    return n;
}

// =====================================================================
// Type 132 — Move ACK (Pi command echo with optional seq)
// =====================================================================
size_t JsonStatus::emitMoveAck(char* buf, size_t bufsize,
                               uint16_t seq, const char* status,
                               const char* reason)
{
    if (!buf || bufsize == 0) return 0;

    StaticJsonDocument<192> doc;
    doc["type"] = 132;
    JsonObject data = doc.createNestedObject("data");
    data["seq"] = seq;
    data["status"] = status ? status : "accepted";
    if (reason && reason[0] != '\0') {
        data["reason"] = reason;
    }

    size_t n = serializeJson(doc, buf, bufsize);
    if (n < bufsize) { buf[n] = '\n'; buf[n + 1] = '\0'; n++; }
    return n;
}
