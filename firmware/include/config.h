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
// ESP32-S3-WROOM-1U-N16R8 (Octal SPI Flash 26-32 + Octal PSRAM 33-37)
//
// Module pads available:
//   Left:  EN, 4,5,6,7,15,16,17,18,8,19,20,3,46,9,10
//   Right: 43,44,2,1,45,46,0,35,36,37,38,39,40,41,42,47,48,21
//   Not on module: 22, 23, 24, 25
// Strapping: 0 (boot), 9, 45, 46
// USB: 18 (D-), 19 (D+) — safe when CDC disabled
// UART0: 43 (TX), 44 (RX) — free on WeAct N16R8 (no bridge chip)
// ============================================================
struct MotorPins {
    uint8_t rpwm;
    uint8_t lpwm;
    uint8_t en;
    int8_t  dir;  // +1 = normal, -1 = reversed (swap forward/backward)
};

static const MotorPins MOTOR_PINS[] = {
    // FL: Front-Left
    { .rpwm = 12, .lpwm = 13, .en = 3,  .dir =  1 },
    // FR: Front-Right  — reversed so it spins forward with same PWM
    { .rpwm = 14, .lpwm = 15, .en = 7,  .dir = -1 },
    // RL: Rear-Left
    { .rpwm = 16, .lpwm = 17, .en = 48, .dir =  1 },
    // RR: Rear-Right  — reversed so it spins forward with same PWM
    { .rpwm = 38, .lpwm = 39, .en = 47, .dir = -1 },
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
    { .cha = 42, .chb = 6  },
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

// Pi 5 ↔ ESP32-S3 connection — now uses USB CDC (Type-C cable),
// not the GPIO 43/44 hardware UART.  USB CDC skips the PL011 DMA
// (dma2chan2) path on the Pi 5 which was causing system freezes.
//
// Baud rate constant kept for protocol consistency, but USB CDC
// ignores baud — actual throughput is full-speed USB.
#define PI_UART_BAUD       115200

// Alias: PiSerial goes to the Pi.  On ESP32-S3, Serial = native USB CDC,
// which appears as /dev/ttyACM0 on the Raspberry Pi 5.
#ifndef PiSerial
#define PiSerial Serial
#endif

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

// ============================================================
// BNO055 IMU (9-DOF, I2C address 0x28)
// ============================================================
#define BNO055_I2C_ADDR        0x28
#define BNO055_SDA_PIN         10       // Module pad 17 (left side)
#define BNO055_SCL_PIN         11       // Module pad 18 (right side)
#define BNO055_I2C_FREQ_HZ     400000
#define IMU_PUBLISH_MS         50       // Publish heading at 20 Hz

// ============================================================
// INA226 Power Monitor (CJMCU-226, I2C address 0x40)
// ============================================================
#define INA226_I2C_ADDR        0x40
#define INA226_SDA_PIN         10       // Shared I2C bus with BNO055
#define INA226_SCL_PIN         11       // Shared I2C bus with BNO055
#define INA226_I2C_FREQ_HZ     400000
#define INA226_SHUNT_OHMS      0.01f    // 10 mΩ on CJMCU-226
#define POWER_PUBLISH_MS       5000     // Publish power telemetry every 5 s

// ============================================================
// Battery — 3S Li-ion (18650) SOC Curve
// Full = 12.6V (4.2V/cell), Empty = 9.0V (3.0V/cell)
// ============================================================
#define BATTERY_VOLTAGE_FULL   12.6f    // 4.2V × 3 cells — 100%
#define BATTERY_VOLTAGE_NOM    11.1f    // 3.7V × 3 cells — ~50%
#define BATTERY_VOLTAGE_EMPTY  9.0f     // 3.0V × 3 cells —   0%
#define BATTERY_LOW_WARN_PCT   20       // Warning threshold (%)
#define BATTERY_CRITICAL_PCT   10       // Critical — notify Pi for safe stop

// ============================================================
// E18-D80NK IR Proximity Sensors (digital, active-LOW)
// ============================================================
#define IR_SENSOR_COUNT       4
#define IR_SENSOR_POLL_MS     20       // Read at 50 Hz (same as PID)
#define IR_DEBOUNCE_MS        50       // Debounce filter

// ============================================================
// AutoRoam — when Pi is disconnected, drive with sensors
// ============================================================
#define AUTO_ROAM_BOOT_DELAY_MS  3000   // wait this long on boot before going AUTO_ROAM
#define AUTO_ROAM_FORWARD_SPEED  70     // base forward PWM (out of 255)
#define AUTO_ROAM_SLOW_SPEED     30     // forward speed inside Sharp slow-zone
#define AUTO_ROAM_ESCAPE_STRAFE  90     // IR side-trigger escape
#define AUTO_ROAM_ESCAPE_ROTATE  70     // IR both-sides-trigger escape
#define AUTO_ROAM_REVERSE_NUDGE  40     // gentle forward push when rear IR triggers while reversing

#define IR_REAR_LEFT_PIN      1
#define IR_REAR_RIGHT_PIN     8
#define IR_LEFT_PIN           45       // Strapping pin — safe as input after boot
#define IR_RIGHT_PIN          46       // Strapping pin — safe as input after boot

// ============================================================
// Sharp GP2Y0A21YK0F — Front-mounted analog distance sensor
// (10-80 cm range, analog voltage output)
// ============================================================
#define SHARP_FRONT_PIN       9        // ADC1_CH8
#define SHARP_FRONT_THRESHOLD_CM  15   // Hard-stop distance (cm)
#define SHARP_FRONT_SLOW_CM       60   // Begin slowing down (cm)
#define SHARP_FRONT_POLL_MS       20   // Read at 50 Hz

// ============================================================
// VL53L0X V2 — TOF Laser Distance Sensor (I2C address 0x29)
// Rear-mounted, points at ground/shelf for precise alignment
// before unloading. Used in DistanceCheck (4 cm target).
// Shares I2C bus with BNO055 (0x28) and INA226 (0x40).
// ============================================================
#define VL53L0X_I2C_ADDR         0x29
#define VL53L0X_UNLOAD_DISTANCE_MM  40    // 4 cm — flowchart target distance
#define VL53L0X_TOLERANCE_MM       10    // ±1 cm tolerance band
#define VL53L0X_POLL_MS            50    // 20 Hz (33 ms budget + slack)

// ============================================================
// Cylinder Actuator — 12VDC electric cylinder + L298N driver
// Used to LIFT the dump body for unloading at the warehouse
// (graphviz node: ExtendActuator → DropItem → RetractActuator).
// ENA on L298N is tied HIGH (jumper); only IN1/IN2 needed.
// ============================================================
#define CYLINDER_IN1_PIN         2        // L298N IN1 → extend (HIGH)
#define CYLINDER_IN2_PIN         35       // L298N IN2 → retract (HIGH)
#define CYLINDER_MAX_RUN_MS      8000     // Safety auto-stop (8 s full extension)
#define CYLINDER_HOLD_AT_TOP_MS  3000     // Hold extended while dumping (3 s)
#define CYLINDER_ADJUST_PWM      40       // Forward nudge speed during position adjust
#define CYLINDER_ADJUST_TIMEOUT_MS 5000   // Max time spent on alignment loop

// ============================================================
// Docking Sequence — BNO055 heading gate + leave-dock parameters
// ============================================================
#define HEADING_GATE_DEG        2.0f    // ±2° heading error allowed before unload
#define LEAVE_DOCK_SPEED        50      // PWM for backing out after unload
#define LEAVE_DOCK_DISTANCE_CM  30      // Distance to reverse away from dock
#define LEAVE_DOCK_TIMEOUT_MS   8000    // Safety timeout for leave-dock
