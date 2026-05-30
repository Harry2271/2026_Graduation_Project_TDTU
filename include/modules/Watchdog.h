#pragma once

#include <stdint.h>

enum SystemMode {
    MODE_SAFE,   // No heartbeat — motors stopped, waiting for connection
    MODE_NAV,    // Active heartbeat from Pi+LiDAR — autonomous navigation
    MODE_MANUAL, // Pi disconnected, but web/manual control active
};

class Watchdog {
public:
    Watchdog();

    void begin();

    // Call periodically to check heartbeat
    SystemMode update(uint32_t now_ms);

    // Call when any Pi/serial command is received
    void onHeartbeatReceived(uint32_t now_ms);

    // Call when Pi heartbeat times out
    void onHeartbeatTimeout();

    // Call when manual/web control is activated
    void setManualActive(bool active);

    [[nodiscard]] SystemMode getMode() const { return mode_; }
    [[nodiscard]] bool hasHeartbeat() const { return heartbeat_seen_; }
    [[nodiscard]] uint32_t getLastHeartbeatMs() const { return last_heartbeat_ms_; }
    [[nodiscard]] uint32_t getUptimeMs() const { return startup_ms_; }

    static const char* modeName(SystemMode m);

private:
    SystemMode mode_;
    bool heartbeat_seen_;
    bool manual_active_;
    uint32_t last_heartbeat_ms_;
    uint32_t startup_ms_;
};
