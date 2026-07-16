#include <Arduino.h>
#include <driver/ledc.h>
#include <driver/gpio.h>
#include <string.h>
#include <Wire.h>

#include "config.h"
#include "modules.h"

// ========================================================================
// Hardware Instances
// ========================================================================
BTS7960Driver g_motors[4] = {
    BTS7960Driver(MOTOR_PINS[0].rpwm, MOTOR_PINS[0].lpwm, MOTOR_PINS[0].en,
                  LEDC_CHAN_RPWM[0], LEDC_CHAN_LPWM[0]),
    BTS7960Driver(MOTOR_PINS[1].rpwm, MOTOR_PINS[1].lpwm, MOTOR_PINS[1].en,
                  LEDC_CHAN_RPWM[1], LEDC_CHAN_LPWM[1]),
    BTS7960Driver(MOTOR_PINS[2].rpwm, MOTOR_PINS[2].lpwm, MOTOR_PINS[2].en,
                  LEDC_CHAN_RPWM[2], LEDC_CHAN_LPWM[2]),
    BTS7960Driver(MOTOR_PINS[3].rpwm, MOTOR_PINS[3].lpwm, MOTOR_PINS[3].en,
                  LEDC_CHAN_RPWM[3], LEDC_CHAN_LPWM[3]),
};

Encoder g_encoders[4] = {
    Encoder(PCNT_UNITS[0], ENCODER_PINS[0].cha, ENCODER_PINS[0].chb, "FL"),
    Encoder(PCNT_UNITS[1], ENCODER_PINS[1].cha, ENCODER_PINS[1].chb, "FR"),
    Encoder(PCNT_UNITS[2], ENCODER_PINS[2].cha, ENCODER_PINS[2].chb, "RL"),
    Encoder(PCNT_UNITS[3], ENCODER_PINS[3].cha, ENCODER_PINS[3].chb, "RR"),
};

PIDController g_pid[4] = {
    PIDController("FL"),
    PIDController("FR"),
    PIDController("RL"),
    PIDController("RR"),
};

MecanumDrive  g_mecanum;
CommandParser g_parser;
ModeManager   g_modeManager;
BNO055Sensor  g_imu;
INA226Sensor  g_power;
IRProximitySensor g_ir;
SharpFrontSensor g_sharp;
VL53L0XSensor   g_tof;
CylinderActuator g_cylinder;

// ========================================================================
// Motor State — single control path
// ========================================================================
int16_t g_target_speeds[4] = {0};
int16_t g_ramped_speeds[4] = {0};
bool g_pid_enabled = true;
bool g_e_stop_active = false;
uint8_t g_max_speed_pct = 100;

// Navigation velocity (vx/vy/omega) — single source of truth for movement
int16_t g_nav_vx     = 0;
int16_t g_nav_vy     = 0;
int16_t g_nav_omega  = 0;

// Per-wheel override (CMD_INDIVIDUAL) — bypasses mecanum when active
bool g_individual_mode = false;

// Obstacle avoidance state (from IR + Sharp sensors)
ObstacleAvoidance g_obstacle;

// Kick-start boost: applies extra PWM for first few ticks when motor starts
#define KICK_BOOST_PWM     180     // Extra PWM to overcome static friction
#define KICK_BOOST_TICKS   8       // Number of PID ticks (~160ms at 50Hz)
int8_t g_kick_ticks[4] = {0, 0, 0, 0};

// Direct motor test mode (bypasses PID + ramp, for hardware debugging)
bool g_raw_test_mode = false;
int16_t g_raw_test_speeds[4] = {0};

// Shared JSON output buffer for status messages (UART to Pi 5)
static char g_json_buf[1200];

// Unload state tracking (for transition detection → type 140 emit)
AutoRoam::UnloadState g_last_unload_state = AutoRoam::UNLOAD_IDLE;

// ========================================================================
// LEDC Timer Setup
// ========================================================================
void setupLEDC()
{
    ledc_timer_config_t timer_conf = {};
    timer_conf.speed_mode      = LEDC_LOW_SPEED_MODE;
    timer_conf.timer_num       = LEDC_TIMER_0;
    timer_conf.freq_hz         = PWM_FREQUENCY;
    timer_conf.duty_resolution = (ledc_timer_bit_t)PWM_RESOLUTION;
    timer_conf.clk_cfg         = LEDC_AUTO_CLK;
    ledc_timer_config(&timer_conf);
}

