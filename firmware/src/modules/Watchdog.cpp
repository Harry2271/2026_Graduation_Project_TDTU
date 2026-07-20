#include "Watchdog.h"
#include <Arduino.h>
#include "config.h"

Watchdog::Watchdog()
    : mode_(MODE_SAFE)
    , heartbeat_seen_(false)
    , manual_active_(false)
    , forced_auto_roam_(false)
    , last_heartbeat_ms_(0)
    , startup_ms_(0)
{
}

void Watchdog::begin()
{
    startup_ms_ = millis();
    last_heartbeat_ms_ = startup_ms_;
}

void Watchdog::onHeartbeatReceived(uint32_t now_ms)
{
    last_heartbeat_ms_ = now_ms;
    heartbeat_seen_ = true;

    // Respect forced AUTO_ROAM — don't bounce back to NAV on heartbeat.
    // The user pressed 'A' explicitly to enter sensor-only mode.
    if (forced_auto_roam_) return;

    // Any Pi connection → switch to NAV mode
    if (mode_ != MODE_NAV) {
        mode_ = MODE_NAV;
    }
}

SystemMode Watchdog::update(uint32_t now_ms)
{
    // First boot: after init delay, enter AUTO_ROAM if no Pi connected yet
    if (!heartbeat_seen_ && mode_ == MODE_SAFE && !forced_auto_roam_) {
        if (now_ms - startup_ms_ >= AUTO_ROAM_BOOT_DELAY_MS) {
            mode_ = MODE_AUTO_ROAM;
        }
        return mode_;
    }

    if (!heartbeat_seen_) return mode_;

    // Forced AUTO_ROAM never goes back to NAV
    if (forced_auto_roam_) {
        mode_ = MODE_AUTO_ROAM;
        return mode_;
    }

    // Heartbeat timeout from NAV → enter AUTO_ROAM (keep driving with sensors)
    if (now_ms - last_heartbeat_ms_ >= HEARTBEAT_TIMEOUT_MS) {
        if (mode_ == MODE_NAV) {
            mode_ = MODE_AUTO_ROAM;
        }
    }
    return mode_;
}

void Watchdog::onHeartbeatTimeout()
{
    if (mode_ == MODE_NAV) {
        mode_ = MODE_AUTO_ROAM;
    }
}

void Watchdog::setManualActive(bool active)
{
    manual_active_ = active;
    if (active && mode_ == MODE_SAFE) {
        mode_ = MODE_MANUAL;
    }
}

void Watchdog::setMode(SystemMode m)
{
    mode_ = m;
    if (m == MODE_AUTO_ROAM) {
        forced_auto_roam_ = true;
    } else {
        forced_auto_roam_ = false;
    }
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
