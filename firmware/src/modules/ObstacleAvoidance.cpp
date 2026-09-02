// firmware/src/modules/ObstacleAvoidance.cpp
// Fix FRONT_CORNER_FORWARD_CAP logic — chỉ cap forward khi vx > 0

#include "ObstacleAvoidance.h"
#include "config.h"
#include <math.h>

void ObstacleAvoidance::applyToCommand(int16_t& vx, int16_t& vy, int16_t& omega, uint32_t now_ms) {
    if (obstacle_active_ && last_dir_ == ObstacleDirection::FRONT) {
        if (vx > 0) vx = 0;
        return;
    }

    updateDodge(now_ms);

    if (!dodging_ && last_dir_ != ObstacleDirection::NONE) {
        if (now_ms - last_obstacle_ms_ > CLEAR_THRESHOLD_MS) {
            clearObstacles(now_ms);
            return;
        }
        dodging_ = true;
    }

    if (!dodging_) return;

    saved_vx_ = vx;
    saved_vy_ = vy;
    saved_omega_ = omega;

    switch (last_dir_) {
        case ObstacleDirection::FRONT:
            vx = 0;
            vy = 0;
            omega = 0;
            break;

        case ObstacleDirection::LEFT:
            vy = 100;
            vx = (vx > 0) ? 60 : vx;
            omega = 0;
            break;

        case ObstacleDirection::RIGHT:
            vy = -100;
            vx = (vx > 0) ? 60 : vx;
            omega = 0;
            break;

        case ObstacleDirection::FRONT_LEFT:
            if (vx > 0) vx = std::min<int16_t>(vx, static_cast<int16_t>(FRONT_CORNER_FORWARD_CAP));
            if (vx > 0) vx = 0;
            vy = 120;
            omega = 40;
            break;

        case ObstacleDirection::FRONT_RIGHT:
            if (vx > 0) vx = std::min<int16_t>(vx, static_cast<int16_t>(FRONT_CORNER_FORWARD_CAP));
            if (vx > 0) vx = 0;
            vy = -120;
            omega = -40;
            break;

        case ObstacleDirection::REAR:
            if (vx < 0) vx = 40;
            vy = 0;
            omega = 0;
            break;

        case ObstacleDirection::REAR_LEFT:
            if (vx < 0) vx = 0;
            vy = 80;
            omega = 0;
            break;

        case ObstacleDirection::REAR_RIGHT:
            if (vx < 0) vx = 0;
            vy = -80;
            omega = 0;
            break;

        default:
            break;
    }
}