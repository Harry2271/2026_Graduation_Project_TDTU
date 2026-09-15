#include "ObstacleAvoidance.h"
#include "config.h"
#include <math.h>

ObstacleAvoidance::ObstacleAvoidance()
    : last_dir_(ObstacleDirection::NONE)
    , dodging_(false)
    , obstacle_active_(false)
    , dodge_start_ms_(0)
    , dodge_duration_ms_(DODGE_DURATION_MS)
    , last_clear_ms_(0)
    , last_obstacle_ms_(0)
    , last_distance_m_(0.0f)
    , last_severity_(0.0f)
    , saved_vx_(0)
    , saved_vy_(0)
    , saved_omega_(0)
{
}

void ObstacleAvoidance::onObstacleEvent(ObstacleDirection dir, uint32_t now_ms,
                                        bool has_payload,
                                        float distance_m,
                                        float severity)
{
    last_obstacle_ms_ = now_ms;
    obstacle_active_ = true;

    if (has_payload) {
        // Tiny NaN/Inf guard so a corrupt LiDAR payload can't poison the
        // dodge math.  Anything that fails isfinite() is treated as missing.
        if (isfinite(distance_m)) last_distance_m_ = distance_m;
        if (isfinite(severity))   last_severity_   = severity;
    } else {
        last_distance_m_ = 0.0f;
        last_severity_   = 0.0f;
    }

    if (dir != ObstacleDirection::NONE) {
        if (dir != last_dir_ || !dodging_) {
            startDodge(dir, now_ms, last_severity_);
        }
    }
}

void ObstacleAvoidance::startDodge(ObstacleDirection dir, uint32_t now_ms,
                                    float severity)
{
    last_dir_ = dir;
    dodging_ = true;
    // Severity scales the dodge duration only between 0.4× and 1.4× the
    // base DODGE_DURATION_MS.  A vertical scale, not a different direction:
    // the dodge direction table is fixed for each direction.
    float scale = 1.0f;
    if (severity > 0.0f) {
        scale = 0.4f + 1.0f * severity;
        if (scale < 0.4f) scale = 0.4f;
        if (scale > 1.4f) scale = 1.4f;
    }
    uint32_t duration_ms = (uint32_t)((float)DODGE_DURATION_MS * scale);
    if (duration_ms < (uint32_t)(DODGE_DURATION_MS / 2)) {
        duration_ms = (uint32_t)(DODGE_DURATION_MS / 2);
    }
    if (duration_ms > (uint32_t)(CLEAR_THRESHOLD_MS * 3)) {
        duration_ms = (uint32_t)(CLEAR_THRESHOLD_MS * 3);
    }
    dodge_start_ms_ = now_ms;
    dodge_duration_ms_ = duration_ms;
}

void ObstacleAvoidance::updateDodge(uint32_t now_ms)
{
    if (!dodging_) return;

    if (now_ms - dodge_start_ms_ >= dodge_duration_ms_) {
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

void ObstacleAvoidance::updateLastSeen(uint32_t now_ms)
{
    // Bump the "last obstacle event" timestamp so the 500ms safety
    // window in applyToCommand keeps obstacle_active_ true until the
    // sensors have been clear for a full CLEAR_THRESHOLD_MS period.
    if (obstacle_active_) {
        last_obstacle_ms_ = now_ms;
    }
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
    // Front obstacle → HARD STOP.  The vehicle should not advance when
    // the physical sensors (IR/Sharp) report something directly ahead,
    // regardless of how the dodge state-machine ticks.  FRONT_HARD_STOP_LATCH_MS
    // == 0 means "latch until the operator explicitly clears" — never auto-
    // release, otherwise a quiet sensor tick could re-arm forward motion
    // while the obstacle is still in the path.
    if (obstacle_active_ && last_dir_ == ObstacleDirection::FRONT) {
        // Never advance into a center-front obstacle, but preserve a
        // caller-supplied reverse/strafe escape vector.  The local IR/Sharp
        // interlock independently clamps unsafe components and may still
        // hard-stop when no safe escape exists.
        if (vx > 0) vx = 0;
        return;
    }

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
            // FRONT direction dodge (fallback path when not in active-stop above)
            vx = 0;
            vy = 0;
            omega = 0;
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
            // FL-corner obstacle: never drive into that wheel. Reverse a
            // little and strafe right, away from the blocked corner. Cap
            // any remaining forward command so Nav2 cannot push the FL
            // wheel into a pallet leg that the front ToF cannot see.
            // FIX: Only cap if vx is positive, then zero it
            if (vx > 0) {
                vx = (vx > FRONT_CORNER_FORWARD_CAP) ? FRONT_CORNER_FORWARD_CAP : vx;
                vx = 0;  // Then hard-stop forward motion
            }
            vy = 120;
            omega = 40;
            break;

        case ObstacleDirection::FRONT_RIGHT:
            // FR-corner obstacle: mirror of FRONT_LEFT.
            // FIX: Only cap if vx is positive, then zero it
            if (vx > 0) {
                vx = (vx > FRONT_CORNER_FORWARD_CAP) ? FRONT_CORNER_FORWARD_CAP : vx;
                vx = 0;  // Then hard-stop forward motion
            }
            vy = -120;
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

    // A front event is a hard safety latch.  It must not disappear merely
    // because the serial/LiDAR stream went quiet; require explicit clear.
    if (last_dir_ != ObstacleDirection::FRONT &&
        now_ms - last_obstacle_ms_ > CLEAR_THRESHOLD_MS * 3) {
        clearObstacles(now_ms);
        r.clear = true;
        r.dodging = false;
    }

    return r;
}
