#include "HealthMonitor.h"
#include "config.h"
#include <Arduino.h>
#include <ArduinoJson.h>

// =====================================================================
// HealthMonitor — per-module health tracking + type 142 emission.
//
// Lifecycle:
//   begin()     — register all modules with default stale thresholds
//   reportOk()  — called after each successful sensor/operation
//   reportError() — called on failure
//   tick()      — checks staleness, triggers recovery, logs state changes
//   emitHealthJson() — produces type 142 JSON for Pi
//
// Recovery flow (inside tick()):
//   ONLINE + stale > STALE_MS  → WARNING
//   WARNING + stale > 2×STALE_MS → RECOVERING → attempt reinit
//   RECOVERING + retry ≥ MAX_RETRIES → FAILED
//   FAILED (critical) → forceStopMotors() + Pi notification
// =====================================================================

static const char* STATE_NAMES[] = {
    "ONLINE", "WARNING", "RECOVERING", "FAILED", "OFFLINE"
};

static const char* MODULE_NAMES[] = {
    "imu", "encoders", "motor_driver", "battery", "e_stop",
    "ir", "front_tof", "dock_tof", "cylinder", "pi_link", "i2c_bus"
};

HealthMonitor::HealthMonitor()
    : changed_(false), last_emit_ms_(0)
{
}

void HealthMonitor::begin()
{
    // ModuleId          stale_ms   critical
    const uint32_t stale[MOD_COUNT] = {
        2000,  // MOD_IMU            — cached read at 1 Hz via readSensorsSlow()
        200,   // MOD_ENCODERS       — 50 Hz PID, 10 frames
        1000,  // MOD_MOTOR_DRIVER   — detect stall over 1s
        2000,  // MOD_BATTERY        — 1 Hz read, 2 cycles
        0,     // MOD_E_STOP         — managed by e_stop flag, not stale
        200,   // MOD_IR             — 50 Hz poll, 10 frames
        200,   // MOD_FRONT_TOF          — 20 Hz poll, 4 frames
        200,   // MOD_TOF            — 10 Hz, 2 frames
        500,   // MOD_CYLINDER       — low frequency
        4000,  // MOD_Pi_LINK        — 2× HEARTBEAT_TIMEOUT_MS
        1000,  // MOD_I2C_BUS        — check every 1s
    };
    const bool critical[MOD_COUNT] = {
        true,   // IMU
        true,   // Encoders
        true,   // Motor driver
        true,   // Battery (critical only)
        true,   // E-stop
        false,  // IR
        false,  // Front ToF
        false,  // TOF
        false,  // Cylinder
        false,  // Pi link (degrades, doesn't e-stop)
        true,   // I2C bus (affects critical modules)
    };

    uint32_t now = millis();
    for (uint8_t i = 0; i < MOD_COUNT; i++) {
        modules_[i].id = (ModuleId)i;
        modules_[i].state = ST_ONLINE;
        modules_[i].prev_state = ST_ONLINE;
        modules_[i].err_code = 0;
        modules_[i].retry_count = 0;
        modules_[i].last_ok_ms = now;
        modules_[i].last_change_ms = now;
        modules_[i].stale_ms = stale[i];
        modules_[i].name = MODULE_NAMES[i];
        modules_[i].is_critical = critical[i];
    }
}

// =====================================================================
// reportOk — mark a module as healthy.
// =====================================================================
void HealthMonitor::reportOk(ModuleId id, uint32_t now_ms)
{
    ModuleStatus& m = modules_[id];
    m.last_ok_ms = now_ms;

    if (m.state == ST_WARNING || m.state == ST_RECOVERING) {
        // Recovered from a warning or recovery attempt
        if (m.state == ST_RECOVERING) {
            Serial.printf("[HEALTH] %s recovered (retry=%d)\n",
                          m.name, m.retry_count);
        }
        m.prev_state = m.state;
        m.state = ST_ONLINE;
        m.retry_count = 0;
        m.err_code = 0;
        m.last_change_ms = now_ms;
        changed_ = true;
    } else if (m.state == ST_FAILED) {
        // Device came back online after being marked FAILED
        Serial.printf("[HEALTH] %s back online\n", m.name);
        m.prev_state = m.state;
        m.state = ST_ONLINE;
        m.retry_count = 0;
        m.err_code = 0;
        m.last_change_ms = now_ms;
        changed_ = true;
    }
    // If already ONLINE, update last_ok_ms and clear any stale error code
    // so the type-142 report shows err=0.
    m.err_code = 0;
}