// ========================================================================
// Hardware Initialization
// ========================================================================
void setupHardware()
{
    Serial.setTimeout(1);
    Serial.begin(SERIAL_BAUD);
    delay(500);

    digitalWrite(2, LOW);  // LED off — ESP32-S3 WeAct built-in
    digitalWrite(2, LOW);

    // ---- I2C bus (shared: BNO055 + INA226) ----
    Wire.begin(BNO055_SDA_PIN, BNO055_SCL_PIN);
    Wire.setClock(BNO055_I2C_FREQ_HZ);

    setupLEDC();

    for (int i = 0; i < MOTOR_COUNT; i++) {
        g_motors[i].begin();
        g_motors[i].enable();
        g_motors[i].coast();
        Serial.printf("  [MOTOR %d %s] EN=GPIO%d RPWM=GPIO%d LPWM=GPIO%d\n",
            i, MOTOR_NAMES[i],
            MOTOR_PINS[i].en, MOTOR_PINS[i].rpwm, MOTOR_PINS[i].lpwm);
    }

    for (int i = 0; i < MOTOR_COUNT; i++) {
        g_encoders[i].begin();
    }

    for (int i = 0; i < MOTOR_COUNT; i++) {
        g_pid[i].setGains(DEFAULT_KP, DEFAULT_KI, DEFAULT_KD);
    }

    // ---- I2C sensors ----
    if (!g_imu.begin(BNO055_I2C_ADDR)) {
        Serial.println("  [WARN] BNO055 not found — IMU telemetry disabled");
    } else {
        Serial.println("  [OK]   BNO055 IMU ready");
    }

    if (!g_power.begin(INA226_I2C_ADDR)) {
        Serial.println("  [WARN] INA226 not found — power telemetry disabled");
    } else {
        Serial.println("  [OK]   INA226 power monitor ready");
    }

    // Wire sensors into ModeManager for AUTO_ROAM (Pi-less) operation
    g_modeManager.attachSensors(&g_imu, &g_ir, &g_sharp, &g_power, &g_tof, &g_cylinder);

    // ---- IR proximity sensors ----
    g_ir.begin();

    // ---- Sharp front distance sensor ----
    g_sharp.begin();

    // ---- VL53L0X TOF distance sensor (rear, used for unloading precision) ----
    if (!g_tof.begin()) {
        Serial.println("  [WARN] VL53L0X TOF init failed — unloading precision disabled");
    }

    // ---- Cylinder actuator (12V lift cylinder via L298N) ----
    g_cylinder.begin();

    Serial.printf("\n");
    Serial.printf("=====================================================\n");
    Serial.printf("  ESP32-S3 Mecanum Controller\n");
    Serial.printf("=====================================================\n");
    Serial.printf("  Motors: %d | Encoders: PCNT 0-3\n", MOTOR_COUNT);
    Serial.printf("  PID: %.2f / %.2f / %.2f @ %d Hz\n",
        DEFAULT_KP, DEFAULT_KI, DEFAULT_KD, PID_UPDATE_RATE_HZ);
    Serial.printf("  I2C: SDA=%u SCL=%u @ %u kHz\n", BNO055_SDA_PIN, BNO055_SCL_PIN, BNO055_I2C_FREQ_HZ / 1000);
    Serial.printf("  IMU:  %s\n", g_imu.isOperational() ? "BNO055 (heading + accel + gyro)" : "NONE");
    Serial.printf("  PWR:  %s\n", g_power.isOperational() ? "INA226 (V + I + P)" : "NONE");
    Serial.printf("  IR:   %d proximity sensors\n", IR_SENSOR_COUNT);
    Serial.printf("  SHARP: GP2Y0A21YK0F front (GPIO %u, < %dcm)\n",
        SHARP_FRONT_PIN, SHARP_FRONT_THRESHOLD_CM);
    Serial.printf("  Heartbeat timeout: %d ms\n", HEARTBEAT_TIMEOUT_MS);
    Serial.printf("=====================================================\n");
    Serial.printf("\n");
}

