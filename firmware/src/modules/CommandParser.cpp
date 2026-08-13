#include "CommandParser.h"
#include "config.h"

CommandParser::CommandParser()
    : buffer_index_(0)
{
    buffer_[0] = '\0';
}

CommandType CommandParser::feed(uint8_t byte, Command& out_cmd)
{
    if (byte == '\r') return CMD_UNKNOWN;

    if (byte == CMD_TERMINATOR || byte == '\n') {
        if (buffer_index_ > 0) {
            buffer_[buffer_index_] = '\0';
            buffer_index_ = 0;
            return parse(buffer_, out_cmd);
        }
        return CMD_UNKNOWN;
    }

    if (buffer_index_ < CMD_BUFFER_SIZE - 1) {
        buffer_[buffer_index_++] = (char)byte;
        buffer_[buffer_index_] = '\0';
    }
    return CMD_UNKNOWN;
}

CommandType CommandParser::parse(const char* cmd, Command& out)
{
    memset(&out, 0, sizeof(out));

    if (cmd[0] == '{') {
        return parseJSON(cmd, out);
    }
    return parseASCII(cmd, out);
}

CommandType CommandParser::parseASCII(const char* cmd, Command& out)
{
    out.type = CMD_UNKNOWN;

    char first = cmd[0];

    switch (first) {
        case 'F': case 'f': {
            int v = atoi(cmd + 1);
            out.type  = CMD_FORWARD;
            out.speed = clampVal(v, 0, 255);
        } break;

        case 'B': case 'b': {
            int v = atoi(cmd + 1);
            out.type  = CMD_BACKWARD;
            out.speed = clampVal(v, 0, 255);
        } break;

        case 'L': case 'l': {
            int v = atoi(cmd + 1);
            out.type        = CMD_MOVE;
            out.move_vx     = 0;
            out.move_vy     = -clampVal(v, 0, 255);
            out.move_omega  = 0;
        } break;

        case 'R': case 'r': {
            if (cmd[1] != '\0' && cmd[1] >= '0' && cmd[1] <= '9') {
                int v = atoi(cmd + 1);
                out.type        = CMD_MOVE;
                out.move_vx     = 0;
                out.move_vy     = clampVal(v, 0, 255);
                out.move_omega  = 0;
            } else {
                out.type = CMD_RESET_ENCODER;
            }
        } break;

        case 'Q': case 'q': {
            int v = atoi(cmd + 1);
            out.type        = CMD_MOVE;
            out.move_vx     = 0;
            out.move_vy     = 0;
            out.move_omega  = -clampVal(v, 0, 255);
        } break;

        case 'E': case 'e': {
            int v = atoi(cmd + 1);
            out.type        = CMD_MOVE;
            out.move_vx     = 0;
            out.move_vy     = 0;
            out.move_omega  = clampVal(v, 0, 255);
        } break;

        case 'M': case 'm': {
            int m[4] = {0, 0, 0, 0};
            int n = sscanf(cmd + 1, "%d %d %d %d", &m[0], &m[1], &m[2], &m[3]);
            if (n >= 4) {
                out.type = CMD_INDIVIDUAL;
                for (int i = 0; i < 4; i++) {
                    out.motor_speeds[i] = clampVal(m[i], -255, 255);
                }
            }
        } break;

        case 'S': case 's': {
            out.type = CMD_STOP;
        } break;

        case 'D': case 'd': {
            out.type = CMD_E_STOP;
        } break;

        case 'K': case 'k': {
            out.type = CMD_E_STOP_CLEAR;
        } break;

        case 'V': case 'v': {
            out.type = CMD_GET_STATUS;
        } break;

        case 'I': case 'i': {
            out.type = CMD_GET_IMU;
        } break;

        case 'W': case 'w': {
            out.type = CMD_GET_POWER;
        } break;

        case 'N': case 'n': {
            out.type = CMD_GET_IR;
        } break;

        case 'J': case 'j': {
            out.type = CMD_GET_SHARP;
        } break;

        case 'P': case 'p': {
            float kp, ki, kd;
            if (sscanf(cmd + 1, "%f %f %f", &kp, &ki, &kd) == 3) {
                out.type = CMD_SET_PID;
                out.kp   = kp;
                out.ki   = ki;
                out.kd   = kd;
            }
        } break;

        case 'X': case 'x': {
            int v = atoi(cmd + 1);
            out.type      = CMD_SET_MAX_SPEED;
            out.max_speed = clampVal(v, 0, 100);
        } break;

        case 'A': case 'a':
            // Force AUTO_ROAM mode (sensor-only autonomy, ignores Pi heartbeat)
            out.type = CMD_FORCE_AUTO_ROAM;
            break;

        case 'U': case 'u': {
            out.type = CMD_GET_CARGO;
        } break;

        case 'T': case 't': {
            out.type = CMD_TEST;
        } break;

        case 'Y': case 'y': {
            out.type = CMD_GET_TOF;
        } break;

        case 'G': case 'g': {
            // G = extend (uppercase), g = retract (lowercase)
            if (first == 'G') {
                out.type = CMD_CYLINDER_EXTEND;
            } else {
                out.type = CMD_CYLINDER_RETRACT;
            }
        } break;

        case 'C': case 'c': {
            out.type = CMD_CYLINDER_STOP;
        } break;

        case 'Z': case 'z': {
            out.type = CMD_HEARTBEAT;
        } break;

        case '?': case 'h': case 'H': {
            out.type = CMD_HELP;
        } break;

        case 'O': case 'o': {
            // O<id> <speed> — raw motor test, bypass PID + ramp
            int id = 0, speed = 0;
            if (sscanf(cmd + 1, "%d %d", &id, &speed) == 2) {
                out.type = CMD_RAW_MOTOR;
                out.motor_speeds[0] = clampVal(id, 0, 3);
                out.motor_speeds[1] = clampVal(speed, -255, 255);
            }
        } break;

        default:
            out.type = CMD_UNKNOWN;
            break;
    }

    return out.type;
}

