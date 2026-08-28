#pragma once

#include <stdint.h>
#include <driver/gpio.h>

/**
 * BNO055_SPI — Software SPI driver for BNO055 on ESP32-S3
 *
 * Uses bit-banged SPI on arbitrary GPIO pins.  Supports:
 *   - 8-bit register read/write
 *   - Multi-byte burst read (BNO055 auto-increments register address)
 *   - Automatic CS control per transaction
 *
 * Hardware requirements (per Bosch BNO055 datasheet):
 *   - PS1 = HIGH, PS0 = LOW → SPI mode selected
 *   - SDO/SDA → MISO (ESP32 reads from BNO055)
 *   - SDA/SDI → MOSI (ESP32 writes to BNO055)
 *   - SCL/SCK → Clock
 *   - CS → Active LOW chip select
 *
 * SPI mode: CPOL=0, CPHA=0 (Mode 0, same as BNO055 default)
 * Max clock: 1 MHz (BNO055 datasheet)
 */

// ---------- Pin setup ----------

void BNO055_SPI_init_pins(void);

/**
 * Initialize BNO055 over SPI: probe chip ID → CONFIG → NDOF mode.
 * Returns true on success (SPI detected and configured).
 */
bool BNO055_SPI_init(uint8_t bno055_addr);

// ---------- Single-byte register I/O ----------

uint8_t BNO055_SPI_read_reg8(uint8_t reg);
void    BNO055_SPI_write_reg8(uint8_t reg, uint8_t value);

// ---------- Multi-byte burst read ----------

void BNO055_SPI_read_multi(uint8_t reg, uint8_t* buf, uint8_t count);
