#pragma once

#include <stdint.h>
#include "AvoidanceFSM.h"

// Forward declarations — avoid pulling all sensor headers into one place
class BNO055Sensor;
class IRProximitySensor;
class FrontTofSensor;
class INA226Sensor;
class VL53L0XSensor;
class CylinderActuator;
class Encoder;

/**
 * AutoRoam — drives the robot autonomously using only onboard sensors
 * (no Pi / no LiDAR required).
 *
 * Behaviour, derived from the AGV flowchart for the "Pi disconnected" branch:
 *
 *   ┌─ Heading PID (BNO055)  ─► keep heading straight (omega correction)
 *   │
 *   ├─ Front ToF  (< 30 cm)  ► E-STOP
 *   ├─ front-ToF slow    (< 60 cm)  ► slow + scan IR for escape route
 *   ├─ IR rear hit              ► stop backward, nudge forward
 *   ├─ IR left hit              ► strafe right
 *   ├─ IR right hit             ► strafe left
 *   ├─ IR both side hit         ► rotate to clear
 *   │
 *   └─ Battery low (< 20 %)     ► slow down to 50 %
 *
 *   Default drive: forward + slow forward + reactive corrections.
 *
 *   Docking / unloading sequence (triggered by Pi via CMD_BEGIN_DOCK):
 *
 *     ADJUSTING → EXTENDING → HOLDING → RETRACTING → DONE → LEAVE → COMPLETE → IDLE
 */
class AutoRoam {
public:
    AutoRoam();

    /// Wire sensor pointers (call once in setup)
    void attachSensors(BNO055Sensor* imu,
                       IRProximitySensor* ir,
                       FrontTofSensor* front_tof,
                       INA226Sensor* power,
                       VL53L0XSensor* tof,
                       CylinderActuator* cylinder);

    /// Reset state (e.g. when leaving AUTO_ROAM mode)
    void reset();

    /// Compute (vx, vy, omega) for this tick. Call every PID cycle.
    /// Returns true if motion is allowed; false means HARD STOP requested.
    /// @param encoders optional — used for leave-dock distance tracking.
    bool compute(uint32_t now_ms,
                 int16_t& out_vx, int16_t& out_vy, int16_t& out_omega,
                 Encoder* encoders = nullptr);

    /// True while a front-ToF-triggered hard stop is engaged.
    [[nodiscard]] bool isHardStopped() const { return hard_stop_; }

    /// True when the unloading sequence is active (any state other than IDLE).
    [[nodiscard]] bool isUnloading() const { return unload_state_ != UNLOAD_IDLE; }

    /// True only for a non-empty idempotency key matching the active unload.
    [[nodiscard]] bool isCurrentOperation(const char* operation_id) const;

    // ---- Docking / unloading API (Pi brain → ESP32 actuator) ----

    /// Dock errors are retained after the state returns to IDLE so the Pi can
    /// distinguish a completed unload from a refused/cancelled one.
    enum DockError : uint8_t {
        DOCK_ERROR_NONE = 0,
        DOCK_ERROR_BUSY = 1,
        DOCK_ERROR_TOF_UNAVAILABLE = 2,
        DOCK_ERROR_IMU_UNAVAILABLE = 3,
        DOCK_ERROR_IMU_UNCALIBRATED = 4,
        DOCK_ERROR_ADJUST_TIMEOUT = 5,
        DOCK_ERROR_LOCAL_OBSTACLE = 6,
        DOCK_ERROR_CANCELLED = 7,
        DOCK_ERROR_E_STOP = 8,
        DOCK_ERROR_LEAVE_TIMEOUT = 9,
        DOCK_ERROR_RETRACT_TIMEOUT = 10,
        DOCK_ERROR_PI_LINK_LOST = 11,
    };

    /// Start the full docking+unloading sequence (triggered by Pi via CMD_BEGIN_DOCK).
    /// Returns false when pre-flight safety conditions reject the operation.
    /// @param facing_theta_deg target heading for the heading gate. Pass
    ///        -999.0f (or any value outside [0,360)) to use captured heading
    ///        (legacy behavior).
    bool startDock(uint16_t tag_id, uint16_t target_distance_mm,
                   float facing_theta_deg = -999.0f,
                   const char* operation_id = nullptr);

    /// Manually trigger the leave-dock reverse phase.
    /// Returns false unless the sequence is idle or ready-to-leave.
    bool startLeaveDock();

