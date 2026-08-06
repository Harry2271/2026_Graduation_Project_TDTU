#include "BNO055_SPI.h"
#include "config.h"
#include <Arduino.h>

// =====================================================================
// BNO055_SPI — Software SPI for BNO055 on ESP32-S3
//
// Software SPI (bit-banged) is used because the ESP32-S3's hardware
// SPI peripherals are fully allocated by motor drivers:
//   SPI3 (VSPI) GPIO 11/13/12/14 → BNO055 I2C pins / Motor FL PWM
//   SPI2 (HSPI) GPIO 38/39 → Motor RR PWM
//
// All functions use direct GPIO writes via the Arduino framework.
// Maximum BNO055 SPI clock = 1 MHz; with ~100ns per GPIO toggle on
// ESP32-S3, we get ~100 kHz effective clock (well within spec).
//
// SPI mode: CPOL=0, CPHA=0 (data valid on rising edge)
//   1. CS LOW (chip select active)
//   2. Send register address with bit 7 = READ bit
//   3. Clock data in/out (MSB first)
//   4. CS HIGH (transaction complete)
//
// BNO055 SPI register protocol:
//   Write: send (reg & 0x7F), then data byte(s)
//   Read:  send (reg | 0x80), then clock in data byte(s)
//   BNO055 auto-increments register address for burst reads
// =====================================================================

#define SPI_SCK_HIGH()  digitalWrite(BNO055_SPI_SCK_PIN, HIGH)
#define SPI_SCK_LOW()   digitalWrite(BNO055_SPI_SCK_PIN, LOW)
#define SPI_MOSI_HIGH() digitalWrite(BNO055_SPI_MOSI_PIN, HIGH)
#define SPI_MOSI_LOW()  digitalWrite(BNO055_SPI_MOSI_PIN, LOW)
#define SPI_CS_HIGH()   digitalWrite(BNO055_SPI_CS_PIN, HIGH)
#define SPI_CS_LOW()    digitalWrite(BNO055_SPI_CS_PIN, LOW)
#define SPI_MISO_READ() digitalRead(BNO055_SPI_MISO_PIN)

// ---------- Pin initialization ----------

void BNO055_SPI_init_pins(void)
{
    pinMode(BNO055_SPI_SCK_PIN,  OUTPUT);
    pinMode(BNO055_SPI_MOSI_PIN, OUTPUT);
    pinMode(BNO055_SPI_MISO_PIN, INPUT);    // MISO = input only
    pinMode(BNO055_SPI_CS_PIN,   OUTPUT);

    // Idle state: SCK low, CS high (deselected)
    SPI_SCK_LOW();
    SPI_CS_HIGH();

    Serial.printf("  [SPI] SCK=%d MISO=%d MOSI=%d CS=%d @ %d kHz\n",
        BNO055_SPI_SCK_PIN, BNO055_SPI_MISO_PIN,
        BNO055_SPI_MOSI_PIN, BNO055_SPI_CS_PIN,
        BNO055_SPI_SPEED_HZ / 1000);
}

// ---------- Transfer 1 byte (SPI Mode 0) ----------
// CPOL=0 → clock idles LOW
// CPHA=0 → data sampled on rising edge, shifted out on falling edge

static uint8_t spi_transfer8(uint8_t data)
{
    uint8_t received = 0;

    for (int8_t bit = 7; bit >= 0; bit--) {
        // Set MOSI before falling edge
        if (data & (1 << bit)) {
            SPI_MOSI_HIGH();
        } else {
            SPI_MOSI_LOW();
        }

        SPI_SCK_HIGH();  // Rising edge — slave latches MOSI

        // Read MISO after rising edge
        if (SPI_MISO_READ()) {
            received |= (1 << bit);
        }

        SPI_SCK_LOW();   // Falling edge — next bit ready
    }

    return received;
}

// ---------- Single-byte register read ----------

uint8_t BNO055_SPI_read_reg8(uint8_t reg)
{
    SPI_CS_LOW();                         // Begin transaction
    spi_transfer8(reg | 0x80);            // Send register address + READ bit
    uint8_t value = spi_transfer8(0x00);  // Clock in 1 data byte (dummy)
    SPI_CS_HIGH();                        // End transaction
    return value;
}

