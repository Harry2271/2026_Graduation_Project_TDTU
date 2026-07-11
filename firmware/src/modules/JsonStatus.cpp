#include "JsonStatus.h"
#include "ModeManager.h"
#include "MecanumDrive.h"
#include "BTS7960Driver.h"
#include "Encoder.h"
#include "PIDController.h"
#include "BNO055Sensor.h"
#include "INA226Sensor.h"
#include "IRProximitySensor.h"
#include "SharpFrontSensor.h"
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
    JsonArray arr = doc.createNestedArray("motors");
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
    if (imu->isOperational()) {
        doc["heading"] = imu->getHeading();
        doc["err"]     = imu->getHeadingError();
        doc["accel_x"] = imu->getLinearAccelX();
        doc["accel_y"] = imu->getLinearAccelY();
        doc["gyro_z"]  = imu->getGyroZ();
        doc["temp_c"]  = imu->getTemperature();
        JsonObject cal = doc.createNestedObject("cal");
        cal["sys"]   = imu->getCalSys();
        cal["gyro"]  = imu->getCalGyro();
        cal["accel"] = imu->getCalAccel();
        cal["mag"]   = imu->getCalMag();
    } else {
        doc["ok"] = false;
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
    if (power->isOperational()) {
        doc["voltage_v"] = power->getBusVoltage();
        doc["current_a"] = power->getCurrent();
        doc["power_w"]   = power->getPower();
        doc["battery_pct"] = power->getBatteryPct();
        doc["battery_status"]=
            power->getBatteryStatus() == 2 ? "critical" :
            power->getBatteryStatus() == 1 ? "low" : "ok";
    } else {
        doc["ok"] = false;
    }
    size_t n = serializeJson(doc, buf, bufsize);
    if (n < bufsize) { buf[n] = '\n'; buf[n + 1] = '\0'; n++; }
    return n;
}
