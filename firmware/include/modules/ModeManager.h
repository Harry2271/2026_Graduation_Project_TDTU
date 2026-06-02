#pragma once

#include <stdint.h>
#include "Watchdog.h"
#include "ObstacleAvoidance.h"
#include "CommandParser.h"

class BTS7960Driver;
class Encoder;
class PIDController;
class MecanumDrive;

class ModeManager {
public:
    ModeManager();

    void begin();

    void update(uint32_t now_ms);

    void onPiCommand(const Command& cmd, uint32_t now_ms);

    void applyMotorOutputs(BTS7960Driver* motors, Encoder* encoders,
                            PIDController* pids, MecanumDrive* mecanum,
                            uint32_t now_ms, uint32_t dt_us);

    void getTelemetryJson(char* buf, size_t bufsize,
                           Encoder* encoders, PIDController* pids);

    [[nodiscard]] SystemMode getMode() const { return watchdog_.getMode(); }
    [[nodiscard]] bool isEStopActive() const { return estop_active_; }
    [[nodiscard]] bool isPIDEnabled() const { return pid_enabled_; }
    [[nodiscard]] uint8_t getMaxSpeedPct() const { return max_speed_pct_; }

private:
    void applyRampAndPID(int16_t target_speeds[4],
                          BTS7960Driver* motors, Encoder* encoders,
                          PIDController* pids, uint32_t dt_us);

    Watchdog watchdog_;
    ObstacleAvoidance obstacle_;
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
