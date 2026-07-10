#pragma once

#include <stdint.h>

// Forward declarations — avoid pulling all sensor headers into one place
class BNO055Sensor;
class IRProximitySensor;
class SharpFrontSensor;
class INA226Sensor;

/**
 * AutoRoam — drives the robot autonomously using only onboard sensors
 * (no Pi / no LiDAR required).
 *
 * Behaviour, derived from the AGV flowchart for the "Pi disconnected" branch:
 *
 *   ┌─ Heading PID (BNO055)  ─► keep heading straight (omega correction)
 *   │
 *   ├─ Sharp front  (< 30 cm)  ► E-STOP
 *   ├─ Sharp slow    (< 60 cm)  ► slow + scan IR for escape route
 *   ├─ IR rear hit              ► stop backward, nudge forward
 *   ├─ IR left hit              ► strafe right
 *   ├─ IR right hit             ► strafe left
 *   ├─ IR both side hit         ► rotate to clear
 *   │
 *   └─ Battery low (< 20 %)     ► slow down to 50 %
 *
 *   Default drive: forward + slow forward + reactive corrections.
 */
class AutoRoam {
public:
    AutoRoam();

    /// Wire sensor pointers (call once in setup)
    void attachSensors(BNO055Sensor* imu,
                       IRProximitySensor* ir,
                       SharpFrontSensor* sharp,
                       INA226Sensor* power);

    /// Reset state (e.g. when leaving AUTO_ROAM mode)
    void reset();

    /// Compute (vx, vy, omega) for this tick. Call every PID cycle.
    /// Returns true if motion is allowed; false means HARD STOP requested.
    bool compute(uint32_t now_ms,
                 int16_t& out_vx, int16_t& out_vy, int16_t& out_omega);

    /// True while a Sharp-triggered hard stop is engaged.
    [[nodiscard]] bool isHardStopped() const { return hard_stop_; }

private:
    // Heading-hold PI controller (BNO055 Euler H → target = initial heading)
    float hold_heading_;
    bool  has_heading_;
    float heading_integral_;
    float heading_kp_;
    float heading_ki_;

    // Wall-clock for edge-triggered state changes
    uint32_t last_obstacle_ms_;
    uint32_t sharp_clear_ms_;
    bool     hard_stop_;
    uint8_t  last_ir_mask_;   // for edge-triggered log on IR transitions

    // Sensors
    BNO055Sensor*      imu_;
    IRProximitySensor* ir_;
    SharpFrontSensor*  sharp_;
    INA226Sensor*      power_;

    // Tuning
    static constexpr int16_t BASE_FWD_SPEED     = 70;    // default forward PWM
    static constexpr int16_t SLOW_FWD_SPEED     = 30;    // Sharp slow-zone
    static constexpr int16_t ESCAPE_STRAFE      = 90;    // IR side dodge
    static constexpr int16_t ESCAPE_ROTATE      = 70;    // IR both sides
    static constexpr int16_t REVERSE_NUDGE      = 40;    // IR rear
    static constexpr int16_t SCAN_ROTATE        = 50;    // gentle rotate to find clear
    static constexpr uint32_t HEADING_HOLD_MS   = 1500;  // capture heading after settle
    static constexpr uint32_t SHARP_HOLD_MS     = 500;   // hold hard-stop this long after Sharp clears
};