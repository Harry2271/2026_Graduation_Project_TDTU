#include <Arduino.h>
#include <driver/ledc.h>
#include <driver/gpio.h>
#include <string.h>

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

// ========================================================================
// Motor State (mirrors old firmware behavior)
// ========================================================================
int16_t g_target_speeds[4] = {0};
int16_t g_ramped_speeds[4] = {0};
bool g_pid_enabled = true;
bool g_e_stop_active = false;
uint8_t g_max_speed_pct = 100;

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

    pinMode(2, OUTPUT);
    digitalWrite(2, LOW);

    setupLEDC();

    for (int i = 0; i < MOTOR_COUNT; i++) {
        g_motors[i].begin();
        g_motors[i].enable();
        g_motors[i].coast();
    }

    for (int i = 0; i < MOTOR_COUNT; i++) {
        g_encoders[i].begin();
    }

    for (int i = 0; i < MOTOR_COUNT; i++) {
        g_pid[i].setGains(DEFAULT_KP, DEFAULT_KI, DEFAULT_KD);
    }

    Serial.printf("\n");
    Serial.printf("=====================================================\n");
    Serial.printf("  ESP32-S3 Mecanum Controller\n");
    Serial.printf("=====================================================\n");
    Serial.printf("  Motors: %d | Encoders: PCNT 0-3\n", MOTOR_COUNT);
    Serial.printf("  PID: %.2f / %.2f / %.2f @ %d Hz\n",
        DEFAULT_KP, DEFAULT_KI, DEFAULT_KD, PID_UPDATE_RATE_HZ);
    Serial.printf("  Heartbeat timeout: %d ms\n", HEARTBEAT_TIMEOUT_MS);
    Serial.printf("=====================================================\n");
    Serial.printf("\n");
}

// ========================================================================
// Apply speeds with ramp + PID (mirrors old firmware applySpeeds)
// ========================================================================
void applySpeeds()
{
    if (g_e_stop_active) return;

    for (int i = 0; i < MOTOR_COUNT; i++) {
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
        float target_rpm = limited * (MOTOR_NOMINAL_RPM / 255.0f);

        if (g_pid_enabled) {
            float actual_rpm = g_encoders[i].getFilteredRPM();
            int16_t correction = g_pid[i].compute(target_rpm, actual_rpm, PID_UPDATE_MS * 1000);
            int16_t final_pwm = limited + correction;
            final_pwm = constrain(final_pwm, -MOTOR_MAX_DUTY, MOTOR_MAX_DUTY);
            g_motors[i].setSpeed(final_pwm);
        } else {
            g_motors[i].setSpeed(limited);
        }
    }
}

// ========================================================================
// Command Handlers (mirrors old firmware)
// ========================================================================
void handleForward(int speed)
{
    for (int i = 0; i < MOTOR_COUNT; i++) {
        g_target_speeds[i] = constrain(speed, 0, 255);
    }
    Serial.printf("ACK: forward %d\n", speed);
}

void handleBackward(int speed)
{
    for (int i = 0; i < MOTOR_COUNT; i++) {
        g_target_speeds[i] = -constrain(speed, 0, 255);
    }
    Serial.printf("ACK: backward %d\n", speed);
}

void handleLeft(int speed)
{
    int s = constrain(speed, 0, 255);
    g_target_speeds[0] =  s; g_target_speeds[1] = -s;
    g_target_speeds[2] = -s; g_target_speeds[3] =  s;
    Serial.printf("ACK: left %d\n", speed);
}

void handleRight(int speed)
{
    int s = constrain(speed, 0, 255);
    g_target_speeds[0] = -s; g_target_speeds[1] =  s;
    g_target_speeds[2] =  s; g_target_speeds[3] = -s;
    Serial.printf("ACK: right %d\n", speed);
}

void handleRotateCW(int speed)
{
    int s = constrain(speed, 0, 255);
    g_target_speeds[0] =  s; g_target_speeds[1] = -s;
    g_target_speeds[2] =  s; g_target_speeds[3] = -s;
    Serial.printf("ACK: rotate CW %d\n", speed);
}

void handleRotateCCW(int speed)
{
    int s = constrain(speed, 0, 255);
    g_target_speeds[0] = -s; g_target_speeds[1] =  s;
    g_target_speeds[2] = -s; g_target_speeds[3] =  s;
    Serial.printf("ACK: rotate CCW %d\n", speed);
}

void handleStop()
{
    for (int i = 0; i < MOTOR_COUNT; i++) {
        g_target_speeds[i] = 0;
        g_motors[i].brake();
    }
    Serial.println("ACK: stopped");
}

void handleEStop()
{
    g_e_stop_active = true;
    g_pid_enabled = false;
    for (int i = 0; i < MOTOR_COUNT; i++) {
        g_target_speeds[i] = 0;
        g_motors[i].emergencyStop();
    }
    Serial.println("ACK: E-STOP activated");
}

void handleEStopClear()
{
    g_e_stop_active = false;
    g_pid_enabled = true;
    for (int i = 0; i < MOTOR_COUNT; i++) {
        g_motors[i].enable();
        g_motors[i].coast();
        g_ramped_speeds[i] = 0;
        g_target_speeds[i] = 0;
    }
    Serial.println("ACK: E-STOP cleared");
}

void handleM(int fl, int fr, int rl, int rr)
{
    g_target_speeds[0] = constrain(fl, -255, 255);
    g_target_speeds[1] = constrain(fr, -255, 255);
    g_target_speeds[2] = constrain(rl, -255, 255);
    g_target_speeds[3] = constrain(rr, -255, 255);
    Serial.printf("ACK: M %d %d %d %d\n", fl, fr, rl, rr);
}

