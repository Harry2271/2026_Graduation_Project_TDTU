#pragma once

#include <Arduino.h>
#include <HardwareSerial.h>
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
    { .rpwm = 12, .lpwm = 13, .en = 3,  .dir = -1 },
    // FR: Front-Right
    { .rpwm = 14, .lpwm = 15, .en = 7,  .dir =  1 },
    // RL: Rear-Left
    { .rpwm = 16, .lpwm = 17, .en = 48, .dir = -1 },
    // RR: Rear-Right
    { .rpwm = 38, .lpwm = 39, .en = 47, .dir =  1 },
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

// 21V supply — limit to ~10.5V average for 12V motor safety
// 21V * (511/1023) ≈ 10.5V
#define MOTOR_MAX_DUTY   511

// ============================================================
// PID Control Parameters
// ============================================================
#define PID_UPDATE_RATE_HZ  50
#define PID_UPDATE_MS       (1000 / PID_UPDATE_RATE_HZ)
// Reduced from 400 → 200: the old limit allowed integral contribution up to
// Ki×400 = 0.2×400 = 80 PWM (~16% of 511 max duty) — aggressive for small
// geared motors and caused visible overshoot after stall recovery.  At 200
// the max integral term is 40 PWM (~8%), still enough to correct steady-state
// error without hunting.
#define PID_INTEGRAL_LIMIT  200.0f
#define PID_OUTPUT_LIMIT    (float)MOTOR_MAX_DUTY

#define DEFAULT_KP  2.5f
#define DEFAULT_KI  0.2f
#define DEFAULT_KD  0.05f

// ============================================================
// Mecanum Kinematics
// ============================================================
#define MECANUM_MAX_SPEED  255

// Acceleration ramp: max PWM change per 20ms PID tick
#define ACCEL_RAMP_RATE   50

// Kick-start boost for gearbox static friction
#define KICK_BOOST_PWM    255
#define KICK_BOOST_TICKS  15

// ============================================================
// UART Communication — native USB CDC (Type-C cable)
// GPIO43/44 are XSHUT pins for the two ToF sensors, not UART.
// ============================================================
#define SERIAL_BAUD        115200
#define SERIAL_TIMEOUT_MS  100
#define CMD_TERMINATOR     '\n'

#ifndef PiSerial
#define PiSerial Serial
#endif

// ============================================================
// Motor State

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
#define BNO055_SDA_PIN         10       // I2C SDA (shared with VL53L0X, INA226)
#define BNO055_SCL_PIN         11       // I2C SCL (shared with VL53L0X, INA226)
#define BNO055_I2C_FREQ_HZ     100000   // I2C fallback mode (100 kHz for CJMCU-055 clones)

// BNO055 SPI mode - UNUSED / DEPRECATED
// These SPI pins conflict with motor PWM and encoder hardware:
// GPIO 15 = FR LPWM, GPIO 4 = RL encoder CHA, GPIO 21 = RR encoder CHB.
// I2C mode (GPIO 10/11) is the only supported interface for BNO055.
// Do not enable SPI mode; it will corrupt encoder reads and motor output.
#define BNO055_SPI_SCK_PIN     15       // CONFLICTS with FR LPWM - DO NOT USE
#define BNO055_SPI_MISO_PIN    36       // CONFLICTS with CargoSensor - DO NOT USE
#define BNO055_SPI_MOSI_PIN    4        // CONFLICTS with RL encoder CHA - DO NOT USE
#define BNO055_SPI_CS_PIN      21       // CONFLICTS with RR encoder CHB - DO NOT USE
#define BNO055_SPI_SPEED_HZ    1000000  // UNUSED - I2C mode only
#define I2C_TRANSACTION_TIMEOUT_MS  100  // ms — controller transaction timeout
#define I2C_READ_TIMEOUT_MS         100  // ms — bounded wait for requested bytes
#define I2C_BOOT_SETTLE_MS          100  // ms — sensor/bus settle after first Wire.begin()
#define I2C_RECOVERY_SETTLE_MS       50  // ms — settle after STOP + recovery init
#define I2C_DEVICE_RETRY_COUNT        2  // initial probe plus one controlled recovery retry
#define I2C_DEVICE_RETRY_DELAY_MS   100  // ms — delay before retrying after recovery
#define I2C_EXTERNAL_PULLUP_OHMS    4700 // Required on SDA/SCL for stable shared bus
#define IMU_PUBLISH_MS         50       // Publish heading at 20 Hz

