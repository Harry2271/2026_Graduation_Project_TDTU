#pragma once

#include <stdint.h>
#include <string.h>
#include <ArduinoJson.h>

enum CommandType {
    CMD_UNKNOWN = 0,
    CMD_FORWARD,
    CMD_BACKWARD,
    CMD_STOP,
    CMD_E_STOP,
    CMD_E_STOP_CLEAR,
    CMD_GET_ENCODER,
    CMD_RESET_ENCODER,
    CMD_SET_PID,
    CMD_SET_MAX_SPEED,
    CMD_GET_STATUS,
    CMD_TEST,
    CMD_HELP,

    // Mecanum navigation commands
    CMD_MOVE,
    CMD_INDIVIDUAL,
    CMD_HEARTBEAT,

    // LiDAR / obstacle commands (from Pi)
    CMD_OBSTACLE_LEFT,
    CMD_OBSTACLE_RIGHT,
    CMD_OBSTACLE_FRONT,
    CMD_OBSTACLE_CLEAR,

    // Sensor query commands
    CMD_GET_IMU,       // IMU heading (type 134)
    CMD_GET_POWER,     // Power telemetry (type 133)
    CMD_GET_IR,        // IR proximity (type 135)
    CMD_GET_SHARP,     // Sharp front distance (type 136)

    // Raw motor test (bypass PID + ramp)
    CMD_RAW_MOTOR,     // O<id> <speed> — direct PWM to one motor

    // Force into AUTO_ROAM (sensor-only autonomy, ignores Pi heartbeat)
    CMD_FORCE_AUTO_ROAM,

    // VL53L0X TOF distance sensor
    CMD_GET_TOF,        // Y — query distance (type 138)

    // Cylinder actuator (12V lift via L298N)
    CMD_CYLINDER_EXTEND,   // H — extend cylinder
    CMD_CYLINDER_RETRACT,  // h — retract cylinder
    CMD_CYLINDER_STOP,     // c — stop cylinder

    // Docking sequence (Pi brain → ESP32 actuator hand-off)
    CMD_BEGIN_DOCK,          // JSON: begin_dock with tag_id + target_distance_mm
    CMD_BEGIN_LEAVE_DOCK,    // JSON: begin_leave_dock
    CMD_CANCEL_DOCK,         // JSON: cancel_dock
    CMD_GET_UNLOAD_STATE,    // JSON: get_unload_state (response type 140)

    // Cargo sensor (microswitch on cargo bed)
    CMD_GET_CARGO,           // U — query cargo presence (response type 145)

    // System commands
    CMD_RESTART,             // JSON: restart — soft reboot via ESP.restart()
};

struct Command {
    CommandType type;
    int16_t  speed;
    float    kp, ki, kd;
    uint8_t  max_speed;

    int16_t move_vx;
    int16_t move_vy;
    int16_t move_omega;
    uint16_t move_seq;        // sequence number from Pi
    bool has_move_seq;        // true only when JSON included seq

    int16_t motor_speeds[4];

    // Docking command parameters (populated by begin_dock)
    uint16_t tag_id;
    uint16_t target_distance_mm;
    float facing_theta_deg;   // target heading for heading gate
    char    operation_id[37]; // UUID string from Pi (36 chars + NUL); empty if absent
};

class CommandParser {
public:
    CommandParser();

    CommandType feed(uint8_t byte, Command& out_cmd);
    CommandType parse(const char* cmd, Command& out);

private:
    CommandType parseASCII(const char* cmd, Command& out);
    CommandType parseJSON(const char* json_str, Command& out);
    static int  clampVal(int val, int min_val, int max_val);

    static constexpr size_t CMD_BUFFER_SIZE = 256;
    char buffer_[CMD_BUFFER_SIZE];
    size_t buffer_index_;
};