void handleHeartbeat()
{
    Command cmd = {};
    cmd.type = CMD_HEARTBEAT;
    g_modeManager.onPiCommand(cmd, millis());
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
    Serial.printf("{\"type\":130,\"data\":{\"mode\":\"%s\",\"motors\":[",
        Watchdog::modeName(g_modeManager.getMode()));
    for (int i = 0; i < MOTOR_COUNT; i++) {
        Serial.printf("{\"id\":%d,\"name\":\"%s\",\"count\":%ld,\"rpm\":%.1f}",
            i, MOTOR_NAMES[i],
            (long)g_encoders[i].getCumulativeCount(),
            g_encoders[i].getFilteredRPM());
        if (i < MOTOR_COUNT - 1) Serial.print(",");
    }
    Serial.printf("]}}\n");
}

void handleResetEncoder()
{
    for (int i = 0; i < MOTOR_COUNT; i++) g_encoders[i].reset();
    Serial.println("ACK: encoders reset");
}

void handleGetStatus()
{
    Serial.printf("{\"type\":131,\"data\":{");
    Serial.printf("\"uptime_ms\":%lu,", millis());
    Serial.printf("\"mode\":\"%s\",", Watchdog::modeName(g_modeManager.getMode()));
    Serial.printf("\"e_stop\":%s,", g_e_stop_active ? "true" : "false");
    Serial.printf("\"pid\":%s,", g_pid_enabled ? "true" : "false");
    Serial.printf("\"max_pct\":%d,", g_max_speed_pct);
    Serial.printf("\"motors\":[");
    for (int i = 0; i < MOTOR_COUNT; i++) {
        Serial.printf("{\"id\":%d,\"name\":\"%s\",\"target\":%d,\"rpm\":%.1f}",
            i, MOTOR_NAMES[i],
            g_target_speeds[i],
            g_encoders[i].getFilteredRPM());
        if (i < MOTOR_COUNT - 1) Serial.print(",");
    }
    Serial.printf("]}}\n");
}

void handleTestSequence()
{
    Serial.printf("ACK: test sequence starting...\n");
    handleStop();
    delay(500);

    int16_t steps[] = { 50, 100, 150, 200, 150, 100, 50, 0 };
    for (size_t i = 0; i < sizeof(steps)/sizeof(steps[0]); i++) {
        Serial.printf("TEST: forward %d\n", steps[i]);
        for (int m = 0; m < MOTOR_COUNT; m++) {
            g_target_speeds[m] = steps[i];
        }
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
    Serial.println("  V           Status");
    Serial.println("  P <kp> <ki> <kd>  Set PID");
    Serial.println("  X<0-100>    Max speed %");
    Serial.println("  T           Test sequence");
    Serial.println("  ?           Help");
    Serial.println();
}

// ========================================================================
// Serial Command Processing (Pi UART + ASCII serial)
// ========================================================================
void processPiCommand(const Command& cmd, uint32_t now_ms)
{
    g_modeManager.onPiCommand(cmd, now_ms);

    switch (cmd.type) {
        case CMD_MOVE: {
            int16_t speeds[4];
            g_mecanum.compute(cmd.move_vx, cmd.move_vy, cmd.move_omega, speeds);
            for (int i = 0; i < MOTOR_COUNT; i++) {
                g_target_speeds[i] = speeds[i];
            }
        } break;

        case CMD_INDIVIDUAL:
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
        case CMD_HEARTBEAT:
            handleHeartbeat();
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
void updateLED(uint32_t now_ms)
{
    static bool led_state = false;
    static uint32_t last_led_ms = 0;

    uint32_t interval;
    if (g_e_stop_active) {
        interval = 200;
    } else if (g_modeManager.getMode() == MODE_SAFE) {
        interval = 500;
    } else {
        interval = 1000;
    }

    if (now_ms - last_led_ms >= interval) {
        last_led_ms = now_ms;
        led_state = !led_state;
        digitalWrite(2, led_state ? HIGH : LOW);
    }
}

// ========================================================================
// Status Print
// ========================================================================
void printStatus(uint32_t now_ms)
{
    static uint32_t last_status_ms = 0;
    if (now_ms - last_status_ms < 5000) return;
    last_status_ms = now_ms;

    if (g_e_stop_active) return;

    Serial.printf("[STATUS] mode=%-6s | max=%d%% | rpm: ",
        Watchdog::modeName(g_modeManager.getMode()), g_max_speed_pct);
    for (int i = 0; i < MOTOR_COUNT; i++) {
        Serial.printf("%.0f ", g_encoders[i].getFilteredRPM());
    }
    Serial.println();
}

// ========================================================================
// Setup & Loop
// ========================================================================
void setup()
{
    setupHardware();
    g_modeManager.begin();

    Serial.println();
    Serial.println("Ready. Commands: F/B/L/R/Q/E <0-255> | S stop | D e-stop | K clear | M <fl> <fr> <rl> <rr> | V status | T test | ? help");
    Serial.println();
}

static uint32_t g_last_pid_ms = 0;

void loop()
{
    uint32_t now = millis();

    readSerial();
    g_modeManager.update(now);

    if (now - g_last_pid_ms >= PID_UPDATE_MS) {
        uint32_t dt = now - g_last_pid_ms;
        g_last_pid_ms = now;

        for (int i = 0; i < MOTOR_COUNT; i++) {
            g_encoders[i].calculateRPM(dt);
        }

        applySpeeds();
    }

    printStatus(now);
    updateLED(now);

    delay(1);
}
