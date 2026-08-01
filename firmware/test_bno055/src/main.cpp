/*
 * BNO055 Standalone Test Firmware for ESP32-S3
 * ==============================================
 * Tests CJMCU-055 BNO055 module independently, without motor drivers,
 * INA226, VL53L0X, health monitor or watchdog.
 *
 * Features:
 *   - Full I2C bus scan (0x00-0x7F)
 *   - BNO055 probe at 0x28 and 0x29
 *   - Chip ID verification (0xA0)
 *   - CONFIG → NORMAL → NDOF init sequence
 *   - Continuous heading/roll/pitch/accel/gyro output
 *
 * Pin configuration (edit TEST_SDA_PIN/TEST_SCL_PIN in platformio.ini):
 *   ESP32 GPIO10 → CJMCU-055 SDA
 *   ESP32 GPIO11 → CJMCU-055 SCL
 *   ESP32 3.3V   → VCC
 *   ESP32 GND    → GND + GNDIO
 *   ADR/COM3     → GND (address 0x28)
 *   PS0/PS1      → LOW or unconnected (I2C mode)
 *   RST          → 3.3V or floating (pull-up on module)
 *
 * Serial output: USB CDC (COM8, 115200 baud)
 */

#include <Arduino.h>
#include <Wire.h>

// ─── Pin configuration ────────────────────────────────────────────────
#ifndef TEST_SDA_PIN
#define TEST_SDA_PIN 10
#endif
#ifndef TEST_SCL_PIN
#define TEST_SCL_PIN 11
#endif

// ─── BNO055 register map (Bosch datasheet page 0) ─────────────────────
#define BNO055_CHIP_ID_ADDR       0x00
#define BNO055_ACCEL_DATA_X_LSB   0x08
#define BNO055_GYRO_DATA_X_LSB    0x14
#define BNO055_EULER_H_LSB        0x1A
#define BNO055_TEMP_ADDR          0x34
#define BNO055_CALIB_STAT_ADDR    0x35
#define BNO055_OPR_MODE_ADDR      0x3D
#define BNO055_PWR_MODE_ADDR      0x3E
#define BNO055_SYS_TRIGGER_ADDR   0x3F
#define BNO055_PAGE_ID_ADDR       0x07

#define BNO055_CHIP_ID_VALUE      0xA0
#define BNO055_MODE_CONFIG        0x00
#define BNO055_MODE_NDOF          0x0C
#define BNO055_POWER_NORMAL       0x00

// ─── I2C primitives (matching BNOExample driver) ─────────────────────
static bool writeReg(uint8_t addr, uint8_t reg, uint8_t value) {
    uint8_t buf[2] = { reg, value };
    Wire.beginTransmission(addr);
    Wire.write(buf, 2);
    Wire.endTransmission();  // STOP
    return true;
}

static uint8_t readReg(uint8_t addr, uint8_t reg) {
    Wire.beginTransmission(addr);
    Wire.write(reg);
    if (Wire.endTransmission(false) != 0) return 0xFF;
    if (Wire.requestFrom(addr, (uint8_t)1) != 1) return 0xFF;
    return Wire.read();
}

static bool readRegs(uint8_t addr, uint8_t reg, uint8_t* buf, uint8_t cnt) {
    Wire.beginTransmission(addr);
    Wire.write(reg);
    uint8_t tx_err = Wire.endTransmission();  // STOP
    if (tx_err != 0) {
        return false;
    }

    // Request exactly once. Do not retry indefinitely: on a missing device or
    // broken SDA/SCL, Arduino Wire returns -1 and the old loop spammed errors.
    uint8_t received = Wire.requestFrom(addr, cnt);
    if (received != cnt) {
        while (Wire.available()) (void)Wire.read();
        return false;
    }
    for (uint8_t i = 0; i < cnt; i++) {
        if (!Wire.available()) return false;
        buf[i] = Wire.read();
    }
    return true;
}

// ─── I2C bus scan ─────────────────────────────────────────────────────
int scanBus(uint8_t sda, uint8_t scl, const char* label) {
    Serial.printf("\n[I2C] Scan %s (SDA=%d SCL=%d):\n", label, sda, scl);

    // Enable the internal pull-ups as a fallback for bench testing. They are
    // weak (~45k ohm); use external 2.2k-4.7k pull-ups on the real bus.
    pinMode(sda, INPUT_PULLUP);
    pinMode(scl, INPUT_PULLUP);

    // Init Wire on the requested pins — do NOT call Wire.end() before
    // Wire.begin() on ESP32, as it may crash when Wire is not yet initialised.
    Wire.begin(sda, scl);
    Wire.setClock(100000);
    delay(50);

    int line_sda = digitalRead(sda);
    int line_scl = digitalRead(scl);
    Serial.printf("[I2C] Idle lines: SDA=%s SCL=%s\n",
                  line_sda == LOW ? "LOW (stuck)" : "HIGH",
                  line_scl == LOW ? "LOW (stuck)" : "HIGH");
    if (line_sda == LOW || line_scl == LOW) {
        Serial.println("[I2C] Bus is not idle — check shorts, powered modules, and pull-ups");
    }

    int found = 0;
    for (uint8_t addr = 1; addr < 127; addr++) {
        Wire.beginTransmission(addr);
        // Use timeout — Wire.endTransmission() may block if SDA stuck
        uint8_t err = Wire.endTransmission();
        if (err == 0) {
            Serial.printf("  0x%02X", addr);
            if (addr == 0x28) Serial.print(" ← BNO055");
            if (addr == 0x29) Serial.print(" ← VL53L0X");
            if (addr == 0x40) Serial.print(" ← INA226");
            Serial.println();
            found++;
        }
    }
    Serial.printf("  Total: %d device(s)\n", found);
    return found;
}

