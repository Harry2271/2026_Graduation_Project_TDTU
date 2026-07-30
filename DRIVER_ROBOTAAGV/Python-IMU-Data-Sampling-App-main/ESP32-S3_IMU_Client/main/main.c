/*
 * ESP32 IMU Client Project
 * 
 * Description:
 * This project implements a WiFi-enabled IMU data acquisition and transmission system
 * using an ESP32-S3 microcontroller with a BNO-055 9-axis IMU sensor and LCD display.
 * 
 * Key Features:
 * - Real-time IMU data sampling at 100Hz (accelerometer, gyroscope, quaternion)
 * - UDP transmission of IMU data over WiFi to a remote server
 * - LCD touchscreen interface (ST7789 240x320) with LVGL GUI
 * - Battery voltage monitoring via ADC
 * - Touch control (CST816S) for starting/stopping IMU transmission
 * 
 * Hardware Configuration:
 * - IMU Sensor: BNO-055 on I2C channel 1
 *   - SDA: GPIO 13
 *   - SCL: GPIO 15
 *   - I2C Address: 0x29
 * 
 * - Display: ST7789 LCD via SPI
 *   - SCLK: GPIO 39
 *   - MOSI: GPIO 38
 *   - MISO: GPIO 40
 *   - DC: GPIO 42
 *   - CS: GPIO 45
 *   - Backlight: GPIO 1
 * 
 * - Touch Controller: CST816S on I2C channel 0 (BSP default)
 * 
 * Important Notes:
 * - The I2C setting in menuconfig for the BSP has been changed to I2C number 0
 * - The BNO-055 IMU is configured on I2C channel 1 using GPIO pins 13 (SDA) and 15 (SCL)
 * - This allows the touch controller and IMU to operate on separate I2C buses
 * 
 * WiFi Configuration:
 * - Update WIFI_SSID, WIFI_PASS, and UDP_SERVER_IP before use
 * - UDP port: 5000 (compatible with x-IMU Python server)
 */

#include <stdio.h>
#include <string.h>
#include "esp_check.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "nvs_flash.h"
#include "lwip/err.h"
#include "lwip/sys.h"
#include "lwip/sockets.h"
#include "lwip/netdb.h"

#include "esp_lcd_panel_interface.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_vendor.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_panel_commands.h"
#include "esp_lcd_touch_cst816s.h"
#include "esp_lvgl_port.h"

#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "driver/gpio.h"
#include "driver/ledc.h"
#include "driver/i2s_std.h"
#include "driver/i2c_master.h"
#include "bsp/esp-bsp.h"
#include "lvgl.h"

#include "esp_adc/adc_oneshot.h"
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define BATTERY_ADC_SIZE 15

#define EXAMPLE_BATTERY_ADC_CHANNEL ADC_CHANNEL_4
#define EXAMPLE_ADC_ATTEN ADC_ATTEN_DB_12

// WiFi Configuration
#define WIFI_SSID      ""     // CHANGE THIS
#define WIFI_PASS      ""   // CHANGE THIS
#define UDP_SERVER_IP  "192.168.0.1" // CHANGE THIS to your PC's IP
#define UDP_PORT       5000

// WiFi event bits
#define WIFI_CONNECTED_BIT BIT0
#define WIFI_FAIL_BIT      BIT1
#define WIFI_MAXIMUM_RETRY 10

#define EXAMPLE_PIN_NUM_SCLK 39
#define EXAMPLE_PIN_NUM_MOSI 38
#define EXAMPLE_PIN_NUM_MISO 40

#define EXAMPLE_SPI_HOST SPI2_HOST

// BNO055 IMU I2C configuration (separate bus)
#define BNO055_I2C_NUM 1 // I2C number for BNO055  
#define BNO055_PIN_NUM_SDA 13
#define BNO055_PIN_NUM_SCL 15

// BNO055 I2C Address (default is 0x28, can be 0x29 if ADR pin is high)
#define BNO055_I2C_ADDR 0x29

// BNO055 Register definitions
#define BNO055_CHIP_ID_ADDR 0x00
#define BNO055_PAGE_ID_ADDR 0x07
#define BNO055_OPR_MODE_ADDR 0x3D
#define BNO055_PWR_MODE_ADDR 0x3E
#define BNO055_SYS_TRIGGER_ADDR 0x3F

// Data registers
#define BNO055_EULER_H_LSB_ADDR 0x1A
#define BNO055_GYRO_DATA_X_LSB_ADDR 0x14
#define BNO055_ACCEL_DATA_X_LSB_ADDR 0x08
#define BNO055_QUATERNION_DATA_W_LSB_ADDR 0x20

// Operating modes
#define BNO055_OPERATION_MODE_CONFIG 0x00
#define BNO055_OPERATION_MODE_NDOF 0x0C

// Power modes
#define BNO055_POWER_MODE_NORMAL 0x00

// IMU data structure
typedef struct {
    float euler_heading;
    float euler_roll;
    float euler_pitch;
    float gyro_x;
    float gyro_y;
    float gyro_z;
    float accel_x;
    float accel_y;
    float accel_z;
    float quat_w;
    float quat_x;
    float quat_y;
    float quat_z;
} bno055_data_t;

#define EXAMPLE_LCD_PIXEL_CLOCK_HZ (80 * 1000 * 1000)

