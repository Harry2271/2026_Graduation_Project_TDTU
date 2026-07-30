# ESP32-S3 IMU Client

A real-time IMU data acquisition and transmission system for ESP32-S3 with BNO-055 sensor, LCD display, and WiFi connectivity.

## Overview

This project implements a high-performance IMU data streaming solution that captures 9-axis motion data at 100Hz and transmits it over WiFi via UDP. The system features a touchscreen interface for control and real-time monitoring of sensor data, battery voltage, and network status.

## Features

- **100Hz IMU Data Acquisition**: Real-time sampling of accelerometer, gyroscope, and quaternion data from BNO-055 sensor
- **WiFi UDP Transmission**: Wireless streaming of IMU data to remote server (compatible with x-IMU Python server format)
- **LCD Touchscreen Interface**: 240x320 color display with LVGL-based GUI
- **Touch Control**: Start/stop IMU transmission with on-screen button
- **Battery Monitoring**: Real-time voltage and ADC value display
- **System Monitoring**: Uptime tracker and IMU sampling rate display
- **Dual I2C Bus Architecture**: Separate I2C channels for touch controller and IMU sensor

## Hardware Requirements

### Main Components
- **Microcontroller**: ESP32-S3
- **IMU Sensor**: BNO-055 (9-axis absolute orientation sensor)
- **Display**: ST7789 240x320 LCD (SPI interface)
- **Touch Controller**: CST816S (I2C interface)

### Pin Configuration

#### BNO-055 IMU Sensor (I2C Channel 1)
- **SDA**: GPIO 13
- **SCL**: GPIO 15
- **I2C Address**: 0x29

#### ST7789 LCD Display (SPI)
- **SCLK**: GPIO 39
- **MOSI**: GPIO 38
- **MISO**: GPIO 40
- **DC**: GPIO 42
- **CS**: GPIO 45
- **Backlight**: GPIO 1

#### CST816S Touch Controller (I2C Channel 0)
- Uses BSP (Board Support Package) default I2C configuration
- **Note**: BSP I2C setting in menuconfig must be set to channel 0

#### Battery Monitoring
- **ADC Channel**: ADC1 Channel 4

## Software Architecture

### Task Structure
- **IMU Task** (Core 0, Priority 6): Samples BNO-055 at 100Hz, queues data for transmission
- **UDP Send Task** (Core 1, Priority 5): Processes queued IMU data and transmits via UDP
- **LVGL Task**: Handles GUI updates and touch input processing

### Data Flow
1. IMU data sampled at 100Hz by dedicated task
2. Data queued in 10-element FreeRTOS queue
3. UDP task dequeues and transmits data when IMU transmission is enabled
4. GUI updated via LVGL timers (battery: 60s, FPS/uptime: 1s)

### I2C Bus Configuration
The project uses two separate I2C buses to avoid conflicts:
- **I2C 0**: Touch controller (CST816S) via BSP
- **I2C 1**: BNO-055 IMU sensor (GPIO 13/15)

**Important**: The BSP I2C configuration in menuconfig must be set to I2C number 0.

## Building and Flashing

### Prerequisites
- **ESP-IDF**: v5.4
- **Target**: ESP32-S3
- USB cable for programming

### Component Versions
This project uses the following component versions (managed via IDF Component Manager):
- `espressif/esp_bsp_generic`: ^3.0.0
- `espressif/esp_lcd_touch_cst816s`: ^1.0.6
- `lvgl/lvgl`: ^9.2.2
- `espressif/esp_lvgl_port`: ^2.5.0

### Configuration

1. **WiFi Settings**: Edit `main/main.c` and update:
   ```c
   #define WIFI_SSID      "your_wifi_ssid"
   #define WIFI_PASS      "your_wifi_password"
   #define UDP_SERVER_IP  "192.168.x.x"  // Your PC's IP address
   #define UDP_PORT       5000
   ```

2. **BSP I2C Configuration**:
   ```bash
   idf.py menuconfig
   # Navigate to: Component config → Board Support Package → I2C
   # Set I2C peripheral index to 0
   ```

## Usage

1. **Power On**: The device will automatically connect to configured WiFi
2. **Check Status**: LCD displays WiFi IP, battery voltage, IMU FPS, and uptime
3. **Start Transmission**: Tap "Start IMU" button to begin streaming data
4. **Monitor**: IMU FPS counter shows actual sampling rate (should be ~100Hz)
5. **Stop Transmission**: Tap "Stop IMU" button to halt data streaming

### UDP Data Format

Data is transmitted as ASCII strings compatible with x-IMU Python server:
```
Accel[ax,ay,az] Gyro[gx,gy,gz] Quat[qw,qx,qy,qz]
```

- **Acceleration**: In g-units (m/s² / 9.81)
- **Gyroscope**: In degrees/second
- **Quaternion**: Normalized quaternion (w,x,y,z)

## GUI Display

The LCD interface shows:
- **WiFi IP**: Current IP address (or "Connecting...")
- **ADC Value**: Raw ADC reading for battery
- **Battery Voltage**: Calculated voltage (V)
- **IMU FPS**: Actual sampling rate in Hz
- **Uptime**: System runtime (HH:MM:SS)
- **Control Button**: Start/Stop IMU transmission

## Troubleshooting

### IMU Not Detected
- Check I2C wiring (GPIO 13/15)
- Verify BNO-055 I2C address (0x29 or 0x28)
- Ensure BSP I2C is set to channel 0 in menuconfig

### WiFi Connection Failed
- Verify SSID and password in code
- Check WiFi signal strength
- Ensure 2.4GHz network (ESP32 doesn't support 5GHz)

### Low IMU FPS
- Check serial monitor for I2C errors
- Verify queue isn't overflowing (queue depth shown in logs)
- Ensure UDP send task isn't blocking

### Touch Not Working
- Verify BSP I2C configuration (must be channel 0)
- Check touch controller I2C address in BSP configuration
- Test with BSP example code

## Dependencies

This project uses the following ESP-IDF components:
- `esp_wifi`: WiFi connectivity
- `esp_lvgl_port`: LVGL graphics library integration
- `esp_lcd_touch_cst816s`: Touch controller driver
- `driver/i2c_master`: I2C driver (NG version)
- `freertos`: RTOS kernel

Managed components (via IDF Component Manager):
- `espressif/esp_lvgl_port`
- `espressif/esp_lcd_touch`
- `espressif/esp_lcd_touch_cst816s`
- `lvgl/lvgl`
- `espressif/esp_bsp_generic`

## License

This project is provided as-is for educational and development purposes.

## Author

Created: November 2025

## Version History

- **v1.0**: Initial release with 100Hz IMU sampling and UDP transmission
