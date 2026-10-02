#include "ModeManager.h"
#include "BTS7960Driver.h"
#include "Encoder.h"
#include "PIDController.h"
#include "MecanumDrive.h"
#include "AdaptivePID.h"
#include "config.h"
#include <Arduino.h>

// Phase 3: Battery feed-forward in AUTO_ROAM requires access to g_adaptive_pid
extern AdaptivePID g_adaptive_pid;

ModeManager::ModeManager()
    : last_mode_(MODE_SAFE)
    , nav_vx_(0), nav_vy_(0), nav_omega_(0)
    , estop_active_(false)
    , pid_enabled_(true)
    , max_speed_pct_(100)
    , accel_ramp_rate_(ACCEL_RAMP_RATE)
    , kick_boost_pwm_(KICK_BOOST_PWM)
    , kick_boost_ticks_(KICK_BOOST_TICKS)
{
    for (int i = 0; i < 4; i++) {
        ramped_speeds_[i] = 0;
        mecanum_targets_[i] = 0;
        kick_ticks_[i]     = 0;
        prev_target_for_kick_[i] = 0;
    }
}

void ModeManager::begin()
{
    watchdog_.begin();
    Serial.printf("[ModeManager] Initialized — AUTO_ROAM pending\n");
}

void ModeManager::attachSensors(BNO055Sensor* imu,
                                IRProximitySensor* ir,
                                FrontTofSensor* front_tof,
                                INA226Sensor* power,
                                VL53L0XSensor* tof,
                                CylinderActuator* cylinder)
{
    auto_roam_.attachSensors(imu, ir, front_tof, power, tof, cylinder);
    Serial.println("[ModeManager] AutoRoam sensors attached");
}

void ModeManager::update(uint32_t now_ms)
{
    SystemMode prev = watchdog_.getMode();
    watchdog_.update(now_ms);
    SystemMode curr = watchdog_.getMode();

    if (curr != prev) {
        Serial.printf("[ModeManager] Mode changed: %s -> %s\n",
            Watchdog::modeName(prev), Watchdog::modeName(curr));
        if (curr == MODE_SAFE && !watchdog_.isForcedAutoRoam()) {
            nav_vx_ = nav_vy_ = nav_omega_ = 0;
            for (int i = 0; i < MOTOR_COUNT; i++) {
                ramped_speeds_[i] = 0;
                kick_ticks_[i] = 0;
            }
            if (auto_roam_.isUnloading()) {
                auto_roam_.cancelUnloading(AutoRoam::DOCK_ERROR_PI_LINK_LOST);
            }
            obstacle_.clearObstacles(now_ms);
            Serial.println("[ModeManager] Pi heartbeat lost; motion stopped in SAFE mode");
        }
        last_mode_ = curr;
    }

    obstacle_.update(now_ms);
}

void ModeManager::requestRecovery(uint32_t now_ms)
{
    if (watchdog_.getMode() == MODE_AUTO_ROAM) {
        auto_roam_.requestRecovery(now_ms);
        return;
    }
    // NAV / MANUAL have no local planner. Zero the last command so the
    // chassis stops pushing into the jam; the motion watchdog in main.cpp
    // still escalates to E-stop if the operator/Pi keeps sending motion.
    nav_vx_ = nav_vy_ = nav_omega_ = 0;
    Serial.println("[ModeManager] motion-progress recovery: command zeroed");
}

void ModeManager::enterEStop(uint32_t now_ms)
{
    estop_active_ = true;
    pid_enabled_ = false;
    nav_vx_ = nav_vy_ = nav_omega_ = 0;
    for (int i = 0; i < MOTOR_COUNT; i++) {
        ramped_speeds_[i] = 0;
        kick_ticks_[i] = 0;
    }
    obstacle_.clearObstacles(now_ms);
    auto_roam_.cancelUnloading(AutoRoam::DOCK_ERROR_E_STOP);
    Serial.println("[ModeManager] E-STOP activated; autonomous output latched");
}