// ---------- Single-byte register write ----------

void BNO055_SPI_write_reg8(uint8_t reg, uint8_t value)
{
    SPI_CS_LOW();
    spi_transfer8(reg & 0x7F);  // Send register address (WRITE bit = 0)
    spi_transfer8(value);       // Send data byte
    SPI_CS_HIGH();
}

// ---------- Multi-byte burst read ----------
// BNO055 auto-increments the register address after each byte read

void BNO055_SPI_read_multi(uint8_t reg, uint8_t* buf, uint8_t count)
{
    SPI_CS_LOW();
    spi_transfer8(reg | 0x80);  // First register address + READ bit

    for (uint8_t i = 0; i < count; i++) {
        buf[i] = spi_transfer8(0x00);
        // For multi-byte reads, BNO055 auto-increments the internal
        // register pointer, so we just clock in the next byte(s).
    }

    SPI_CS_HIGH();
}

// ---------- Full BNO055 SPI initialization ----------
// Probe chip ID → CONFIG mode → NDOF mode

#define BNO055_CHIP_ID_ADDR     0x00
#define BNO055_PAGE_ID_ADDR     0x07
#define BNO055_OPR_MODE_ADDR    0x3D
#define BNO055_PWR_MODE_ADDR    0x3E
#define BNO055_SYS_TRIGGER      0x3F
#define BNO055_CHIP_ID_VALUE    0xA0
#define BNO055_MODE_CONFIG      0x00
#define BNO055_MODE_NDOF        0x0C
#define BNO055_POWER_NORMAL     0x00

bool BNO055_SPI_init(uint8_t bno055_addr)
{
    (void)bno055_addr;  // SPI mode is single-slave — no address parameter

    BNO055_SPI_init_pins();

    // Release CS (deselect chip)
    digitalWrite(BNO055_SPI_CS_PIN, HIGH);
    delay(50);

    // Try reading chip ID via SPI
    uint8_t chipId = BNO055_SPI_read_reg8(BNO055_CHIP_ID_ADDR);
    Serial.printf("[BNO055] SPI probe: chip ID = 0x%02X (expected 0xA0)\n", chipId);

    if (chipId != BNO055_CHIP_ID_VALUE) {
        delay(1000);
        chipId = BNO055_SPI_read_reg8(BNO055_CHIP_ID_ADDR);
        Serial.printf("[BNO055] SPI probe retry: chip ID = 0x%02X\n", chipId);
    }

    if (chipId != BNO055_CHIP_ID_VALUE) {
        return false;
    }
    Serial.println("[BNO055] SPI mode OK — chip detected");

    // Enter CONFIG mode (required before changing power/mode registers)
    BNO055_SPI_write_reg8(BNO055_OPR_MODE_ADDR, BNO055_MODE_CONFIG);
    delay(30);
    uint8_t mode = BNO055_SPI_read_reg8(BNO055_OPR_MODE_ADDR);
    if (mode != BNO055_MODE_CONFIG) {
        Serial.printf("[BNO055] SPI CONFIG mode verify failed (mode=0x%02X)\n", mode);
        return false;
    }
    Serial.println("[BNO055] CONFIG mode OK via SPI");

    BNO055_SPI_write_reg8(BNO055_PWR_MODE_ADDR, BNO055_POWER_NORMAL);
    delay(10);
    BNO055_SPI_write_reg8(BNO055_PAGE_ID_ADDR, 0);
    delay(10);
    BNO055_SPI_write_reg8(BNO055_SYS_TRIGGER, 0x00);
    delay(10);

    BNO055_SPI_write_reg8(BNO055_OPR_MODE_ADDR, BNO055_MODE_NDOF);
    delay(500);  // fusion needs time to stabilize

    mode = BNO055_SPI_read_reg8(BNO055_OPR_MODE_ADDR);
    if (mode != BNO055_MODE_NDOF) {
        Serial.printf("[BNO055] NDOF verify failed via SPI (mode=0x%02X)\n", mode);
        return false;
    }

    Serial.println("[BNO055] NDOF mode OK via SPI — fusion active");
    return true;
}