// BNO055 attitude/impact observation thresholds. @bench-tune: record normal
// braking, strafing, payload, unload, ramp and controlled-impact data before
// enabling enforcement. Observation mode never changes motor/cylinder output.
#define IMU_SAFETY_ENFORCEMENT_ENABLED false
#define IMU_SAFETY_CONFIG_REV          1
#define IMU_TILT_WARNING_DEG           10.0f
#define IMU_TILT_WARNING_DWELL_MS      250
#define IMU_TILT_OBSERVE_DEG           18.0f
#define IMU_TILT_OBSERVE_DWELL_MS      500
#define IMU_TILT_CLEAR_DEG             8.0f
#define IMU_TILT_CLEAR_DWELL_MS        2000
#define IMU_SHOCK_CANDIDATE_MPS2       6.0f
#define IMU_SHOCK_PEAK_MPS2            8.0f
#define IMU_SHOCK_CONFIRM_WINDOW_MS    150

// ============================================================
// INA226 Power Monitor (CJMCU-226, I2C address 0x40)
// ============================================================
#define INA226_I2C_ADDR        0x40
#define INA226_SDA_PIN         10       // Shared I2C bus with BNO055 (GPIO10)
#define INA226_SCL_PIN         11       // Shared I2C bus with BNO055 (GPIO11)
#define INA226_I2C_FREQ_HZ     100000   // Shared bus clock; BNO055 clone requires 100 kHz
#define INA226_SHUNT_OHMS      0.01f    // 10 mΩ on CJMCU-226
#define POWER_PUBLISH_MS       5000     // Publish power telemetry every 5 s

// ============================================================
// Battery — Molicel M21-B4055A pack (84 Wh)
// Pack voltage: 20.5V fully charged → 14.0V empty under load.
// INA226 VIN+ wired directly to pack red (+), VIN- to pack black (GND).
// SOC uses the piecewise Li-ion curve in INA226Sensor.cpp.
// ============================================================
#define BATTERY_VOLTAGE_FULL   20.5f    // 100% — fully charged pack
#define BATTERY_VOLTAGE_EMPTY  14.0f    // 0% — minimum operational voltage
#define BATTERY_LOW_WARN_PCT   20       // Warning threshold (%)
#define BATTERY_CRITICAL_PCT   10       // Critical — notify Pi for safe stop

// ============================================================
// E18-D80NK IR Proximity Sensors (digital, active-LOW)
// Range: ≤15cm (after potentiometer adjustment on each sensor)
// ============================================================
#define IR_SENSOR_COUNT       4
#define IR_SENSOR_POLL_MS     20       // Read at 50 Hz (same as PID)
#define IR_DEBOUNCE_MS        50       // Debounce filter
#define IR_DETECTION_RANGE_CM 15       // Potentiometer-adjusted detection (cm)

// ============================================================
// AutoRoam — when Pi is disconnected, drive with sensors
// ============================================================
#define AUTO_ROAM_BOOT_DELAY_MS  3000   // wait this long on boot before going AUTO_ROAM
#define AUTO_ROAM_FORWARD_SPEED  70     // base forward PWM (out of 255)
#define AUTO_ROAM_SLOW_SPEED     30     // forward speed inside front-ToF slow zone
#define AUTO_ROAM_ESCAPE_STRAFE  90     // IR side-trigger escape
#define AUTO_ROAM_ESCAPE_ROTATE  70     // IR both-sides-trigger escape
#define AUTO_ROAM_REVERSE_NUDGE  40     // gentle forward push when rear IR triggers while reversing

#define IR_REAR_LEFT_PIN      1
#define IR_REAR_RIGHT_PIN     37       // moved from GPIO8; input-only pin
#define IR_LEFT_PIN           45       // Strapping pin — safe as input after boot
#define IR_RIGHT_PIN          46       // Strapping pin — safe as input after boot
// GPIO45 is a strapping pin and reads LOW on this board when no E18 is
// connected. Keep this channel disabled until an external 3.3V-safe E18
// output and pull-up are physically installed.
#define IR_LEFT_ENABLED       0
#define CARGO_SENSOR_PIN      36       // Cargo microswitch, INPUT_PULLUP

// ============================================================
// Front TOF400C — VL53L1X laser distance sensor
// Replaces the Sharp GP2Y0A21YK0F analog front sensor.
// ============================================================
#define VL53L1X_DEFAULT_I2C_ADDR       0x29
#define VL53L1X_I2C_ADDR               0x31  // Assigned after XSHUT boot
#define VL53L1X_SDA_PIN                10
#define VL53L1X_SCL_PIN                11
#define VL53L1X_I2C_FREQ_HZ            100000
#define VL53L1X_FRONT_THRESHOLD_CM     15    // Hard-stop / front block
#define VL53L1X_FRONT_SLOW_CM          60    // Begin slowing
#define VL53L1X_FRONT_POLL_MS          20    // Safety/cache poll cadence
#define VL53L1X_FRONT_MEASUREMENT_MS   50    // Long-mode timing budget/continuous period
#define VL53L1X_FRONT_STALE_MS         250   // No fresh sample => blocked
#define VL53L1X_FRONT_MIN_MM            40
#define VL53L1X_FRONT_MAX_MM          4000
#define VL53L1X_FRONT_TIMEOUT_MS       200