// ========================================================================
// Compute motor targets from nav velocity (called before applySpeeds)
// ========================================================================
void computeNavTargets()
{
    // Apply obstacle avoidance to nav velocity
    int16_t adj_vx    = g_nav_vx;
    int16_t adj_vy    = g_nav_vy;
    int16_t adj_omega = g_nav_omega;
    g_obstacle.applyToCommand(adj_vx, adj_vy, adj_omega, millis());

    // Mecanum kinematics → 4 wheel targets
    g_mecanum.compute(adj_vx, adj_vy, adj_omega, g_target_speeds);
}

// ========================================================================
// Apply speeds with kick-start boost + ramp + PID
// ========================================================================
void applySpeeds()
{
    if (g_e_stop_active) {
        for (int i = 0; i < MOTOR_COUNT; i++) {
            g_motors[i].emergencyStop();
        }
        return;
    }

    // Raw test mode: bypass PID + ramp, send PWM directly
    if (g_raw_test_mode) {
        for (int i = 0; i < MOTOR_COUNT; i++) {
            int16_t s = g_raw_test_speeds[i] * MOTOR_PINS[i].dir;
            g_motors[i].setSpeed(s);
        }
        return;
    }

    for (int i = 0; i < MOTOR_COUNT; i++) {
        // Detect motor start: was stopped, now has a target
        // Guard: only kick if no kick already active (prevents re-trigger on direction change)
        if (g_ramped_speeds[i] == 0 && g_target_speeds[i] != 0 && g_kick_ticks[i] == 0) {
            g_kick_ticks[i] = KICK_BOOST_TICKS;
        }

        // Ramp toward target
        int16_t diff = g_target_speeds[i] - g_ramped_speeds[i];
        if (diff > ACCEL_RAMP_RATE) {
            g_ramped_speeds[i] += ACCEL_RAMP_RATE;
        } else if (diff < -ACCEL_RAMP_RATE) {
            g_ramped_speeds[i] -= ACCEL_RAMP_RATE;
        } else {
            g_ramped_speeds[i] = g_target_speeds[i];
        }

        float scale = g_max_speed_pct / 100.0f;
        int16_t limited = (int16_t)(g_ramped_speeds[i] * scale);

        // Apply kick-start boost for first KICK_BOOST_TICKS after motor starts
        if (g_kick_ticks[i] > 0) {
            int16_t boost = (limited > 0) ? KICK_BOOST_PWM : -KICK_BOOST_PWM;
            limited += boost;
            limited = constrain(limited, -MOTOR_MAX_DUTY, MOTOR_MAX_DUTY);
            g_kick_ticks[i]--;
        }

        float target_rpm = limited * (MOTOR_NOMINAL_RPM / 255.0f);

        if (g_pid_enabled) {
            float actual_rpm = g_encoders[i].getFilteredRPM() * MOTOR_PINS[i].dir;
            int16_t correction = g_pid[i].compute(target_rpm, actual_rpm, PID_UPDATE_MS * 1000);
            int16_t final_pwm = limited + correction;
            final_pwm = constrain(final_pwm, -MOTOR_MAX_DUTY, MOTOR_MAX_DUTY);
            int16_t motor_cmd = final_pwm * MOTOR_PINS[i].dir;
            g_motors[i].setSpeed(motor_cmd);

            // Debug: print every motor's signal path (once per second per motor)
            static uint32_t last_debug_ms[4] = {0, 0, 0, 0};
            if (millis() - last_debug_ms[i] >= 1000 && abs(g_target_speeds[i]) > 10) {
                last_debug_ms[i] = millis();
                Serial.printf("  [%s] tgt=%d ramp=%d lim=%d tgtRPM=%.0f actRPM=%.0f corr=%d pwm=%d cmd=%d dir=%d\n",
                    MOTOR_NAMES[i], g_target_speeds[i], g_ramped_speeds[i], limited,
                    target_rpm, actual_rpm, correction, final_pwm, motor_cmd, MOTOR_PINS[i].dir);
            }
        } else {
            g_motors[i].setSpeed(limited * MOTOR_PINS[i].dir);
        }
    }
}

// ========================================================================
// ASCII Command Handlers
// ========================================================================
void handleForward(int speed)
{
    g_individual_mode = false;
    g_raw_test_mode = false;
    g_nav_vx    = constrain(speed, 0, 255);
    g_nav_vy    = 0;
    g_nav_omega = 0;
    Serial.printf("ACK: forward %d\n", speed);
}