    /// Stop the actuator and reset the unloading sequence back to IDLE.
    /// The terminal error remains available through type-140 telemetry.
    void cancelUnloading(DockError error = DOCK_ERROR_CANCELLED);

    // ---- Docking state getters (for JSON telemetry type 140) ----

    [[nodiscard]] uint16_t  getDockTagId() const    { return dock_tag_id_; }
    [[nodiscard]] uint16_t  getDockTargetMm() const  { return dock_target_mm_; }
    [[nodiscard]] float     getHeadingErrDeg() const  { return heading_err_deg_; }
    [[nodiscard]] bool      isHeadingOk() const       { return heading_ok_; }
    [[nodiscard]] bool      hasUnloadError() const     { return unload_error_ != DOCK_ERROR_NONE; }
    [[nodiscard]] uint8_t   getUnloadErrorCode() const { return (uint8_t)unload_error_; }
    [[nodiscard]] const char* getUnloadErrorName() const;

    /// Unloading sub-state
    enum UnloadState : uint8_t {
        UNLOAD_IDLE       = 0,  // not unloading
        UNLOAD_ADJUSTING  = 1,  // VL53L0X + heading gate → fine-tune position
        UNLOAD_EXTENDING  = 2,  // cylinder going up
        UNLOAD_HOLDING    = 3,  // wait while dumping
        UNLOAD_RETRACTING = 4,  // cylinder going down
        UNLOAD_DONE       = 5,  // sequence complete → auto transition to LEAVE
        UNLOAD_LEAVE      = 6,  // reverse away from dock (heading-hold + encoder tracking)
        UNLOAD_COMPLETE   = 7,  // leave-dock done → return to IDLE
    };

    [[nodiscard]] UnloadState getUnloadState() const { return unload_state_; }

private:
    // Heading-hold PI controller (BNO055 Euler H → target = initial heading)
    float hold_heading_;
    bool  has_heading_;
    float heading_integral_;
    float heading_kp_;
    float heading_ki_;

    // Wall-clock for edge-triggered state changes
    uint32_t last_obstacle_ms_;
    uint32_t front_tof_clear_ms_;
    bool     hard_stop_;
    uint8_t  last_ir_mask_;
    int32_t  last_encoder_count_;   // for FSM reverse-distance tracking

    // Sensors
    BNO055Sensor*      imu_;
    IRProximitySensor* ir_;
    FrontTofSensor*  front_tof_;
    INA226Sensor*      power_;
    VL53L0XSensor*     tof_;
    CylinderActuator*  cylinder_;

    // Multi-sensor obstacle avoidance FSM (replaces old heading-hold logic)
    AvoidanceFSM      avoidance_fsm_;

    // Unloading state machine
    UnloadState unload_state_;
    uint32_t    unload_start_ms_;
    uint32_t    adjust_start_ms_;

    // Runtime docking parameters (set by Pi via begin_dock)
    uint16_t dock_tag_id_;
    uint16_t dock_target_mm_;

    // Heading gate
    float    heading_err_deg_;
    bool     heading_ok_;

    // Retained terminal error for Pi type-140 telemetry.
    DockError unload_error_;

    // Leave-dock tracking
    int32_t  leave_start_count_;
    uint32_t leave_start_ms_;
    float    leave_target_heading_;

    // Time the AUTO_ROAM driving loop first started (for Front ToF boot-skip)
    uint32_t drive_start_ms_ = 0;

    // Idempotency key — tracks current operationId to reject duplicate dock commands
    char current_operation_id_[37] = "";

    // Tuning (compile-time defaults)
    static constexpr int16_t BASE_FWD_SPEED     = 70;
    static constexpr int16_t SLOW_FWD_SPEED     = 30;
    static constexpr int16_t ESCAPE_STRAFE      = 90;
    static constexpr int16_t ESCAPE_ROTATE      = 70;
    static constexpr int16_t REVERSE_NUDGE      = 40;
    static constexpr int16_t SCAN_ROTATE        = 50;
    static constexpr uint32_t HEADING_HOLD_MS   = 1500;
    static constexpr uint32_t FRONT_TOF_HOLD_MS     = 500;
    static constexpr int16_t ADJUST_FWD_SPEED   = 40;
    static constexpr uint32_t ADJUST_TIMEOUT_MS = 5000;
};