#define EXAMPLE_PIN_NUM_LCD_DC 42
#define EXAMPLE_PIN_NUM_LCD_RST -1
#define EXAMPLE_PIN_NUM_LCD_CS 45

#define EXAMPLE_LCD_CMD_BITS 8
#define EXAMPLE_LCD_PARAM_BITS 8

#define EXAMPLE_LCD_H_RES 240
#define EXAMPLE_LCD_V_RES 320

#define EXAMPLE_PIN_NUM_BK_LIGHT 1

#define LCD_BL_LEDC_TIMER LEDC_TIMER_0
#define LCD_BL_LEDC_MODE LEDC_LOW_SPEED_MODE

#define LCD_BL_LEDC_CHANNEL LEDC_CHANNEL_0
#define LCD_BL_LEDC_DUTY_RES LEDC_TIMER_10_BIT // Set duty resolution to 13 bits
#define LCD_BL_LEDC_DUTY (1024)                // Set duty to 50%. (2 ** 13) * 50% = 4096
#define LCD_BL_LEDC_FREQUENCY (10000)          // Frequency in Hertz. Set frequency at 5 kHz

#define EXAMPLE_LVGL_TICK_PERIOD_MS 2
#define EXAMPLE_LVGL_TASK_MAX_DELAY_MS 500
#define EXAMPLE_LVGL_TASK_MIN_DELAY_MS 1

static const char *TAG = "IMU_Client";

esp_lcd_panel_io_handle_t io_handle;
esp_lcd_panel_handle_t panel_handle;
esp_lcd_touch_handle_t tp;

/* LVGL display and touch */
static lv_display_t *lvgl_disp = NULL;
static lv_indev_t *lvgl_touch_indev = NULL;

/* LVGL UI labels and timers */
static lv_obj_t *label_adc_raw = NULL;
static lv_obj_t *label_voltage = NULL;
static lv_obj_t *label_imu_fps = NULL;
static lv_obj_t *label_uptime = NULL;
static lv_obj_t *label_wifi_status = NULL;
static lv_obj_t *btn_imu_control = NULL;
static lv_obj_t *btn_label = NULL;

/* Global variable for IMU FPS */
static volatile float imu_fps = 0.0f;

/* I2C handles for BNO055 (separate I2C bus) */
static i2c_master_bus_handle_t bno055_i2c_bus_handle = NULL;
static i2c_master_dev_handle_t bno055_i2c_dev_handle = NULL;

/* WiFi and UDP variables */
static EventGroupHandle_t s_wifi_event_group;
static int udp_socket = -1;
static struct sockaddr_in dest_addr;
static bool wifi_connected = false;
static int s_retry_num = 0;
static bool imu_sending = false;  // Control IMU data transmission

/* IMU data queue for buffering samples */
#define IMU_QUEUE_SIZE 10
static QueueHandle_t imu_data_queue = NULL;

/* ADC handles */
adc_oneshot_unit_handle_t adc1_handle;
adc_cali_handle_t adc1_cali_chan0_handle = NULL;
bool do_calibration1_chan0;

/* Function declarations */
static void imu_task(void *param);
static void udp_send_task(void *param);
static void battery_timer_callback(lv_timer_t *timer);
static void fps_timer_callback(lv_timer_t *timer);
static void uptime_timer_callback(lv_timer_t *timer);
static void wifi_event_handler(void* arg, esp_event_base_t event_base, int32_t event_id, void* event_data);
static void wifi_init_sta(void);
static void udp_client_init(void);
static void send_udp_data(float accel_x, float accel_y, float accel_z, float gyro_x, float gyro_y, float gyro_z, float quat_w, float quat_x, float quat_y, float quat_z);
static void btn_imu_event_cb(lv_event_t * e);
void bsp_battery_init(void);
void bsp_battery_get_voltage(float *voltage, uint16_t *adc_value);
void lvgl_battery_ui_init(void);


void display_init(void)
{
    ESP_LOGI(TAG, "SPI BUS init");
    spi_bus_config_t buscfg = {
        .sclk_io_num = EXAMPLE_PIN_NUM_SCLK,
        .mosi_io_num = EXAMPLE_PIN_NUM_MOSI,
        .miso_io_num = EXAMPLE_PIN_NUM_MISO,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
        .max_transfer_sz = 4000,
    };
    ESP_ERROR_CHECK(spi_bus_initialize(EXAMPLE_SPI_HOST, &buscfg, SPI_DMA_CH_AUTO));
    ESP_LOGI(TAG, "Install panel IO");

    

    esp_lcd_panel_io_spi_config_t io_config = {
        .dc_gpio_num = EXAMPLE_PIN_NUM_LCD_DC,
        .cs_gpio_num = EXAMPLE_PIN_NUM_LCD_CS,
        .pclk_hz = EXAMPLE_LCD_PIXEL_CLOCK_HZ,
        .lcd_cmd_bits = EXAMPLE_LCD_CMD_BITS,
        .lcd_param_bits = EXAMPLE_LCD_PARAM_BITS,
        .spi_mode = 0,
        .trans_queue_depth = 10,
        //.on_color_trans_done = example_notify_lvgl_flush_ready,
    };
    // Attach the LCD to the SPI bus
    ESP_ERROR_CHECK(esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)EXAMPLE_SPI_HOST, &io_config, &io_handle));

    esp_lcd_panel_dev_config_t panel_config = {
        .reset_gpio_num = EXAMPLE_PIN_NUM_LCD_RST,
        .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB,
        .bits_per_pixel = 16,
    };
    ESP_LOGI(TAG, "Install ST7789 panel driver");
    ESP_ERROR_CHECK(esp_lcd_new_panel_st7789(io_handle, &panel_config, &panel_handle));

    ESP_ERROR_CHECK(esp_lcd_panel_reset(panel_handle));
    ESP_ERROR_CHECK(esp_lcd_panel_init(panel_handle));
    ESP_ERROR_CHECK(esp_lcd_panel_mirror(panel_handle, false, false));
    ESP_ERROR_CHECK(esp_lcd_panel_swap_xy(panel_handle, false));
    ESP_ERROR_CHECK(esp_lcd_panel_disp_on_off(panel_handle, true));
    ESP_ERROR_CHECK(esp_lcd_panel_invert_color(panel_handle, true));
}

