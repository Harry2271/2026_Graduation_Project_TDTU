#include <Arduino.h>
#include <Wire.h>
#include <VL53L0X.h>
#include <VL53L1X.h>

// Independent dual-ToF hardware test.
// VL53L0X and VL53L1X both boot at 0x29; XSHUT sequencing assigns
// VL53L0X -> 0x30 and VL53L1X -> 0x31.
static constexpr uint8_t SDA_PIN = 10;
static constexpr uint8_t SCL_PIN = 11;
static constexpr uint8_t REAR_XSHUT = 8;
static constexpr uint8_t FRONT_XSHUT = 9;
static constexpr uint8_t DEFAULT_ADDR = 0x29;
static constexpr uint8_t REAR_ADDR = 0x30;
static constexpr uint8_t FRONT_ADDR = 0x31;
static constexpr uint32_t I2C_HZ = 100000;
static constexpr uint32_t SENSOR_BOOT_MS = 150;

static VL53L0X rear;
static VL53L1X front;
static bool rear_ok = false;
static bool front_ok = false;

static uint8_t probe(uint8_t address)
{
    Wire.beginTransmission(address);
    const uint8_t err = Wire.endTransmission();
    Serial.printf("[I2C] probe 0x%02X -> %u\n", address, err);
    return err;
}

static void fail(const char* message)
{
    Serial.printf("[FAIL] %s\n", message);
    Serial.printf("       SDA=%d SCL=%d XSHUT(rear)=%d XSHUT(front)=%d\n",
                  digitalRead(SDA_PIN), digitalRead(SCL_PIN),
                  digitalRead(REAR_XSHUT), digitalRead(FRONT_XSHUT));
    while (true) {
        delay(1000);
        Serial.println("[FAIL] Reset board after correcting wiring/power.");
    }
}

void setup()
{
    Serial.begin(115200);
    delay(1200);
    Serial.println();
    Serial.println("===============================================");
    Serial.println(" Dual VL53L0X + VL53L1X standalone test");
    Serial.println(" SDA=GPIO10 SCL=GPIO11 XSHUT rear=8 front=9");
    Serial.println(" expected runtime addresses: rear=0x30 front=0x31");
    Serial.println("===============================================");

    // Both devices must be in reset before the bus is started.
    pinMode(REAR_XSHUT, OUTPUT);
    pinMode(FRONT_XSHUT, OUTPUT);
    digitalWrite(REAR_XSHUT, LOW);
    digitalWrite(FRONT_XSHUT, LOW);
    delay(100);

    Wire.begin(SDA_PIN, SCL_PIN);
    Wire.setClock(I2C_HZ);
    Wire.setTimeout(500);
    delay(100);

    Serial.printf("[BUS] SDA=%d SCL=%d XSHUT rear=%d front=%d\n",
                  digitalRead(SDA_PIN), digitalRead(SCL_PIN),
                  digitalRead(REAR_XSHUT), digitalRead(FRONT_XSHUT));
    if (probe(DEFAULT_ADDR) == 0) {
        fail("A ToF device answers at 0x29 while both XSHUT lines are LOW");
    }

    // Release rear only, using the carrier pull-up as in the reference driver.
    digitalWrite(REAR_XSHUT, HIGH);
    delay(SENSOR_BOOT_MS);
    Serial.printf("[SEQ] rear XSHUT high (boot %u ms): XSHUT=%d\n", SENSOR_BOOT_MS, digitalRead(REAR_XSHUT));
    if (probe(DEFAULT_ADDR) != 0) fail("VL53L0X did not ACK at 0x29 after XSHUT high");

    rear.setBus(&Wire);
    rear.setTimeout(500);
    Serial.println("[SEQ] init VL53L0X at 0x29");
    if (!rear.init()) fail("VL53L0X init failed at 0x29");
    rear.setAddress(REAR_ADDR);
    delay(20);
    if (probe(DEFAULT_ADDR) == 0) fail("VL53L0X still answers at default 0x29");
    if (probe(REAR_ADDR) != 0) fail("VL53L0X did not move to 0x30");
    rear.setMeasurementTimingBudget(33000);
    rear.startContinuous(50);
    rear_ok = true;
    Serial.println("[PASS] VL53L0X initialized and assigned 0x30");

    // Release and initialize front only after rear is at 0x30.
    // Release and initialize front only after rear is at 0x30.
    digitalWrite(FRONT_XSHUT, HIGH);
    delay(SENSOR_BOOT_MS);
    Serial.printf("[SEQ] front XSHUT high (boot %u ms): XSHUT=%d\n", SENSOR_BOOT_MS, digitalRead(FRONT_XSHUT));
    if (probe(DEFAULT_ADDR) != 0) fail("VL53L1X did not ACK at 0x29 after XSHUT high");

    front.setBus(&Wire);
    front.setTimeout(500);
    Serial.println("[SEQ] init VL53L1X at 0x29");
    if (!front.init()) fail("VL53L1X init failed at 0x29");
    front.setAddress(FRONT_ADDR);
    delay(20);
    if (probe(REAR_ADDR) != 0) fail("VL53L0X lost runtime address 0x30");
    if (probe(DEFAULT_ADDR) == 0) fail("VL53L1X remained at default 0x29");
    if (probe(FRONT_ADDR) != 0) fail("VL53L1X did not move to 0x31");
    if (!front.setDistanceMode(VL53L1X::Long)) fail("VL53L1X Long mode failed");
    if (!front.setMeasurementTimingBudget(50000)) fail("VL53L1X timing budget failed");
    front.startContinuous(50);
    front_ok = true;
    Serial.println("[PASS] VL53L1X initialized and assigned 0x31");
    Serial.println("[PASS] Both ToF sensors passed address sequencing.");
}

void loop()
{
    static uint32_t last_ms = 0;
    if (millis() - last_ms < 500) return;
    last_ms = millis();

    if (rear_ok) {
        const uint16_t mm = rear.readRangeContinuousMillimeters();
        Serial.printf("[RANGE] rear 0x30 = %u mm%s\n", mm,
                      rear.timeoutOccurred() ? " TIMEOUT" : "");
    }
    if (front_ok) {
        const uint16_t mm = front.readRangeContinuousMillimeters();
        Serial.printf("[RANGE] front 0x31 = %u mm%s status=%u\n", mm,
                      front.timeoutOccurred() ? " TIMEOUT" : "",
                      (unsigned)front.ranging_data.range_status);
    }
}