// ─── BNO055 init sequence (matches Arduino BNOExample) ────────────────
bool initBNO055(uint8_t addr) {
    Serial.printf("\n[BNO055] Begin init at 0x%02X (100 kHz, STOP pattern)\n", addr);

    // Bosch datasheet: 650 ms power-on delay
    Serial.println("[BNO055] Waiting 650 ms for power-up...");
    delay(650);

    // 1. Probe
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() != 0) {
        Serial.printf("[BNO055] FAIL: No ACK at 0x%02X\n", addr);
        return false;
    }
    Serial.printf("[BNO055] OK: ACK at 0x%02X\n", addr);

    // 2. Chip ID
    uint8_t chipId = readReg(addr, BNO055_CHIP_ID_ADDR);
    Serial.printf("[BNO055] Chip ID = 0x%02X (expected 0xA0)\n", chipId);
    if (chipId != BNO055_CHIP_ID_VALUE) {
        Serial.println("[BNO055] Waiting extra 1 s for boot...");
        delay(1000);
        chipId = readReg(addr, BNO055_CHIP_ID_ADDR);
        Serial.printf("[BNO055] Chip ID retry = 0x%02X\n", chipId);
        if (chipId != BNO055_CHIP_ID_VALUE) {
            Serial.println("[BNO055] FAIL: Bad chip ID — not BNO055 or still booting");
            return false;
        }
    }

    // 3. Enter CONFIG mode
    writeReg(addr, BNO055_OPR_MODE_ADDR, BNO055_MODE_CONFIG);
    delay(30);
    uint8_t mode = readReg(addr, BNO055_OPR_MODE_ADDR);
    Serial.printf("[BNO055] CONFIG mode: 0x%02X (expect 0x00)\n", mode);
    if (mode != BNO055_MODE_CONFIG) {
        Serial.println("[BNO055] FAIL: Could not enter CONFIG mode");
        return false;
    }

    // 4. Set power mode NORMAL
    writeReg(addr, BNO055_PWR_MODE_ADDR, BNO055_POWER_NORMAL);
    delay(10);

    // 5. Page 0
    writeReg(addr, BNO055_PAGE_ID_ADDR, 0);
    delay(10);

    // 6. Clear system trigger
    writeReg(addr, BNO055_SYS_TRIGGER_ADDR, 0x00);
    delay(10);

    // 7. Enter NDOF fusion mode
    Serial.println("[BNO055] Entering NDOF mode (500 ms settle)...");
    writeReg(addr, BNO055_OPR_MODE_ADDR, BNO055_MODE_NDOF);
    delay(500);

    mode = readReg(addr, BNO055_OPR_MODE_ADDR);
    Serial.printf("[BNO055] NDOF mode: 0x%02X (expect 0x0C)\n", mode);
    if (mode != BNO055_MODE_NDOF) {
        Serial.println("[BNO055] FAIL: NDOF mode verify failed");
        return false;
    }

    Serial.println("[BNO055] ===== INIT COMPLETE =====");
    return true;
}

// ─── Read BNO055 sensor data ─────────────────────────────────────────
struct BNO055Data {
    float heading;     // degrees (0-360)
    float roll;        // degrees
    float pitch;       // degrees
    float accel_x;     // m/s²
    float accel_y;     // m/s²
    float accel_z;     // m/s²
    float gyro_z;      // °/s
    int8_t temperature;// °C
    uint8_t cal_sys;
    uint8_t cal_gyro;
    uint8_t cal_accel;
    uint8_t cal_mag;
};

BNO055Data readBNO055(uint8_t addr) {
    BNO055Data d = {};
    uint8_t buf[6];

    // Euler (heading/roll/pitch, 0.1° units)
    if (readRegs(addr, BNO055_EULER_H_LSB, buf, 6)) {
        int16_t h = (int16_t)((buf[1] << 8) | buf[0]);
        int16_t r = (int16_t)((buf[3] << 8) | buf[2]);
        int16_t p = (int16_t)((buf[5] << 8) | buf[4]);
        d.heading = h / 16.0f;
        d.roll    = r / 16.0f;
        d.pitch   = p / 16.0f;
    }

    // Accelerometer
    if (readRegs(addr, BNO055_ACCEL_DATA_X_LSB, buf, 6)) {
        d.accel_x = (int16_t)((buf[1] << 8) | buf[0]) / 100.0f;
        d.accel_y = (int16_t)((buf[3] << 8) | buf[2]) / 100.0f;
        d.accel_z = (int16_t)((buf[5] << 8) | buf[4]) / 100.0f;
    }

    // Gyro Z
    if (readRegs(addr, BNO055_GYRO_DATA_X_LSB + 4, buf, 2)) {
        d.gyro_z = (int16_t)((buf[1] << 8) | buf[0]) / 16.0f;
    }

    // Temperature
    d.temperature = (int8_t)readReg(addr, BNO055_TEMP_ADDR);

    // Calibration
    uint8_t cal = readReg(addr, BNO055_CALIB_STAT_ADDR);
    d.cal_sys   = (cal >> 6) & 0x03;
    d.cal_gyro  = (cal >> 4) & 0x03;
    d.cal_accel = (cal >> 2) & 0x03;
    d.cal_mag   = cal & 0x03;

    return d;
}

