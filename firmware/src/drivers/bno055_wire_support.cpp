// Arduino Wire (I2C) adapter for the Bosch bno055 driver.
// The Bosch library was originally written for bare-metal MCUs; this file
// wires the four function pointers (bus_read, bus_write, delay_msec) to
// the ESP32 Arduino Wire library. The dev_addr is already stored in the
// global bno055 struct by bno055_set_addr_pin(), so we just pass it
// straight through to Wire.beginTransmission().
#include "bno055.h"
#include <Arduino.h>
#include <Wire.h>

extern "C" {

// 7-bit address expected by Arduino Wire (already the form the Bosch lib uses).
#define BNO055_I2C_BUS_WRITE_ARRAY_INDEX ((u8)1)

s8 BNO055_I2C_bus_read(u8 dev_addr, u8 reg_addr, u8 *reg_data, u8 cnt)
{
    if (cnt == 0 || reg_data == NULL) return BNO055_ERROR;

    Wire.beginTransmission(dev_addr);
    Wire.write(reg_addr);
    if (Wire.endTransmission(false) != 0) return BNO055_ERROR;  // repeated start

    uint8_t got = Wire.requestFrom(dev_addr, (uint8_t)cnt);
    if (got < cnt) return BNO055_ERROR;

    for (uint8_t i = 0; i < cnt; i++) {
        if (!Wire.available()) return BNO055_ERROR;
        reg_data[i] = Wire.read();
    }
    return BNO055_SUCCESS;
}

s8 BNO055_I2C_bus_write(u8 dev_addr, u8 reg_addr, u8 *reg_data, u8 cnt)
{
    if (cnt == 0 || reg_data == NULL) return BNO055_ERROR;

    Wire.beginTransmission(dev_addr);
    Wire.write(reg_addr);
    for (uint8_t i = 0; i < cnt; i++) {
        Wire.write(reg_data[i]);
    }
    if (Wire.endTransmission() != 0) return BNO055_ERROR;
    return BNO055_SUCCESS;
}

void BNO055_delay_msek(u32 msek)
{
    delay(msek);
}

}  // extern "C"