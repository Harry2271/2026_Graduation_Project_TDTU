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
    CMD_OBSTACLE_FRONT_LEFT,
    CMD_OBSTACLE_FRONT_RIGHT,
    CMD_OBSTACLE_REAR,
    CMD_OBSTACLE_REAR_LEFT,
    CMD_OBSTACLE_REAR_RIGHT,
    CMD_OBSTACLE_CLEAR,

    // Sensor query commands
    CMD_GET_IMU,       // IMU heading (type 134)
    CMD_GET_POWER,     // Power telemetry (type 133)
    CMD_GET_IR,        // IR proximity (type 135)
    CMD_GET_FRONT_TOF, // Canonical front VL53L1X query (type 136)
    CMD_GET_SHARP = CMD_GET_FRONT_TOF, // Legacy get_sharp / ASCII J alias

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

    // Phase 1-4 Upgrade Commands (Safety, Battery, Motor Health, BlackBox)
    CMD_CLEAR_SOFT_STOP,     // JSON: clear_soft_stop
    CMD_CLEAR_HARD_STOP,     // JSON: clear_hard_stop
    CMD_CLEAR_EMERGENCY,     // JSON: clear_emergency
    CMD_GET_BLACKBOX,        // JSON: get_blackbox — stream type 147
    CMD_CLEAR_BLACKBOX,      // JSON: clear_blackbox — resume recording
    CMD_RESET_MOTOR_WARNINGS,// JSON: reset_motor_warnings with motor_id
    CMD_RESET_COULOMB,       // JSON: reset_coulomb — zero battery counter

    // Robotic Arm Commands (Phase A)
    CMD_ARM_MOVE,            // JSON: arm_move with joints array [θ1,θ2,θ3,θ4,θ5]
    CMD_ARM_GRIP,            // JSON: arm_grip with close bool
    CMD_ARM_HOME,            // ASCII: 'A' or JSON: arm_home
    CMD_GET_ARM,             // ASCII: 'a' or JSON: get_arm — response type 148

    // PathLearner Commands (Phase 1: RL Navigation)
    CMD_TUNE_AUTO,           // JSON: tune_auto with enable bool
    CMD_RECORD_DELIVERY,     // JSON: record_delivery with time_s, collision, energy_wh, distance_m, jerk_sum
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

    // Obstacle event parameters (populated by obstacle_* commands).
    // Optional fields.  The Pi may include them to convey LiDAR severity
    // to the firmware so it can scale dodge duration/intensity.  When
    // fields are missing, firmware uses the existing default dodge tables.
    //   distance_m:    closest point in the reported zone (meters, 0..12)
    //   severity:      0.0 .. 1.0; 0 = barely inside threshold, 1 = bumper range
    //   has_payload:   true only when JSON included distance_m OR severity
    float obstacle_distance_m;
    float obstacle_severity;
    bool  obstacle_has_payload;

    // Robotic Arm parameters (populated by arm_* commands)
    float arm_joints[5];     // Joint angles θ1..θ5 (degrees or servo positions)
    bool  arm_grip_close;    // true = close gripper, false = open
    bool  has_arm_data;      // true when arm_move or arm_grip was parsed

    // PathLearner parameters (populated by tune_auto / record_delivery)
    bool  tune_enable;       // true = enable auto-tuning, false = disable
    float delivery_time_s;   // Time to complete delivery (seconds)
    bool  delivery_collision;// true if collision occurred during delivery
    float delivery_energy_wh;// Energy consumed during delivery (watt-hours)
    float delivery_distance_m;// Distance traveled (meters)
    float delivery_jerk_sum; // Accumulated jerk integral (smoothness metric)
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
    // Discard an oversized frame through its newline so a truncated command
    // can never be parsed or joined with the following frame.
    bool discard_until_terminator_;
};