void handleBackward(int speed)
{
    g_individual_mode = false;
    g_raw_test_mode = false;
    g_nav_vx    = -constrain(speed, 0, 255);
    g_nav_vy    = 0;
    g_nav_omega = 0;
    Serial.printf("ACK: backward %d\n", speed);
}

void handleStop()
{
    g_nav_vx    = 0;
    g_nav_vy    = 0;
    g_nav_omega = 0;
    g_raw_test_mode = false;
    for (int i = 0; i < MOTOR_COUNT; i++) {
        g_target_speeds[i] = 0;
        g_ramped_speeds[i] = 0;
        g_raw_test_speeds[i] = 0;
        g_kick_ticks[i] = 0;
        g_motors[i].brake();
    }
    Serial.println("ACK: stopped");
}

void handleEStop()
{
    g_e_stop_active = true;
    g_pid_enabled   = false;
    g_nav_vx    = 0;
    g_nav_vy    = 0;
    g_nav_omega = 0;
    for (int i = 0; i < MOTOR_COUNT; i++) {
        g_target_speeds[i] = 0;
        g_ramped_speeds[i] = 0;
        g_motors[i].emergencyStop();
    }
    Serial.println("ACK: E-STOP activated");
}

void handleEStopClear()
{
    g_e_stop_active = false;
    g_pid_enabled   = true;
    g_nav_vx    = 0;
    g_nav_vy    = 0;
    g_nav_omega = 0;
    for (int i = 0; i < MOTOR_COUNT; i++) {
        g_motors[i].enable();
        g_motors[i].coast();
        g_ramped_speeds[i]  = 0;
        g_target_speeds[i]  = 0;
    }
    Serial.println("ACK: E-STOP cleared");
}

void handleSetPID(float kp, float ki, float kd)
{
    for (int i = 0; i < MOTOR_COUNT; i++) {
        g_pid[i].setGains(kp, ki, kd);
    }
    g_pid_enabled = true;
    Serial.printf("ACK: PID kp=%.2f ki=%.2f kd=%.2f\n", kp, ki, kd);
}

void handleSetMaxSpeed(int pct)
{
    g_max_speed_pct = constrain(pct, 0, 100);
    Serial.printf("ACK: max_speed=%d%%\n", g_max_speed_pct);
}

void handleGetEncoder()
{
    const int16_t* tgt = g_modeManager.getRampedSpeeds();
    size_t n = JsonStatus::emitEncoderSnapshot(
        g_json_buf, sizeof(g_json_buf),
        tgt, g_encoders);
    Serial.write(g_json_buf, n);
}

void handleResetEncoder()
{
    for (int i = 0; i < MOTOR_COUNT; i++) g_encoders[i].reset();
    Serial.println("ACK: encoders reset");
}

void handleGetStatus()
{
    size_t n = JsonStatus::emitFullStatus(
        g_json_buf, sizeof(g_json_buf), millis(),
        &g_modeManager, &g_mecanum,
        g_encoders, g_pid, g_motors,
        &g_imu, &g_power, &g_ir, &g_sharp,
        &g_tof, &g_cylinder,
        g_nav_vx, g_nav_vy, g_nav_omega,
        g_e_stop_active, g_max_speed_pct);
    Serial.write(g_json_buf, n);
}

void handleUnloadState()
{
    size_t n = JsonStatus::emitUnloadState(
        g_json_buf, sizeof(g_json_buf), millis(),
        &g_modeManager.getAutoRoam(),
        &g_tof, &g_imu, &g_cylinder);
    Serial.write(g_json_buf, n);
}

void handleTestSequence()
{
    Serial.printf("ACK: test sequence starting...\n");
    handleStop();
    delay(500);

    g_individual_mode = false;
    int16_t steps[] = { 50, 100, 150, 200, 150, 100, 50, 0 };
    for (size_t i = 0; i < sizeof(steps)/sizeof(steps[0]); i++) {
        Serial.printf("TEST: forward %d\n", steps[i]);
        g_nav_vx = steps[i];
        g_nav_vy = 0;
        g_nav_omega = 0;
        delay(1000);
    }
    handleStop();
    Serial.println("ACK: test sequence complete");
}

