

/*
****************************************************************************
* Copyright (C) 2015 - 2016 Bosch Sensortec GmbH
*
* bno055_support.c
* Date: 2016/03/14
* Revision: 1.0.4 $
*
* Usage: Sensor Driver support file for BNO055 sensor
*
****************************************************************************
* License:
*
* Redistribution and use in source and binary forms, with or without
* modification, are permitted provided that the following conditions are met:
*
*   Redistributions of source code must retain the above copyright
*   notice, this list of conditions and the following disclaimer.
*
*   Redistributions in binary form must reproduce the above copyright
*   notice, this list of conditions and the following disclaimer in the
*   documentation and/or other materials provided with the distribution.
*
*   Neither the name of the copyright holder nor the names of the
*   contributors may be used to endorse or promote products derived from
*   this software without specific prior written permission.
*
* THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND
* CONTRIBUTORS "AS IS" AND ANY EXPRESS OR
* IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
* WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
* DISCLAIMED. IN NO EVENT SHALL COPYRIGHT HOLDER
* OR CONTRIBUTORS BE LIABLE FOR ANY
* DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY,
* OR CONSEQUENTIAL DAMAGES(INCLUDING, BUT NOT LIMITED TO,
* PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
* LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
* HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
* WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
* (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN
* ANY WAY OUT OF THE USE OF THIS
* SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE
*
* The information provided is believed to be accurate and reliable.
* The copyright holder assumes no responsibility
* for the consequences of use
* of such information nor for any infringement of patents or
* other rights of third parties which may result from its use.
* No license is granted by implication or otherwise under any patent or
* patent rights of the copyright holder.
**************************************************************************/
/*---------------------------------------------------------------------------*
 Includes
*---------------------------------------------------------------------------*/
#ifdef __cplusplus
extern "C" {
#endif

#include "bno055.h"

#ifdef __cplusplus
} // extern "C"
#endif

#define BNO055_API

/*----------------------------------------------------------------------------*
 *  The following APIs are used for reading and writing of
 *  sensor data using I2C communication
*----------------------------------------------------------------------------*/



#ifdef  BNO055_API
#define BNO055_I2C_BUS_WRITE_ARRAY_INDEX  ((u8)1)
/*  \Brief: The API is used as I2C bus read
 *  \Return : Status of the I2C read
 *  \param dev_addr : The device address of the sensor
 *  \param reg_addr : Address of the first register,
 *   will data is going to be read
 *  \param reg_data : This data read from the sensor,
 *   which is hold in an array
 *  \param cnt : The no of byte of data to be read
 */
s8 BNO055_I2C_bus_read(u8 dev_addr, u8 reg_addr, u8 *reg_data, u8 cnt);
/*  \Brief: The API is used as SPI bus write
 *  \Return : Status of the SPI write
 *  \param dev_addr : The device address of the sensor
 *  \param reg_addr : Address of the first register,
 *   will data is going to be written
 *  \param reg_data : It is a value hold in the array,
 *  will be used for write the value into the register
 *  \param cnt : The no of byte of data to be write
 */
s8 BNO055_I2C_bus_write(u8 dev_addr, u8 reg_addr, u8 *reg_data, u8 cnt);
/*
 * \Brief: I2C init routine
*/
s8 I2C_routine(void);
#endif
/********************End of I2C APIs declarations***********************/
/*  Brief : The delay routine
 *  \param : delay in ms
*/
void BNO055_delay_msek(u32 msek);
/* This API is an example for reading sensor data
 *  \param: None
 *  \return: communication result
 */
s32 bno055_data_readout_template_loop(void);
s32 bno055_data_readout_template_setup(void);
s32 bno055_data_readout_template_setdown(void);

/*----------------------------------------------------------------------------*
 *  struct bno055_t parameters can be accessed by using BNO055
 *  BNO055_t having the following parameters
 *  Bus write function pointer: BNO055_WR_FUNC_PTR
 *  Bus read function pointer: BNO055_RD_FUNC_PTR
 *  Burst read function pointer: BNO055_BRD_FUNC_PTR
 *  Delay function pointer: delay_msec
 *  I2C address: dev_addr
 *  Chip id of the sensor: chip_id
*---------------------------------------------------------------------------*/
struct bno055_t bno055;


s32 bno055_data_readout_template_setup(void)
{
  /* Variable used to return value of
  communication routine*/
  s32 comres = BNO055_ERROR;
  /* variable used to set the power mode of the sensor*/
  u8 power_mode = BNO055_INIT_VALUE;
  /*********read raw accel data***********/

/*---------------------------------------------------------------------------*
 *********************** START INITIALIZATION ************************
 *--------------------------------------------------------------------------*/


 
 #ifdef BNO055_API
/*  Based on the user need configure I2C interface.
 *  It is example code to explain how to use the bno055 API*/
  I2C_routine();

 #endif

  comres = bno055_init(&bno055);

  comres += bno055_set_operation_mode(BNO055_OPERATION_MODE_CONFIG);

  power_mode = BNO055_POWER_MODE_NORMAL;
  comres += bno055_set_power_mode(power_mode);

  u8 clk_src_u8=1;
  bno055_set_clk_src(clk_src_u8);

 comres += bno055_set_operation_mode(BNO055_OPERATION_MODE_NDOF);

 return comres;
}

