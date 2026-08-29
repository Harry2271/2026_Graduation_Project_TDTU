#include "Watchdog.h"
#include <Arduino.h>
#include "config.h"

Watchdog::Watchdog()
    : mode_(MODE_SAFE)
    , heartbeat_seen_(false)
    , manual_active_(false)
    , forced_auto_roam_(false)
    , last_heartbeat_ms_(0)
    , last_serial_activity_ms_(0)
    , startup_ms_(0)
{
}

void Watchdog::begin()
{
    startup_ms_ = millis();
    last_heartbeat_ms_ = startup_ms_;
    last_serial_activity_ms_ = startup_ms_;
}

void Watchdog::onSerialActivity(uint32_t now_ms)
{
    last_serial_activity_ms_ = now_ms;
}

void Watchdog::onHeartbeatReceived(uint32_t now_ms)
{
    last_heartbeat_ms_ = now_ms;
    heartbeat_seen_ = true;

    // Keep an active autonomous dock in AUTO_ROAM while heartbeats continue;
    // the dock state machine owns the motor output until it reaches terminal
    // state. Standalone AUTO_ROAM is likewise pinned by forced_auto_roam_.
    if (mode_ == MODE_AUTO_ROAM) return;

    // Any Pi connection → switch to NAV mode.
    if (mode_ != MODE_NAV) mode_ = MODE_NAV;
}

SystemMode Watchdog::update(uint32_t now_ms)
{
    // Helper: wrap-safe elapsed-time (millis() rolls over every ~49.7 days).
    // Without this, a single rollover event can mask heartbeat timeouts
    // indefinitely and the robot stays stuck in MODE_NAV forever.
    auto elapsedSince = [](uint32_t now, uint32_t then) -> uint32_t {
        return (now >= then) ? (now - then)
                              : (UINT32_MAX - then + now + 1);
    };

    // Boot and Pi-link loss are fail-closed. The chassis may enter sensor-only
    // roaming only after an explicit standalone request, never merely because
    // the Pi stopped sending commands.
    if (!heartbeat_seen_) return mode_;

    // An explicit operator standalone-roam request remains independent from
    // Pi link health. Docking uses setMode(MODE_AUTO_ROAM) without this flag.
    if (forced_auto_roam_) {
        mode_ = MODE_AUTO_ROAM;
        return mode_;
    }

    if (mode_ == MODE_NAV || mode_ == MODE_AUTO_ROAM) {
        if (elapsedSince(now_ms, last_heartbeat_ms_) >= HEARTBEAT_TIMEOUT_MS) {
            mode_ = MODE_SAFE;
        }
    }
    return mode_;
}

void Watchdog::onHeartbeatTimeout()
{
    if (!forced_auto_roam_) {
        mode_ = MODE_SAFE;
    }
}

void Watchdog::setManualActive(bool active)
{
    manual_active_ = active;
    if (active && mode_ == MODE_SAFE) {
        mode_ = MODE_MANUAL;
    }
}

void Watchdog::setMode(SystemMode m, bool standalone_auto_roam)
{
    mode_ = m;
    forced_auto_roam_ = (m == MODE_AUTO_ROAM && standalone_auto_roam);
}

const char* Watchdog::modeName(SystemMode m)
{
    switch (m) {
        case MODE_NAV:       return "NAV";
        case MODE_MANUAL:    return "MANUAL";
        case MODE_SAFE:      return "SAFE";
        case MODE_AUTO_ROAM: return "AUTO_ROAM";
        default:             return "UNKNOWN";
    }
}