void handleHelp()
{
    Serial.println();
    Serial.println("=== ESP32-S3 Mecanum Controller ===");
    Serial.println("ASCII Commands:");
    Serial.println("  F<0-255>    Forward");
    Serial.println("  B<0-255>    Backward");
    Serial.println("  L<0-255>    Strafe left");
    Serial.println("  R<0-255>    Strafe right");
    Serial.println("  Q<0-255>    Rotate CCW");
    Serial.println("  E<0-255>    Rotate CW");
    Serial.println("  S           Stop (brake)");
    Serial.println("  D           E-Stop");
    Serial.println("  K           Clear E-Stop");
    Serial.println("  M <fl> <fr> <rl> <rr>  Manual motor");
    Serial.println("  Z           Heartbeat (Pi)");
    Serial.println("  V           Status (detailed)");
    Serial.println("  P <kp> <ki> <kd>  Set PID");
    Serial.println("  X<0-100>    Max speed %");
    Serial.println("  T           Test sequence");
    Serial.println("  ?           Help");
    Serial.println("  I           Read IMU (type 134)");
    Serial.println("  W           Read power (type 133)");
    Serial.println("  N           Read IR proximity (type 135)");
    Serial.println("  J           Read Sharp front distance (type 136)");
    Serial.println("  O<id> <pwm> Raw motor test (0=FL,1=FR,2=RL,3=RR, bypass PID)");
    Serial.println("  O0 0        Exit raw test mode");
    Serial.println("  Y           Read VL53L0X TOF distance (type 138)");
    Serial.println("  G           Extend cylinder (lift dump body)");
    Serial.println("  g           Retract cylinder (lower dump body)");
    Serial.println("  C           Stop cylinder (coast)");
    Serial.println("  A           Force AUTO_ROAM (sensor-only, no Pi)");
    Serial.println("  JSON: begin_dock, begin_leave_dock, cancel_dock, get_unload_state");
    Serial.println();
}

// ========================================================================
// Serial Command Processing (Pi UART + ASCII serial)
// ========================================================================
void processPiCommand(const Command& cmd, uint32_t now_ms)
{
    switch (cmd.type) {
        // ---- Navigation (mecanum) ----
        case CMD_MOVE:
            g_individual_mode = false;
            g_raw_test_mode = false;
            g_nav_vx    = cmd.move_vx;
            g_nav_vy    = cmd.move_vy;
            g_nav_omega = cmd.move_omega;
            break;

        // ---- Direct per-wheel (bypasses mecanum) ----
        case CMD_INDIVIDUAL:
            g_individual_mode = true;
            for (int i = 0; i < MOTOR_COUNT; i++) {
                g_target_speeds[i] = cmd.motor_speeds[i];
            }
            break;

        case CMD_FORWARD:
            handleForward(cmd.speed);
            break;
        case CMD_BACKWARD:
            handleBackward(cmd.speed);
            break;
        case CMD_STOP:
            handleStop();
            break;
        case CMD_E_STOP:
            handleEStop();
            break;
        case CMD_E_STOP_CLEAR:
            handleEStopClear();
            break;
        case CMD_FORCE_AUTO_ROAM:
            g_modeManager.onPiCommand(cmd, now_ms);
            Serial.println("ACK: AUTO_ROAM forced (Pi disconnected, sensors driving)");
            break;
        case CMD_HEARTBEAT:
            g_modeManager.onPiCommand(cmd, now_ms);
            break;
        case CMD_GET_ENCODER:
            handleGetEncoder();
            break;
        case CMD_RESET_ENCODER:
            handleResetEncoder();
            break;
        case CMD_SET_PID:
            handleSetPID(cmd.kp, cmd.ki, cmd.kd);
            break;
        case CMD_SET_MAX_SPEED:
            handleSetMaxSpeed(cmd.max_speed);
            break;
        case CMD_GET_STATUS:
            handleGetStatus();
            break;
        case CMD_TEST:
            handleTestSequence();
            break;
        case CMD_HELP:
            handleHelp();
            break;

        case CMD_GET_IMU:
            if (g_imu.isOperational()) {
                g_imu.read();
                g_imu.printTelemetry();
                g_imu.printReadable();
            }
            break;
        case CMD_GET_POWER:
            if (g_power.isOperational()) {
                g_power.read();
                g_power.printTelemetry();
            }
            break;

        case CMD_GET_IR:
            g_ir.printStatusJson();
            break;

        case CMD_GET_SHARP:
            g_sharp.printStatusJson();
            break;

        case CMD_GET_TOF:
            g_tof.printStatusJson();
            break;

        case CMD_CYLINDER_EXTEND:
            g_cylinder.extend();
            Serial.println("ACK: cylinder extend");
            break;

        case CMD_CYLINDER_RETRACT:
            g_cylinder.retract();
            Serial.println("ACK: cylinder retract");
            break;

        case CMD_CYLINDER_STOP:
            g_cylinder.stop();
            Serial.println("ACK: cylinder stop");
            break;

        case CMD_BEGIN_DOCK:
        case CMD_BEGIN_LEAVE_DOCK:
        case CMD_CANCEL_DOCK:
            g_modeManager.onPiCommand(cmd, now_ms);
            Serial.printf("ACK: dock cmd %d\n", cmd.type);
            break;

        case CMD_GET_UNLOAD_STATE:
            handleUnloadState();
            break;

        case CMD_RAW_MOTOR: {
            int id    = cmd.motor_speeds[0];
            int speed = cmd.motor_speeds[1];
            g_raw_test_mode = true;
            g_raw_test_speeds[0] = 0;
            g_raw_test_speeds[1] = 0;
            g_raw_test_speeds[2] = 0;
            g_raw_test_speeds[3] = 0;
            g_raw_test_speeds[id] = speed;
            g_nav_vx = 0; g_nav_vy = 0; g_nav_omega = 0;
            if (speed == 0) g_raw_test_mode = false;
            Serial.printf("ACK: raw motor[%d] = %d (PID OFF)\n", id, speed);
        } break;

        default:
            break;
    }
}