// ─── Main ─────────────────────────────────────────────────────────────
uint8_t bno_addr = 0x28;   // will be updated after scan
bool bno_ok = false;

void setup() {
    Serial.begin(115200);
    delay(500);

    Serial.println();
    Serial.println("============================================");
    Serial.println("  BNO055 Standalone Test (ESP32-S3)");
    Serial.println("============================================");
    Serial.printf("  SDA = GPIO%d\n", TEST_SDA_PIN);
    Serial.printf("  SCL = GPIO%d\n", TEST_SCL_PIN);
    Serial.printf("  Pull-ups: INPUT_PULLUP on both pins\n");
    Serial.println("============================================");

    // Wire.begin() called inside scanBus — do NOT call it before scan

    // ── Step 1: I2C scan on test bus ──
    int found = scanBus(TEST_SDA_PIN, TEST_SCL_PIN, "GPIO10/11");

    if (found == 0) {
        Serial.println("\n[WARN] No devices found on GPIO10/11");
        Serial.println("[INFO] Trying alternate ESP32 default pins GPIO21/22...");
        int alt = scanBus(21, 22, "GPIO21/22 (Arduino default)");
        if (alt > 0) {
            Serial.println("[HINT] Device found on GPIO21/22 — your wiring may be there");
        } else {
            Serial.println("[WARN] No devices on GPIO21/22 either");
        }
    }

    // Restore test bus
    Wire.begin(TEST_SDA_PIN, TEST_SCL_PIN);
    Wire.setClock(100000);
    delay(50);

    // ── Step 2: Probe BNO055 at 0x28 ──
    Serial.println("\n[STEP 2] Probe BNO055 at 0x28...");
    Wire.beginTransmission(0x28);
    if (Wire.endTransmission() == 0) {
        bno_addr = 0x28;
        Serial.println("[STEP 2] Found at 0x28");
    } else {
        // Try 0x29
        Serial.println("[STEP 2] Not at 0x28, trying 0x29...");
        Wire.beginTransmission(0x29);
        if (Wire.endTransmission() == 0) {
            bno_addr = 0x29;
            Serial.println("[STEP 2] Found at 0x29 — ADR pin is HIGH");
        } else {
            Serial.println("[STEP 2] FAIL: BNO055 not found at 0x28 or 0x29");
            Serial.println("\n[ERROR] Cannot proceed without BNO055 on bus.");
            Serial.println("Check: SDA=GPIO10, SCL=GPIO11, ADR/COM3=GND, PS0/PS1=float, VCC=3.3V, GND+GNDIO=GND");
            Serial.println("       External 2.2k-4.7k pull-ups on SDA and SCL are strongly recommended");
            return;
        }
    }

    // ── Step 3: Full init ──
    Serial.println("\n[STEP 3] Init BNO055...");
    bno_ok = initBNO055(bno_addr);

    if (!bno_ok) {
        Serial.println("\n[ERROR] BNO055 init failed");
        return;
    }

    // ── Step 4: Read sensor data ──
    Serial.println("\n[STEP 4] Reading sensor data (every 500 ms)...");
    Serial.println("  heading | roll | pitch | accelXYZ | gyroZ | temp | cal(S/G/A/M)");
    Serial.println("  --------|------|-------|----------|-------|------|--------------");
}

void loop() {
    if (!bno_ok) {
        // Wait for the user to fix wiring; do not retry endlessly.
        delay(5000);
        return;
    }

    BNO055Data d = readBNO055(bno_addr);

    if (!Wire.available() && d.heading == 0 && d.temperature == 0) {
        // No fresh data — likely an I2C glitch; report and continue.
        static uint32_t last_warn = 0;
        if (millis() - last_warn > 5000) {
            Serial.println("[LOOP] No data — check SDA/SCL pull-ups");
            last_warn = millis();
        }
    } else {
        Serial.printf("  %6.1f° | %+5.1f | %+5.1f | %+5.2f %+5.2f %+5.2f | %+6.2f | %3d | %d/%d/%d/%d\n",
            d.heading, d.roll, d.pitch,
            d.accel_x, d.accel_y, d.accel_z,
            d.gyro_z, d.temperature,
            d.cal_sys, d.cal_gyro, d.cal_accel, d.cal_mag);
    }

    delay(500);
}
