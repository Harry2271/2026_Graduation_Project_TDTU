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

// How long to maintain a dodge maneuver before re-evaluating
#define DODGE_DURATION_MS 800
#define CLEAR_THRESHOLD_MS 500

class ObstacleAvoidance {
public:
    ObstacleAvoidance();

    // Feed an obstacle event from the Pi (LiDAR processed data)
    void onObstacleEvent(ObstacleDirection dir, uint32_t now_ms);

    // Call periodically to update dodge state
    AvoidanceResult update(uint32_t now_ms);

    // Clear obstacle state (path is clear)
    void clearObstacles(uint32_t now_ms);

    // Given a raw navigation command, apply avoidance logic
    AvoidanceResult processCommand(int16_t vx, int16_t vy, int16_t omega,
                                    uint32_t now_ms);

    // Apply obstacle to current command (used by mode manager)
    void applyToCommand(int16_t& vx, int16_t& vy, int16_t& omega,
                         uint32_t now_ms);

    [[nodiscard]] bool hasActiveObstacle() const;
    [[nodiscard]] ObstacleDirection getLastDirection() const { return last_dir_; }
    [[nodiscard]] bool isDodging() const { return dodging_; }

private:
    void startDodge(ObstacleDirection dir, uint32_t now_ms);
    void updateDodge(uint32_t now_ms);
    void endDodge();

    ObstacleDirection last_dir_;
    bool dodging_;
    bool obstacle_active_;
    uint32_t dodge_start_ms_;
    uint32_t last_clear_ms_;
    uint32_t last_obstacle_ms_;

    int16_t saved_vx_;
    int16_t saved_vy_;
    int16_t saved_omega_;
};