void touch_init(void)
{
    esp_lcd_panel_io_handle_t tp_io_handle = NULL;
    i2c_master_bus_handle_t i2c_handle;


    ESP_LOGI(TAG, "Initialize I2C");
    esp_err_t ret = bsp_i2c_init();
    if (ret != ESP_OK)
    {
        ESP_LOGE(TAG, "Initialize I2C Fail");
        abort();
    }

    esp_lcd_touch_config_t tp_cfg = {
        .x_max = EXAMPLE_LCD_V_RES,
        .y_max = EXAMPLE_LCD_H_RES,
        .rst_gpio_num = -1,
        .int_gpio_num = -1,
        .flags = {
            .swap_xy = 0,
            .mirror_x = 0,
            .mirror_y = 0,
        },
    };



    esp_lcd_panel_io_i2c_config_t tp_io_config = ESP_LCD_TOUCH_IO_I2C_CST816S_CONFIG();
    tp_io_config.scl_speed_hz = CONFIG_BSP_I2C_CLK_SPEED_HZ; // This parameter was introduced together with I2C Driver-NG in IDF v5.2


    i2c_handle = bsp_i2c_get_handle();
    esp_lcd_new_panel_io_i2c(i2c_handle, &tp_io_config, &tp_io_handle);
    esp_lcd_touch_new_i2c_cst816s(tp_io_handle, &tp_cfg, &tp);
}

void bsp_brightness_init(void)
{
    gpio_set_direction(EXAMPLE_PIN_NUM_BK_LIGHT, GPIO_MODE_OUTPUT);
    gpio_set_level(EXAMPLE_PIN_NUM_BK_LIGHT, 1);

    // Prepare and then apply the LEDC PWM timer configuration
    ledc_timer_config_t ledc_timer = {
        .speed_mode = LCD_BL_LEDC_MODE,
        .timer_num = LCD_BL_LEDC_TIMER,
        .duty_resolution = LCD_BL_LEDC_DUTY_RES,
        .freq_hz = LCD_BL_LEDC_FREQUENCY, // Set output frequency at 5 kHz
        .clk_cfg = LEDC_AUTO_CLK};
    ESP_ERROR_CHECK(ledc_timer_config(&ledc_timer));

    // Prepare and then apply the LEDC PWM channel configuration
    ledc_channel_config_t ledc_channel = {
        .speed_mode = LCD_BL_LEDC_MODE,
        .channel = LCD_BL_LEDC_CHANNEL,
        .timer_sel = LCD_BL_LEDC_TIMER,
        .intr_type = LEDC_INTR_DISABLE,
        .gpio_num = EXAMPLE_PIN_NUM_BK_LIGHT,
        .duty = 0, // Set duty to 0%
        .hpoint = 0};
    ESP_ERROR_CHECK(ledc_channel_config(&ledc_channel));
}

void bsp_brightness_set_level(uint8_t level)
{
    if (level > 100)
    {
        ESP_LOGE(TAG, "Brightness value out of range");
        return;
    }

    uint32_t duty = (level * (LCD_BL_LEDC_DUTY - 1)) / 100;

    ESP_ERROR_CHECK(ledc_set_duty(LCD_BL_LEDC_MODE, LCD_BL_LEDC_CHANNEL, duty));
    ESP_ERROR_CHECK(ledc_update_duty(LCD_BL_LEDC_MODE, LCD_BL_LEDC_CHANNEL));

    ESP_LOGI(TAG, "LCD brightness set to %d%%", level);
}

// BNO055 I2C functions using driver-ng
static esp_err_t bno055_write_byte(uint8_t reg_addr, uint8_t data)
{
    uint8_t write_buf[2] = {reg_addr, data};
    return i2c_master_transmit(bno055_i2c_dev_handle, write_buf, sizeof(write_buf), 1000);
}

static esp_err_t bno055_read_bytes(uint8_t reg_addr, uint8_t *data, size_t len)
{
    return i2c_master_transmit_receive(bno055_i2c_dev_handle, &reg_addr, 1, data, len, 1000);
}