/************************* START READ RAW SENSOR DATA****************/

/*  Using BNO055 sensor we can read the following sensor data and
  virtual sensor data
  Sensor data:
    Accel
    Mag
    Gyro
  Virtual sensor data
    Euler
    Quaternion
    Linear acceleration
    Gravity sensor */
/*  For reading sensor raw data it is required to set the
  operation modes of the sensor
  operation mode can set from the register
  page - page0
  register - 0x3D
  bit - 0 to 3
  for sensor data read following operation mode have to set
   * SENSOR MODE
    *0x01 - BNO055_OPERATION_MODE_ACCONLY
    *0x02 - BNO055_OPERATION_MODE_MAGONLY
    *0x03 - BNO055_OPERATION_MODE_GYRONLY
    *0x04 - BNO055_OPERATION_MODE_ACCMAG
    *0x05 - BNO055_OPERATION_MODE_ACCGYRO
    *0x06 - BNO055_OPERATION_MODE_MAGGYRO
    *0x07 - BNO055_OPERATION_MODE_AMG
    based on the user need configure the operation mode*/



s32 bno055_data_readout_template_loop(void)
{    
  s32 comres = BNO055_ERROR;
  
  struct bno055_mag_offset_t  mag_offset;
  struct bno055_mag_t mag_xyz;
  struct bno055_euler_t euler;

  comres += bno055_read_mag_xyz(&mag_xyz);
  comres +=bno055_read_euler_hrp(&euler);
  comres +=bno055_read_mag_offset(&mag_offset);

  u8 mag_calib_u8;
  u8 accel_calib_u8;
  u8 gyro_calib_u8;
  u8 sys_calib_u8;
  
  comres+=bno055_get_mag_calib_stat(&mag_calib_u8);
  comres+=bno055_get_accel_calib_stat(&accel_calib_u8);
  comres+=bno055_get_gyro_calib_stat(&gyro_calib_u8);
  comres+=bno055_get_sys_calib_stat(&sys_calib_u8);

  Serial.print(euler.h);
  Serial.print(",");
  Serial.print(euler.r);
  Serial.print(",");
  Serial.print(euler.p);
  Serial.print(",");
  Serial.print(sys_calib_u8);
  Serial.print(",");
  Serial.print(gyro_calib_u8);
  Serial.print(",");
  Serial.print(accel_calib_u8);
  Serial.print(",");
  Serial.print(mag_calib_u8);
  Serial.print(",");
  Serial.print(mag_xyz.x);  
  Serial.print(",");
  Serial.print(mag_xyz.y);  
  Serial.print(",");
  Serial.print(mag_xyz.z);  
  Serial.print(",");
  Serial.print(mag_offset.x);  
  Serial.print(",");
  Serial.print(mag_offset.y);  
  Serial.print(",");
  Serial.print(mag_offset.z);
  Serial.print(",");
  Serial.print(mag_offset.r);


  Serial.println();
  
 return comres;
}
  
/*-----------------------------------------------------------------------*
************************* START DE-INITIALIZATION ***********************
*-------------------------------------------------------------------------*/
/*  For de - initializing the BNO sensor it is required
  to the operation mode of the sensor as SUSPEND
  Suspend mode can set from the register
  Page - page0
  register - 0x3E
  bit positions - 0 and 1*/

s32 bno055_data_readout_template_setdown(void)  
{
  s32 comres = BNO055_ERROR;
  u8 power_mode = BNO055_INIT_VALUE;
    
  power_mode = BNO055_POWER_MODE_SUSPEND;
  /* set the power mode as SUSPEND*/
  comres += bno055_set_power_mode(power_mode);

/*---------------------------------------------------------------------*
************************* END DE-INITIALIZATION **********************
*---------------------------------------------------------------------*/
return comres;
}


s32 bno055_suspend(void)
{
  s32 comres = BNO055_ERROR;
  u8 power_mode = BNO055_INIT_VALUE;

  comres += bno055_set_operation_mode(BNO055_OPERATION_MODE_CONFIG);
    
  power_mode = BNO055_POWER_MODE_SUSPEND;
  /* set the power mode as SUSPEND*/
  comres += bno055_set_power_mode(power_mode);

 comres += bno055_set_operation_mode(BNO055_OPERATION_MODE_NDOF);

  return comres;
}


s32 bno055_normal(void)
{
  s32 comres = BNO055_ERROR;
  u8 power_mode = BNO055_INIT_VALUE;

  comres += bno055_set_operation_mode(BNO055_OPERATION_MODE_CONFIG);

  power_mode = BNO055_POWER_MODE_NORMAL;
  comres += bno055_set_power_mode(power_mode);

 comres += bno055_set_operation_mode(BNO055_OPERATION_MODE_NDOF);

 return comres; 
}




