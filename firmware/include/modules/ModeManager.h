#pragma once

#include <stdint.h>
#include "Watchdog.h"
#include "ObstacleAvoidance.h"
#include "CommandParser.h"
#include "AutoRoam.h"

class BTS7960Driver;
class Encoder;
class PIDController;
class MecanumDrive;
class BNO055Sensor;
class IRProximitySensor;
class SharpFrontSensor;
class INA226Sensor;
class VL53L0XSensor;
class CylinderActuator;

class ModeManager {
public:
    ModeManager();

    void begin();

    void update(uint32_t now_ms);

    void onPiCommand(const Command& cmd, uint32_t now_ms);

    /// Forward proof-of-life from any byte received on the Pi UART, even if
    /// the command frame was corrupt (e.g. cable yank mid-packet).
    void onSerialActivity(uint32_t now_ms) { watchdog_.onSerialActivity(now_ms); }

    void attachSensors(BNO055Sensor* imu,
                       IRProximitySensor* ir,
                       SharpFrontSensor* sharp,
                       INA226Sensor* power,
                       VL53L0XSensor* tof,
                       CylinderActuator* cylinder);

    /// Trigger unloading sequence (forward to Pi via CMD)
    void startDock(uint16_t tag_id, uint16_t target_distance_mm,
                   float facing_theta_deg = -999.0f) {
        auto_roam_.startDock(tag_id, target_distance_mm, facing_theta_deg);
    }

    /// Manually trigger the leave-dock reverse phase
    void startLeaveDock() { auto_roam_.startLeaveDock(); }

    /// Cancel unloading sequence
    void cancelUnloading() { auto_roam_.cancelUnloading(); }

    [[nodiscard]] AutoRoam::UnloadState getUnloadState() const { return auto_roam_.getUnloadState(); }

    void applyMotorOutputs(BTS7960Driver* motors, Encoder* encoders,
                            PIDController* pids, MecanumDrive* mecanum,
                            uint32_t now_ms, uint32_t dt_us);

    void getTelemetryJson(char* buf, size_t bufsize,
                           Encoder* encoders, PIDController* pids);

    [[nodiscard]] SystemMode getMode() const { return watchdog_.getMode(); }
    [[nodiscard]] uint32_t getLastSerialActivityMs() const { return watchdog_.getLastSerialActivityMs(); }
    [[nodiscard]] bool hasHeartbeat() const { return watchdog_.hasHeartbeat(); }
    [[nodiscard]] bool isEStopActive() const { return estop_active_; }
    [[nodiscard]] bool isPIDEnabled() const { return pid_enabled_; }
    [[nodiscard]] uint8_t getMaxSpeedPct() const { return max_speed_pct_; }
    [[nodiscard]] const AutoRoam& getAutoRoam() const { return auto_roam_; }

    /// Per-wheel ramped speeds (after acceleration ramp + speed limit).
    /// Used by printStatus to show the *actual* speed sent to each motor.
    [[nodiscard]] const int16_t* getRampedSpeeds() const { return ramped_speeds_; }

private:
    void applyRampAndPID(int16_t target_speeds[4],
                          BTS7960Driver* motors, Encoder* encoders,
                          PIDController* pids, uint32_t dt_us);

    Watchdog watchdog_;
    ObstacleAvoidance obstacle_;
    AutoRoam auto_roam_;
    SystemMode last_mode_;

    int16_t nav_vx_;
    int16_t nav_vy_;
    int16_t nav_omega_;
    int16_t ramped_speeds_[4];
    int16_t mecanum_targets_[4];

    bool estop_active_;
    bool pid_enabled_;
    uint8_t max_speed_pct_;
};