void ModeManager::clearEStop(uint32_t now_ms)
{
    estop_active_ = false;
    pid_enabled_ = true;
    nav_vx_ = nav_vy_ = nav_omega_ = 0;
    for (int i = 0; i < MOTOR_COUNT; i++) {
        ramped_speeds_[i] = 0;
        kick_ticks_[i] = 0;
    }
    obstacle_.clearObstacles(now_ms);
    auto_roam_.reset();
    // Clearing the hardware latch must not resume a dock's AUTO_ROAM mode.
    // A new Pi heartbeat or an explicit operator command is required before
    // any motion path can become active again.
    watchdog_.setMode(MODE_SAFE);
    Serial.println("[ModeManager] E-STOP cleared; waiting in SAFE for a new command");
}

void ModeManager::finishDock(uint32_t now_ms)
{
    nav_vx_ = nav_vy_ = nav_omega_ = 0;
    for (int i = 0; i < MOTOR_COUNT; i++) {
        ramped_speeds_[i] = 0;
        kick_ticks_[i] = 0;
    }
    obstacle_.clearObstacles(now_ms);
    watchdog_.setMode(MODE_NAV);
    Serial.println("[ModeManager] Dock complete; holding still in NAV mode");
}

bool ModeManager::startLeaveDock(uint32_t now_ms)
{
    if (!auto_roam_.startLeaveDock()) return false;
    watchdog_.setMode(MODE_AUTO_ROAM);
    Serial.printf("[ModeManager] Leave-dock started at %lu ms\n",
                  (unsigned long)now_ms);
    return true;
}

void ModeManager::onPiCommand(const Command& cmd, uint32_t now_ms)
{
    // A cancel is always allowed so an interrupted unload can be brought to a
    // known stopped state while the operator keeps the E-stop latched.
    if (estop_active_) {
        if (cmd.type == CMD_CANCEL_DOCK) {
            auto_roam_.cancelUnloading(AutoRoam::DOCK_ERROR_E_STOP);
        }
        return;
    }

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
            for (int i = 0; i < 4; i++) { ramped_speeds_[i] = 0; kick_ticks_[i] = 0; }
            break;

        case CMD_E_STOP:
            enterEStop(now_ms);
            break;

        case CMD_E_STOP_CLEAR:
            clearEStop(now_ms);
            break;

        case CMD_FORCE_AUTO_ROAM:
            auto_roam_.reset();
            watchdog_.setMode(MODE_AUTO_ROAM, true);
            Serial.println("[ModeManager] FORCED into standalone AUTO_ROAM");
            break;

        case CMD_OBSTACLE_LEFT:
            obstacle_.onObstacleEvent(ObstacleDirection::LEFT, now_ms,
                                      cmd.obstacle_has_payload,
                                      cmd.obstacle_distance_m,
                                      cmd.obstacle_severity);
            break;

        case CMD_OBSTACLE_RIGHT:
            obstacle_.onObstacleEvent(ObstacleDirection::RIGHT, now_ms,
                                      cmd.obstacle_has_payload,
                                      cmd.obstacle_distance_m,
                                      cmd.obstacle_severity);
            break;

        case CMD_OBSTACLE_FRONT:
            obstacle_.onObstacleEvent(ObstacleDirection::FRONT, now_ms,
                                      cmd.obstacle_has_payload,
                                      cmd.obstacle_distance_m,
                                      cmd.obstacle_severity);
            break;

        case CMD_OBSTACLE_FRONT_LEFT:
            obstacle_.onObstacleEvent(ObstacleDirection::FRONT_LEFT, now_ms,
                                      cmd.obstacle_has_payload,
                                      cmd.obstacle_distance_m,
                                      cmd.obstacle_severity);
            auto_roam_.setFrontCornerBlocked(true, false);
            break;

        case CMD_OBSTACLE_FRONT_RIGHT:
            obstacle_.onObstacleEvent(ObstacleDirection::FRONT_RIGHT, now_ms,
                                      cmd.obstacle_has_payload,
                                      cmd.obstacle_distance_m,
                                      cmd.obstacle_severity);
            auto_roam_.setFrontCornerBlocked(false, true);
            break;

        case CMD_OBSTACLE_REAR:
            obstacle_.onObstacleEvent(ObstacleDirection::REAR, now_ms,
                                      cmd.obstacle_has_payload,
                                      cmd.obstacle_distance_m,
                                      cmd.obstacle_severity);
            break;

        case CMD_OBSTACLE_REAR_LEFT:
            obstacle_.onObstacleEvent(ObstacleDirection::REAR_LEFT, now_ms,
                                      cmd.obstacle_has_payload,
                                      cmd.obstacle_distance_m,
                                      cmd.obstacle_severity);
            break;

        case CMD_OBSTACLE_REAR_RIGHT:
            obstacle_.onObstacleEvent(ObstacleDirection::REAR_RIGHT, now_ms,
                                      cmd.obstacle_has_payload,
                                      cmd.obstacle_distance_m,
                                      cmd.obstacle_severity);
            break;

        case CMD_OBSTACLE_CLEAR:
            obstacle_.clearObstacles(now_ms);
            auto_roam_.clearFrontCorners();
            // Explicit Pi clear is also the only non-e-stop route to reset
            // the latched AUTO_ROAM avoidance FSM.  Local IR/Front ToF are still
            // polled independently and can reassert the hard stop immediately.
            auto_roam_.reset();
            break;

        case CMD_SET_MAX_SPEED:
            max_speed_pct_ = constrain(cmd.max_speed, 0, 100);
            break;

        // ---- Docking / unloading sequence (Pi brain) ----
        case CMD_BEGIN_DOCK: {
            const bool started = auto_roam_.startDock(
                cmd.tag_id, cmd.target_distance_mm,
                cmd.facing_theta_deg, cmd.operation_id);
            if (started) {
                watchdog_.setMode(MODE_AUTO_ROAM);
            }
            Serial.printf("[ModeManager] CMD_BEGIN_DOCK %s tag=%u target=%u opId=%s\n",
                started ? "accepted" : "rejected", cmd.tag_id,
                cmd.target_distance_mm,
                cmd.operation_id[0] ? cmd.operation_id : "-");
        } break;

        case CMD_BEGIN_LEAVE_DOCK:
            startLeaveDock(now_ms);
            break;

        case CMD_CANCEL_DOCK:
            // A late cleanup command after a completed/idle dock must not
            // create a synthetic cancellation error for the next mission.
            if (auto_roam_.isUnloading()) {
                auto_roam_.cancelUnloading();
            }
            Serial.println("[ModeManager] CMD_CANCEL_DOCK");
            break;

        case CMD_GET_UNLOAD_STATE:
            // Pi queries unload state — response handled by caller (main.cpp)
            break;

        default:
            break;
    }
}

