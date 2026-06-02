#pragma once

#include <driver/pcnt.h>

// ============================================================
// WeAct ESP32-S3 N16R8 — Mecanum Wheel Motor Controller
// 4x BTS7960 + 4x JGB37-520 DC Motors + Quadrature Encoders
// ============================================================

// --- TEST MODE: Set number of motors to test: 1, 2, or 4 ---
#define TEST_MOTOR_COUNT 4

// --- Motor IDs ---
#define MOTOR_FL  0
#define MOTOR_FR  1
#define MOTOR_RL  2
#define MOTOR_RR  3
#define MOTOR_COUNT TEST_MOTOR_COUNT

// --- Motor Names ---
static const char* MOTOR_NAMES[] = {
    "FL", "FR", "RL", "RR"
};

// ============================================================
// BTS7960 PIN MAPPING
// Safe GPIOs: 1-5, 7-8, 12-17, 20-25, 38-42, 47-48
// ============================================================
struct MotorPins {
    uint8_t rpwm;
    uint8_t lpwm;
    uint8_t en;
};

static const MotorPins MOTOR_PINS[] = {
    // FL: Front-Left
    { .rpwm = 12, .lpwm = 13, .en = 3  },
    // FR: Front-Right
    { .rpwm = 14, .lpwm = 15, .en = 7  },
    // RL: Rear-Left
    { .rpwm = 16, .lpwm = 17, .en = 48 },
    // RR: Rear-Right
    { .rpwm = 38, .lpwm = 39, .en = 21 },
};

// LEDC channels (8 total, 2 per motor)
static const int8_t LEDC_CHAN_RPWM[] = { 0, 1, 2, 3 };
static const int8_t LEDC_CHAN_LPWM[] = { 4, 5, 6, 7 };

// ============================================================
// ENCODER PIN MAPPING (PCNT Hardware Counters, x2 decoding)
// ============================================================
struct EncoderPins {
    uint8_t cha;
    uint8_t chb;
};

static const EncoderPins ENCODER_PINS[] = {
    // FL encoder — PCNT_UNIT_0
    { .cha = 40, .chb = 41 },
    // FR encoder — PCNT_UNIT_1
    { .cha = 42, .chb = 2  },
    // RL encoder — PCNT_UNIT_2
    { .cha = 4,  .chb = 5  },
    // RR encoder — PCNT_UNIT_3
    { .cha = 20, .chb = 21 },
};

static const pcnt_unit_t PCNT_UNITS[] = {
    PCNT_UNIT_0, PCNT_UNIT_1, PCNT_UNIT_2, PCNT_UNIT_3
};

// ============================================================
// JGB37-520 Motor Specifications
// ============================================================
#define MOTOR_NOMINAL_RPM      333.0f
#define MOTOR_NOMINAL_VOLTAGE   12.0f
#define MOTOR_ENCODER_PPR       11       // Pulses per revolution (motor shaft)
#define MOTOR_GEAR_RATIO        30.0f
#define MOTOR_ENCODER_CPR       (MOTOR_ENCODER_PPR * 2)

// ============================================================
// PWM Configuration
// ============================================================
#define PWM_FREQUENCY    20000U
#define PWM_RESOLUTION   10        // 10-bit: 0-1023
#define PWM_MAX_DUTY     1023

// 12V motors on 21V supply — limit to ~12V average
// 21V * (584/1023) ≈ 12V
#define MOTOR_MAX_DUTY   584

// ============================================================
// PID Control Parameters
// ============================================================
#define PID_UPDATE_RATE_HZ  50
#define PID_UPDATE_MS       (1000 / PID_UPDATE_RATE_HZ)
#define PID_INTEGRAL_LIMIT  400.0f
#define PID_OUTPUT_LIMIT    (float)MOTOR_MAX_DUTY

#define DEFAULT_KP  2.5f
#define DEFAULT_KI  0.8f
#define DEFAULT_KD  0.15f

// ============================================================
// Mecanum Kinematics
// ============================================================
#define MECANUM_MAX_SPEED  255

// Acceleration ramp: max PWM change per 20ms PID tick
#define ACCEL_RAMP_RATE   30

// ============================================================
// UART Communication
// ============================================================
#define SERIAL_BAUD        115200
#define SERIAL_TIMEOUT_MS  100
#define CMD_TERMINATOR     '\n'

// ============================================================
// Motor State
// ============================================================
enum MotorState {
    MOTOR_COAST    = 0,
    MOTOR_FORWARD  = 1,
    MOTOR_BACKWARD = 2,
    MOTOR_BRAKE    = 3,
    MOTOR_DISABLED = 4,
};

// ============================================================
// System Watchdog — Pi Heartbeat Timeout
// ============================================================
#define HEARTBEAT_TIMEOUT_MS    2000    // Switch to MANUAL/SAFE after 2s no Pi signal
#define WIFI_CONNECT_TIMEOUT_MS 30000   // WiFi connection timeout for web server

// ============================================================
// Obstacle Avoidance
// ============================================================
#define OBSTACLE_THRESHOLD_CM   100     // Distance to trigger dodge (cm)
#define DODGE_STRAFE_SPEED      100     // Strafe speed during dodge (-255 to 255)
#define DODGE_DURATION_MS       800     // How long to maintain dodge maneuver
#define DODGE_SLOW_FORWARD      60      // Forward speed while dodging
