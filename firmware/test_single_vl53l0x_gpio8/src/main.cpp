#include <Arduino.h>
#include <Wire.h>

// Test: Does GPIO8 control VL53L0X XSHUT?
// Expected: With GPIO9 LOW and GPIO8 INPUT, probe 0x29 should ACK.

#define TEST_SDA_PIN 10
#define TEST_SCL_PIN 11
#define VL53L0X_XSHUT_PIN 8
#define VL53L1X_XSHUT_PIN 9
#define DEFAULT_ADDR 0x29

void setup() {
    Serial.begin(115200);
    delay(1500);
    Serial.println("\n=== VL53L0X GPIO8 XSHUT Test ===");

    // Hold both XSHUT LOW
    pinMode(VL53L0X_XSHUT_PIN, OUTPUT);
    pinMode(VL53L1X_XSHUT_PIN, OUTPUT);
    digitalWrite(VL53L0X_XSHUT_PIN, LOW);
    digitalWrite(VL53L1X_XSHUT_PIN, LOW);
    delay(100);

    Wire.begin(TEST_SDA_PIN, TEST_SCL_PIN);
    Wire.setClock(100000);
    Wire.setTimeout(500);
    delay(100);

    Serial.printf("SDA=%d SCL=%d\n", digitalRead(TEST_SDA_PIN), digitalRead(TEST_SCL_PIN));
    Serial.printf("GPIO8=%d GPIO9=%d (both should be 0)\n",
                  digitalRead(VL53L0X_XSHUT_PIN), digitalRead(VL53L1X_XSHUT_PIN));

    Wire.beginTransmission(DEFAULT_ADDR);
    uint8_t err = Wire.endTransmission();
    Serial.printf("Probe 0x29 with both XSHUT LOW: err=%u (expect NACK=2)\n", err);

    // Release VL53L0X only
    pinMode(VL53L0X_XSHUT_PIN, INPUT);
    delay(500);
    Serial.printf("GPIO8 released: level=%d\n", digitalRead(VL53L0X_XSHUT_PIN));

    Wire.beginTransmission(DEFAULT_ADDR);
    err = Wire.endTransmission();
    Serial.printf("Probe 0x29 after GPIO8 INPUT: err=%u\n", err);

    if (err == 0) {
        Serial.println("[PASS] VL53L0X ACK at 0x29 — GPIO8 controls VL53L0X XSHUT");
    } else if (err == 2) {
        Serial.println("[FAIL] VL53L0X NACK at 0x29 — GPIO8 does NOT control VL53L0X XSHUT or sensor absent");
    } else {
        Serial.printf("[FAIL] Unexpected error %u\n", err);
    }
}

void loop() {
    delay(5000);
    Serial.println("Test complete. Reset to run again.");
}