void ModeManager::applyRampAndPID(int16_t target_speeds[4],
                                    BTS7960Driver* motors, Encoder* encoders,
                                    PIDController* pids, uint32_t dt_us)
{
    // Edge-triggered per-motor debug (only when target changes a lot or PWM saturates)
    static uint32_t last_dbg_ms = 0;
    static int16_t  last_pwm[4] = {0, 0, 0, 0};

    for (int i = 0; i < MOTOR_COUNT; i++) {
        ramped_speeds_[i] = MecanumDrive::ramp(
            target_speeds[i], ramped_speeds_[i], accel_ramp_rate_);

        // Kick-start boost: fire only on a genuine target 0→non-zero
        // transition (not on ramp crossings), matching the applySpeeds()
        // logic in main.cpp.
        if (prev_target_for_kick_[i] == 0 && target_speeds[i] != 0 && kick_ticks_[i] == 0) {
            kick_ticks_[i] = (int8_t)kick_boost_ticks_;
        }
        prev_target_for_kick_[i] = target_speeds[i];

        float scale = max_speed_pct_ / 100.0f;
        int16_t limited = (int16_t)(ramped_speeds_[i] * scale);

        float target_rpm = limited * (MOTOR_NOMINAL_RPM / (float)MOTOR_RPM_REF_DUTY);

        if (pid_enabled_) {
            // Sign the measurement with the motor's dir so the PID
            // matches the wheel's physical rotation (avoids fabsf masking
            // a mis-wired motor).
            float actual_rpm = encoders[i].getFilteredRPM() * (float)MOTOR_PINS[i].dir;
            int16_t correction = pids[i].compute(target_rpm, actual_rpm, dt_us);

            // Phase 3: battery feed-forward compensates for voltage sag, matching
            // the NAV path in applySpeeds() so AUTO_ROAM and NAV behave identically
            // at the same battery state.
            float ff = g_adaptive_pid.getBatteryCompensation();
            int16_t final_pwm = (int16_t)((limited + correction) * ff);
            final_pwm = constrain(final_pwm, -MOTOR_MAX_DUTY, MOTOR_MAX_DUTY);

            // Kick boost applied AFTER PID, independent of target_rpm.
            if (kick_ticks_[i] > 0) {
                int16_t boost = (limited > 0) ? (int16_t)kick_boost_pwm_ : -(int16_t)kick_boost_pwm_;
                final_pwm = constrain(final_pwm + boost, -MOTOR_MAX_DUTY, MOTOR_MAX_DUTY);
                kick_ticks_[i]--;
            }

            int16_t motor_cmd = final_pwm * MOTOR_PINS[i].dir;
            motors[i].setSpeed(motor_cmd);

            // Log when PWM is saturated OR motor won't move —
            // both signal "something is wrong with this motor".
            uint32_t now = millis();
            if (now - last_dbg_ms > 2000) {
                bool saturated = (abs(final_pwm) >= MOTOR_MAX_DUTY - 2);
                bool dead_motor = (abs(actual_rpm) < 2.0f && abs(target_rpm) > 50.0f);
                if (saturated || dead_motor) {
                    Serial.printf("  [PID %s] tgtRPM=%3.0f actRPM=%+4.0f corr=%+4d pwm=%+4d EN=%d\n",
                        MOTOR_NAMES[i], target_rpm, actual_rpm, correction, final_pwm,
                        motors[i].isEnabled() ? 1 : 0);
                }
                last_pwm[i] = final_pwm;
            }
        } else {
            motors[i].setSpeed(limited * MOTOR_PINS[i].dir);
        }
    }
    if (millis() - last_dbg_ms > 2000) last_dbg_ms = millis();
}