// Rear VL53L0X uses the default address while held in XSHUT, then moves to
// a unique runtime address before the front sensor is released.
#define VL53L0X_DEFAULT_I2C_ADDR       0x29
#define VL53L0X_I2C_ADDR               0x30  // Fixed runtime address after XSHUT boot

// Runtime addresses are deliberately fixed and unique on the shared bus.
#if VL53L1X_I2C_ADDR == VL53L0X_I2C_ADDR || \
    VL53L1X_I2C_ADDR == BNO055_I2C_ADDR || \
    VL53L1X_I2C_ADDR == INA226_I2C_ADDR
#error "VL53L1X_I2C_ADDR conflicts with another I2C device"
#endif
#if VL53L0X_I2C_ADDR == BNO055_I2C_ADDR || \
    VL53L0X_I2C_ADDR == INA226_I2C_ADDR
#error "VL53L0X_I2C_ADDR conflicts with another I2C device"
#endif

// XSHUT pins are available because production Pi transport is USB CDC.
// Dedicated XSHUT lines. Avoid GPIO0 (BOOT) and GPIO43/44 (UART0/CH343).
#define VL53L0X_XSHUT_PIN              8     // Rear VL53L0X
#define VL53L1X_XSHUT_PIN              9     // Front VL53L1X

// ============================================================
// Rear VL53L0X — docking/alignment distance sensor
// ============================================================
#define VL53L0X_SDA_PIN               10
#define VL53L0X_SCL_PIN               11
#define VL53L0X_I2C_FREQ_HZ           100000
#define VL53L0X_MIN_VALID_MM          30       // Reject 0/2mm phantom readings
#define VL53L0X_MAX_VALID_MM        2000
#define VL53L0X_UNLOAD_DISTANCE_MM    40
#define VL53L0X_TOLERANCE_MM          10
#define VL53L0X_POLL_MS               50
#define VL53L0X_STALE_MS             250  // No successful dock sample beyond this is usable

// ============================================================
// Cylinder Actuator — 12VDC electric cylinder + L298N driver
// Used to LIFT the dump body for unloading at the warehouse
// (graphviz node: ExtendActuator → DropItem → RetractActuator).
// ENA on L298N is tied HIGH (jumper); only IN1/IN2 needed.
// ============================================================
#define CYLINDER_IN1_PIN         2        // L298N IN1 → extend (HIGH)
#define CYLINDER_IN2_PIN         35       // L298N IN2 → retract (HIGH)
#define CYLINDER_RETRACT_SWITCH_PIN 44    // Limit switch: LOW when cylinder is fully retracted (INPUT_PULLUP)
#define CYLINDER_LIMIT_DEBOUNCE_MS 100    // Require a stable limit signal before stopping
#define CYLINDER_MAX_RUN_MS      8000     // Safety auto-stop (8 s full extension/retraction)
#define CYLINDER_HOLD_AT_TOP_MS  3000     // Hold extended while dumping (3 s)
#define CYLINDER_ADJUST_PWM      40       // Forward nudge speed during position adjust
#define CYLINDER_ADJUST_TIMEOUT_MS 5000   // Max time spent on alignment loop

// Keep safety inputs single-owner. A duplicate pin can make a limit switch
// indistinguishable from an obstacle sensor or motor signal.
#if CYLINDER_RETRACT_SWITCH_PIN == IR_REAR_LEFT_PIN || \
    CYLINDER_RETRACT_SWITCH_PIN == IR_REAR_RIGHT_PIN || \
    CYLINDER_RETRACT_SWITCH_PIN == IR_LEFT_PIN || \
    CYLINDER_RETRACT_SWITCH_PIN == IR_RIGHT_PIN || \
    CYLINDER_RETRACT_SWITCH_PIN == CARGO_SENSOR_PIN || \
    CYLINDER_RETRACT_SWITCH_PIN == VL53L0X_XSHUT_PIN || \
    CYLINDER_RETRACT_SWITCH_PIN == VL53L1X_XSHUT_PIN || \
    CYLINDER_RETRACT_SWITCH_PIN == BNO055_SDA_PIN || \
    CYLINDER_RETRACT_SWITCH_PIN == BNO055_SCL_PIN || \
    CYLINDER_RETRACT_SWITCH_PIN == CYLINDER_IN1_PIN || \
    CYLINDER_RETRACT_SWITCH_PIN == CYLINDER_IN2_PIN
#error "CYLINDER_RETRACT_SWITCH_PIN conflicts with another assigned GPIO"
#endif

// ============================================================
// Docking Sequence — BNO055 heading gate + leave-dock parameters
// ============================================================
#define HEADING_GATE_DEG        2.0f    // ±2° heading error allowed before unload
#define LEAVE_DOCK_SPEED        50      // PWM for backing out after unload
#define LEAVE_DOCK_DISTANCE_CM  30      // Distance to reverse away from dock
#define LEAVE_DOCK_TIMEOUT_MS   8000    // Safety timeout for leave-dock
