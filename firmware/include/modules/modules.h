// ========================================================================
// Module Index — include this file to get all modules
// ========================================================================
#pragma once

// The production firmware uses native USB CDC. PiSerial aliases Serial, so
// debug text and JSON protocol share that endpoint; the Pi parser filters
// non-JSON lines. GPIO43/44 UART is not configured by this build.
#ifndef PiSerial
#define PiSerial Serial
#endif

// NOTE: All module headers live in this same directory.
// Use bare filenames — the including file's directory IS on the include path.
#include "BTS7960Driver.h"
#include "Encoder.h"
#include "PIDController.h"
#include "MecanumDrive.h"
#include "CommandParser.h"
#include "Watchdog.h"
#include "ObstacleAvoidance.h"
#include "ModeManager.h"
#include "BNO055Sensor.h"
#include "INA226Sensor.h"
#include "IRProximitySensor.h"
#include "SharpFrontSensor.h"
#include "VL53L0XSensor.h"
#include "CylinderActuator.h"
#include "CargoSensor.h"
#include "JsonStatus.h"
#include "HealthMonitor.h"
#include "I2CBus.h"
