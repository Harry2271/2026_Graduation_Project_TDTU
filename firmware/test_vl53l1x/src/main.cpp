#include <Arduino.h>
#include <Wire.h>
#include <VL53L1X.h>

#ifndef TEST_SDA_PIN
#define TEST_SDA_PIN 10
#endif
#ifndef TEST_SCL_PIN
#define TEST_SCL_PIN 11
#endif
#ifndef TEST_XSHUT_PIN
#define TEST_XSHUT_PIN 44
#endif

static constexpr uint32_t I2C_HZ = 100000;
static constexpr uint8_t SENSOR_ADDR = 0x29;

static void printBus(const char* label)
{
    Serial.printf("[BUS] %s SDA=%d SCL=%d\n", label,
                  digitalRead(TEST_SDA_PIN), digitalRead(TEST_SCL_PIN));
}

static int probe(uint8_t address)
{
    Wire.beginTransmission(address);
    const uint8_t err = Wire.endTransmission();
    Serial.printf("[I2C] probe 0x%02X -> err=%u\n", address, err);
    return err;
}

static void stopHere(const char* reason)
{
    Serial.printf("[FAIL] %s\n", reason);
    printBus("failure");
    while (true) {
        delay(1000);
        Serial.println("[FAIL] test stopped");
    }
}

VL53L1X sensor;

void setup()
{
    Serial.begin(115200);
    delay(1200);
    Serial.println();
    Serial.println("==============================================");
    Serial.println(" VL53L1X TOF400C standalone test");
    Serial.println(" ESP32-S3 + one VL53L1X only");
    Serial.println("==============================================");
    Serial.printf("Pins: SDA=GPIO%d SCL=GPIO%d XSHUT=GPIO%d\n",
                  TEST_SDA_PIN, TEST_SCL_PIN, TEST_XSHUT_PIN);

    // XSHUT is optional for a single sensor. If connected, hold it LOW
    // during bus setup, then release it as the reference driver does.
    pinMode(TEST_XSHUT_PIN, OUTPUT);
    digitalWrite(TEST_XSHUT_PIN, LOW);
    delay(50);

    pinMode(TEST_SDA_PIN, INPUT);
    pinMode(TEST_SCL_PIN, INPUT);
    delay(10);
    printBus("before Wire.begin");
    if (digitalRead(TEST_SDA_PIN) != HIGH || digitalRead(TEST_SCL_PIN) != HIGH) {
        stopHere("SDA/SCL are not HIGH. Check 4.7k pull-ups to 3.3V and wiring.");
    }

    Serial.println("[I2C] Wire.begin...");
    Wire.begin(TEST_SDA_PIN, TEST_SCL_PIN);
    Wire.setClock(I2C_HZ);
    Wire.setTimeout(100);
    delay(100);
    printBus("after Wire.begin");

    // The reference example releases XSHUT with INPUT so the carrier's
    // pull-up, not a 3.3V GPIO output, determines the high level.
    pinMode(TEST_XSHUT_PIN, INPUT);
    delay(100);
    printBus("after XSHUT release");

    if (probe(SENSOR_ADDR) != 0) {
        stopHere("VL53L1X did not ACK at 0x29. Check VIN, GND, SDA, SCL, XSHUT.");
    }

    sensor.setBus(&Wire);
    sensor.setTimeout(500);
    Serial.println("[TOF] init at default address 0x29...");
    if (!sensor.init()) {
        stopHere("VL53L1X init failed. Check module power/pinout; INT is not required.");
    }

    Serial.println("[TOF] init OK");
    if (!sensor.setDistanceMode(VL53L1X::Long)) {
        stopHere("setDistanceMode(Long) failed");
    }
    if (!sensor.setMeasurementTimingBudget(50000)) {
        stopHere("setMeasurementTimingBudget failed");
    }
    sensor.startContinuous(50);
    Serial.println("[TOF] continuous ranging started");
}

void loop()
{
    const uint16_t distance = sensor.read();
    Serial.printf("[RANGE] %u mm", distance);
    if (sensor.timeoutOccurred()) {
        Serial.print(" TIMEOUT");
    }
    Serial.println();
    delay(200);
}
