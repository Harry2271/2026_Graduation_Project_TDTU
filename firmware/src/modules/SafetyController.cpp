#include "SafetyController.h"

SafetyController::SafetyController()
    : m_current_level(SafetyLevel::NORMAL)
    , m_soft_stop_clear_since_ms(0)
    , m_sensors_clear(true)
{
    m_latest_event.level = SafetyLevel::NORMAL;
    m_latest_event.timestamp_ms = 0;
    m_latest_event.source = "INIT";
    m_latest_event.reason = "System boot";
}

void SafetyController::begin()
{
    Serial.println("  [SAFETY] Multi-level controller initialized");
    Serial.println("           NORMAL -> SOFT_STOP -> HARD_STOP -> EMERGENCY");
}

void SafetyController::update(uint32_t now_ms)
{
    // Auto-clear SOFT_STOP khi sensors clear for 500ms
    if (m_current_level == SafetyLevel::SOFT_STOP && m_sensors_clear) {
        if (m_soft_stop_clear_since_ms == 0) {
            m_soft_stop_clear_since_ms = now_ms;
        } else if (now_ms - m_soft_stop_clear_since_ms >= SOFT_STOP_AUTO_CLEAR_MS) {
            Serial.printf("[SAFETY] SOFT_STOP auto-clearing (sensors clear for %lu ms)\n",
                         now_ms - m_soft_stop_clear_since_ms);
            clearSoftStop();
        }
    }
}

void SafetyController::triggerSoftStop(const char* source, const char* reason)
{
    // SOFT_STOP can be triggered from NORMAL only
    // Already in HARD_STOP/EMERGENCY? Don't downgrade
    if (m_current_level == SafetyLevel::NORMAL) {
        transitionTo(SafetyLevel::SOFT_STOP, source, reason);
    }
}

void SafetyController::triggerHardStop(const char* source, const char* reason)
{
    // HARD_STOP upgrades NORMAL or SOFT_STOP
    if (m_current_level != SafetyLevel::EMERGENCY) {
        transitionTo(SafetyLevel::HARD_STOP, source, reason);
    }
}

void SafetyController::triggerEmergency(const char* source, const char* reason)
{
    // EMERGENCY is highest priority — always transitions
    transitionTo(SafetyLevel::EMERGENCY, source, reason);
}

void SafetyController::clearSoftStop()
{
    if (m_current_level == SafetyLevel::SOFT_STOP) {
        transitionTo(SafetyLevel::NORMAL, "AUTO", "Sensors clear");
        m_soft_stop_clear_since_ms = 0;
    }
}

void SafetyController::clearHardStop()
{
    if (m_current_level == SafetyLevel::HARD_STOP) {
        transitionTo(SafetyLevel::NORMAL, "OPERATOR", "Manual clear");
    }
}

void SafetyController::clearEmergency()
{
    if (m_current_level == SafetyLevel::EMERGENCY) {
        transitionTo(SafetyLevel::NORMAL, "OPERATOR", "Manual emergency clear");
    }
}

void SafetyController::notifySensorsClear(uint32_t now_ms)
{
    if (!m_sensors_clear) {
        m_sensors_clear = true;
        m_soft_stop_clear_since_ms = now_ms;
    }
}

void SafetyController::notifySensorsBlocked(uint32_t now_ms)
{
    m_sensors_clear = false;
    m_soft_stop_clear_since_ms = 0;
}

void SafetyController::transitionTo(SafetyLevel new_level, const char* source, const char* reason)
{
    if (new_level == m_current_level) return;

    SafetyLevel old_level = m_current_level;
    m_current_level = new_level;

    m_latest_event.level = new_level;
    m_latest_event.timestamp_ms = millis();
    m_latest_event.source = source;
    m_latest_event.reason = reason;

    Serial.printf("[SAFETY] %s -> %s (source: %s, reason: %s)\n",
                  levelToString(old_level),
                  levelToString(new_level),
                  source, reason);

    // Emit type 146 safety event to Pi
    Serial.print("{\"type\":146,\"data\":{\"level\":");
    Serial.print((uint8_t)new_level);
    Serial.print(",\"timestamp_ms\":");
    Serial.print(m_latest_event.timestamp_ms);
    Serial.print(",\"source\":\"");
    Serial.print(source);
    Serial.print("\",\"reason\":\"");
    Serial.print(reason);
    Serial.print("\",\"old_level\":");
    Serial.print((uint8_t)old_level);
    Serial.println("}}");
}

const char* SafetyController::levelToString(SafetyLevel level) const
{
    switch (level) {
        case SafetyLevel::NORMAL:    return "NORMAL";
        case SafetyLevel::SOFT_STOP: return "SOFT_STOP";
        case SafetyLevel::HARD_STOP: return "HARD_STOP";
        case SafetyLevel::EMERGENCY: return "EMERGENCY";
        default: return "UNKNOWN";
    }
}