esp_err_t bno055_init(void)
{
    esp_err_t ret;
    uint8_t chip_id;

    // Initialize separate I2C bus for BNO055 using driver-ng
    ESP_LOGI(TAG, "Initialize I2C bus %d for BNO055 on SDA=%d, SCL=%d", BNO055_I2C_NUM, BNO055_PIN_NUM_SDA, BNO055_PIN_NUM_SCL);
    
    i2c_master_bus_config_t bus_config = {
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .i2c_port = BNO055_I2C_NUM,
        .scl_io_num = BNO055_PIN_NUM_SCL,
        .sda_io_num = BNO055_PIN_NUM_SDA,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    
    ret = i2c_new_master_bus(&bus_config, &bno055_i2c_bus_handle);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "BNO055 I2C master bus init failed: %s", esp_err_to_name(ret));
        return ret;
    }
    
    // Add BNO055 device to the bus
    i2c_device_config_t dev_config = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = BNO055_I2C_ADDR,
        .scl_speed_hz = 100000, // 100kHz for better compatibility
    };
    
    ret = i2c_master_bus_add_device(bno055_i2c_bus_handle, &dev_config, &bno055_i2c_dev_handle);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "BNO055 I2C device add failed: %s", esp_err_to_name(ret));
        return ret;
    }
    
    ESP_LOGI(TAG, "BNO055 I2C bus initialized successfully");

    // Wait for sensor to be ready
    vTaskDelay(pdMS_TO_TICKS(1000));
    
    // Read chip ID with retries
    for (int i = 0; i < 5; i++) {
        ret = bno055_read_bytes(BNO055_CHIP_ID_ADDR, &chip_id, 1);
        if (ret == ESP_OK) {
            ESP_LOGI(TAG, "BNO055 chip ID read success: 0x%02X", chip_id);
            break;
        }
        ESP_LOGW(TAG, "Failed to read BNO055 chip ID, retry %d/5", i + 1);
        vTaskDelay(pdMS_TO_TICKS(100));
    }
    
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to read BNO055 chip ID after retries");
        return ret;
    }

    if (chip_id != 0xA0) {
        ESP_LOGE(TAG, "Invalid BNO055 chip ID: 0x%02X (expected 0xA0)", chip_id);
        return ESP_ERR_INVALID_RESPONSE;
    }

    ESP_LOGI(TAG, "BNO055 chip ID verified: 0x%02X", chip_id);

    // Set to config mode
    ret = bno055_write_byte(BNO055_OPR_MODE_ADDR, BNO055_OPERATION_MODE_CONFIG);
    if (ret != ESP_OK) return ret;
    vTaskDelay(pdMS_TO_TICKS(30));

    // Reset
    ret = bno055_write_byte(BNO055_SYS_TRIGGER_ADDR, 0x20);
    if (ret != ESP_OK) return ret;
    vTaskDelay(pdMS_TO_TICKS(650));

    // Set power mode to normal
    ret = bno055_write_byte(BNO055_PWR_MODE_ADDR, BNO055_POWER_MODE_NORMAL);
    if (ret != ESP_OK) return ret;
    vTaskDelay(pdMS_TO_TICKS(10));

    // Set page 0
    ret = bno055_write_byte(BNO055_PAGE_ID_ADDR, 0x00);
    if (ret != ESP_OK) return ret;

    // Set operation mode to NDOF (Nine Degrees of Freedom)
    ret = bno055_write_byte(BNO055_OPR_MODE_ADDR, BNO055_OPERATION_MODE_NDOF);
    if (ret != ESP_OK) return ret;
    vTaskDelay(pdMS_TO_TICKS(20));

    ESP_LOGI(TAG, "BNO055 initialized successfully");
    return ESP_OK;
}

esp_err_t bno055_read_euler_angles(float *heading, float *roll, float *pitch)
{
    uint8_t buffer[6];
    esp_err_t ret = bno055_read_bytes(BNO055_EULER_H_LSB_ADDR, buffer, 6);
    if (ret != ESP_OK) return ret;

    int16_t h = (int16_t)((buffer[1] << 8) | buffer[0]);
    int16_t r = (int16_t)((buffer[3] << 8) | buffer[2]);
    int16_t p = (int16_t)((buffer[5] << 8) | buffer[4]);

    *heading = h / 16.0f;
    *roll = r / 16.0f;
    *pitch = p / 16.0f;

    return ESP_OK;
}

esp_err_t bno055_read_gyro(float *x, float *y, float *z)
{
    uint8_t buffer[6];
    esp_err_t ret = bno055_read_bytes(BNO055_GYRO_DATA_X_LSB_ADDR, buffer, 6);
    if (ret != ESP_OK) return ret;

    int16_t gx = (int16_t)((buffer[1] << 8) | buffer[0]);
    int16_t gy = (int16_t)((buffer[3] << 8) | buffer[2]);
    int16_t gz = (int16_t)((buffer[5] << 8) | buffer[4]);

    *x = gx / 16.0f;  // deg/s
    *y = gy / 16.0f;
    *z = gz / 16.0f;

    return ESP_OK;
}

esp_err_t bno055_read_accel(float *x, float *y, float *z)
{
    uint8_t buffer[6];
    esp_err_t ret = bno055_read_bytes(BNO055_ACCEL_DATA_X_LSB_ADDR, buffer, 6);
    if (ret != ESP_OK) return ret;

    int16_t ax = (int16_t)((buffer[1] << 8) | buffer[0]);
    int16_t ay = (int16_t)((buffer[3] << 8) | buffer[2]);
    int16_t az = (int16_t)((buffer[5] << 8) | buffer[4]);

    *x = ax / 100.0f;  // m/s²
    *y = ay / 100.0f;
    *z = az / 100.0f;

    return ESP_OK;
}

