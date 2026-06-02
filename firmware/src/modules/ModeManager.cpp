#include "ModeManager.h"
#include "BTS7960Driver.h"
#include "Encoder.h"
#include "PIDController.h"
#include "MecanumDrive.h"
#include "config.h"
#include <Arduino.h>

ModeManager::ModeManager()
    : last_mode_(MODE_SAFE)
    , nav_vx_(0), nav_vy_(0), nav_omega_(0)
    , estop_active_(false)
    , pid_enabled_(true)
    , max_speed_pct_(100)
{
    for (int i = 0; i < 4; i++) {
        ramped_speeds_[i] = 0;
        mecanum_targets_[i] = 0;
    }
}

void ModeManager::begin()
{
    watchdog_.begin();
    Serial.printf("[ModeManager] Initialized in SAFE mode\n");
}

void ModeManager::update(uint32_t now_ms)
{
    SystemMode prev = watchdog_.getMode();
    watchdog_.update(now_ms);
    SystemMode curr = watchdog_.getMode();

    if (curr != prev) {
        Serial.printf("[ModeManager] Mode changed: %s -> %s\n",
            Watchdog::modeName(prev), Watchdog::modeName(curr));
        last_mode_ = curr;
    }

    obstacle_.update(now_ms);
}

void ModeManager::onPiCommand(const Command& cmd, uint32_t now_ms)
{
    if (estop_active_) return;

    watchdog_.onHeartbeatReceived(now_ms);

    switch (cmd.type) {
        case CMD_HEARTBEAT:
            break;

        case CMD_MOVE: {
            nav_vx_     = cmd.move_vx;
            nav_vy_     = cmd.move_vy;
            nav_omega_  = cmd.move_omega;
            obstacle_.applyToCommand(nav_vx_, nav_vy_, nav_omega_, now_ms);
        } break;

        case CMD_INDIVIDUAL:
            nav_vx_ = 0; nav_vy_ = 0; nav_omega_ = 0;
            for (int i = 0; i < 4; i++) {
                ramped_speeds_[i] = cmd.motor_speeds[i];
            }
            break;

        case CMD_FORWARD:
            nav_vx_ = cmd.speed; nav_vy_ = 0; nav_omega_ = 0;
            break;

        case CMD_BACKWARD:
            nav_vx_ = -cmd.speed; nav_vy_ = 0; nav_omega_ = 0;
            break;

        case CMD_STOP:
            nav_vx_ = 0; nav_vy_ = 0; nav_omega_ = 0;
            for (int i = 0; i < 4; i++) ramped_speeds_[i] = 0;
            break;

        case CMD_E_STOP:
            estop_active_ = true;
            pid_enabled_ = false;
            nav_vx_ = nav_vy_ = nav_omega_ = 0;
            for (int i = 0; i < 4; i++) ramped_speeds_[i] = 0;
            Serial.println("[ModeManager] E-STOP activated");
            break;

        case CMD_E_STOP_CLEAR:
            estop_active_ = false;
            pid_enabled_ = true;
            Serial.println("[ModeManager] E-STOP cleared");
            break;

        case CMD_OBSTACLE_LEFT:
            obstacle_.onObstacleEvent(ObstacleDirection::LEFT, now_ms);
            break;

        case CMD_OBSTACLE_RIGHT:
            obstacle_.onObstacleEvent(ObstacleDirection::RIGHT, now_ms);
            break;

        case CMD_OBSTACLE_FRONT:
            obstacle_.onObstacleEvent(ObstacleDirection::FRONT, now_ms);
            break;

        case CMD_OBSTACLE_CLEAR:
            obstacle_.clearObstacles(now_ms);
            break;

        case CMD_SET_MAX_SPEED:
            max_speed_pct_ = constrain(cmd.max_speed, 0, 100);
            break;

        default:
            break;
    }
}

void ModeManager::applyRampAndPID(int16_t target_speeds[4],
                                    BTS7960Driver* motors, Encoder* encoders,
                                    PIDController* pids, uint32_t dt_us)
{
    for (int i = 0; i < MOTOR_COUNT; i++) {
        ramped_speeds_[i] = MecanumDrive::ramp(
            target_speeds[i], ramped_speeds_[i], ACCEL_RAMP_RATE);

        float scale = max_speed_pct_ / 100.0f;
        int16_t limited = (int16_t)(ramped_speeds_[i] * scale);

        float target_rpm = limited * (MOTOR_NOMINAL_RPM / 255.0f);

        if (pid_enabled_) {
            float actual_rpm = encoders[i].getFilteredRPM();
            int16_t correction = pids[i].compute(target_rpm, actual_rpm, dt_us);
            int16_t final_pwm = limited + correction;
            final_pwm = constrain(final_pwm, -MOTOR_MAX_DUTY, MOTOR_MAX_DUTY);
            motors[i].setSpeed(final_pwm);
        } else {
            motors[i].setSpeed(limited);
        }
    }
}

void ModeManager::applyMotorOutputs(BTS7960Driver* motors, Encoder* encoders,
                                      PIDController* pids, MecanumDrive* mecanum,
                                      uint32_t now_ms, uint32_t dt_us)
{
    (void)now_ms;

    if (estop_active_) {
        for (int i = 0; i < MOTOR_COUNT; i++) {
            motors[i].emergencyStop();
        }
        return;
    }

    SystemMode mode = watchdog_.getMode();
    int16_t target_speeds[4];

    if (mode == MODE_NAV && (nav_vx_ != 0 || nav_vy_ != 0 || nav_omega_ != 0)) {
        mecanum->compute(nav_vx_, nav_vy_, nav_omega_, target_speeds);
    } else {
        mecanum->stop(target_speeds);
    }

    applyRampAndPID(target_speeds, motors, encoders, pids, dt_us);
}

void ModeManager::getTelemetryJson(char* buf, size_t bufsize,
                                     Encoder* encoders, PIDController* pids)
{
    (void)pids;
    SystemMode mode = watchdog_.getMode();
    int n = snprintf(buf, bufsize,
        "{\"type\":\"telemetry\",\"mode\":\"%s\",\"e_stop\":%s,\"pid\":%s,\"max_pct\":%d,",
        Watchdog::modeName(mode),
        estop_active_ ? "true" : "false",
        pid_enabled_ ? "true" : "false",
        max_speed_pct_);

    if (n > 0 && (size_t)n < bufsize) {
        char* p = buf + n;
        size_t left = bufsize - n;

        n = snprintf(p, left, "\"rpm\":[");
        if (n > 0 && n < left) { p += n; left -= n; }
        for (int i = 0; i < MOTOR_COUNT; i++) {
            n = snprintf(p, left, "%.1f%s",
                encoders[i].getFilteredRPM(),
                i < MOTOR_COUNT - 1 ? "," : "");
            if (n > 0 && n < left) { p += n; left -= n; }
        }
        n = snprintf(p, left, "],\"target\":[");
        if (n > 0 && n < left) { p += n; left -= n; }
        for (int i = 0; i < MOTOR_COUNT; i++) {
            n = snprintf(p, left, "%d%s",
                ramped_speeds_[i],
                i < MOTOR_COUNT - 1 ? "," : "");
            if (n > 0 && n < left) { p += n; left -= n; }
        }
        snprintf(p, left, "],\"dodge\":%s}",
            obstacle_.isDodging() ? "true" : "false");
    }
}
