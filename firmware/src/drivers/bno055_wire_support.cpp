// Arduino Wire (I2C) adapter for the Bosch bno055 driver.
// The Bosch library was originally written for bare-metal MCUs; this file
// wires the four function pointers (bus_read, bus_write, delay_msec) to
// the ESP32 Arduino Wire library. The dev_addr is already stored in the
// global bno055 struct by bno055_set_addr_pin(), so we just pass it
// straight through to Wire.beginTransmission().
#include "bno055.h"
#include "I2CBus.h"
#include "config.h"
#include <Arduino.h>

extern "C" {

// 7-bit address expected by Arduino Wire (already the form the Bosch lib uses).
#define BNO055_I2C_BUS_WRITE_ARRAY_INDEX ((u8)1)

s8 BNO055_I2C_bus_read(u8 dev_addr, u8 reg_addr, u8 *reg_data, u8 cnt)
{
    if (cnt == 0 || reg_data == NULL) return BNO055_ERROR;

    return I2CBus::safeReadBurst(BNO055_SDA_PIN, BNO055_SCL_PIN,
                                  BNO055_I2C_FREQ_HZ, dev_addr, reg_addr,
                                  reg_data, cnt)
        ? BNO055_SUCCESS : BNO055_ERROR;
}

s8 BNO055_I2C_bus_write(u8 dev_addr, u8 reg_addr, u8 *reg_data, u8 cnt)
{
    if (cnt == 0 || reg_data == NULL) return BNO055_ERROR;

    return I2CBus::safeWriteBurst(BNO055_SDA_PIN, BNO055_SCL_PIN,
                                   BNO055_I2C_FREQ_HZ, dev_addr, reg_addr,
                                   reg_data, cnt)
        ? BNO055_SUCCESS : BNO055_ERROR;
}

void BNO055_delay_msek(u32 msek)
{
    delay(msek);
}

}  // extern "C"