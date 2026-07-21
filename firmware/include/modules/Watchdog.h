#pragma once

#include <stdint.h>

enum SystemMode {
    MODE_SAFE,      // No heartbeat — motors stopped, waiting for connection
    MODE_NAV,       // Active heartbeat from Pi+LiDAR — autonomous navigation
    MODE_MANUAL,    // Pi disconnected, but web/manual control active
    MODE_AUTO_ROAM, // Pi disconnected — drive autonomously using onboard sensors
};

class Watchdog {
public:
    Watchdog();

    void begin();

    // Call periodically to check heartbeat
    SystemMode update(uint32_t now_ms);

    // Call when any Pi/serial command is received
    void onHeartbeatReceived(uint32_t now_ms);

    // Call when raw bytes have been seen from the Pi, even if the parser
    // rejected them (e.g. corrupted/partial JSON frame during cable yank).
    // This prevents the watchdog from getting stuck in MODE_NAV if the
    // parser can't deliver a clean CMD_HEARTBEAT to onHeartbeatReceived.
    void onSerialActivity(uint32_t now_ms);

    // Call when Pi heartbeat times out
    void onHeartbeatTimeout();

    // Call when manual/web control is activated
    void setManualActive(bool active);

    // Force a specific mode (used by ASCII 'A' command to enter AUTO_ROAM on demand)
    void setMode(SystemMode m);

    [[nodiscard]] SystemMode getMode() const { return mode_; }
    [[nodiscard]] bool hasHeartbeat() const { return heartbeat_seen_; }
    [[nodiscard]] bool isForcedAutoRoam() const { return forced_auto_roam_; }
    [[nodiscard]] uint32_t getLastHeartbeatMs() const { return last_heartbeat_ms_; }
    [[nodiscard]] uint32_t getLastSerialActivityMs() const { return last_serial_activity_ms_; }
    [[nodiscard]] uint32_t getUptimeMs() const { return startup_ms_; }

    static const char* modeName(SystemMode m);

private:
    SystemMode mode_;
    bool heartbeat_seen_;
    bool manual_active_;
    bool forced_auto_roam_;  // true after explicit 'A' command — pins AUTO_ROAM
    uint32_t last_heartbeat_ms_;
    uint32_t last_serial_activity_ms_;  // last time any byte arrived from Serial
    uint32_t startup_ms_;
};