void ModeManager::applyMotorOutputs(BTS7960Driver* motors, Encoder* encoders,
                                      PIDController* pids, MecanumDrive* mecanum,
                                      uint32_t now_ms, uint32_t dt_us)
{
    if (estop_active_) {
        for (int i = 0; i < MOTOR_COUNT; i++) {
            motors[i].emergencyStop();
        }
        return;
    }

    SystemMode mode = watchdog_.getMode();
    int16_t target_speeds[4];

    if (mode == MODE_SAFE) {
        for (int i = 0; i < MOTOR_COUNT; i++) {
            motors[i].coast();
            ramped_speeds_[i] = 0;
            kick_ticks_[i] = 0;
        }
        return;
    }

    if (mode == MODE_NAV && (nav_vx_ != 0 || nav_vy_ != 0 || nav_omega_ != 0)) {
        mecanum->compute(nav_vx_, nav_vy_, nav_omega_, target_speeds);
    }
    else if (mode == MODE_AUTO_ROAM) {
        // Hold the terminal COMPLETE frame for telemetry and never fall
        // through to normal sensor roaming before the Pi sends the next goal.
        if (auto_roam_.getUnloadState() == AutoRoam::UNLOAD_COMPLETE) {
            finishDock(now_ms);
            for (int i = 0; i < MOTOR_COUNT; i++) {
                motors[i].coast();
                ramped_speeds_[i] = 0;
            }
            return;
        }

        int16_t roam_vx = 0, roam_vy = 0, roam_omega = 0;
        if (auto_roam_.compute(now_ms, roam_vx, roam_vy, roam_omega, encoders)) {
            mecanum->compute(roam_vx, roam_vy, roam_omega, target_speeds);
        } else {
            if (auto_roam_.getUnloadState() == AutoRoam::UNLOAD_COMPLETE) {
                finishDock(now_ms);
            }
            // front-ToF-triggered soft-hold: zero PWM but DO NOT latch EN low.
            // emergencyStop() would set enabled_=false and stop wheels permanently
            // until E-STOP is cleared. coast() just zeros PWM and leaves the
            // driver enabled so the next tick can resume immediately.
            for (int i = 0; i < MOTOR_COUNT; i++) {
                motors[i].coast();
            }
            for (int i = 0; i < MOTOR_COUNT; i++) {
                ramped_speeds_[i] = 0;
            }
            return;
        }
    }
    else {
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
                encoders[i].getFilteredRPM() * MOTOR_PINS[i].dir,
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
