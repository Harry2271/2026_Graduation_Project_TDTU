// Arduino Wire (I2C) interface for LibDriver INA226.
#include "driver_ina226_interface.h"
#include "I2CBus.h"
#include "config.h"
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
    // LibDriver stores INA226 addresses in the 8-bit (left-shifted) form.
    // Preserve the complete 7-bit address after converting it for Wire.
    uint8_t addr7 = (addr >> 1) & 0x7F;

    // Guard: do NOT touch the bus unless SDA/SCL are idle.
    // Do NOT call Wire.end()/begin() from a callback — recovery
    // belongs to INA226Sensor / HealthMonitor after this returns error.
    if (len == 0 || len > 32 || buf == nullptr) return 1;

    return I2CBus::safeReadBurst(INA226_SDA_PIN, INA226_SCL_PIN,
                                 INA226_I2C_FREQ_HZ, addr7, reg,
                                 buf, (uint8_t)len) ? 0 : 1;
}

uint8_t ina226_interface_iic_write(uint8_t addr, uint8_t reg, uint8_t *buf, uint16_t len)
{
    uint8_t addr7 = (addr >> 1) & 0x7F;

    if (len == 0 || len > 30 || buf == nullptr) return 1;

    return I2CBus::safeWriteBurst(INA226_SDA_PIN, INA226_SCL_PIN,
                                  INA226_I2C_FREQ_HZ, addr7, reg,
                                  buf, (uint8_t)len) ? 0 : 1;
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