#include <Arduino.h>
#include <driver/ledc.h>
#include <driver/gpio.h>
#include <string.h>
#include <Wire.h>
#include <esp_task_wdt.h>

#include "config.h"
#include "modules.h"
#include "BNO055_SPI.h"
#include "I2CBus.h"

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
CargoSensor      g_cargo;

// Module health monitor — detects stuck I2C sensors, triggers recovery,
// emits type 142 health report every 1s + on state change
HealthMonitor   g_health;

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

// Obstacle avoidance state (from IR + Sharp + Pi LiDAR events)
ObstacleAvoidance g_obstacle;

// Local hard-stop latch.  Kept separate from the LiDAR dodge state so a
// Pi move command or CMD_INDIVIDUAL cannot override a physical IR/Sharp
// obstacle while the obstacle is present.
static bool g_local_obstacle_stop = false;

// Kick-start boost constants live in config.h (single source of truth).
int8_t g_kick_ticks[4] = {0, 0, 0, 0};

// PID timing globals (used by both loop() and applySpeeds())
static uint32_t g_last_pid_ms = 0;
static uint32_t g_pid_dt_us   = 0;   // real elapsed PID interval (μs) for applySpeeds
int16_t g_prev_target_for_kick[4] = {0, 0, 0, 0};

// Direct motor test mode (bypasses PID + ramp, for hardware debugging)
bool g_raw_test_mode = false;
int16_t g_raw_test_speeds[4] = {0};

// Shared JSON output buffer for status messages (UART to Pi 5)
static char g_json_buf[1200];

// Unload state tracking (for transition detection → type 140 emit)
AutoRoam::UnloadState g_last_unload_state = AutoRoam::UNLOAD_IDLE;

// Heartbeat counter — bumped every successful "alive" publish.  Pi
// monitor uses this to detect that ESP32 firmware is still ticking;
// if the counter freezes, the host knows to reconnect even though no
// transport-level error occurred.
static uint32_t g_alive_counter = 0;

// Slow sensor read timer — keeps I2C off the 500 ms hot path so a
// stuck sensor cannot wedge the publish loop.
static uint32_t g_last_sensor_read_ms = 0;
#define SLOW_SENSOR_READ_MS  1000

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

// Helper: log sensor init result with timing
#define LOG_SENSOR_INIT_RESULT(name, ok_call) \
    do { \
        Serial.printf("  [INIT] %s starting...\n", name); \
        uint32_t _t0 = millis(); \
        bool _ok = (ok_call); \
        Serial.printf("  [INIT] %s %s (%lu ms)\n", name, \
                      _ok ? "OK" : "FAILED", millis() - _t0); \
    } while (0)