// =====================================================================
// reportError — mark a module as having failed an operation.
// =====================================================================
void HealthMonitor::reportError(ModuleId id, uint8_t err_code, uint32_t now_ms)
{
    ModuleStatus& m = modules_[id];
    m.err_code = err_code;

    if (m.state == ST_ONLINE) {
        Serial.printf("[HEALTH] %s WARNING (err=%d)\n", m.name, err_code);
        m.prev_state = m.state;
        m.state = ST_WARNING;
        m.last_change_ms = now_ms;
        changed_ = true;
    }
}

// =====================================================================
// reportState — force a module into a specific state.
// =====================================================================
void HealthMonitor::reportState(ModuleId id, ModuleState s, uint8_t err_code,
                                uint32_t now_ms)
{
    ModuleStatus& m = modules_[id];
    if (m.state != s) {
        m.prev_state = m.state;
        m.state = s;
        m.err_code = err_code;
        m.last_change_ms = now_ms;
        m.retry_count = 0;
        changed_ = true;
        Serial.printf("[HEALTH] %s -> %s (err=%d)\n",
                      m.name, STATE_NAMES[s], err_code);
    }
}

// =====================================================================
// reportRecoveryFailure — mark a recovery attempt as failed.
// =====================================================================
void HealthMonitor::reportRecoveryFailure(ModuleId id, uint8_t err_code,
                                          uint32_t now_ms)
{
    ModuleStatus& m = modules_[id];
    m.err_code = err_code;
    m.retry_count++;
    m.last_change_ms = now_ms;

    if (m.retry_count >= HEALTH_MAX_RETRIES) {
        Serial.printf("[HEALTH] %s FAILED after %d retries\n",
                      m.name, m.retry_count);
        m.prev_state = m.state;
        m.state = ST_FAILED;
        changed_ = true;
    }
}

// =====================================================================
// recoveryDue — true when we should attempt the next recovery step.
// =====================================================================
bool HealthMonitor::recoveryDue(ModuleId id, uint32_t now_ms) const
{
    const ModuleStatus& m = modules_[id];
    if (m.state != ST_RECOVERING) return false;
    return (now_ms - m.last_change_ms) >= HEALTH_RETRY_INTERVAL_MS;
}

// =====================================================================
// hasChanged — returns true if any state changed since last clear.
// =====================================================================
bool HealthMonitor::hasChanged()
{
    if (changed_) {
        changed_ = false;
        return true;
    }
    return false;
}

// =====================================================================
// hasCriticalFailed — any critical module in FAILED state?
// =====================================================================
bool HealthMonitor::hasCriticalFailed() const
{
    for (uint8_t i = 0; i < MOD_COUNT; i++) {
        if (modules_[i].is_critical && modules_[i].state == ST_FAILED) {
            return true;
        }
    }
    return false;
}