esp_err_t bno055_read_quaternion(float *w, float *x, float *y, float *z)
{
    uint8_t buffer[8];
    esp_err_t ret = bno055_read_bytes(BNO055_QUATERNION_DATA_W_LSB_ADDR, buffer, 8);
    if (ret != ESP_OK) return ret;

    int16_t qw = (int16_t)((buffer[1] << 8) | buffer[0]);
    int16_t qx = (int16_t)((buffer[3] << 8) | buffer[2]);
    int16_t qy = (int16_t)((buffer[5] << 8) | buffer[4]);
    int16_t qz = (int16_t)((buffer[7] << 8) | buffer[6]);

    // BNO055 quaternion scale factor is 2^14
    *w = qw / 16384.0f;
    *x = qx / 16384.0f;
    *y = qy / 16384.0f;
    *z = qz / 16384.0f;

    return ESP_OK;
}

esp_err_t bno055_read_all_data(bno055_data_t *data)
{
    esp_err_t ret;
    
    ret = bno055_read_euler_angles(&data->euler_heading, &data->euler_roll, &data->euler_pitch);
    if (ret != ESP_OK) return ret;

    ret = bno055_read_gyro(&data->gyro_x, &data->gyro_y, &data->gyro_z);
    if (ret != ESP_OK) return ret;

    ret = bno055_read_accel(&data->accel_x, &data->accel_y, &data->accel_z);
    if (ret != ESP_OK) return ret;

    ret = bno055_read_quaternion(&data->quat_w, &data->quat_x, &data->quat_y, &data->quat_z);
    if (ret != ESP_OK) return ret;

    return ESP_OK;
}

// Battery ADC functions
static bool example_adc_calibration_init(adc_unit_t unit, adc_channel_t channel, adc_atten_t atten, adc_cali_handle_t *out_handle)
{
    adc_cali_handle_t handle = NULL;
    esp_err_t ret = ESP_FAIL;
    bool calibrated = false;

#if ADC_CALI_SCHEME_CURVE_FITTING_SUPPORTED
    if (!calibrated)
    {
        ESP_LOGI(TAG, "calibration scheme version is %s", "Curve Fitting");
        adc_cali_curve_fitting_config_t cali_config = {
            .unit_id = unit,
            .chan = channel,
            .atten = atten,
            .bitwidth = ADC_BITWIDTH_DEFAULT,
        };
        ret = adc_cali_create_scheme_curve_fitting(&cali_config, &handle);
        if (ret == ESP_OK)
        {
            calibrated = true;
        }
    }
#endif

#if ADC_CALI_SCHEME_LINE_FITTING_SUPPORTED
    if (!calibrated)
    {
        ESP_LOGI(TAG, "calibration scheme version is %s", "Line Fitting");
        adc_cali_line_fitting_config_t cali_config = {
            .unit_id = unit,
            .atten = atten,
            .bitwidth = ADC_BITWIDTH_DEFAULT,
        };
        ret = adc_cali_create_scheme_line_fitting(&cali_config, &handle);
        if (ret == ESP_OK)
        {
            calibrated = true;
        }
    }
#endif

    *out_handle = handle;
    if (ret == ESP_OK)
    {
        ESP_LOGI(TAG, "Calibration Success");
    }
    else if (ret == ESP_ERR_NOT_SUPPORTED || !calibrated)
    {
        ESP_LOGW(TAG, "eFuse not burnt, skip software calibration");
    }
    else
    {
        ESP_LOGE(TAG, "Invalid arg or no memory");
    }

    return calibrated;
}

// WiFi event handler
static void wifi_event_handler(void* arg, esp_event_base_t event_base, int32_t event_id, void* event_data)
{
    if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_DISCONNECTED) {
        if (s_retry_num < WIFI_MAXIMUM_RETRY) {
            esp_wifi_connect();
            s_retry_num++;
            ESP_LOGI(TAG, "Retry connecting to WiFi...");
        } else {
            xEventGroupSetBits(s_wifi_event_group, WIFI_FAIL_BIT);
        }
        wifi_connected = false;
        ESP_LOGI(TAG, "WiFi connection failed");
    } else if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t* event = (ip_event_got_ip_t*) event_data;
        ESP_LOGI(TAG, "Got IP:" IPSTR, IP2STR(&event->ip_info.ip));
        s_retry_num = 0;
        xEventGroupSetBits(s_wifi_event_group, WIFI_CONNECTED_BIT);
        wifi_connected = true;
        
        // Update WiFi status on screen
        lvgl_port_lock(0);
        if (label_wifi_status != NULL) {
            char ip_str[32];
            snprintf(ip_str, sizeof(ip_str), IPSTR, IP2STR(&event->ip_info.ip));
            lv_label_set_text(label_wifi_status, ip_str);
        }
        lvgl_port_unlock();
    }
}