// ========================================================================
// Non-blocking Serial Read
// ========================================================================
void readSerial()
{
    static char linebuf[256];
    static size_t pos = 0;

    while (Serial.available() > 0) {
        int byte = Serial.read();

        if (byte == '\r') continue;

        if (byte == '\n' || byte == '\0') {
            if (pos > 0) {
                linebuf[pos] = '\0';
                Command cmd;
                CommandType type = g_parser.parse(linebuf, cmd);
                if (type != CMD_UNKNOWN) {
                    processPiCommand(cmd, millis());
                }
                pos = 0;
            }
            continue;
        }

        if (pos < sizeof(linebuf) - 1) {
            linebuf[pos++] = (char)byte;
        } else {
            pos = 0;
        }
    }
}

// ========================================================================
// LED Blink
// ========================================================================
// LED disabled — keep no-op stub to avoid refactoring call sites
void updateLED(uint32_t) {}

// ========================================================================
// JSON Status — FULL every 1 s (line-delimited JSON to UART)
// pi reads line-delimited JSON. tick (5 Hz) and IMU/Power handled by
// publishSensors() below.
// ========================================================================
void printStatus(uint32_t now_ms)
{
    // --- Full JSON every 1 s (type=131, all fields) ---
    static uint32_t last_full_ms = 0;
    if (now_ms - last_full_ms >= 1000) {
        last_full_ms = now_ms;
        size_t n = JsonStatus::emitFullStatus(
            g_json_buf, sizeof(g_json_buf), now_ms,
            &g_modeManager, &g_mecanum,
            g_encoders, g_pid, g_motors,
            &g_imu, &g_power, &g_ir, &g_sharp,
            &g_tof, &g_cylinder,
            g_nav_vx, g_nav_vy, g_nav_omega,
            g_e_stop_active, g_max_speed_pct);
        Serial.write(g_json_buf, n);
    }
}

// ========================================================================
// Periodic Sensor Publishing — JSON, line-delimited (UART to Pi 5)
// Tick 5 Hz | IMU 20 Hz | Power 0.2 Hz
// ========================================================================
void publishSensors(uint32_t now_ms)
{
    // Tick status at 5 Hz (200 ms) — compact motors + IR
    static uint32_t last_tick_ms = 0;
    if (now_ms - last_tick_ms >= 200) {
        last_tick_ms = now_ms;
        size_t n = JsonStatus::emitTickStatus(
            g_json_buf, sizeof(g_json_buf), now_ms,
            &g_modeManager, g_encoders, g_motors,
            &g_imu, &g_power, &g_ir, &g_sharp,
            &g_tof, &g_cylinder,
            g_nav_vx, g_nav_vy, g_nav_omega,
            g_e_stop_active, g_max_speed_pct);
        Serial.write(g_json_buf, n);
    }

    // IMU at 20 Hz (50 ms) — type 134
    static uint32_t last_imu_ms = 0;
    if (now_ms - last_imu_ms >= IMU_PUBLISH_MS) {
        last_imu_ms = now_ms;
        if (g_imu.isOperational()) {
            g_imu.read();
            size_t n = JsonStatus::emitIMU(g_json_buf, sizeof(g_json_buf), &g_imu);
            Serial.write(g_json_buf, n);
        }
    }

    // Power at 0.2 Hz (5 s) — type 133
    static uint32_t last_power_ms = 0;
    if (now_ms - last_power_ms >= POWER_PUBLISH_MS) {
        last_power_ms = now_ms;
        if (g_power.isOperational()) {
            g_power.read();
            size_t n = JsonStatus::emitPower(g_json_buf, sizeof(g_json_buf), &g_power);
            Serial.write(g_json_buf, n);
        }
    }
}

