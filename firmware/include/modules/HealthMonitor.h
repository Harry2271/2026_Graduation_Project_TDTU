#pragma once

#include <stdint.h>
#include <cstddef>

// =====================================================================
// Module Health Monitor — detects stuck/error modules and triggers
// auto-recovery (reinit) or safety actions (e-stop).
//
// Usage:
//   1. Call begin() in setup().
//   2. Call reportOk(id, now_ms) after each successful sensor read/operation.
//   3. Call reportError(id, err_code, now_ms) when an operation fails.
//   4. Call tick(now_ms) every loop iteration to check staleness.
//   5. Call emitHealthJson() to produce type 142 for Pi.
//   6. Query hasCriticalFailed() to decide if motors should stop.
// =====================================================================

/// Module IDs — one per monitorable component.
enum ModuleId : uint8_t {
    MOD_IMU,            // BNO055 IMU
    MOD_ENCODERS,       // PCNT encoders (aggregate all 4)
    MOD_MOTOR_DRIVER,   // BTS7960 driver (target vs actual RPM)
    MOD_BATTERY,        // INA226 power monitor
    MOD_E_STOP,         // Emergency stop state
    MOD_IR,             // IR proximity sensors
    MOD_FRONT_TOF,      // VL53L1X front TOF distance sensor
    MOD_TOF,            // VL53L0X rear docking distance sensor
    MOD_CYLINDER,       // Cylinder actuator
    MOD_Pi_LINK,        // Heartbeat from Pi
    MOD_I2C_BUS,        // Shared I2C bus health
    MOD_COUNT
};

/// Health states.
enum ModuleState : uint8_t {
    ST_ONLINE,      // Operating normally
    ST_WARNING,     // Not updated within STALE_MS — may be transient
    ST_RECOVERING,  // Reinit attempt in progress
    ST_FAILED,      // Recovery failed — retry is still scheduled
    ST_OFFLINE      // Not present at boot (sensor absent)
};

/// Per-module status record.
struct ModuleStatus {
    ModuleId    id;
    ModuleState state;
    ModuleState prev_state;       // for edge detection
    uint8_t     err_code;         // 0 = no error
    uint8_t     retry_count;      // consecutive recovery attempts
    uint32_t    last_ok_ms;       // last successful operation timestamp
    uint32_t    last_change_ms;   // last time state changed
    uint32_t    stale_ms;         // timeout threshold for this module
    const char* name;             // human-readable label
    bool        is_critical;      // critical = stop motors on FAIL
};

/// Max modules (compile-time cap).
static const uint8_t HEALTH_MAX_MODULES = MOD_COUNT;

/// Max retries before FAILED state.
static const uint8_t HEALTH_MAX_RETRIES = 3;

/// Recovery retry interval (ms).
static const uint32_t HEALTH_RETRY_INTERVAL_MS = 500;

/// Retry a module after it has reached FAILED. This prevents a transient
/// I2C/power glitch from disabling the IMU until the next reboot.
static const uint32_t HEALTH_FAILED_RETRY_INTERVAL_MS = 30000;

class HealthMonitor {
public:
    HealthMonitor();

    /// Register all modules with default stale_ms values.
    void begin();

    /// Call every loop().  Checks staleness, triggers recovery, logs changes.
    void tick(uint32_t now_ms);

    /// Call after a successful sensor read / operation for that module.
    void reportOk(ModuleId id, uint32_t now_ms);

    /// Call when an operation fails.
    void reportError(ModuleId id, uint8_t err_code, uint32_t now_ms);

    /// Force a module into a specific state.
    void reportState(ModuleId id, ModuleState s, uint8_t err_code, uint32_t now_ms);

    /// Mark a failed recovery attempt. The monitor increments retry_count
    /// and moves to FAILED after HEALTH_MAX_RETRIES attempts.
    void reportRecoveryFailure(ModuleId id, uint8_t err_code, uint32_t now_ms);

    /// True when the module is in RECOVERING and its retry interval elapsed.
    bool recoveryDue(ModuleId id, uint32_t now_ms) const;

    /// True if any state changed since last check — for "emit immediately" path.
    bool hasChanged();

    /// True if any CRITICAL module is in ST_FAILED state.
    bool hasCriticalFailed() const;

    /// Get a module's status.
    const ModuleStatus& get(ModuleId id) const { return modules_[id]; }

    /// Emit type 142 health JSON into buf. Returns bytes written.
    size_t emitHealthJson(char* buf, size_t bufsize, uint32_t uptime_ms,
                          bool e_stop_active, const char* mode_name) const;

private:
    ModuleStatus modules_[HEALTH_MAX_MODULES];
    bool changed_;
    uint32_t last_emit_ms_;
};