// Initialize WiFi Station mode
static void wifi_init_sta(void)
{
    s_wifi_event_group = xEventGroupCreate();

    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    esp_event_handler_instance_t instance_any_id;
    esp_event_handler_instance_t instance_got_ip;
    ESP_ERROR_CHECK(esp_event_handler_instance_register(WIFI_EVENT,
                                                        ESP_EVENT_ANY_ID,
                                                        &wifi_event_handler,
                                                        NULL,
                                                        &instance_any_id));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(IP_EVENT,
                                                        IP_EVENT_STA_GOT_IP,
                                                        &wifi_event_handler,
                                                        NULL,
                                                        &instance_got_ip));

    wifi_config_t wifi_config = {};
    strcpy((char*)wifi_config.sta.ssid, WIFI_SSID);
    strcpy((char*)wifi_config.sta.password, WIFI_PASS);
    wifi_config.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_config));
    ESP_ERROR_CHECK(esp_wifi_start());

    ESP_LOGI(TAG, "WiFi initialization finished. Connecting to %s...", WIFI_SSID);

    EventBits_t bits = xEventGroupWaitBits(s_wifi_event_group,
            WIFI_CONNECTED_BIT | WIFI_FAIL_BIT,
            pdFALSE,
            pdFALSE,
            portMAX_DELAY);

    if (bits & WIFI_CONNECTED_BIT) {
        ESP_LOGI(TAG, "Connected to WiFi SSID:%s", WIFI_SSID);
    } else if (bits & WIFI_FAIL_BIT) {
        ESP_LOGI(TAG, "Failed to connect to SSID:%s", WIFI_SSID);
    } else {
        ESP_LOGE(TAG, "UNEXPECTED EVENT");
    }
}

// Initialize UDP client
static void udp_client_init(void)
{
    udp_socket = socket(AF_INET, SOCK_DGRAM, IPPROTO_IP);
    if (udp_socket < 0) {
        ESP_LOGE(TAG, "Unable to create socket: errno %d", errno);
        return;
    }

    dest_addr.sin_family = AF_INET;
    dest_addr.sin_port = htons(UDP_PORT);
    dest_addr.sin_addr.s_addr = inet_addr(UDP_SERVER_IP);

    ESP_LOGI(TAG, "UDP client initialized. Target: %s:%d", UDP_SERVER_IP, UDP_PORT);
}
// Send IMU data via UDP (format for x-IMU Python server with quaternion)
static void send_udp_data(float accel_x, float accel_y, float accel_z, 
                          float gyro_x, float gyro_y, float gyro_z,
                          float quat_w, float quat_x, float quat_y, float quat_z)
{
    if (udp_socket < 0 || !wifi_connected || !imu_sending) {
        return;
    }

    // Convert acceleration from m/s² to g (divide by 9.81)
    float accel_x_g = accel_x / 9.81f;
    float accel_y_g = accel_y / 9.81f;
    float accel_z_g = accel_z / 9.81f;

    char buffer[256];
    snprintf(buffer, sizeof(buffer), 
             "Accel[%.6f,%.6f,%.6f] Gyro[%.6f,%.6f,%.6f] Quat[%.6f,%.6f,%.6f,%.6f]",
             accel_x_g, accel_y_g, accel_z_g,
             gyro_x, gyro_y, gyro_z,
             quat_w, quat_x, quat_y, quat_z);

    int err = sendto(udp_socket, buffer, strlen(buffer), 0, 
                     (struct sockaddr *)&dest_addr, sizeof(dest_addr));
    if (err < 0) {
        ESP_LOGW(TAG, "Error occurred during sending: errno %d", errno);
    }
}

// UDP send task - processes queued IMU data
static void udp_send_task(void *param)
{
    bno055_data_t imu_data;
    
    ESP_LOGI(TAG, "UDP send task started");
    
    while (1) {
        // Wait for data from queue (blocks until data available)
        if (xQueueReceive(imu_data_queue, &imu_data, portMAX_DELAY) == pdTRUE) {
            if (imu_sending && wifi_connected && udp_socket >= 0) {
                send_udp_data(imu_data.accel_x, imu_data.accel_y, imu_data.accel_z,
                            imu_data.gyro_x, imu_data.gyro_y, imu_data.gyro_z,
                            imu_data.quat_w, imu_data.quat_x, imu_data.quat_y, imu_data.quat_z);
            }
        }
    }
}

void bsp_battery_init(void)
{
    adc_oneshot_unit_init_cfg_t init_config1 = {
        .unit_id = ADC_UNIT_1,
    };
    ESP_ERROR_CHECK(adc_oneshot_new_unit(&init_config1, &adc1_handle));
    
    //-------------ADC1 Config---------------//
    adc_oneshot_chan_cfg_t config = {
        .bitwidth = ADC_BITWIDTH_DEFAULT,
        .atten = EXAMPLE_ADC_ATTEN,
    };
    ESP_ERROR_CHECK(adc_oneshot_config_channel(adc1_handle, EXAMPLE_BATTERY_ADC_CHANNEL, &config));

    //-------------ADC1 Calibration Init---------------//
    do_calibration1_chan0 = example_adc_calibration_init(ADC_UNIT_1, EXAMPLE_BATTERY_ADC_CHANNEL, EXAMPLE_ADC_ATTEN, &adc1_cali_chan0_handle);
}

void bsp_battery_get_voltage(float *voltage, uint16_t *adc_value)
{
    int adc_raw;
    int voltage_int;
    
    ESP_ERROR_CHECK(adc_oneshot_read(adc1_handle, EXAMPLE_BATTERY_ADC_CHANNEL, &adc_raw));
    
    if (do_calibration1_chan0)
    {
        ESP_ERROR_CHECK(adc_cali_raw_to_voltage(adc1_cali_chan0_handle, adc_raw, &voltage_int));
        *voltage = (voltage_int / 1000.0f) * 3.0; 
        *adc_value = adc_raw;
    }
}

