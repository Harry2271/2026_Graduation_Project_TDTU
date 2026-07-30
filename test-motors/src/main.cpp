// ============================================================
// TEST 4 MOTORS — 4× BTS7960 + 4× JGB37-520
// KHÔNG có sensor, KHÔNG có encoder, KHÔNG có PID
// Chỉ test motor quay forward/reverse theo thứ tự
//
// Wired theo PIN_MAP.md:
//   FL: RPWM=12, LPWM=13, EN=3
//   FR: RPWM=14, LPWM=15, EN=7
//   RL: RPWM=16, LPWM=17, EN=48
//   RR: RPWM=38, LPWM=39, EN=47
//
// ESP32-S3 uses LEDC for PWM (no analogWrite on pins > 33).
// ============================================================

#include <Arduino.h>
#include <driver/ledc.h>

// ---- Pin definitions ----
struct MotorPins {
    uint8_t rpwm;
    uint8_t lpwm;
    uint8_t en;
};

const MotorPins MOTORS[4] = {
    { 12, 13,  3 },   // FL
    { 14, 15,  7 },   // FR
    { 16, 17, 48 },   // RL
    { 38, 39, 47 },   // RR
};

const char* NAMES[4] = { "FL", "FR", "RL", "RR" };

// ---- LEDC PWM config ----
#define PWM_FREQ    20000   // 20 kHz
#define PWM_RES     10      // 10-bit: 0-1023
#define MAX_DUTY    512     // 50% duty — safe for bench test
#define PWM_CHANNEL_RPWM_BASE  0  // FL=0, FR=1, RL=2, RR=3
#define PWM_CHANNEL_LPWM_BASE  4  // FL=4, FR=5, RL=6, RR=7

// ---- LEDC helpers ----
void ledcSetupChannel(int motor_id) {
    // RPWM channel
    ledc_channel_config_t ch_r = {};
    ch_r.gpio_num   = MOTORS[motor_id].rpwm;
    ch_r.speed_mode = LEDC_LOW_SPEED_MODE;
    ch_r.channel    = (ledc_channel_t)(PWM_CHANNEL_RPWM_BASE + motor_id);
    ch_r.timer_sel  = LEDC_TIMER_0;
    ch_r.intr_type  = LEDC_INTR_DISABLE;
    ch_r.duty       = 0;
    ch_r.hpoint     = 0;
    ledc_channel_config(&ch_r);

    // LPWM channel
    ledc_channel_config_t ch_l = {};
    ch_l.gpio_num   = MOTORS[motor_id].lpwm;
    ch_l.speed_mode = LEDC_LOW_SPEED_MODE;
    ch_l.channel    = (ledc_channel_t)(PWM_CHANNEL_LPWM_BASE + motor_id);
    ch_l.timer_sel  = LEDC_TIMER_0;
    ch_l.intr_type  = LEDC_INTR_DISABLE;
    ch_l.duty       = 0;
    ch_l.hpoint     = 0;
    ledc_channel_config(&ch_l);
}

void setRPWM(int motor_id, int duty) {
    ledc_set_duty(LEDC_LOW_SPEED_MODE, (ledc_channel_t)(PWM_CHANNEL_RPWM_BASE + motor_id), duty);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, (ledc_channel_t)(PWM_CHANNEL_RPWM_BASE + motor_id));
}

void setLPWM(int motor_id, int duty) {
    ledc_set_duty(LEDC_LOW_SPEED_MODE, (ledc_channel_t)(PWM_CHANNEL_LPWM_BASE + motor_id), duty);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, (ledc_channel_t)(PWM_CHANNEL_LPWM_BASE + motor_id));
}

// ---- Motor control ----
void motorEnable(int id) {
    digitalWrite(MOTORS[id].en, HIGH);
}

void motorDisable(int id) {
    digitalWrite(MOTORS[id].en, LOW);
    setRPWM(id, 0);
    setLPWM(id, 0);
}

void motorForward(int id, int duty) {
    setRPWM(id, duty);
    setLPWM(id, 0);
}

void motorReverse(int id, int duty) {
    setRPWM(id, 0);
    setLPWM(id, duty);
}

void motorStop(int id) {
    setRPWM(id, 0);
    setLPWM(id, 0);
}

void motorBrake(int id) {
    setRPWM(id, 1023);   // 10-bit max = full duty
    setLPWM(id, 1023);
}