// =====================================================================
// tick — called every loop().  Checks staleness and triggers recovery.
//
// Recovery is NOT done here (no I2C calls in tick).  Instead, tick
// transitions states and increments retry counters.  The actual reinit
// calls happen in the main loop where sensor objects are accessible.
// We use a simple approach: tick transitions to WARNING/FAILED, and the
// main loop calls recover() based on state.
// =====================================================================
void HealthMonitor::tick(uint32_t now_ms)
{
    for (uint8_t i = 0; i < MOD_COUNT; i++) {
        ModuleStatus& m = modules_[i];

        // Skip modules that don't have staleness checking
        if (m.stale_ms == 0) continue;

        uint32_t age = now_ms - m.last_ok_ms;

        switch (m.state) {
            case ST_ONLINE:
                if (age > m.stale_ms) {
                    Serial.printf("[HEALTH] %s stale (%lu ms > %lu ms)\n",
                                  m.name, (unsigned long)age, (unsigned long)m.stale_ms);
                    m.prev_state = m.state;
                    m.state = ST_WARNING;
                    m.last_change_ms = now_ms;
                    changed_ = true;
                }
                break;

            case ST_WARNING:
                if (age > m.stale_ms * 2) {
                    // Escalate to RECOVERING
                    Serial.printf("[HEALTH] %s -> RECOVERING (retry %d)\n",
                                  m.name, m.retry_count);
                    m.prev_state = m.state;
                    m.state = ST_RECOVERING;
                    m.last_change_ms = now_ms;
                    changed_ = true;
                }
                break;

            case ST_RECOVERING:
                // Recovery is attempted externally.  If still stale after
                // another interval, increment retry or fail.
                if (age > m.stale_ms * 3) {
                    m.retry_count++;
                    if (m.retry_count >= HEALTH_MAX_RETRIES) {
                        Serial.printf("[HEALTH] %s FAILED after %d retries\n",
                                      m.name, m.retry_count);
                        m.prev_state = m.state;
                        m.state = ST_FAILED;
                        m.last_change_ms = now_ms;
                        changed_ = true;
                    } else {
                        // Stay in RECOVERING — main loop will retry
                        m.last_change_ms = now_ms;
                    }
                }
                break;

            case ST_FAILED:
                // FAILED is not permanent. A transient I2C/power glitch can
                // recover later, so periodically return to RECOVERING and let
                // the main loop perform a real module reinitialization.
                if ((now_ms - m.last_change_ms) >= HEALTH_FAILED_RETRY_INTERVAL_MS) {
                    Serial.printf("[HEALTH] %s FAILED -> RECOVERING (scheduled retry)\n",
                                  m.name);
                    m.prev_state = m.state;
                    m.state = ST_RECOVERING;
                    m.retry_count = 0;
                    m.last_change_ms = now_ms;
                    changed_ = true;
                }
                break;

            case ST_OFFLINE:
                break;
        }
    }
}

// =====================================================================
// emitHealthJson — type 142 health report
// =====================================================================
size_t HealthMonitor::emitHealthJson(char* buf, size_t bufsize,
                                     uint32_t uptime_ms,
                                     bool e_stop_active,
                                     const char* mode_name) const
{
    StaticJsonDocument<1024> doc;
    doc["type"] = 142;

    JsonObject data = doc.createNestedObject("data");
    data["uptime_ms"] = uptime_ms;

    // Battery info
    JsonObject bat = data.createNestedObject("battery");
    bat["voltage_v"] = 0.0f;
    bat["current_a"] = 0.0f;
    bat["pct"] = 0.0f;
    bat["status"] = "unknown";

    // Robot state
    JsonObject robot = data.createNestedObject("robot");
    robot["mode"] = mode_name ? mode_name : "UNKNOWN";
    robot["e_stop"] = e_stop_active;

    // Module states
    JsonArray mods = data.createNestedArray("modules");
    for (uint8_t i = 0; i < MOD_COUNT; i++) {
        const ModuleStatus& m = modules_[i];
        JsonObject mod = mods.createNestedObject();
        mod["id"] = m.name;
        mod["state"] = STATE_NAMES[m.state];
        mod["err"] = m.err_code;
        mod["retry"] = m.retry_count;
        mod["ok"] = (m.state == ST_ONLINE);
    }

    size_t n = serializeJson(doc, buf, bufsize);
    if (n < bufsize) { buf[n] = '\n'; buf[n + 1] = '\0'; n++; }
    return n;
}
