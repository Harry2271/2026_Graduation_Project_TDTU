/*
 * I2C Multi-Sensor Test — ESP32-S3
 * =================================
 * Standalone test for 3 I2C sensors on the SAME bus:
 *   - BNO055  (IMU)         @ 0x28
 *   - VL53L0X (TOF)         @ 0x29
 *   - INA226  (Power)       @ 0x40
 *
 * Purpose: diagnose address conflict / bus contention when all 3
 * sensors are on the bus simultaneously.
 *
 * Sequence:
 *   1. Full I2C bus scan
 *   2. Test BNO055 alone
 *   3. Test VL53L0X alone
 *   4. Test INA226 alone
 *   5. Test all 3 together
 *   6. If all 3 fail → try different init order
 *   7. Check for bus lockup (SDA stuck LOW)
 *
 * Pin mapping:
 *   GPIO 10 = SDA   (with 4.7 kΩ pull-up to 3.3V)
 *   GPIO 11 = SCL   (with 4.7 kΩ pull-up to 3.3V)
 *   3.3V             → sensor VCC
 *   GND              → sensor GND + common ground
 */

#include <Arduino.h>
#include <Wire.h>
#include <VL53L0X.h>   // Pololu library (in firmware/lib/vl53l0x)

// ─── Pin configuration ─────────────────────────────────────────────
#ifndef TEST_SDA_PIN
#define TEST_SDA_PIN 10
#endif
#ifndef TEST_SCL_PIN
#define TEST_SCL_PIN 11
#endif
#define I2C_FREQ  100000

// ─── BNO055 register map (Bosch datasheet) ────────────────────────
#define BNO055_CHIP_ID_ADDR    0x00
#define BNO055_CHIP_ID_VALUE   0xA0
#define BNO055_OPR_MODE_ADDR   0x3D
#define BNO055_SYS_TRIGGER     0x3F
#define BNO055_MODE_CONFIG     0x00
#define BNO055_MODE_NDOF       0x0C
#define BNO055_PWR_MODE_ADDR   0x3E
#define BNO055_PWR_NORMAL      0x00
#define BNO055_EULER_H_LSB     0x1A
#define BNO055_TEMP_ADDR       0x34
#define BNO055_CALIB_STAT      0x35

// ─── INA226 register map ──────────────────────────────────────────
#define INA226_MANUFACTURER_ID  0xFE   // Expected: 0x5449 ("TI")
#define INA226_DIE_ID           0xFF   // Expected: 0x2260
#define INA226_CONFIG_REG       0x00
#define INA226_BUS_VOLTAGE_REG  0x02

// ─── I2C primitives ───────────────────────────────────────────────
static bool i2c_writeReg(uint8_t addr, uint8_t reg, uint8_t value) {
    Wire.beginTransmission(addr);
    Wire.write(reg);
    Wire.write(value);
    return Wire.endTransmission() == 0;
}

static uint8_t i2c_readReg(uint8_t addr, uint8_t reg) {
    Wire.beginTransmission(addr);
    Wire.write(reg);
    if (Wire.endTransmission(false) != 0) return 0xFF;
    if (Wire.requestFrom(addr, (uint8_t)1) != 1) return 0xFF;
    return Wire.read();
}

static uint16_t i2c_readReg16(uint8_t addr, uint8_t reg) {
    Wire.beginTransmission(addr);
    Wire.write(reg);
    if (Wire.endTransmission(false) != 0) return 0xFFFF;
    if (Wire.requestFrom(addr, (uint8_t)2) != 2) return 0xFFFF;
    // BNO055 returns its 16-bit values least-significant byte first.
    uint16_t val = Wire.read() | (Wire.read() << 8);
    return val;
}

