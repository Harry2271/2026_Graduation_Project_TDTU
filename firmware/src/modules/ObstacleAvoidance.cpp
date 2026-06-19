#include "ObstacleAvoidance.h"
#include "config.h"

ObstacleAvoidance::ObstacleAvoidance()
    : last_dir_(ObstacleDirection::NONE)
    , dodging_(false)
    , obstacle_active_(false)
    , dodge_start_ms_(0)
    , last_clear_ms_(0)
    , last_obstacle_ms_(0)
    , saved_vx_(0)
    , saved_vy_(0)
    , saved_omega_(0)
{
}

void ObstacleAvoidance::onObstacleEvent(ObstacleDirection dir, uint32_t now_ms)
{
    last_obstacle_ms_ = now_ms;
    obstacle_active_ = true;

    if (dir != ObstacleDirection::NONE) {
        if (dir != last_dir_ || !dodging_) {
            startDodge(dir, now_ms);
        }
    }
}

void ObstacleAvoidance::startDodge(ObstacleDirection dir, uint32_t now_ms)
{
    last_dir_ = dir;
    dodging_ = true;
    dodge_start_ms_ = now_ms;
}

void ObstacleAvoidance::updateDodge(uint32_t now_ms)
{
    if (!dodging_) return;

    if (now_ms - dodge_start_ms_ >= DODGE_DURATION_MS) {
        endDodge();
    }
}

void ObstacleAvoidance::endDodge()
{
    dodging_ = false;
    last_dir_ = ObstacleDirection::NONE;
}

void ObstacleAvoidance::clearObstacles(uint32_t now_ms)
{
    last_clear_ms_ = now_ms;
    obstacle_active_ = false;
    dodging_ = false;
    last_dir_ = ObstacleDirection::NONE;
}

bool ObstacleAvoidance::hasActiveObstacle() const
{
    return obstacle_active_;
}

AvoidanceResult ObstacleAvoidance::processCommand(int16_t vx, int16_t vy,
                                                    int16_t omega, uint32_t now_ms)
{
    AvoidanceResult r;
    r.vx = vx;
    r.vy = vy;
    r.omega = omega;
    r.dodging = false;
    r.clear = true;
    r.dir = ObstacleDirection::NONE;

    if (obstacle_active_) {
        r.clear = false;
        applyToCommand(r.vx, r.vy, r.omega, now_ms);
        r.dodging = dodging_;
        r.dir = last_dir_;
    }

    return r;
}

void ObstacleAvoidance::applyToCommand(int16_t& vx, int16_t& vy, int16_t& omega,
                                          uint32_t now_ms)
{
    updateDodge(now_ms);

    if (!dodging_ && last_dir_ != ObstacleDirection::NONE) {
        // Re-evaluate: extend dodge or let it clear
        if (now_ms - last_obstacle_ms_ > CLEAR_THRESHOLD_MS) {
            clearObstacles(now_ms);
            return;
        }
        // Keep dodging for a bit longer
        dodging_ = true;
    }

    if (!dodging_) return;

    // Save original command for when we resume
    saved_vx_ = vx;
    saved_vy_ = vy;
    saved_omega_ = omega;

    switch (last_dir_) {
        case ObstacleDirection::FRONT:
            // Stop forward, rotate to find clear path
            vx = 0;
            omega = 80;  // default rotate CW
            vy = 0;
            break;

        case ObstacleDirection::LEFT:
            // Obstacle on left — strafe right to dodge
            vy = 100;
            vx = (vx > 0) ? 60 : vx;  // slow forward if moving forward
            omega = 0;
            break;

        case ObstacleDirection::RIGHT:
            // Obstacle on right — strafe left to dodge
            vy = -100;
            vx = (vx > 0) ? 60 : vx;
            omega = 0;
            break;

        case ObstacleDirection::FRONT_LEFT:
            // Obstacle front-left — dodge right and back slightly
            vy = 120;
            vx = -40;
            omega = 40;
            break;

        case ObstacleDirection::FRONT_RIGHT:
            // Obstacle front-right — dodge left and back slightly
            vy = -120;
            vx = -40;
            omega = -40;
            break;

        case ObstacleDirection::REAR:
            // Obstacle behind — stop backward, nudge forward
            if (vx < 0) vx = 40;
            vy = 0;
            omega = 0;
            break;

        case ObstacleDirection::REAR_LEFT:
            // Obstacle rear-left — stop backward + strafe right
            if (vx < 0) vx = 0;
            vy = 80;
            omega = 0;
            break;

        case ObstacleDirection::REAR_RIGHT:
            // Obstacle rear-right — stop backward + strafe left
            if (vx < 0) vx = 0;
            vy = -80;
            omega = 0;
            break;

        default:
            break;
    }
}

AvoidanceResult ObstacleAvoidance::update(uint32_t now_ms)
{
    AvoidanceResult r;
    r.vx = saved_vx_;
    r.vy = saved_vy_;
    r.omega = saved_omega_;
    r.clear = !obstacle_active_;
    r.dodging = dodging_;
    r.dir = last_dir_;

    updateDodge(now_ms);

    if (now_ms - last_obstacle_ms_ > CLEAR_THRESHOLD_MS * 3) {
        clearObstacles(now_ms);
        r.clear = true;
        r.dodging = false;
    }

    return r;
}