// IMU task for 100Hz data acquisition
static void imu_task(void *param)
{
    bno055_data_t imu_data;
    const TickType_t sample_period = pdMS_TO_TICKS(10); // 10ms = 100Hz
    TickType_t last_wake_time = xTaskGetTickCount();
    
    // FPS calculation variables
    TickType_t fps_calc_start = xTaskGetTickCount();
    uint32_t fps_sample_count = 0;
    
    ESP_LOGI(TAG, "IMU task started - sampling at 100Hz");
    
    while (1) {
        // Read IMU data at 100Hz
        if (bno055_read_all_data(&imu_data) == ESP_OK) {
            fps_sample_count++;
            
            // Queue data for UDP transmission (non-blocking)
            if (imu_sending && imu_data_queue != NULL) {
                // Try to send to queue without blocking
                if (xQueueSend(imu_data_queue, &imu_data, 0) != pdTRUE) {
                    // Queue full - drop oldest sample to make room for new one
                    bno055_data_t dummy;
                    xQueueReceive(imu_data_queue, &dummy, 0);
                    xQueueSend(imu_data_queue, &imu_data, 0);
                }
            }
            
            // Calculate FPS every second
            TickType_t current_time = xTaskGetTickCount();
            TickType_t elapsed = current_time - fps_calc_start;
            
            if (elapsed >= pdMS_TO_TICKS(1000)) {
                // Calculate actual FPS
                imu_fps = (float)fps_sample_count / (elapsed / (float)configTICK_RATE_HZ);
                
                // Reset counters
                fps_calc_start = current_time;
                fps_sample_count = 0;
                
                // Log every second (only when sending)
                if (imu_sending) {
                    UBaseType_t queue_waiting = uxQueueMessagesWaiting(imu_data_queue);
                    ESP_LOGI(TAG, "[IMU FPS: %.1f] Q:%u/10 | Accel[%.2f,%.2f,%.2f] Gyro[%.1f,%.1f,%.1f] Quat[%.3f,%.3f,%.3f,%.3f]", 
                             imu_fps, queue_waiting, 
                             imu_data.accel_x, imu_data.accel_y, imu_data.accel_z,
                             imu_data.gyro_x, imu_data.gyro_y, imu_data.gyro_z,
                             imu_data.quat_w, imu_data.quat_x, imu_data.quat_y, imu_data.quat_z);
                }
            }
        }
        
        // Maintain precise 100Hz timing
        vTaskDelayUntil(&last_wake_time, sample_period);
    }
}

// LVGL timer callbacks
static void battery_timer_callback(lv_timer_t *timer)
{
    char str_buffer[20];
    float voltage;
    uint16_t adc_value;
    
    bsp_battery_get_voltage(&voltage, &adc_value);
    
    if (label_adc_raw) {
        lv_label_set_text_fmt(label_adc_raw, "%d", adc_value);
    }
    if (label_voltage) {
        sprintf(str_buffer, "%.1f V", voltage);
        lv_label_set_text(label_voltage, str_buffer);
    }
}

static void fps_timer_callback(lv_timer_t *timer)
{
    if (label_imu_fps) {
        char str_buffer[20];
        sprintf(str_buffer, "%.1f Hz", imu_fps);
        lv_label_set_text(label_imu_fps, str_buffer);
    }
}

static void uptime_timer_callback(lv_timer_t *timer)
{
    if (label_uptime) {
        char str_buffer[32];
        uint32_t uptime_sec = esp_timer_get_time() / 1000000;
        uint32_t hours = uptime_sec / 3600;
        uint32_t minutes = (uptime_sec % 3600) / 60;
        uint32_t seconds = uptime_sec % 60;
        sprintf(str_buffer, "%02lu:%02lu:%02lu", hours, minutes, seconds);
        lv_label_set_text(label_uptime, str_buffer);
    }
}

// IMU control button event callback
static void btn_imu_event_cb(lv_event_t * e)
{
    lv_event_code_t code = lv_event_get_code(e);
    if(code == LV_EVENT_CLICKED)
    {
        imu_sending = !imu_sending;
        if (imu_sending)
        {
            if (btn_label != NULL)
                lv_label_set_text(btn_label, "Stop IMU");
            ESP_LOGI(TAG, "IMU transmission started");
        }
        else
        {
            if (btn_label != NULL)
                lv_label_set_text(btn_label, "Start IMU");
            ESP_LOGI(TAG, "IMU transmission stopped");
        }
    }
}