// ========================================================================
// Setup & Loop
// ========================================================================
void setup()
{
    setupHardware();
    g_modeManager.begin();

    Serial.println();
    Serial.println("Ready. F/B/L/R/Q/E <0-255> | S stop | D e-stop | K clear | M <fl> <fr> <rl> <rr> | V status | I IMU | W power | N IR | J Sharp | T test | A auto-roam | ? help");
    Serial.println();
}

static uint32_t g_last_pid_ms = 0;

// ========================================================================
// Poll IR + Sharp sensors → feed ObstacleAvoidance
// ========================================================================
void pollLocalSensors(uint32_t now)
{
    // ---- IR proximity sensors: debounce + always report current state ----
    g_ir.update(now);
    {
        uint8_t mask = g_ir.detectedMask();
        // mask bits: 0=REAR_LEFT, 1=REAR_RIGHT, 2=LEFT, 3=RIGHT

        if (mask == 0) {
            g_obstacle.clearObstacles(now);
        } else {
            bool rl  = mask & 0x01;
            bool rr  = mask & 0x02;
            bool l   = mask & 0x04;
            bool r   = mask & 0x08;

            ObstacleDirection dir = ObstacleDirection::FRONT;
            if (l && r)           dir = ObstacleDirection::REAR;
            else if (l && !r)     dir = ObstacleDirection::LEFT;
            else if (r && !l)     dir = ObstacleDirection::RIGHT;
            else if (rl && rr)    dir = ObstacleDirection::REAR;
            else if (rl && !rr)   dir = ObstacleDirection::REAR_LEFT;
            else if (rr && !rl)   dir = ObstacleDirection::REAR_RIGHT;

            g_obstacle.onObstacleEvent(dir, now);
        }
    }

    // ---- Sharp front sensor: always read distance, feed if close ----
    g_sharp.update(now);
    if (g_sharp.isTooClose() || g_sharp.isSlowing()) {
        g_obstacle.onObstacleEvent(ObstacleDirection::FRONT, now);
    }
}

void loop()
{
    uint32_t now = millis();

    readSerial();
    g_modeManager.update(now);
    pollLocalSensors(now);

    // Poll the slow sensors / actuators (independent of PID tick)
    g_tof.update(now);
    g_cylinder.update(now);

    if (now - g_last_pid_ms >= PID_UPDATE_MS) {
        uint32_t dt = now - g_last_pid_ms;
        uint32_t dt_us = dt * 1000;
        g_last_pid_ms = now;

        for (int i = 0; i < MOTOR_COUNT; i++) {
            g_encoders[i].calculateRPM(dt);
        }

        SystemMode mode = g_modeManager.getMode();

        if (mode == MODE_AUTO_ROAM) {
            // AUTO_ROAM: sensor-based autonomy via ModeManager
            g_modeManager.applyMotorOutputs(g_motors, g_encoders, g_pid,
                                             &g_mecanum, now, dt_us);
        } else {
            // NAV / SAFE / MANUAL: original direct path
            if (!g_individual_mode) {
                computeNavTargets();
            }
            applySpeeds();
        }
    }

    printStatus(now);
    publishSensors(now);
    updateLED(now);

    // Detect unload state transitions and emit type 140 to Pi
    {
        AutoRoam::UnloadState current = g_modeManager.getUnloadState();
        if (current != g_last_unload_state) {
            g_last_unload_state = current;
            handleUnloadState();
        }
    }

    delay(1);
}