static uint16_t i2c_readReg16BE(uint8_t addr, uint8_t reg) {
    Wire.beginTransmission(addr);
    Wire.write(reg);
    if (Wire.endTransmission(false) != 0) return 0xFFFF;
    if (Wire.requestFrom(addr, (uint8_t)2) != 2) return 0xFFFF;
    // INA226 registers are transmitted most-significant byte first.
    uint16_t val = (Wire.read() << 8) | Wire.read();
    return val;
}

// ─── Bus recovery: 9-clock pulse on SCL ───────────────────────────
static void i2c_busRecovery() {
    Serial.println("[I2C] Bus recovery: 9 clock pulses on SCL...");
    pinMode(TEST_SCL_PIN, OUTPUT);
    pinMode(TEST_SDA_PIN, INPUT_PULLUP);

    for (int i = 0; i < 9; i++) {
        digitalWrite(TEST_SCL_PIN, LOW);
        delayMicroseconds(5);
        digitalWrite(TEST_SCL_PIN, HIGH);
        delayMicroseconds(5);
    }

    // Generate STOP condition: SDA LOW → HIGH while SCL is HIGH
    pinMode(TEST_SDA_PIN, OUTPUT);
    digitalWrite(TEST_SDA_PIN, LOW);
    delayMicroseconds(5);
    digitalWrite(TEST_SCL_PIN, HIGH);
    delayMicroseconds(5);
    digitalWrite(TEST_SDA_PIN, HIGH);
    delayMicroseconds(5);

    pinMode(TEST_SDA_PIN, INPUT_PULLUP);
    pinMode(TEST_SCL_PIN, INPUT_PULLUP);
}

// ─── Reinit Wire bus ──────────────────────────────────────────────
static void i2c_reinit() {
    Wire.end();
    Wire.begin(TEST_SDA_PIN, TEST_SCL_PIN);
    Wire.setClock(I2C_FREQ);
    Wire.setTimeout(50);
}

// ─── Full I2C bus scan ────────────────────────────────────────────
static int i2c_scan() {
    Serial.println("\n========================================");
    Serial.println("  I2C Bus Scan — GPIO 10 (SDA) / GPIO 11 (SCL)");
    Serial.println("========================================");

    int found = 0;
    for (byte addr = 1; addr < 127; addr++) {
        Wire.beginTransmission(addr);
        byte err = Wire.endTransmission();
        if (err == 0) {
            Serial.printf("  [OK]   Device at 0x%02X", addr);
            if (addr == 0x28) Serial.print("  <-- BNO055");
            if (addr == 0x29) Serial.print("  <-- VL53L0X");
            if (addr == 0x40) Serial.print("  <-- INA226");
            Serial.println();
            found++;
        } else if (err == 4) {
            Serial.printf("  [ERR]  0x%02X — NACK on data (device exists but rejects)\n", addr);
        }
    }
    if (found == 0) {
        Serial.println("  [WARN] No devices found on bus!");
    } else {
        Serial.printf("  Total: %d device(s) found\n", found);
    }
    return found;
}

// ─── Check for bus lockup (SDA stuck LOW) ─────────────────────────
static bool i2c_checkBusLocked() {
    int sda = digitalRead(TEST_SDA_PIN);
    int scl = digitalRead(TEST_SCL_PIN);
    Serial.printf("[I2C] Bus state — SDA=%d SCL=%d", sda, scl);
    if (sda == LOW) {
        Serial.println("  ← SDA STUCK LOW! Bus locked. Running recovery...");
        i2c_busRecovery();
        i2c_reinit();
        sda = digitalRead(TEST_SDA_PIN);
        Serial.printf("[I2C] After recovery — SDA=%d SCL=%d\n", sda, scl);
        return (sda == LOW);
    }
    Serial.println("  ← OK");
    return false;
}