// ---- Setup ----
void setup() {
    Serial.begin(115200);
    delay(1000);

    Serial.println();
    Serial.println("========================================");
    Serial.println("  TEST 4 MOTORS — BTS7960 Direct Test");
    Serial.println("  LEDC PWM (20 kHz, 10-bit)");
    Serial.println("  No sensors, no PID, no encoder");
    Serial.println("========================================");

    // Configure LEDC timer once (shared by all 8 channels)
    ledc_timer_config_t timer = {};
    timer.speed_mode      = LEDC_LOW_SPEED_MODE;
    timer.timer_num       = LEDC_TIMER_0;
    timer.freq_hz         = PWM_FREQ;
    timer.duty_resolution = (ledc_timer_bit_t)PWM_RES;
    timer.clk_cfg         = LEDC_AUTO_CLK;
    ledc_timer_config(&timer);

    for (int i = 0; i < 4; i++) {
        // GPIO EN
        pinMode(MOTORS[i].en, OUTPUT);
        digitalWrite(MOTORS[i].en, LOW);

        // LEDC PWM for RPWM and LPWM
        ledcSetupChannel(i);

        Serial.printf("  [%s] EN=GPIO%d RPWM=GPIO%d LPWM=GPIO%d LEDC ch%d/ch%d\n",
            NAMES[i], MOTORS[i].en, MOTORS[i].rpwm, MOTORS[i].lpwm,
            PWM_CHANNEL_RPWM_BASE + i, PWM_CHANNEL_LPWM_BASE + i);
    }

    Serial.println();
    Serial.println("Starting test in 3 seconds...");
    delay(3000);
}

// ---- Test 1: Each motor individually ----
void testSingleMotors(int speed, int duration_ms) {
    Serial.println("\n--- Test 1: Single motor forward ---");
    for (int i = 0; i < 4; i++) {
        Serial.printf("  [%s] forward %d for %dms\n", NAMES[i], speed, duration_ms);
        motorEnable(i);
        motorForward(i, speed);
        delay(duration_ms);
        motorStop(i);
        motorDisable(i);
        delay(500);
    }

    Serial.println("\n--- Test 2: Single motor reverse ---");
    for (int i = 0; i < 4; i++) {
        Serial.printf("  [%s] reverse %d for %dms\n", NAMES[i], speed, duration_ms);
        motorEnable(i);
        motorReverse(i, speed);
        delay(duration_ms);
        motorStop(i);
        motorDisable(i);
        delay(500);
    }
}

// ---- Test 3: All forward ----
void testAllForward(int speed, int duration_ms) {
    Serial.printf("\n--- Test 3: ALL forward %d for %dms ---\n", speed, duration_ms);
    for (int i = 0; i < 4; i++) {
        motorEnable(i);
        motorForward(i, speed);
    }
    delay(duration_ms);
    for (int i = 0; i < 4; i++) motorStop(i);
    delay(500);
}

// ---- Test 4: All reverse ----
void testAllReverse(int speed, int duration_ms) {
    Serial.printf("\n--- Test 4: ALL reverse %d for %dms ---\n", speed, duration_ms);
    for (int i = 0; i < 4; i++) {
        motorEnable(i);
        motorReverse(i, speed);
    }
    delay(duration_ms);
    for (int i = 0; i < 4; i++) motorStop(i);
    delay(500);
}

// ---- Test 5: Spin ----
void testSpin(int speed, int duration_ms) {
    Serial.printf("\n--- Test 5: Spin (FL+RL forward, FR+RR reverse) ---\n");
    motorEnable(0); motorForward(0, speed);
    motorEnable(2); motorForward(2, speed);
    motorEnable(1); motorReverse(1, speed);
    motorEnable(3); motorReverse(3, speed);
    delay(duration_ms);
    for (int i = 0; i < 4; i++) motorStop(i);
    delay(500);
}

// ---- Test 6: Ramp up ----
void testRampUp(int max_speed, int duration_ms) {
    Serial.printf("\n--- Test 6: Ramp up all 4 motors ---\n");
    for (int i = 0; i < 4; i++) motorEnable(i);

    int steps = 20;
    int step_delay = duration_ms / steps;
    for (int duty = 0; duty <= max_speed; duty += (max_speed / steps)) {
        Serial.printf("  PWM: %d\n", duty);
        for (int i = 0; i < 4; i++) motorForward(i, duty);
        delay(step_delay);
    }

    for (int i = 0; i < 4; i++) motorStop(i);
    delay(500);
}

// ---- Test 7: FL only (debug) ----
void testFL(int speed, int duration_ms) {
    Serial.printf("\n--- Test 7: FL ONLY forward %d for %dms ---\n", speed, duration_ms);
    motorEnable(0);
    motorForward(0, speed);
    delay(duration_ms);
    motorStop(0);
    motorDisable(0);
    delay(500);

    Serial.printf("--- Test 7: FL ONLY reverse %d for %dms ---\n", speed, duration_ms);
    motorEnable(0);
    motorReverse(0, speed);
    delay(duration_ms);
    motorStop(0);
    motorDisable(0);
    delay(500);
}

// ---- Main loop ----
void loop() {
    int speed = MAX_DUTY;     // 50% duty — safe for bench test
    int duration = 2000;      // 2 seconds per test

    testFL(speed, duration);
    testSingleMotors(speed, duration);
    testAllForward(speed, duration);
    testAllReverse(speed, duration);
    testSpin(speed, duration);
    testRampUp(speed, duration);

    Serial.println("\n========================================");
    Serial.println("  ALL TESTS COMPLETE — restart in 5s");
    Serial.println("========================================\n");
    delay(5000);
}