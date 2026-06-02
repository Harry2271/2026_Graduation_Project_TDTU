#include "Watchdog.h"
#include <Arduino.h>
#include "config.h"

Watchdog::Watchdog()
    : mode_(MODE_SAFE)
    , heartbeat_seen_(false)
    , manual_active_(false)
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

    if (mode_ == MODE_SAFE || mode_ == MODE_MANUAL) {
        mode_ = MODE_NAV;
    }
}

SystemMode Watchdog::update(uint32_t now_ms)
{
    if (!heartbeat_seen_) return mode_;

    if (now_ms - last_heartbeat_ms_ >= HEARTBEAT_TIMEOUT_MS) {
        if (mode_ == MODE_NAV) {
            // Pi disconnected — enter manual mode if web control is active,
            // otherwise stay in safe mode
            mode_ = (manual_active_) ? MODE_MANUAL : MODE_SAFE;
        }
    }
    return mode_;
}

void Watchdog::onHeartbeatTimeout()
{
    if (mode_ == MODE_NAV) {
        mode_ = (manual_active_) ? MODE_MANUAL : MODE_SAFE;
    }
}

void Watchdog::setManualActive(bool active)
{
    manual_active_ = active;
    if (active && mode_ == MODE_SAFE) {
        // Allow manual mode even without Pi
        mode_ = MODE_MANUAL;
    }
}

const char* Watchdog::modeName(SystemMode m)
{
    switch (m) {
        case MODE_NAV:    return "NAV";
        case MODE_MANUAL: return "MANUAL";
        case MODE_SAFE:    return "SAFE";
        default:          return "UNKNOWN";
    }
}