// ═══════════════════════════════════════════════════════════════════
//  BNO055 test (raw I2C, no library)
// ═══════════════════════════════════════════════════════════════════
static bool test_bno055(uint8_t addr = 0x28) {
    Serial.printf("\n--- BNO055 test @ 0x%02X ---\n", addr);

    // Step 1: Read chip ID
    uint8_t chipId = i2c_readReg(addr, BNO055_CHIP_ID_ADDR);
    Serial.printf("  Chip ID: 0x%02X (expected 0xA0) — %s\n",
                  chipId, chipId == BNO055_CHIP_ID_VALUE ? "OK" : "FAIL");
    if (chipId != BNO055_CHIP_ID_VALUE) return false;

    // Step 2: Enter config mode
    i2c_writeReg(addr, BNO055_OPR_MODE_ADDR, BNO055_MODE_CONFIG);
    delay(25);

    // Step 3: Trigger soft reset
    i2c_writeReg(addr, BNO055_SYS_TRIGGER, 0x20);
    delay(650);

    // Step 4: Verify chip ID after reset
    chipId = i2c_readReg(addr, BNO055_CHIP_ID_ADDR);
    Serial.printf("  Chip ID after reset: 0x%02X — %s\n",
                  chipId, chipId == BNO055_CHIP_ID_VALUE ? "OK" : "FAIL");
    if (chipId != BNO055_CHIP_ID_VALUE) return false;

    // Step 5: Set power mode
    i2c_writeReg(addr, BNO055_PWR_MODE_ADDR, BNO055_PWR_NORMAL);
    delay(10);

    // Step 6: Enter NDOF mode
    i2c_writeReg(addr, BNO055_OPR_MODE_ADDR, BNO055_MODE_NDOF);
    delay(20);

    // Step 7: Read heading
    uint16_t euler_h = i2c_readReg16(addr, BNO055_EULER_H_LSB);
    float heading = (float)(euler_h) / 16.0f;
    Serial.printf("  Heading: %.1f°\n", heading);

    // Step 8: Read temperature
    int8_t temp = (int8_t)i2c_readReg(addr, BNO055_TEMP_ADDR);
    Serial.printf("  Temperature: %d°C\n", temp);

    // Step 9: Read calibration
    uint8_t cal = i2c_readReg(addr, BNO055_CALIB_STAT);
    Serial.printf("  Calibration: sys=%d gyro=%d accel=%d mag=%d\n",
                  (cal >> 6) & 0x03, (cal >> 4) & 0x03,
                  (cal >> 2) & 0x03, cal & 0x03);

    Serial.println("  BNO055: PASS ✅");
    return true;
}

// ═══════════════════════════════════════════════════════════════════
//  VL53L0X test (Pololu library)
// ═══════════════════════════════════════════════════════════════════
static VL53L0X tofSensor;

static bool test_vl53l0x() {
    Serial.println("\n--- VL53L0X test @ 0x29 ---");

    // Init with timeout for faster failure detection
    tofSensor.setTimeout(500);
    if (!tofSensor.init()) {
        Serial.println("  VL53L0X init FAILED — no ACK at 0x29");
        return false;
    }

    tofSensor.setMeasurementTimingBudget(33000);  // 33ms
    tofSensor.startContinuous();

    delay(100);
    uint16_t dist = tofSensor.readRangeContinuousMillimeters();
    bool timeout = tofSensor.timeoutOccurred();
    Serial.printf("  Distance: %d mm (timeout=%s)\n", dist, timeout ? "YES" : "NO");

    tofSensor.stopContinuous();

    if (timeout) {
        Serial.println("  VL53L0X: TIMEOUT ⚠️");
        return false;
    }
    Serial.println("  VL53L0X: PASS ✅");
    return true;
}

