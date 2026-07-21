// ========================================================================
// Module Index — include this file to get all modules
// ========================================================================
#pragma once

// Pi 5 <-> ESP32-S3 link — now USB CDC over Type-C cable (not UART GPIO).
// PiSerial = Serial = native USB CDC.  On the Pi 5 it appears as
// /dev/ttyACM0.  Both debug text and JSON protocol go on the same port;
// the Pi parser filters non-JSON lines.
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
#include "JsonStatus.h"
