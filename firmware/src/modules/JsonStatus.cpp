#include "JsonStatus.h"
#include "ModeManager.h"
#include "AutoRoam.h"
#include "MecanumDrive.h"
#include "BTS7960Driver.h"
#include "Encoder.h"
#include "PIDController.h"
#include "BNO055Sensor.h"
#include "ImuSafetyEvaluator.h"
#include "INA226Sensor.h"
#include "IRProximitySensor.h"
#include "FrontTofSensor.h"
#include "VL53L0XSensor.h"

#include "CylinderActuator.h"
#include "CargoSensor.h"
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
    IRProximitySensor* ir, FrontTofSensor* front_tof,
    VL53L0XSensor* tof, CylinderActuator* cylinder,
    int16_t nav_vx, int16_t nav_vy, int16_t nav_omega,
    bool e_stop, uint8_t max_pct)
{
    (void)mecanum; (void)pids;
    JsonDocument doc;

    doc["ts"]   = now_ms;
    doc["type"] = 131;
    doc["mode"] = Watchdog::modeName(modeManager->getMode());
    // Keep the legacy spelling during the Pi rollout, but make the documented
    // e_stop field canonical for new consumers.
    doc["e_stop"] = e_stop;
    doc["estop"] = e_stop;
    doc["pid"]  = modeManager->isPIDEnabled();
    doc["max_pct"] = max_pct;

    JsonObject nav = doc["nav"].to<JsonObject>();
    nav["vx"]    = nav_vx;
    nav["vy"]    = nav_vy;
    nav["omega"] = nav_omega;

    JsonArray motorsArr = doc["motors"].to<JsonArray>();
    const int16_t* tgt = modeManager->getRampedSpeeds();
    for (int i = 0; i < MOTOR_COUNT; i++) {
        JsonObject m = motorsArr.add<JsonObject>();
        m["id"]     = i;
        m["name"]   = MOTOR_NAMES[i];
        m["dir"]    = MOTOR_PINS[i].dir;
        m["enabled"]= motors[i].isEnabled();
        m["target"] = tgt[i];
        float rpm = encoders[i].getFilteredRPM() * MOTOR_PINS[i].dir;
        m["rpm"]    = rpm;
        m["count"]  = (long)(encoders[i].getCumulativeCount() * MOTOR_PINS[i].dir);
    }

    JsonObject ir_obj = doc["ir"].to<JsonObject>();
    ir_obj["mask"] = ir->detectedMask();
    ir_obj["RL"]   = ir->isDetected(IRPosition::REAR_LEFT);
    ir_obj["RR"]   = ir->isDetected(IRPosition::REAR_RIGHT);
    ir_obj["L"]    = ir->isDetected(IRPosition::LEFT);
    ir_obj["R"]    = ir->isDetected(IRPosition::RIGHT);

    const bool front_stale = front_tof->isStale(now_ms);
    const bool front_valid = front_tof->isReadingValid() && !front_stale;
    JsonObject front = doc["front_tof"].to<JsonObject>();
    front["sensor"] = "vl53l1x";
    front["distance_mm"] = front_tof->getDistanceMm();
    front["distance_cm"] = front_tof->getDistanceCm();
    front["valid"] = front_valid;
    front["stale"] = front_stale;
    front["present"] = front_tof->isPresent();
    front["too_close"] = front_tof->isTooClose(now_ms);
    front["slowing"] = front_tof->isSlowing(now_ms);

    // Legacy full-status alias retained during the Pi/UI rollout.
    JsonObject shp = doc["sharp"].to<JsonObject>();
    shp["dist_cm"] = front_tof->getDistanceCm();
    shp["too_close"] = front_tof->isTooClose(now_ms);
    shp["slowing"] = front_tof->isSlowing(now_ms);
    shp["present"] = front_tof->isPresent();

    JsonObject imu_obj = doc["imu"].to<JsonObject>();
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

    JsonObject pwr = doc["pwr"].to<JsonObject>();
    if (power->isOperational()) {
        pwr["ok"]        = true;
        pwr["voltage_v"] = power->getBusVoltage();
        pwr["current_a"] = power->getCurrent();
        pwr["power_w"]   = power->getPower();
        pwr["battery_pct"]   = power->getBatteryPct();
        pwr["battery_status"]=
            power->isNoLoad()  ? "unknown" :
            power->getBatteryStatus() == 2 ? "critical" :
            power->getBatteryStatus() == 1 ? "low" : "ok";
        pwr["noload"] = power->isNoLoad();
    } else {
        pwr["ok"] = false;
    }

    JsonObject tof_obj = doc["tof"].to<JsonObject>();
    tof_obj["present"]   = tof->isPresent();
    tof_obj["dist_mm"]   = tof->getDistanceMm();
    tof_obj["dist_cm"]   = tof->getDistanceCm();
    tof_obj["at_unload"] = tof->isAtUnloadingDistance();

    JsonObject cyl = doc["cyl"].to<JsonObject>();
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
    IRProximitySensor* ir, FrontTofSensor* front_tof,
    VL53L0XSensor* tof, CylinderActuator* cylinder,
    CargoSensor* cargo,
    int16_t nav_vx, int16_t nav_vy, int16_t nav_omega,
    bool e_stop, uint8_t max_pct)
{
    (void)motors;
    JsonDocument doc;

    doc["ts"]   = now_ms;
    doc["type"] = 143;  // Compact tick telemetry (was 131, now split from full status)
    doc["mode"] = Watchdog::modeName(modeManager->getMode());
    doc["e_stop"] = e_stop;
    doc["estop"] = e_stop;
    doc["max_pct"] = max_pct;

    JsonArray nav = doc["nav"].to<JsonArray>();
    nav.add(nav_vx); nav.add(nav_vy); nav.add(nav_omega);

    JsonArray motorsArr = doc["motors"].to<JsonArray>();
    const int16_t* tgt = modeManager->getRampedSpeeds();
    for (int i = 0; i < MOTOR_COUNT; i++) {
        JsonObject m = motorsArr.add<JsonObject>();
        m["t"] = tgt[i];
        float rpm = encoders[i].getFilteredRPM() * MOTOR_PINS[i].dir;
        m["r"] = rpm;
        // Encoder count — useful for diagnosing dead motors
        m["c"] = encoders[i].getCumulativeCount();
        // Direction flag from config: +1 = forward-positive, -1 = reversed
        m["d"] = MOTOR_PINS[i].dir;
    }

    JsonArray ir_arr = doc["ir"].to<JsonArray>();
    ir_arr.add(ir->isDetected(IRPosition::REAR_LEFT));
    ir_arr.add(ir->isDetected(IRPosition::REAR_RIGHT));
    ir_arr.add(ir->isDetected(IRPosition::LEFT));
    ir_arr.add(ir->isDetected(IRPosition::RIGHT));

    JsonObject st = doc["st"].to<JsonObject>();
    st["imu"] = imu->isOperational();
    st["pwr"] = power->isOperational();
    const bool front_stale = front_tof->isStale(now_ms);
    const bool front_valid = front_tof->isReadingValid() && !front_stale;
    st["front_tof_cm"] = front_tof->getDistanceCm();
    st["front_tof_valid"] = front_valid;
    st["front_tof_stale"] = front_stale;
    st["front_tof_sensor"] = "vl53l1x";
    st["sharp"] = front_tof->getDistanceCm();  // legacy cm alias
    const ObstacleAvoidance& avoidance = modeManager->getObstacleAvoidance();
    st["obs"] = front_tof->isTooClose(now_ms) || front_tof->isSlowing(now_ms) || (ir->detectedMask() != 0) ||
                 avoidance.hasActiveObstacle();
    st["obstacle_dir"] = (int)avoidance.getLastDirection();
    st["obstacle_dodge"] = avoidance.isDodging();
    st["obstacle_distance_m"] = avoidance.getLastDistanceM();
    st["obstacle_severity"] = avoidance.getLastSeverity();
    st["tof_mm"] = tof->getDistanceMm();
    st["cyl"]    = CylinderActuator::stateName(cylinder->getState());
    st["cargo"]   = cargo && cargo->hasCargo();

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
        JsonObject m = arr.add<JsonObject>();
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
// Type 137 — combined IR + Front ToF obstacle state
// =======================================================================
size_t JsonStatus::emitObstacle(char* buf, size_t bufsize,
    IRProximitySensor* ir, FrontTofSensor* front_tof)
{
    JsonDocument doc;
    doc["type"] = 137;
    doc["ts"]   = millis();
    doc["front_tof_cm"]    = front_tof->getDistanceCm();
    doc["front_tof_close"] = front_tof->isTooClose(millis());
    doc["sharp_cm"] = front_tof->getDistanceCm();
    doc["sharp_close"] = front_tof->isTooClose(millis());
    JsonArray ir_arr = doc["ir"].to<JsonArray>();
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
//
// Payload (front-end contract — apps/web/src/app/trajectory/page.tsx):
//   ts:     ms (ESP32 uptime)
//   q:      [w, x, y, z]  unit quaternion
//   accel:  [x, y, z]     m/s²  (gravity removed by BNO055 NDOF fusion)
//   gyro:   [x, y, z]     deg/s
//   heading: degrees
//   temp_c: temperature
//   cal:    {sys, gyro, accel, mag}  0–3 each
// =======================================================================
size_t JsonStatus::emitIMU(char* buf, size_t bufsize, BNO055Sensor* imu,
                           const ImuSafetyEvaluator* safety)
{
    JsonDocument doc;
    doc["type"] = 134;
    doc["ts"]   = millis();
    JsonObject data = doc["data"].to<JsonObject>();
    data["ts"] = doc["ts"];
    if (imu->isOperational()) {
        // Native BNO055 fusion quaternion in the documented [w, x, y, z] order.
        JsonArray qArr = data["q"].to<JsonArray>();
        qArr.add(imu->getQuatW());
        qArr.add(imu->getQuatX());
        qArr.add(imu->getQuatY());
        qArr.add(imu->getQuatZ());
        data["quat_valid"] = imu->hasValidQuaternion();

        data["heading"] = imu->getHeading();
        data["err"]     = imu->getHeadingError();

        // ── 3-axis accel + gyro arrays (body frame) ──
        JsonArray accelArr = data["accel"].to<JsonArray>();
        accelArr.add(imu->getLinearAccelX());
        accelArr.add(imu->getLinearAccelY());
        accelArr.add(imu->getLinearAccelZ());

        JsonArray gyroArr = data["gyro"].to<JsonArray>();
        gyroArr.add(imu->getGyroX());
        gyroArr.add(imu->getGyroY());
        gyroArr.add(imu->getGyroZ());

        data["temp_c"]  = imu->getTemperature();
        JsonObject cal = data["cal"].to<JsonObject>();
        cal["sys"]   = imu->getCalSys();
        cal["gyro"]  = imu->getCalGyro();
        cal["accel"] = imu->getCalAccel();
        cal["mag"]   = imu->getCalMag();
    } else {
        data["ok"] = false;
    }

    // Keep this nested object stable even when the sensor is unavailable so
    // Pi consumers can distinguish stale/invalid data from a missing field.
    if (safety) {
        const ImuSafetyEvaluator::Snapshot& s = safety->snapshot();
        JsonObject safety_obj = data["safety"].to<JsonObject>();
        safety_obj["config_rev"] = IMU_SAFETY_CONFIG_REV;
        safety_obj["enforcement"] = safety->enforcementEnabled();
        safety_obj["sample_valid"] = s.sample_valid && imu->isOperational();
        safety_obj["heading_calibrated"] = s.heading_calibrated;
        safety_obj["tilt_deg"] = s.tilt_deg;
        safety_obj["linear_accel_mps2"] = s.linear_accel_mps2;
        safety_obj["gyro_dps"] = s.gyro_dps;
        safety_obj["tilt_warning"] = s.tilt_warning;
        safety_obj["tilt_observed"] = s.tilt_observed;
        safety_obj["shock_candidate"] = s.shock_candidate;
        safety_obj["shock_observed"] = s.shock_observed;
        safety_obj["observed_at_ms"] = s.observed_at_ms;
        safety_obj["event"] = safety->eventName(s.event);
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
            power->isNoLoad()  ? "unknown" :
            power->getBatteryStatus() == 2 ? "critical" :
            power->getBatteryStatus() == 1 ? "low" : "ok";
        data["noload"] = power->isNoLoad();
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
    JsonObject data = doc["data"].to<JsonObject>();
    uint8_t s = (uint8_t)auto_roam->getUnloadState();
    data["state"] = s;
    data["state_name"] = (s < sizeof(STATE_NAMES) / sizeof(STATE_NAMES[0]))
                         ? STATE_NAMES[s] : "unknown";
    data["tag_id"]    = auto_roam->getDockTagId();
    data["target_mm"] = auto_roam->getDockTargetMm();
    data["error"] = auto_roam->hasUnloadError();
    data["error_code"] = auto_roam->getUnloadErrorCode();
    data["error_name"] = auto_roam->getUnloadErrorName();

    if (tof && tof->isPresent()) {
        data["current_mm"] = tof->getDistanceMm();
    } else {
        data["current_mm"] = -1;
    }

    data["heading_err_deg"] = auto_roam->getHeadingErrDeg();
    data["heading_ok"]      = auto_roam->isHeadingOk();

    if (cylinder) {
        data["cyl"] = CylinderActuator::stateName(cylinder->getState());
    } else {
        data["cyl"] = "unknown";
    }

    size_t n = serializeJson(doc, buf, bufsize);
    if (n < bufsize) { buf[n] = '\n'; buf[n + 1] = '\0'; n++; }
    return n;
}

// =====================================================================
// Type 128 — generic command acknowledgement
// =====================================================================
size_t JsonStatus::emitAck(char* buf, size_t bufsize, const char* command,
                           const char* status)
{
    if (!buf || bufsize == 0) return 0;

    JsonDocument doc;
    doc["type"] = 128;
    JsonObject data = doc["data"].to<JsonObject>();
    data["cmd"] = command ? command : "unknown";
    data["status"] = status ? status : "accepted";
    data["ts"] = millis();

    size_t n = serializeJson(doc, buf, bufsize);
    if (n < bufsize) { buf[n] = '\n'; buf[n + 1] = '\0'; n++; }
    return n;
}

// =====================================================================
// Type 129 — structured firmware error for the Pi safety supervisor
// =====================================================================
size_t JsonStatus::emitError(char* buf, size_t bufsize, const char* code,
                             const char* message, const char* severity)
{
    if (!buf || bufsize == 0) return 0;

    JsonDocument doc;
    doc["type"] = 129;
    JsonObject data = doc["data"].to<JsonObject>();
    data["code"] = code ? code : "UNKNOWN";
    data["error"] = message ? message : "Unknown firmware error";
    data["severity"] = severity ? severity : "error";
    data["ts"] = millis();

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

    JsonDocument doc;
    doc["type"] = 132;
    JsonObject data = doc["data"].to<JsonObject>();
    data["seq"] = seq;
    data["status"] = status ? status : "accepted";
    if (reason && reason[0] != '\0') {
        data["reason"] = reason;
    }

    size_t n = serializeJson(doc, buf, bufsize);
    if (n < bufsize) { buf[n] = '\n'; buf[n + 1] = '\0'; n++; }
    return n;
}