// ═══════════════════════════════════════════════════════════════════
//  INA226 test (raw I2C, no library)
// ═══════════════════════════════════════════════════════════════════
static bool test_ina226(uint8_t addr = 0x40) {
    Serial.printf("\n--- INA226 test @ 0x%02X ---\n", addr);

    // Step 1: Read manufacturer ID
    uint16_t mfrId = i2c_readReg16BE(addr, INA226_MANUFACTURER_ID);
    Serial.printf("  Manufacturer ID: 0x%04X (expected 0x5449) — %s\n",
                  mfrId, mfrId == 0x5449 ? "OK" : "FAIL");

    // Step 2: Read die ID
    uint16_t dieId = i2c_readReg16BE(addr, INA226_DIE_ID);
    Serial.printf("  Die ID: 0x%04X (expected 0x2260) — %s\n",
                  dieId, dieId == 0x2260 ? "OK" : "WARN (may be OK)");

    // Step 3: Read bus voltage
    uint16_t busVoltRaw = i2c_readReg16BE(addr, INA226_BUS_VOLTAGE_REG);
    float busVolt = (float)(busVoltRaw >> 3) * 1.25f / 1000.0f;  // LSB = 1.25mV, bits [15:3]
    Serial.printf("  Bus voltage: %.3f V (raw=0x%04X)\n", busVolt, busVoltRaw);

    // Step 4: Read config register
    uint16_t config = i2c_readReg16BE(addr, INA226_CONFIG_REG);
    Serial.printf("  Config: 0x%04X\n", config);

    if (mfrId != 0x5449) {
        Serial.println("  INA226: FAIL (wrong manufacturer ID)");
        return false;
    }
    Serial.println("  INA226: PASS ✅");
    return true;
}

// ═══════════════════════════════════════════════════════════════════
//  Multi-sensor combined test
// ═══════════════════════════════════════════════════════════════════
static void test_all_sensors() {
    Serial.println("\n========================================");
    Serial.println("  Combined test — ALL 3 sensors together");
    Serial.println("========================================");

    int found = i2c_scan();

    bool bno_ok = false, tof_ok = false, ina_ok = false;

    // --- BNO055 ---
    Serial.println("\n  >> Init BNO055...");
    bno_ok = test_bno055();
    i2c_checkBusLocked();

    // --- VL53L0X ---
    Serial.println("\n  >> Init VL53L0X...");
    i2c_reinit();
    delay(50);
    tof_ok = test_vl53l0x();
    i2c_checkBusLocked();

    // --- INA226 ---
    Serial.println("\n  >> Init INA226...");
    i2c_reinit();
    delay(50);
    ina_ok = test_ina226();
    i2c_checkBusLocked();

    // --- Summary ---
    Serial.println("\n========================================");
    Serial.println("  RESULTS (all 3 sensors)");
    Serial.printf("  BNO055  (0x28): %s\n", bno_ok ? "PASS ✅" : "FAIL ❌");
    Serial.printf("  VL53L0X (0x29): %s\n", tof_ok ? "PASS ✅" : "FAIL ❌");
    Serial.printf("  INA226  (0x40): %s\n", ina_ok ? "PASS ✅" : "FAIL ❌");
    Serial.println("========================================");

    if (!bno_ok && !tof_ok && !ina_ok) {
        Serial.println("\n  [!] ALL sensors failed — possible bus lockup.");
        Serial.println("      Check: GND shared, SDA/SCL not swapped, pull-ups to 3.3V.");
        i2c_checkBusLocked();
    } else if (bno_ok && !tof_ok && !ina_ok) {
        Serial.println("\n  [!] VL53L0X + INA226 failed after BNO055 init.");
        Serial.println("      BNO055 may be holding the bus. Check I2C bus recovery.");
    } else if (!bno_ok && tof_ok && ina_ok) {
        Serial.println("\n  [!] BNO055 failed but others OK.");
        Serial.println("      Check BNO055 PS0/PS1 = LOW, ADR = GND, 3.3V power.");
    }
}