#include <Wire.h>




#ifdef  BNO055_API
/*--------------------------------------------------------------------------*
* The following API is used to map the I2C bus read, write, delay and
* device address with global structure bno055_t
*-------------------------------------------------------------------------*/
/*-------------------------------------------------------------------------*
 *  By using bno055 the following structure parameter can be accessed
 *  Bus write function pointer: BNO055_WR_FUNC_PTR
 *  Bus read function pointer: BNO055_RD_FUNC_PTR
 *  Delay function pointer: delay_msec
 *  I2C address: dev_addr
 *--------------------------------------------------------------------------*/
s8 I2C_routine(void)
{
  bno055.bus_write = BNO055_I2C_bus_write;
  bno055.bus_read = BNO055_I2C_bus_read;
  bno055.delay_msec = BNO055_delay_msek;
  bno055.dev_addr = BNO055_I2C_ADDR1;
  Wire.begin();

  return BNO055_INIT_VALUE;
}

/************** I2C buffer length******/

#define I2C_BUFFER_LEN 8
#define I2C0 5
/*-------------------------------------------------------------------*
*
* This is a sample code for read and write the data by using I2C
* Use either I2C  based on your need
* The device address defined in the bno055.h file
*
*--------------------------------------------------------------------*/

/*  \Brief: The API is used as I2C bus write
 *  \Return : Status of the I2C write
 *  \param dev_addr : The device address of the sensor
 *  \param reg_addr : Address of the first register,
 *   will data is going to be written
 *  \param reg_data : It is a value hold in the array,
 *    will be used for write the value into the register
 *  \param cnt : The no of byte of data to be write
 */
s8 BNO055_I2C_bus_write(u8 dev_addr, u8 reg_addr, u8 *reg_data, u8 cnt)
{
  s32 BNO055_iERROR = BNO055_INIT_VALUE;
  u8 array[I2C_BUFFER_LEN];
  u8 stringpos = BNO055_INIT_VALUE;

//  pr("bus write cnt %d reg %d",cnt,reg_addr);

  array[BNO055_INIT_VALUE] = reg_addr;
  for (stringpos = BNO055_INIT_VALUE; stringpos < cnt; stringpos++)
    array[stringpos + BNO055_I2C_BUS_WRITE_ARRAY_INDEX] =
      *(reg_data + stringpos);

  /*
  * Please take the below APIs as your reference for
  * write the data using I2C communication
  * "BNO055_iERROR = I2C_WRITE_STRING(DEV_ADDR, ARRAY, CNT+1)"
  * add your I2C write APIs here
  * BNO055_iERROR is an return value of I2C read API
  * Please select your valid return value
  * In the driver BNO055_SUCCESS defined as 0
    * and FAILURE defined as -1
  * Note :
  * This is a full duplex operation,
  * The first read data is discarded, for that extra write operation
  * have to be initiated. For that cnt+1 operation done
  * in the I2C write string function
  * For more information please refer data sheet SPI communication:
  */

  Wire.beginTransmission(dev_addr);
  Wire.write(array,cnt+1);
  Wire.endTransmission();

  return (s8)BNO055_iERROR;
}

 /* \Brief: The API is used as I2C bus read
 *  \Return : Status of the I2C read
 *  \param dev_addr : The device address of the sensor
 *  \param reg_addr : Address of the first register,
 *  will data is going to be read
 *  \param reg_data : This data read from the sensor,
 *   which is hold in an array
 *  \param cnt : The no of byte of data to be read
 */
s8 BNO055_I2C_bus_read(u8 dev_addr, u8 reg_addr, u8 *reg_data, u8 cnt)
{
  s32 BNO055_iERROR = BNO055_INIT_VALUE;
  u8 array[I2C_BUFFER_LEN] = {BNO055_INIT_VALUE};
  u8 stringpos = BNO055_INIT_VALUE;

//  pr("bus read cnt %d reg %d",cnt,reg_addr);

  array[BNO055_INIT_VALUE] = reg_addr;

  Wire.beginTransmission(dev_addr);
  #if ARDUINO >= 100
    Wire.write((uint8_t)reg_addr);
  #else
    Wire.send(reg_addr);
  #endif
  Wire.endTransmission();
  Wire.requestFrom(dev_addr, (byte)cnt);

  for (uint8_t i = 0; i < cnt; i++)
  {
   if(Wire.available())
   { 
    array[i] = Wire.read();
   }
   else
   {
    i--;
   }
  }

  for (stringpos = BNO055_INIT_VALUE; stringpos < cnt; stringpos++)
    *(reg_data + stringpos) = array[stringpos];

  return (s8)BNO055_iERROR;
}


/*  Brief : The delay routine
 *  \param : delay in ms
*/
void BNO055_delay_msek(u32 msek)
{
 delay(msek);
}

#endif






/*********************************************************************************/



  
void setup() 
{
 Serial.begin(115200);        // connect to the serial port 
 
 bno055_data_readout_template_setup();
}



void loop() 
{
 bno055_data_readout_template_loop();
 delay(100);
}
  


