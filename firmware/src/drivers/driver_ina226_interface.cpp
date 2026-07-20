// Arduino Wire (I2C) interface for LibDriver INA226.
#include "driver_ina226_interface.h"
#include <Arduino.h>
#include <Wire.h>

uint8_t ina226_interface_iic_init(void)
{
    // Wire is already initialized in setupHardware(); nothing to do.
    return 0;
}

uint8_t ina226_interface_iic_deinit(void)
{
    return 0;
}

uint8_t ina226_interface_iic_read(uint8_t addr, uint8_t reg, uint8_t *buf, uint16_t len)
{
    // LibDriver passes 8-bit addresses already left-shifted.
    // Arduino Wire expects 7-bit, so shift right.
    uint8_t addr7 = (addr >> 1);

    Wire.beginTransmission(addr7);
    Wire.write(reg);
    if (Wire.endTransmission(false) != 0) return 1;  // NACK

    uint16_t got = Wire.requestFrom(addr7, (uint8_t)len);
    if (got < len) return 1;

    for (uint16_t i = 0; i < len; i++) {
        buf[i] = Wire.read();
    }
    return 0;
}

uint8_t ina226_interface_iic_write(uint8_t addr, uint8_t reg, uint8_t *buf, uint16_t len)
{
    uint8_t addr7 = (addr >> 1);

    Wire.beginTransmission(addr7);
    Wire.write(reg);
    for (uint16_t i = 0; i < len; i++) {
        Wire.write(buf[i]);
    }
    if (Wire.endTransmission() != 0) return 1;
    return 0;
}

void ina226_interface_delay_ms(uint32_t ms)
{
    delay(ms);
}

void ina226_interface_debug_print(const char *const fmt, ...)
{
    // Forward to Serial for diagnostics
    va_list args;
    va_start(args, fmt);
    char buf[256];
    vsnprintf(buf, sizeof(buf), fmt, args);
    va_end(args);
    Serial.print(buf);
}

void ina226_interface_receive_callback(uint8_t type)
{
    (void)type;
}