// ─── Main ─────────────────────────────────────────────────────────
void setup() {
    Serial.begin(115200);
    delay(1000);

    Serial.println("=====================================================");
    Serial.println("  I2C Multi-Sensor Test — ESP32-S3");
    Serial.println("  SDA=GPIO10  SCL=GPIO11  @ 100 kHz");
    Serial.println("=====================================================");

    // Step 1: Init I2C bus
    Wire.begin(TEST_SDA_PIN, TEST_SCL_PIN);
    Wire.setClock(I2C_FREQ);
    Wire.setTimeout(50);
    delay(100);

    // Step 2: Check bus state
    Serial.println("\n--- Initial bus state ---");
    i2c_checkBusLocked();

    // Step 3: Full bus scan
    int found = i2c_scan();

    // Step 4: Test each sensor individually
    Serial.println("\n========================================");
    Serial.println("  Individual sensor tests");
    Serial.println("========================================");

    // --- BNO055 alone ---
    i2c_reinit();
    delay(100);
    bool bno = test_bno055();
    i2c_checkBusLocked();

    // --- VL53L0X alone ---
    i2c_reinit();
    delay(100);
    bool tof = test_vl53l0x();
    i2c_checkBusLocked();

    // --- INA226 alone ---
    i2c_reinit();
    delay(100);
    bool ina = test_ina226();
    i2c_checkBusLocked();

    Serial.println("\n--- Individual results ---");
    Serial.printf("  BNO055  (0x28): %s\n", bno ? "PASS ✅" : "FAIL ❌");
    Serial.printf("  VL53L0X (0x29): %s\n", tof ? "PASS ✅" : "FAIL ❌");
    Serial.printf("  INA226  (0x40): %s\n", ina ? "PASS ✅" : "FAIL ❌");

    // Step 5: If all individual tests pass, test all together
    if (bno && tof && ina) {
        Serial.println("\n[INFO] All 3 sensors passed individually.");
        Serial.println("[INFO] Now testing with ALL sensors on bus...");

        // Reinit clean
        i2c_busRecovery();
        i2c_reinit();
        delay(200);

        test_all_sensors();
    } else {
        Serial.println("\n[WARN] Some sensors failed individually — fix before combined test.");
    }

    // Step 6: Test different init orders if combined test failed
    if (bno && tof && ina) {
        Serial.println("\n========================================");
        Serial.println("  Testing alternate init order:");
        Serial.println("  INA226 → VL53L0X → BNO055");
        Serial.println("========================================");

        i2c_busRecovery();
        i2c_reinit();
        delay(200);

        bool ina2 = test_ina226();
        i2c_checkBusLocked();

        i2c_reinit();
        delay(50);
        bool tof2 = test_vl53l0x();
        i2c_checkBusLocked();

        i2c_reinit();
        delay(50);
        bool bno2 = test_bno055();
        i2c_checkBusLocked();

        Serial.printf("  INA226:  %s | VL53L0X: %s | BNO055: %s\n",
                      ina2 ? "PASS" : "FAIL",
                      tof2 ? "PASS" : "FAIL",
                      bno2 ? "PASS" : "FAIL");
    }

    Serial.println("\n=====================================================");
    Serial.println("  Test complete. Check results above.");
    Serial.println("=====================================================");
}

void loop() {
    // Continuous combined reading every 2 seconds
    static uint32_t lastRead = 0;
    uint32_t now = millis();
    if (now - lastRead < 2000) return;
    lastRead = now;

    // Reinit bus each cycle (safe)
    i2c_reinit();
    delay(10);

    // Try to read each sensor
    Wire.beginTransmission(0x28);
    bool bno_ok = (Wire.endTransmission() == 0);

    Wire.beginTransmission(0x29);
    bool tof_ok = (Wire.endTransmission() == 0);

    Wire.beginTransmission(0x40);
    bool ina_ok = (Wire.endTransmission() == 0);

    Serial.printf("[LOOP] BNO055=%s VL53L0X=%s INA226=%s\n",
                  bno_ok ? "ACK" : "NACK",
                  tof_ok ? "ACK" : "NACK",
                  ina_ok ? "ACK" : "NACK");

    // Check for bus lockup periodically
    i2c_checkBusLocked();
}