CommandType CommandParser::parseJSON(const char* json_str, Command& out)
{
    memset(&out, 0, sizeof(out));
    out.type = CMD_UNKNOWN;

    static ArduinoJson::JsonDocument doc;
    doc.clear();

    ArduinoJson::DeserializationError err = deserializeJson(doc, json_str);
    if (err) return CMD_UNKNOWN;

    const char* cmd = doc["cmd"];
    if (!cmd) return CMD_UNKNOWN;

    if (strcmp(cmd, "forward") == 0) {
        out.type  = CMD_FORWARD;
        out.speed = doc["speed"] | 0;
    }
    else if (strcmp(cmd, "backward") == 0) {
        out.type  = CMD_BACKWARD;
        out.speed = doc["speed"] | 0;
    }
    else if (strcmp(cmd, "stop") == 0) {
        out.type = CMD_STOP;
    }
    else if (strcmp(cmd, "e_stop") == 0) {
        out.type = CMD_E_STOP;
    }
    else if (strcmp(cmd, "e_stop_clear") == 0) {
        out.type = CMD_E_STOP_CLEAR;
    }
    else if (strcmp(cmd, "get_encoder") == 0) {
        out.type = CMD_GET_ENCODER;
    }
    else if (strcmp(cmd, "reset_encoder") == 0) {
        out.type = CMD_RESET_ENCODER;
    }
    else if (strcmp(cmd, "set_pid") == 0) {
        out.type = CMD_SET_PID;
        out.kp   = doc["kp"] | DEFAULT_KP;
        out.ki   = doc["ki"] | DEFAULT_KI;
        out.kd   = doc["kd"] | DEFAULT_KD;
    }
    else if (strcmp(cmd, "get_status") == 0) {
        out.type = CMD_GET_STATUS;
    }
    else if (strcmp(cmd, "set_max_speed") == 0) {
        out.type      = CMD_SET_MAX_SPEED;
        out.max_speed = doc["speed"] | 100;
    }
    else if (strcmp(cmd, "move") == 0) {
        out.type        = CMD_MOVE;
        out.move_vx     = doc["vx"]     | 0;
        out.move_vy     = doc["vy"]     | 0;
        out.move_omega  = doc["omega"]  | 0;
        out.has_move_seq = doc.containsKey("seq");
        out.move_seq    = doc["seq"]    | 0;
        out.move_vx     = clampVal(out.move_vx,   -255, 255);
        out.move_vy     = clampVal(out.move_vy,   -255, 255);
        out.move_omega = clampVal(out.move_omega, -255, 255);
    }
    else if (strcmp(cmd, "individual") == 0) {
        out.type = CMD_INDIVIDUAL;
        ArduinoJson::JsonArray arr = doc["speeds"];
        if (arr.size() >= 4) {
            for (int i = 0; i < 4; i++) {
                out.motor_speeds[i] = clampVal((int)arr[i].as<int>(), -255, 255);
            }
        } else {
            out.type = CMD_UNKNOWN;
        }
    }
    else if (strcmp(cmd, "heartbeat") == 0) {
        out.type = CMD_HEARTBEAT;
    }
    else if (strncmp(cmd, "obstacle_", 9) == 0) {
        // Obstacle commands are intentionally backward-compatible: the
        // direction remains encoded in the command name, while distance and
        // severity are optional JSON fields from the Pi LiDAR fusion layer.
        if (strcmp(cmd, "obstacle_left") == 0) {
            out.type = CMD_OBSTACLE_LEFT;
        } else if (strcmp(cmd, "obstacle_right") == 0) {
            out.type = CMD_OBSTACLE_RIGHT;
        } else if (strcmp(cmd, "obstacle_front") == 0) {
            out.type = CMD_OBSTACLE_FRONT;
        } else if (strcmp(cmd, "obstacle_front_left") == 0) {
            out.type = CMD_OBSTACLE_FRONT_LEFT;
        } else if (strcmp(cmd, "obstacle_front_right") == 0) {
            out.type = CMD_OBSTACLE_FRONT_RIGHT;
        } else if (strcmp(cmd, "obstacle_rear") == 0) {
            out.type = CMD_OBSTACLE_REAR;
        } else if (strcmp(cmd, "obstacle_rear_left") == 0) {
            out.type = CMD_OBSTACLE_REAR_LEFT;
        } else if (strcmp(cmd, "obstacle_rear_right") == 0) {
            out.type = CMD_OBSTACLE_REAR_RIGHT;
        } else if (strcmp(cmd, "obstacle_clear") == 0) {
            out.type = CMD_OBSTACLE_CLEAR;
        }
        if (out.type != CMD_UNKNOWN) {
            out.obstacle_has_payload = doc.containsKey("distance_m") ||
                                       doc.containsKey("severity");
            out.obstacle_distance_m = doc["distance_m"] | 0.0f;
            out.obstacle_severity = doc["severity"] | 0.0f;
            out.obstacle_distance_m = constrain(out.obstacle_distance_m, 0.0f, 12.0f);
            out.obstacle_severity = constrain(out.obstacle_severity, 0.0f, 1.0f);
        }
    }
    else if (strcmp(cmd, "get_imu") == 0) {
        out.type = CMD_GET_IMU;
    }
    else if (strcmp(cmd, "get_power") == 0) {
        out.type = CMD_GET_POWER;
    }
    else if (strcmp(cmd, "set_speed") == 0) {
        int motor_id = doc["motor_id"] | -1;
        int speed    = doc["speed"]    | 0;
        if (motor_id >= 0 && motor_id < 4) {
            out.type = CMD_INDIVIDUAL;
            for (int i = 0; i < 4; i++) out.motor_speeds[i] = 0;
            out.motor_speeds[motor_id] = clampVal(speed, -255, 255);
        }
    }
    else if (strcmp(cmd, "set_all_speed") == 0) {
        out.type = CMD_INDIVIDUAL;
        ArduinoJson::JsonArray arr = doc["speeds"];
        if (arr.size() >= 4) {
            for (int i = 0; i < 4; i++) {
                out.motor_speeds[i] = clampVal((int)arr[i].as<int>(), -255, 255);
            }
        } else {
            out.type = CMD_UNKNOWN;
        }
    }
    else if (strcmp(cmd, "get_ir") == 0) {
        out.type = CMD_GET_IR;
    }
    else if (strcmp(cmd, "get_sharp") == 0) {
        out.type = CMD_GET_SHARP;
    }
    else if (strcmp(cmd, "get_tof") == 0) {
        out.type = CMD_GET_TOF;
    }
    else if (strcmp(cmd, "cylinder_extend") == 0) {
        out.type = CMD_CYLINDER_EXTEND;
    }
    else if (strcmp(cmd, "cylinder_retract") == 0) {
        out.type = CMD_CYLINDER_RETRACT;
    }
    else if (strcmp(cmd, "cylinder_stop") == 0) {
        out.type = CMD_CYLINDER_STOP;
    }
    else if (strcmp(cmd, "begin_dock") == 0) {
        out.type               = CMD_BEGIN_DOCK;
        out.tag_id             = doc["tag_id"]             | 0;
        out.target_distance_mm = doc["target_distance_mm"] | VL53L0X_UNLOAD_DISTANCE_MM;
        out.facing_theta_deg   = doc["facing_theta"]       | -999.0f;
        // Idempotency key from Pi brain (UUID string, empty if absent)
        const char* oid = doc["operation_id"] | "";
        strncpy(out.operation_id, oid, sizeof(out.operation_id) - 1);
        out.operation_id[sizeof(out.operation_id) - 1] = '\0';
    }
    else if (strcmp(cmd, "begin_leave_dock") == 0) {
        out.type = CMD_BEGIN_LEAVE_DOCK;
    }
    else if (strcmp(cmd, "cancel_dock") == 0) {
        out.type = CMD_CANCEL_DOCK;
    }
    else if (strcmp(cmd, "get_unload_state") == 0) {
        out.type = CMD_GET_UNLOAD_STATE;
    }
    else if (strcmp(cmd, "get_cargo") == 0) {
        out.type = CMD_GET_CARGO;
    }
    else if (strcmp(cmd, "restart") == 0) {
        out.type = CMD_RESTART;
    }

    return out.type;
}

int CommandParser::clampVal(int val, int min_val, int max_val)
{
    if (val < min_val) return min_val;
    if (val > max_val) return max_val;
    return val;
}