void lvgl_battery_ui_init(void)
{
    lv_obj_t *scr = lv_screen_active();
    
    // Create a list to display sensor data
    lv_obj_t *list = lv_list_create(scr);
    lv_obj_set_size(list, lv_pct(100), lv_pct(85));  // Leave space for button
    lv_obj_align(list, LV_ALIGN_TOP_MID, 0, 0);

    // WiFi status display
    lv_obj_t *list_item = lv_list_add_button(list, NULL, "WiFi IP");
    label_wifi_status = lv_label_create(list_item);
    lv_label_set_text(label_wifi_status, "Connecting...");
    lv_obj_align(label_wifi_status, LV_ALIGN_RIGHT_MID, -10, 0);

    // ADC value display
    list_item = lv_list_add_button(list, NULL, "ADC Value");
    label_adc_raw = lv_label_create(list_item);
    lv_label_set_text(label_adc_raw, "0");
    lv_obj_align(label_adc_raw, LV_ALIGN_RIGHT_MID, -10, 0);

    // Voltage display
    list_item = lv_list_add_button(list, NULL, "Battery Voltage");
    label_voltage = lv_label_create(list_item);
    lv_label_set_text(label_voltage, "0.0 V");
    lv_obj_align(label_voltage, LV_ALIGN_RIGHT_MID, -10, 0);
    
    // IMU FPS display
    list_item = lv_list_add_button(list, NULL, "IMU FPS");
    label_imu_fps = lv_label_create(list_item);
    lv_label_set_text(label_imu_fps, "0.0 Hz");
    lv_obj_align(label_imu_fps, LV_ALIGN_RIGHT_MID, -10, 0);
    
    // Uptime display
    list_item = lv_list_add_button(list, NULL, "Uptime");
    label_uptime = lv_label_create(list_item);
    lv_label_set_text(label_uptime, "00:00:00");
    lv_obj_align(label_uptime, LV_ALIGN_RIGHT_MID, -10, 0);
    
    // IMU Control Button at bottom
    btn_imu_control = lv_button_create(scr);
    lv_obj_set_size(btn_imu_control, lv_pct(80), 50);
    lv_obj_align(btn_imu_control, LV_ALIGN_BOTTOM_MID, 0, -10);
    lv_obj_add_event_cb(btn_imu_control, btn_imu_event_cb, LV_EVENT_ALL, NULL);
    
    btn_label = lv_label_create(btn_imu_control);
    lv_label_set_text(btn_label, "Start IMU");
    lv_obj_center(btn_label);
    
    // Battery check every 1 minute (60000 ms)
    lv_timer_create(battery_timer_callback, 60000, NULL);
    
    // FPS display update every 1 second
    lv_timer_create(fps_timer_callback, 1000, NULL);
    
    // Uptime display update every 1 second
    lv_timer_create(uptime_timer_callback, 1000, NULL);
    
    // Trigger first battery read immediately
    battery_timer_callback(NULL);
}


void app_main_display(void)
{
    // Initialize the UI with battery and IMU data displays
    lvgl_battery_ui_init();
}



void app_main(void)
{

    ESP_LOGI(TAG, "app_main");

    // Initialize NVS (required for WiFi)
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);

    // Initialize battery ADC
    bsp_battery_init();
    
    display_init();
    touch_init();


     /* Add LCD screen */
     ESP_LOGI(TAG, "Add LCD screen");
     const lvgl_port_display_cfg_t disp_cfg = {
         .io_handle = io_handle,
         .panel_handle = panel_handle,
         .buffer_size = EXAMPLE_LCD_V_RES * EXAMPLE_LCD_H_RES,
         .double_buffer = true,
         .hres = EXAMPLE_LCD_H_RES,
         .vres = EXAMPLE_LCD_V_RES,
         .monochrome = false,
         .rotation = {
             .swap_xy = false,
             .mirror_x = false,
             .mirror_y = false,
         },
         .flags = {
             .buff_dma = false,
             .buff_spiram = false,
             .sw_rotate = true,
             .swap_bytes = true,
             .full_refresh = true,
             .direct_mode = false,
         }};
 
     const lvgl_port_cfg_t lvgl_cfg = ESP_LVGL_PORT_INIT_CONFIG();
     ESP_ERROR_CHECK(lvgl_port_init(&lvgl_cfg));
     lvgl_disp = lvgl_port_add_disp(&disp_cfg);
     if (!lvgl_disp)
     {
        ESP_LOGE(TAG, "[Err] LVGL Display is not setup properly");
        abort();
     }

      /* Add touch input (for selected screen) */
    const lvgl_port_touch_cfg_t touch_cfg = {
        .disp = lvgl_disp,
        .handle = tp,
    };
    lvgl_touch_indev = lvgl_port_add_touch(&touch_cfg);
    if (!lvgl_touch_indev)
    {
       ESP_LOGE(TAG, "[Err] LVGL Touch is not setup properly");
       abort();
    }

    bsp_brightness_init();
    bsp_brightness_set_level(80);

    /* Lock LVGL for UI initialization */
    lvgl_port_lock(0);
    app_main_display();
    lvgl_port_unlock();

    // Initialize WiFi
    ESP_LOGI(TAG, "Initializing WiFi...");
    wifi_init_sta();
    
    // Initialize UDP client after WiFi connection
    if (wifi_connected) {
        udp_client_init();
    }

    // Create queue for IMU data buffering
    imu_data_queue = xQueueCreate(IMU_QUEUE_SIZE, sizeof(bno055_data_t));
    if (imu_data_queue == NULL) {
        ESP_LOGE(TAG, "Failed to create IMU data queue!");
    } else {
        ESP_LOGI(TAG, "IMU data queue created (size: %d)", IMU_QUEUE_SIZE);
        // Start UDP send task
        xTaskCreatePinnedToCore(udp_send_task, "udp_send_task", 4096, NULL, 5, NULL, 1);
    }

    // Initialize BNO055 IMU sensor on separate I2C bus
    ret = bno055_init();
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "BNO055 initialization failed!");
    } else {
        ESP_LOGI(TAG, "BNO055 initialized successfully");
        // Start IMU task for 100Hz data acquisition
        xTaskCreatePinnedToCore(imu_task, "imu_100hz_task", 4096, NULL, 6, NULL, 0);
    }
}