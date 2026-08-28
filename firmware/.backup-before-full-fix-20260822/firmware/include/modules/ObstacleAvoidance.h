#pragma once

#include <stdint.h>

// Obstacle direction reported by Pi's LiDAR processing
enum class ObstacleDirection {
    NONE,
    FRONT,
    LEFT,
    RIGHT,
    FRONT_LEFT,
    FRONT_RIGHT,
    REAR,
    REAR_LEFT,
    REAR_RIGHT,
};

struct AvoidanceResult {
    bool  dodging;     // true if a dodge maneuver is active
    bool  clear;       // true if path is clear
    int16_t vx;        // adjusted forward speed
    int16_t vy;        // adjusted strafe speed
    int16_t omega;     // adjusted rotation
    ObstacleDirection dir;
};

// Do not auto-clear a hard front stop from sensor silence: the operator
// must explicitly send `obstacle_clear` (or `e_stop_clear`) so the firmware
// does not re-arm forward motion under a still-present physical obstacle.
#define FRONT_HARD_STOP_LATCH_MS 0   // 0 = latch until explicit clear

// How long to maintain a dodge maneuver before re-evaluating
#define DODGE_DURATION_MS 800
#define CLEAR_THRESHOLD_MS 500

class ObstacleAvoidance {
public:
    ObstacleAvoidance();

    // Feed an obstacle event from the Pi (LiDAR processed data).
    // Distance/severity are optional; pass false for has_payload when the
    // Pi sent a plain boolean event.  When payload is provided, severity
    // scales the dodge duration slightly so a closer/blunter object dodges
    // harder, but the direction table is fixed.
    void onObstacleEvent(ObstacleDirection dir, uint32_t now_ms,
                         bool has_payload = false,
                         float distance_m = 0.0f,
                         float severity = 0.0f);

    // Call periodically to update dodge state
    AvoidanceResult update(uint32_t now_ms);

    // Clear obstacle state (path is clear) — operator-initiated only.
    void clearObstacles(uint32_t now_ms);

    // Bump "last obstacle seen" timestamp without changing obstacle_active_
    // direction state.  Used by local sensors (IR/Sharp) to keep the
    // safety window open while the physical obstacle is still present.
    void updateLastSeen(uint32_t now_ms);

    // Given a raw navigation command, apply avoidance logic
    AvoidanceResult processCommand(int16_t vx, int16_t vy, int16_t omega,
                                    uint32_t now_ms);

    // Apply obstacle to current command (used by mode manager)
    void applyToCommand(int16_t& vx, int16_t& vy, int16_t& omega,
                         uint32_t now_ms);

    [[nodiscard]] bool hasActiveObstacle() const { return obstacle_active_; }
    [[nodiscard]] ObstacleDirection getLastDirection() const { return last_dir_; }
    [[nodiscard]] bool isDodging() const { return dodging_; }
    [[nodiscard]] bool isFrontHardStop() const {
        return obstacle_active_ && last_dir_ == ObstacleDirection::FRONT;
    }
    [[nodiscard]] float getLastDistanceM() const { return last_distance_m_; }
    [[nodiscard]] float getLastSeverity() const { return last_severity_; }

private:
    void startDodge(ObstacleDirection dir, uint32_t now_ms, float severity);
    void updateDodge(uint32_t now_ms);
    void endDodge();

    ObstacleDirection last_dir_;
    bool dodging_;
    bool obstacle_active_;
    uint32_t dodge_start_ms_;
    uint32_t dodge_duration_ms_;
    uint32_t last_clear_ms_;
    uint32_t last_obstacle_ms_;

    // Latest distance/severity reported by the Pi (NaN-safe; default 0).
    // Distance is the closest hit in the reported zone; severity is the
    // LiDAR-side intensity (0..1).  Both are advisory and only scale the
    // dodge duration; the direction table and front hard-stop are fixed.
    float last_distance_m_;
    float last_severity_;

    int16_t saved_vx_;
    int16_t saved_vy_;
    int16_t saved_omega_;
};
