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
};

struct Command {
    CommandType type;
    int16_t  speed;
    float    kp, ki, kd;
    uint8_t  max_speed;

    int16_t move_vx;
    int16_t move_vy;
    int16_t move_omega;

    int16_t motor_speeds[4];
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