void setupHardware()
{
    // --- USB CDC: start IMMEDIATELY so all subsequent prints are visible ---
    Serial.begin(SERIAL_BAUD);

    // Short delay for USB enumeration on Windows (host needs ~500 ms to
    // recognize the CDC device after firmware re-enumerates).
    delay(1500);

    Serial.println();
    Serial.println("=====================================================");
    Serial.println("  ESP32-S3 Mecanum Controller — booting...");
    Serial.println("=====================================================");

    // Pi 5 <-> ESP32-S3 link is now hardware UART0 on GPIO43/44.
    // Serial.begin() above already started UART0 at 115200 baud.
    // Pi reads this stream as /dev/ttyACM0 or /dev/ttyUSB0 on Linux.
    Serial.println("  [OK]   PiSerial = UART0 GPIO43(TX)/GPIO44(RX) @ 115200");
    PiSerial.setTimeout(1);

    pinMode(2, OUTPUT);
    digitalWrite(2, LOW);  // LED off — ESP32-S3 WeAct built-in

    // ---- I2C bus (shared: BNO055 + INA226 + VL53L0X) ----
    Serial.printf("  [INIT] I2C bus SDA=GPIO%d SCL=GPIO%d @ %u kHz...\n",
                  BNO055_SDA_PIN, BNO055_SCL_PIN,
                  BNO055_I2C_FREQ_HZ / 1000);

    // ── Pull-up diagnostic — read SDA/SCL BEFORE Wire.begin() ──
    // If external 4.7kΩ pull-ups are soldered correctly, both pins read HIGH
    // even with internal pull-up disabled. If pull-up is missing/broken, both
    // pins read LOW (no pull-up source). Print BEFORE Wire takes over.
    pinMode(BNO055_SDA_PIN, INPUT);
    pinMode(BNO055_SCL_PIN, INPUT);
    delayMicroseconds(10);
    int sda_raw = digitalRead(BNO055_SDA_PIN);
    int scl_raw = digitalRead(BNO055_SCL_PIN);
    Serial.printf("  [DIAG] SDA=%d SCL=%d (no internal pullup — test your external 4.7kΩ)\n",
                  sda_raw, scl_raw);

    // Now enable internal pull-up as fallback. External pull-up is required
    // for reliable operation with multiple devices or long wires.
    pinMode(BNO055_SDA_PIN, INPUT_PULLUP);
    pinMode(BNO055_SCL_PIN, INPUT_PULLUP);

    // 9-clock bus recovery BEFORE first Wire.begin — releases any slave
    // that may be holding SDA low from a previous boot.
    I2CBus::busReset(BNO055_SDA_PIN, BNO055_SCL_PIN);

    Wire.begin(BNO055_SDA_PIN, BNO055_SCL_PIN);
    Wire.setClock(BNO055_I2C_FREQ_HZ);
    // CRITICAL: cap each I2C transaction.  Without this, a held-low SDA
    // (e.g. missing pull-ups, faulty breakout) makes Wire.endTransmission()
    // block forever, which freezes the motor control loop.
    Wire.setTimeout(I2C_TRANSACTION_TIMEOUT_MS);
    Serial.println("  [OK]   I2C bus started (100 kHz, after 9-clock recovery)");

    // ---- I2C bus health check — pin-level guard, never blocks ----
    // Wire.endTransmission() does NOT honor Wire.setTimeout() — it blocks
    // forever if a slave holds SDA low.  Check linesIdle() first.
    bool i2c_bus_ok = I2CBus::linesIdle(BNO055_SDA_PIN, BNO055_SCL_PIN);
    if (!i2c_bus_ok) {
        Serial.printf("  [I2C BUS] SDA=%d SCL=%d — bus unhealthy, attempting recovery...\n",
                      digitalRead(BNO055_SDA_PIN), digitalRead(BNO055_SCL_PIN));
        I2CBus::busReset(BNO055_SDA_PIN, BNO055_SCL_PIN);
        i2c_bus_ok = I2CBus::linesIdle(BNO055_SDA_PIN, BNO055_SCL_PIN);
        if (!i2c_bus_ok) {
            Serial.println("  [I2C BUS] Still unhealthy — check pull-ups, shorts, powered modules");
        }
    }

    // I2C scan: probe ONLY the 3 known device addresses.  A full
    // 126-address scan with Wire.endTransmission() is unsafe on ESP32
    // (no software watchdog for endTransmission).  The per-sensor begin()
    // calls below already do their own probing and degrade gracefully.
    int found = 0;
    if (i2c_bus_ok) {
        Serial.println("  [SCAN] I2C device probe...");
        static const uint8_t known_addrs[] = {0x28, 0x29, 0x40};
        static const char*  known_names[]  = {"BNO055", "VL53L0X", "INA226"};
        for (size_t k = 0; k < sizeof(known_addrs); k++) {
            if (I2CBus::probe(BNO055_SDA_PIN, BNO055_SCL_PIN, known_addrs[k])) {
                Serial.printf("         Found 0x%02X (%s)\n", known_addrs[k], known_names[k]);
                found++;
            }
        }
        if (found == 0) {
            Serial.println("         No devices found");
        } else {
            Serial.printf("         Total: %d device(s)\n", found);
        }
    } else {
        Serial.println("  [SCAN] I2C scan SKIPPED (bus unhealthy)");
    }

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

    // ---- I2C sensors (with progress logging) ----
    // Init order: BNO055 first (has 650 ms power-up delay), then
    // VL53L0X (Pololu library does NOT call Wire.begin()), then INA226.
    // Addresses must not overlap: BNO055=0x28, VL53L0X=0x29, INA226=0x40.
    // Before each sensor, do a 9-clock bus recovery + re-init to ensure
    // the bus is clean (previous sensor init may have left it in a bad state).

    Serial.println("  [INIT] BNO055 IMU...");
    I2CBus::busReset(BNO055_SDA_PIN, BNO055_SCL_PIN);
    I2CBus::reinitialize(BNO055_SDA_PIN, BNO055_SCL_PIN, BNO055_I2C_FREQ_HZ);
    bool imu_ok = g_imu.begin(BNO055_I2C_ADDR);
    Serial.printf("  [%s] BNO055\n", imu_ok ? "OK  " : "WARN");

    Serial.println("  [INIT] VL53L0X TOF sensor (Pololu)...");
    I2CBus::busReset(BNO055_SDA_PIN, BNO055_SCL_PIN);
    I2CBus::reinitialize(BNO055_SDA_PIN, BNO055_SCL_PIN, BNO055_I2C_FREQ_HZ);
    bool tof_ok = g_tof.begin();
    Serial.printf("  [%s] VL53L0X\n", tof_ok ? "OK  " : "WARN");

    Serial.println("  [INIT] INA226 power monitor...");
    I2CBus::busReset(BNO055_SDA_PIN, BNO055_SCL_PIN);
    I2CBus::reinitialize(BNO055_SDA_PIN, BNO055_SCL_PIN, BNO055_I2C_FREQ_HZ);
    bool pwr_ok = g_power.begin(INA226_I2C_ADDR);
    Serial.printf("  [%s] INA226\n", pwr_ok ? "OK  " : "WARN");

    // Wire sensors into ModeManager for AUTO_ROAM (Pi-less) operation
    g_modeManager.attachSensors(&g_imu, &g_ir, &g_sharp, &g_power, &g_tof, &g_cylinder);

    // IR proximity sensors
    g_ir.begin();
    Serial.println("  [OK]   IR proximity sensors");

    // Sharp front distance sensor
    g_sharp.begin();
    Serial.println("  [OK]   Sharp front distance sensor");

    // ---- Cylinder actuator (12V lift cylinder via L298N) ----
    g_cylinder.begin();
    Serial.println("  [OK]   Cylinder actuator");

    // ---- Cargo sensor (microswitch on cargo bed) ----
    g_cargo.begin();

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
    // Apply obstacle avoidance to nav velocity.  Physical local sensors
    // have priority over every Pi command: a direct move/individual command
    // must not be able to drive through an object while IR/Sharp is active.
    int16_t adj_vx    = g_nav_vx;
    int16_t adj_vy    = g_nav_vy;
    int16_t adj_omega = g_nav_omega;
    g_obstacle.applyToCommand(adj_vx, adj_vy, adj_omega, millis());
    if (g_local_obstacle_stop) {
        adj_vx = 0;
        adj_vy = 0;
        adj_omega = 0;
    }

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

    // Local hard-stop latch overrides every Pi-supplied command.  Clear it
    // here once the sensors have been quiet for the safety window.
    if (g_local_obstacle_stop) {
        for (int i = 0; i < MOTOR_COUNT; i++) {
            g_target_speeds[i] = 0;
            g_ramped_speeds[i] = 0;
            g_motors[i].coast();
        }
        // Use a simple debounce: once the latch fires, wait at least
        // SHARP_HOLD_MS before allowing it to clear.  This prevents
        // rapid toggling when the Sharp reading fluctuates around 60 cm.
        if (!g_ir.anyDetected() && !g_sharp.isTooClose() && !g_sharp.isSlowing()) {
            g_local_obstacle_stop = false;
            Serial.println("[SAFETY] obstacle latch cleared — resuming");
        }
        return;
    }

    // Raw test mode: bypass PID + ramp, send PWM directly
    if (g_raw_test_mode) {
        for (int i = 0; i < MOTOR_COUNT; i++) {
            // Ensure drivers are enabled — e-stop or brake may have
            // cleared the EN pin; raw test must override that.
            if (!g_motors[i].isEnabled()) {
                g_motors[i].enable();
            }
            int16_t s = g_raw_test_speeds[i] * MOTOR_PINS[i].dir;
            g_motors[i].setSpeed(s);
        }
        // Debug: print raw speeds once per second
        static uint32_t last_raw_dbg = 0;
        if (millis() - last_raw_dbg >= 1000) {
            last_raw_dbg = millis();
            Serial.printf("[RAW] FL rpwm=%d lpwm=%d en=%d | FR rl=%d rr=%d en=%d | RL rl=%d rr=%d en=%d | RR rl=%d rr=%d en=%d\n",
                digitalRead(MOTOR_PINS[0].rpwm), digitalRead(MOTOR_PINS[0].lpwm), digitalRead(MOTOR_PINS[0].en),
                digitalRead(MOTOR_PINS[1].rpwm), digitalRead(MOTOR_PINS[1].lpwm), digitalRead(MOTOR_PINS[1].en),
                digitalRead(MOTOR_PINS[2].rpwm), digitalRead(MOTOR_PINS[2].lpwm), digitalRead(MOTOR_PINS[2].en),
                digitalRead(MOTOR_PINS[3].rpwm), digitalRead(MOTOR_PINS[3].lpwm), digitalRead(MOTOR_PINS[3].en));
            Serial.printf("[RAW] speeds: %d %d %d %d | dir: %d %d %d %d\n",
                g_raw_test_speeds[0], g_raw_test_speeds[1], g_raw_test_speeds[2], g_raw_test_speeds[3],
                MOTOR_PINS[0].dir, MOTOR_PINS[1].dir, MOTOR_PINS[2].dir, MOTOR_PINS[3].dir);
        }
        return;
    }

    for (int i = 0; i < MOTOR_COUNT; i++) {
        // Detect motor start: target transitions from 0 → non-zero.
        // Track *target* (not ramped) so we only kick on genuine starts,
        // not on every ramp-crossing-zero during direction changes.
        if (g_prev_target_for_kick[i] == 0 && g_target_speeds[i] != 0 && g_kick_ticks[i] == 0) {
            g_kick_ticks[i] = KICK_BOOST_TICKS;
        }
        g_prev_target_for_kick[i] = g_target_speeds[i];

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

        float target_rpm = limited * (MOTOR_NOMINAL_RPM / (float)MOTOR_MAX_DUTY);

        if (g_pid_enabled) {
            // Sign the measurement with the motor's hardware direction so the
            // PID matches the wheel's physical rotation, not the encoder's
            // raw polarity.  fabsf() previously destroyed this and let a
            // mis-wired motor track the encoder while moving the chassis
            // in the opposite direction.
            float actual_rpm = g_encoders[i].getFilteredRPM() * (float)MOTOR_PINS[i].dir;
            int16_t correction = g_pid[i].compute(target_rpm, actual_rpm, g_pid_dt_us);
            int16_t final_pwm = limited + correction;
            final_pwm = constrain(final_pwm, -MOTOR_MAX_DUTY, MOTOR_MAX_DUTY);

            // Kick-start boost: applied AFTER the PID output, on top of the
            // saturated final_pwm, with the same ±MOTOR_MAX_DUTY cap.  This
            // keeps the boost independent of the PID target so the boost
            // does not fight the controller during the first 300 ms.
            if (g_kick_ticks[i] > 0) {
                int16_t boost = (limited > 0) ? KICK_BOOST_PWM : -KICK_BOOST_PWM;
                final_pwm = constrain(final_pwm + boost, -MOTOR_MAX_DUTY, MOTOR_MAX_DUTY);
                g_kick_ticks[i]--;
            }

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
    PiSerial.printf("ACK: forward %d\n", speed);
}

void handleBackward(int speed)
{
    g_individual_mode = false;
    g_raw_test_mode = false;
    g_nav_vx    = -constrain(speed, 0, 255);
    g_nav_vy    = 0;
    g_nav_omega = 0;
    PiSerial.printf("ACK: backward %d\n", speed);
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
        // Soft stop: PWM to 0, drivers stay enabled (no hard e-stop).
        g_motors[i].coast();
    }
    PiSerial.println("ACK: stopped");
}

void handleEStop()
{
    // CRITICAL safety path — hardware disable of BTS7960 drivers.
    // Pulls EN pin LOW on every driver so no PWM can produce torque,
    // even if the firmware later writes PWM by mistake.
    g_e_stop_active = true;
    g_pid_enabled   = false;
    g_nav_vx    = 0;
    g_nav_vy    = 0;
    g_nav_omega = 0;
    for (int i = 0; i < MOTOR_COUNT; i++) {
        g_target_speeds[i] = 0;
        g_ramped_speeds[i] = 0;
        g_kick_ticks[i] = 0;
        // emergencyStop() pulls EN LOW and zeros PWM. Disarms until
        // an explicit handleEStopClear() re-arms the drivers.
        g_motors[i].emergencyStop();
    }
    PiSerial.println("ACK: E-STOP (hardware disabled)");
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
    PiSerial.println("ACK: E-STOP cleared");
}

void handleSetPID(float kp, float ki, float kd)
{
    for (int i = 0; i < MOTOR_COUNT; i++) {
        g_pid[i].setGains(kp, ki, kd);
    }
    g_pid_enabled = true;
    PiSerial.printf("ACK: PID kp=%.2f ki=%.2f kd=%.2f\n", kp, ki, kd);
}

void handleSetMaxSpeed(int pct)
{
    g_max_speed_pct = constrain(pct, 0, 100);
    PiSerial.printf("ACK: max_speed=%d%%\n", g_max_speed_pct);
}

void handleGetEncoder()
{
    const int16_t* tgt = g_modeManager.getRampedSpeeds();
    size_t n = JsonStatus::emitEncoderSnapshot(
        g_json_buf, sizeof(g_json_buf),
        tgt, g_encoders);
    PiSerial.write(g_json_buf, n);
}

void handleResetEncoder()
{
    for (int i = 0; i < MOTOR_COUNT; i++) g_encoders[i].reset();
    PiSerial.println("ACK: encoders reset");
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
    PiSerial.write(g_json_buf, n);
}

void handleUnloadState()
{
    size_t n = JsonStatus::emitUnloadState(
        g_json_buf, sizeof(g_json_buf), millis(),
        &g_modeManager.getAutoRoam(),
        &g_tof, &g_imu, &g_cylinder);
    PiSerial.write(g_json_buf, n);
}

void handleTestSequence()
{
    PiSerial.printf("ACK: test sequence starting...\n");
    handleStop();
    delay(500);

    g_individual_mode = false;
    int16_t steps[] = { 50, 100, 150, 200, 150, 100, 50, 0 };
    for (size_t i = 0; i < sizeof(steps)/sizeof(steps[0]); i++) {
        PiSerial.printf("TEST: forward %d\n", steps[i]);
        g_nav_vx = steps[i];
        g_nav_vy = 0;
        g_nav_omega = 0;
        delay(1000);
    }
    handleStop();
    PiSerial.println("ACK: test sequence complete");
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
            // Emit type 132 move ACK if Pi included a seq number
            if (cmd.has_move_seq) {
                const char* ack_status = g_e_stop_active ? "rejected" : "accepted";
                const char* ack_reason = g_e_stop_active ? "e_stop_active" : nullptr;
                size_t n = JsonStatus::emitMoveAck(
                    g_json_buf, sizeof(g_json_buf),
                    cmd.move_seq, ack_status, ack_reason);
                PiSerial.write(g_json_buf, n);
            }
            break;

        // ---- Direct per-wheel (bypasses mecanum) ----
        case CMD_INDIVIDUAL:
            g_individual_mode = true;
            for (int i = 0; i < MOTOR_COUNT; i++) {
                g_target_speeds[i] = cmd.motor_speeds[i];
            }
            // Emit type 132 ACK if Pi included seq
            if (cmd.has_move_seq) {
                size_t n = JsonStatus::emitMoveAck(
                    g_json_buf, sizeof(g_json_buf),
                    cmd.move_seq, "accepted");
                PiSerial.write(g_json_buf, n);
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
            PiSerial.println("ACK: AUTO_ROAM forced (Pi disconnected, sensors driving)");
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
            PiSerial.println("ACK: cylinder extend");
            break;

        case CMD_CYLINDER_RETRACT:
            g_cylinder.retract();
            PiSerial.println("ACK: cylinder retract");
            break;

        case CMD_CYLINDER_STOP:
            g_cylinder.stop();
            PiSerial.println("ACK: cylinder stop");
            break;

        case CMD_BEGIN_DOCK:
            g_modeManager.onPiCommand(cmd, now_ms);
            // onPiCommand handles startDock with full params (tag, distance,
            // facing_theta, operation_id) — no duplicate call needed here.
            PiSerial.printf("ACK: dock cmd %d\n", cmd.type);
            break;

        case CMD_BEGIN_LEAVE_DOCK:
        case CMD_CANCEL_DOCK:
            g_modeManager.onPiCommand(cmd, now_ms);
            PiSerial.printf("ACK: dock cmd %d\n", cmd.type);
            break;

        case CMD_GET_UNLOAD_STATE:
            handleUnloadState();
            break;

        case CMD_GET_CARGO:
            g_cargo.emitStatusJson();
            break;

        case CMD_RESTART:
            // Graceful reboot.  Send an ACK first so the host knows
            // the command was accepted, then call ESP.restart() to
            // reload firmware without touching the BOOT button.
            PiSerial.println("{\"type\":128,\"data\":{\"status\":\"restarting\"}}");
            PiSerial.flush();
            delay(20);
            ESP.restart();
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
            // Apply immediately as well as in the 50 Hz loop. This makes
            // the bench command deterministic and independent of NAV versus
            // AUTO_ROAM scheduling.
            if (speed != 0) {
                g_e_stop_active = false;
                g_pid_enabled = false;
                g_motors[id].enable();
                g_motors[id].setSpeed(speed * MOTOR_PINS[id].dir);
            } else {
                g_motors[id].coast();
                g_raw_test_mode = false;
            }
            PiSerial.printf("ACK: raw motor[%d] = %d (PID OFF)\n", id, speed);
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

    while (PiSerial.available() > 0) {
        int byte = PiSerial.read();

        // Any byte from the Pi is proof-of-life, even if the parser later
        // rejects the frame (e.g. a truncated JSON line left behind when the
        // UART cable is yanked mid-transmission). This keeps the watchdog from
        // being fooled into MODE_NAV when the Pi has actually gone silent.
        g_modeManager.onSerialActivity(millis());

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
// DISABLED: emitFullStatus allocates through ArduinoJson every second,
// which fragments the heap on long-running sessions.  publishSensors()
// below emits the same fields on the 500 ms tick — one fewer allocation
// path is enough.
// ========================================================================
void printStatus(uint32_t /*now_ms*/)
{
    // Intentionally empty: full status type-131 was causing heap
    // fragmentation when running >10 minutes (ESP32 silently rebooted,
    // Pi saw "ESP32 stopped sending data").  Use type-141 (alive) and
    // the 500 ms tick from publishSensors() instead — same fields,
    // no extra alloc path.
}

// ========================================================================
// Periodic Sensor Publishing — JSON, line-delimited (USB CDC to Pi)
//
// The hot path (every 500 ms) only emits JSON built from cached state.
// All I2C sensor reads happen on a separate slow timer (every 1 s).
// This means a stuck sensor (BNO055 / INA226) CANNOT silence the
// telemetry — the brain still sees alive + uptime + e_stop advance
// and can react.
// ========================================================================
#define TELEMETRY_PUBLISH_MS  500   // Always-fire tick (alive + cached state)

// Cheap read of slow sensors.  Each read is gated so a single stuck
// sensor can't lock up the loop.  Failure is non-fatal — the next
// tick will retry.
static void readSensorsSlow(uint32_t now_ms)
{
    if (now_ms - g_last_sensor_read_ms < SLOW_SENSOR_READ_MS) return;
    g_last_sensor_read_ms = now_ms;

    // IMU read — Bosch driver does ~7 I2C transactions per call.  If
    // BNO055 hangs on the bus (e.g. motor-induced glitch), the
    // surrounding "if operational" gate won't help — we only added
    // the slow timer to keep this OFF the publish hot path.
    if (g_imu.isOperational()) {
        if (g_imu.read()) {
            g_health.reportOk(MOD_IMU, now_ms);
        } else {
            g_health.reportError(MOD_IMU, 1, now_ms);
        }
    }
    if (g_power.isOperational()) {
        if (g_power.read()) {
            g_health.reportOk(MOD_BATTERY, now_ms);
        } else {
            g_health.reportError(MOD_BATTERY, 1, now_ms);
        }
    }
}

// Reliable fire-every-500ms tick.  Even if I2C wedges, this still
// emits a small JSON frame so the host sees motion and knows the
// firmware is alive.  Type 141 is a custom "alive" frame.
static void publishAlive(uint32_t now_ms)
{
    static uint32_t last_ms = 0;
    if (now_ms - last_ms < TELEMETRY_PUBLISH_MS) return;
    last_ms = now_ms;
    g_alive_counter++;

    // Emit JSON manually (no I2C, no encoder reads, no locks) so this
    // cannot block.  ~120 bytes per line at 500 ms = ~240 B/s.
    int n = snprintf(g_json_buf, sizeof(g_json_buf),
        "{\"type\":141,\"data\":{\"uptime_ms\":%lu,\"alive\":%lu,"
        "\"e_stop\":%s,\"mode\":\"%s\"}}\n",
        (unsigned long)now_ms,
        (unsigned long)g_alive_counter,
        g_e_stop_active ? "true" : "false",
        Watchdog::modeName(g_modeManager.getMode()));
    if (n > 0 && n < (int)sizeof(g_json_buf)) {
        PiSerial.write((uint8_t*)g_json_buf, (size_t)n);
    }
    // Yield to RTOS — important when host doesn't drain fast enough to
    // keep the USB endpoint clear.  Without this, repeated writes can
    // hit a queued-full endpoint stall and back-pressure the loop.
    yield();
}

// Full telemetry — same 500 ms cadence but with motor + sensor data.
// Runs in addition to publishAlive, so the host gets BOTH a stream of
// frames (alive) and richer detail (tick).
static void publishTelemetry(uint32_t now_ms)
{
    static uint32_t last_ms = 0;
    if (now_ms - last_ms < TELEMETRY_PUBLISH_MS) return;
    last_ms = now_ms;

    // NOTE: g_imu.read() / g_power.read() are NOT called here — they
    // run in readSensorsSlow() at1 Hz.  Mixing I2C reads into the
    // publish path caused occasional USB CDC stalls when the Bosch
    // BNO055 driver held Wire for >100 ms (even when "not operational",
    // the driver sometimes pings the bus on stale state).
    // Here we only emit cached values — pure memcpy + JSON, no I2C.

    size_t n = JsonStatus::emitTickStatus(
        g_json_buf, sizeof(g_json_buf), now_ms,
        &g_modeManager, g_encoders, g_motors,
        &g_imu, &g_power, &g_ir, &g_sharp,
        &g_tof, &g_cylinder,
        &g_cargo,
        g_nav_vx, g_nav_vy, g_nav_omega,
        g_e_stop_active, g_max_speed_pct);
    PiSerial.write(g_json_buf, n);
    yield();
}

void publishSensors(uint32_t now_ms)
{
    readSensorsSlow(now_ms);
    publishAlive(now_ms);
    publishTelemetry(now_ms);

    // ---- Periodic sensor types (independent cadences) ----
    // Each type runs at its own Hz.  All use cached values from
    // readSensorsSlow() so no I2C reads block the publish path.

    static uint32_t last_imu_ms   = 0;
    static uint32_t last_pwr_ms   = 0;
    static uint32_t last_enc_ms   = 0;
    static uint32_t last_tof_ms   = 0;
    static uint32_t last_ir_ms    = 0;
    static uint32_t last_sharp_ms = 0;

    // IMU — 20 Hz (50 ms)
    if (now_ms - last_imu_ms >= 50) {
        last_imu_ms = now_ms;
        if (g_imu.isOperational()) {
            size_t n = JsonStatus::emitIMU(g_json_buf, sizeof(g_json_buf), &g_imu);
            PiSerial.write(g_json_buf, n);
            yield();
        }
    }

    // Power — 1 Hz (1000 ms)
    if (now_ms - last_pwr_ms >= 1000) {
        last_pwr_ms = now_ms;
        if (g_power.isOperational()) {
            size_t n = JsonStatus::emitPower(g_json_buf, sizeof(g_json_buf), &g_power);
            PiSerial.write(g_json_buf, n);
            yield();
        }
    }

    // Encoder — 10 Hz (100 ms)
    if (now_ms - last_enc_ms >= 100) {
        last_enc_ms = now_ms;
        size_t n = JsonStatus::emitEncoderSnapshot(
            g_json_buf, sizeof(g_json_buf),
            g_modeManager.getRampedSpeeds(), g_encoders);
        PiSerial.write(g_json_buf, n);
        yield();
    }

    // TOF — 10 Hz (100 ms)
    if (now_ms - last_tof_ms >= 100) {
        last_tof_ms = now_ms;
        if (g_tof.isPresent()) {
            g_tof.printStatusJson();
            yield();
        }
    }

    // IR proximity — 20 Hz (50 ms)
    if (now_ms - last_ir_ms >= 50) {
        last_ir_ms = now_ms;
        g_ir.printStatusJson();
        yield();
    }

    // Sharp front — 20 Hz (50 ms)
    if (now_ms - last_sharp_ms >= 50) {
        last_sharp_ms = now_ms;
        g_sharp.printStatusJson();
        yield();
    }

    // ---- Module health report (type 142) ----
    // 1 Hz periodic + immediate on state change
    static uint32_t last_health_ms = 0;
    bool health_changed = g_health.hasChanged();
    if (health_changed || (now_ms - last_health_ms >= 1000)) {
        last_health_ms = now_ms;
        const char* mode_name = Watchdog::modeName(g_modeManager.getMode());
        size_t n = g_health.emitHealthJson(g_json_buf, sizeof(g_json_buf),
                                          now_ms, g_e_stop_active, mode_name);
        PiSerial.write(g_json_buf, n);
        yield();
    }
}

// ========================================================================
// Setup & Loop
// ========================================================================
void setup()
{
    // Do NOT arm watchdog yet — sensor init (I2C scan, BNO055, VL53L0X)
    // can take 10+ seconds and would trigger a false watchdog reset.
    // Arm AFTER hardware init completes.

    setupHardware();
    g_health.begin();
    // Reflect boot-time sensor initialization immediately.  HealthMonitor
    // defaults records to ONLINE, so an absent/failing BNO055 must be marked
    // explicitly instead of being reported healthy until the first stale tick.
    if (!g_imu.isOperational()) {
        g_health.reportState(MOD_IMU, ST_FAILED, 1, millis());
    }
    if (!g_power.isOperational()) {
        g_health.reportState(MOD_BATTERY, ST_FAILED, 2, millis());
    }
    g_modeManager.begin();

    // The I2C bus is operational once Wire.begin() succeeds in setupHardware.
    // Per-sensor health (IMU, TOF, INA226) is independent: a missing sensor
    // does NOT mean the bus is broken.  Mark it ONLINE so the type 142 report
    // doesn't flag the bus as FAILED just because one peripheral is unplugged.
    g_health.reportOk(MOD_I2C_BUS, millis());

    // Arm hardware watchdog AFTER all sensor init is complete.
    // 10s timeout is enough for loop() to run; boot was unprotected
    // by design to avoid false resets during I2C scan / sensor init.
    esp_task_wdt_init(10, true);
    esp_task_wdt_add(NULL);

    Serial.println();
    Serial.println("Ready. F/B/L/R/Q/E <0-255> | S stop | D e-stop | K clear | M <fl> <fr> <rl> <rr> | V status | I IMU | W power | N IR | J Sharp | T test | A auto-roam | ? help");
    Serial.println();
}


// ========================================================================
// Poll IR + Sharp sensors → feed ObstacleAvoidance
// ========================================================================
void pollLocalSensors(uint32_t now)
{
    // ---- IR proximity sensors: debounce + always report current state ----
    // `update` returns true only when a sensor pin changed; a stable reading
    // also counts as a successful poll, so we always reportOk after the call.
    g_ir.update(now);
    g_health.reportOk(MOD_IR, now);
    {
        uint8_t mask = g_ir.detectedMask();
        // mask bits: 0=REAR_LEFT, 1=REAR_RIGHT, 2=LEFT, 3=RIGHT

        if (mask != 0) {
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
            g_local_obstacle_stop = true;
        } else {
            // Sensor reads clear — leave the obstacle state untouched.
            // applyToCommand() clears it after CLEAR_THRESHOLD_MS.  Calling
            // clearObstacles() here would erase the stop on the very next
            // poll and let a fresh Pi move command drive into the object.
        }
    }

    // ---- Sharp front sensor: always read distance, feed if close ----
    g_sharp.update(now);
    g_health.reportOk(MOD_SHARP, now);
    if (g_sharp.isTooClose() || g_sharp.isSlowing()) {
        g_obstacle.onObstacleEvent(ObstacleDirection::FRONT, now);
        g_local_obstacle_stop = true;
    }

    // ---- Cargo sensor (microswitch, polled every tick) ----
    g_cargo.update(now);

    // ---- Battery safety monitoring ----
    // TEMPORARILY DISABLED for bench testing without INA226 wiring.
    // TODO: re-enable when INA226 VIN+/VIN- are properly connected.
    /*
    if (g_power.isOperational() && g_power.getLastReadMs() > 0) {
        uint8_t bstatus = g_power.getBatteryStatus();
        if (bstatus == 2) {
            g_health.reportError(MOD_BATTERY, 3, now);
            if (!g_e_stop_active) {
                Serial.println("[POWER] Battery CRITICAL — auto e-stop");
                handleEStop();
            }
        } else {
            if (bstatus == 1) {
                if (g_max_speed_pct > 50) {
                    g_max_speed_pct = 50;
                    Serial.println("[POWER] Battery low — max speed capped to 50%");
                }
            }
            g_health.reportOk(MOD_BATTERY, now);
        }
    }
    */

    // ---- Motor driver health ----
    // BTS7960 has no diagnostic feedback pin.  Do not infer a driver fault
    // from low encoder RPM: a low PWM command may not overcome static
    // friction, and encoder wiring is checked independently below.  Actual
    // stall detection belongs to the calibrated motor test/PID layer.
    if (!g_e_stop_active) {
        g_health.reportOk(MOD_MOTOR_DRIVER, now);
    }

    // ---- Encoder health (PID tick runs every 20ms = 50Hz) ----
    // Use the actual ramped command, not g_target_speeds: AUTO_ROAM has its
    // own local target array and g_target_speeds can retain an old command.
    // At zero command there is no valid stall test, so encoders are healthy.
    bool enc_ok = true;
    bool any_target = false;
    const int16_t* actual_targets = g_modeManager.getRampedSpeeds();
    for (int i = 0; i < MOTOR_COUNT; i++) {
        if (abs(actual_targets[i]) > 50) {
            any_target = true;
            float actual = abs(g_encoders[i].getFilteredRPM());
            if (actual < 2) {
                g_health.reportError(MOD_ENCODERS, 1, now);
                enc_ok = false;
                break;
            }
        }
    }
    if (enc_ok || !any_target) g_health.reportOk(MOD_ENCODERS, now);

    // ---- Pi link health — aligned with HEARTBEAT_TIMEOUT_MS ----
    // The firmware watchdog transitions to AUTO_ROAM at 2 s; the health
    // report should agree.  Report OK when the last serial activity is
    // younger than the timeout; report stale otherwise.
    const uint32_t pi_link_window_ms = HEARTBEAT_TIMEOUT_MS + 500;
    if (now > 1000 && (now - g_modeManager.getLastSerialActivityMs()) < pi_link_window_ms) {
        g_health.reportOk(MOD_Pi_LINK, now);
    } else if (now > pi_link_window_ms) {
        g_health.reportError(MOD_Pi_LINK, 1, now);
    }
}

void loop()
{
    uint32_t now = millis();

    readSerial();
    g_modeManager.update(now);

    // ---- Health monitor tick (staleness check + state transitions) ----
    g_health.tick(now);

    // ---- Per-module recovery attempts ----
    // If any I2C module is RECOVERING and retry interval elapsed,
    // call begin() again.  Failures bump retry_count toward FAILED.
    if (g_health.recoveryDue(MOD_IMU, now)) {
        // BNO055 runs in SPI mode (frees I2C for VL53L0X + INA226).
        // Reinit SPI pins (safe, no bus crash) then re-attempt begin().
        // If SPI was used at boot, SPI_init will re-detect; if I2C was used,
        // I2CBus::probeWithRecovery handles the I2C path.
        Serial.println("[HEALTH] IMU recovery attempt — reinit SPI then begin...");
        BNO055_SPI_init_pins();
        bool ok = g_imu.begin(BNO055_I2C_ADDR);
        if (ok) g_health.reportOk(MOD_IMU, now);
        else    g_health.reportRecoveryFailure(MOD_IMU, 1, now);
    }
    if (g_health.recoveryDue(MOD_TOF, now)) {
        Serial.println("[HEALTH] TOF recovery attempt — bus reset then reinit...");
        I2CBus::busReset(BNO055_SDA_PIN, BNO055_SCL_PIN);
        Wire.begin(BNO055_SDA_PIN, BNO055_SCL_PIN);
        Wire.setClock(BNO055_I2C_FREQ_HZ);
        Wire.setTimeout(I2C_TRANSACTION_TIMEOUT_MS);
        bool ok = g_tof.begin();
        if (ok) g_health.reportOk(MOD_TOF, now);
        else    g_health.reportRecoveryFailure(MOD_TOF, 2, now);
    }

    // ---- Bus-level recovery DISABLED ----
    // Calling I2CBus::reinitialize() during runtime can crash the ESP32-S3
    // (Wire.end() while Wire is mid-transfer or BNO055 is clock-stretching).
    // Mark the bus as ONLINE as long as Wire.begin() succeeded at boot;
    // individual sensor failures are reported via reportError() in their
    // own loops.
    // {
    //     uint8_t i2c_warnings = 0;
    //     const ModuleId i2c_mods[] = {MOD_IMU, MOD_TOF};
    //     for (ModuleId id : i2c_mods) {
    //         if (g_health.get(id).state == ST_WARNING ||
    //             g_health.get(id).state == ST_FAILED) {
    //             i2c_warnings++;
    //         }
    //     }
    //     static uint32_t last_bus_reset_ms = 0;
    //     if (i2c_warnings >= 2 && (now - last_bus_reset_ms) > 5000) {
    //         ... (recovery loop disabled to prevent RTC_SW_SYS_RST)
    //     }
    // }

    // Wire.begin() is active; peripheral presence is tracked separately.
    // Keep bus health fresh so an unplugged optional sensor cannot make the
    // shared bus appear FAILED.
    g_health.reportOk(MOD_I2C_BUS, now);

    pollLocalSensors(now);

    // Poll the slow sensors / actuators (independent of PID tick)
    if (g_tof.isPresent()) {
        // update() returns false between poll intervals; that is not a
        // sensor failure.  Presence plus a responsive I2C bus is sufficient
        // to keep the optional TOF module ONLINE.
        g_tof.update(now);
        g_health.reportOk(MOD_TOF, now);
    } else {
        g_health.reportState(MOD_TOF, ST_OFFLINE, 0, now);
    }
    g_cylinder.update(now);
    // The cylinder has no feedback sensor; update() enforces its timeout.
    // Reaching this point means the actuator watchdog is healthy.
    g_health.reportOk(MOD_CYLINDER, now);

    if (now - g_last_pid_ms >= PID_UPDATE_MS) {
        // Use the *measured* dt (capped) so the PID integrator and D-term
        // see the actual elapsed time.  Without this, a single delayed
        // loop iteration (Wire recovery, etc.) makes dt_us a lie and the
        // controller integrates at the wrong rate.
        uint32_t dt = now - g_last_pid_ms;
        if (dt > 100) dt = PID_UPDATE_MS;   // clamp first-tick / stall gaps
        uint32_t dt_us = dt * 1000;
        g_pid_dt_us = dt_us;                // visible to applySpeeds
        g_last_pid_ms = now;

        for (int i = 0; i < MOTOR_COUNT; i++) {
            g_encoders[i].calculateRPM(dt);
        }

        SystemMode mode = g_modeManager.getMode();

        // Raw bench-test mode always takes priority over the autonomous
        // output path. Previously AUTO_ROAM bypassed applySpeeds(), so an
        // O<id> <pwm> command was silently overwritten by sensor autonomy.
        if (g_raw_test_mode) {
            static uint32_t last_raw_beat = 0;
            if (millis() - last_raw_beat >= 500) {
                last_raw_beat = millis();
                Serial.printf("[DBG] raw mode TRUE | speeds %d %d %d %d | pid=%d\n",
                    g_raw_test_speeds[0], g_raw_test_speeds[1],
                    g_raw_test_speeds[2], g_raw_test_speeds[3],
                    g_pid_enabled);
            }
            applySpeeds();
        } else if (mode == MODE_AUTO_ROAM) {
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

    // Reset hardware watchdog — if loop() blocks for >5s (e.g. Wire
    // held SDA low), esp_task_wdt triggers esp_restart().
    esp_task_wdt_reset();
}
