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
class FrontTofSensor;
class INA226Sensor;
class VL53L0XSensor;
class CylinderActuator;

class ModeManager {
public:
    ModeManager();

    void begin();

    void update(uint32_t now_ms);

    void onPiCommand(const Command& cmd, uint32_t now_ms);

    /// Keep the autonomous control path latched with main.cpp's hardware
    /// interlock. Only clearEStop() may re-arm motor output.
    void enterEStop(uint32_t now_ms);
    void clearEStop(uint32_t now_ms);

    /// Motion-progress watchdog: ask AUTO_ROAM to replan instead of
    /// continuing to push into a jam. NAV mode has no local planner, so
    /// the watchdog in main.cpp still hard-stops after MOTION_STUCK_STOP_MS.
    void requestRecovery(uint32_t now_ms);

    /// Keep the autonomous output path aligned with the global NAV speed cap.
    void setMaxSpeedPct(uint8_t pct) { max_speed_pct_ = pct; }

    /// Phase 3: drive the AUTO_ROAM ramp from DynamicAcceleration profiles.
    /// main.cpp refreshes these each tick from g_accel; defaults mirror
    /// config.h so behavior is unchanged until it is wired.
    void setAccelParams(uint8_t ramp_rate, uint8_t kick_pwm, uint8_t kick_ticks) {
        accel_ramp_rate_  = ramp_rate;
        kick_boost_pwm_   = kick_pwm;
        kick_boost_ticks_ = kick_ticks;
    }

    /// Forward proof-of-life from any byte received on the Pi UART, even if
    /// the command frame was corrupt (e.g. cable yank mid-packet).
    void onSerialActivity(uint32_t now_ms) { watchdog_.onSerialActivity(now_ms); }

    void attachSensors(BNO055Sensor* imu,
                       IRProximitySensor* ir,
                       FrontTofSensor* front_tof,
                       INA226Sensor* power,
                       VL53L0XSensor* tof,
                       CylinderActuator* cylinder);

    /// Trigger unloading sequence (forward to Pi via CMD)
    void startDock(uint16_t tag_id, uint16_t target_distance_mm,
                   float facing_theta_deg = -999.0f,
                   const char* operation_id = nullptr) {
        auto_roam_.startDock(tag_id, target_distance_mm, facing_theta_deg, operation_id);
    }

    /// Manually trigger the leave-dock reverse phase.
    bool startLeaveDock(uint32_t now_ms);

    /// End an autonomous dock with no residual motion; Pi/heartbeat owns the
    /// next navigation command rather than AUTO_ROAM resuming on its own.
    void finishDock(uint32_t now_ms);

    /// Cancel unloading sequence
    void cancelUnloading(AutoRoam::DockError error = AutoRoam::DOCK_ERROR_CANCELLED) {
        auto_roam_.cancelUnloading(error);
    }

    [[nodiscard]] AutoRoam::UnloadState getUnloadState() const { return auto_roam_.getUnloadState(); }
    [[nodiscard]] AutoRoam& getAutoRoam() { return auto_roam_; }

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
    [[nodiscard]] const ObstacleAvoidance& getObstacleAvoidance() const { return obstacle_; }

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
    int8_t  kick_ticks_[4];
    int16_t prev_target_for_kick_[4];  // trigger kick only on target transitions

    bool estop_active_;
    bool pid_enabled_;
    uint8_t max_speed_pct_;

    // Phase 3: DynamicAcceleration-driven ramp params. Initialized to the
    // config.h constants in the constructor; overwritten each tick by
    // main.cpp's setAccelParams() once g_accel is wired in.
    uint8_t accel_ramp_rate_;
    uint8_t kick_boost_pwm_;
    uint8_t kick_boost_ticks_;
};
