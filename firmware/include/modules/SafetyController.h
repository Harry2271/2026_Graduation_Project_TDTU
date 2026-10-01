#pragma once

#include <Arduino.h>

// ============================================================
// SafetyController — Multi-Level E-Stop với Recovery Hierarchy
// ============================================================
// Thay thế boolean g_e_stop_active bằng state machine phân cấp:
//   NORMAL → SOFT_STOP → HARD_STOP → EMERGENCY
//
// Recovery sequence:
//   EMERGENCY: cần manual inspect + clear_emergency command
//   HARD_STOP: Pi obstacle_clear hoặc operator K command
//   SOFT_STOP: auto-clear khi sensors clear for 500ms
// ============================================================

enum class SafetyLevel : uint8_t {
    NORMAL = 0,       // No safety intervention
    SOFT_STOP = 1,    // Brake motors, giữ enable, auto-clear
    HARD_STOP = 2,    // Disable motors, cần Pi clear
    EMERGENCY = 3     // Disable motors + cylinder, cần manual inspect
};

struct SafetyEvent {
    SafetyLevel level;
    uint32_t timestamp_ms;
    const char* source;    // "IR_LEFT", "FRONT_TOF", "IMU_SHOCK", etc.
    const char* reason;
};

class SafetyController {
public:
    SafetyController();

    void begin();
    void update(uint32_t now_ms);

    // Trigger safety events
    void triggerSoftStop(const char* source, const char* reason);
    void triggerHardStop(const char* source, const char* reason);
    void triggerEmergency(const char* source, const char* reason);

    // Manual clear commands
    void clearSoftStop();     // Auto-called when sensors clear
    void clearHardStop();     // Pi obstacle_clear or operator K
    void clearEmergency();    // Operator clear_emergency command

    // State query
    SafetyLevel getLevel() const { return m_current_level; }
    bool isNormal() const { return m_current_level == SafetyLevel::NORMAL; }
    bool isSoftStop() const { return m_current_level == SafetyLevel::SOFT_STOP; }
    bool isHardStop() const { return m_current_level == SafetyLevel::HARD_STOP; }
    bool isEmergency() const { return m_current_level == SafetyLevel::EMERGENCY; }
    bool canMove() const { return m_current_level == SafetyLevel::NORMAL; }

    // Get latest event
    const SafetyEvent& getLatestEvent() const { return m_latest_event; }

    // Auto-clear logic for SOFT_STOP
    void notifySensorsClear(uint32_t now_ms);
    void notifySensorsBlocked(uint32_t now_ms);

    // Get human-readable level name
    const char* levelToString(SafetyLevel level) const;

private:
    SafetyLevel m_current_level;
    SafetyEvent m_latest_event;

    // Auto-clear tracking for SOFT_STOP
    uint32_t m_soft_stop_clear_since_ms;
    bool m_sensors_clear;

    static constexpr uint32_t SOFT_STOP_AUTO_CLEAR_MS = 500;

    void transitionTo(SafetyLevel new_level, const char* source, const char* reason);
};
