// ========================================================================
// Module Index — include this file to get all modules
// ========================================================================
#pragma once

// Production transport is native USB CDC on the Type-C port. GPIO43/44 are
// reserved for the two ToF sensor XSHUT lines.
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
#include "ImuSafetyEvaluator.h"
#include "INA226Sensor.h"
#include "IRProximitySensor.h"
#include "FrontTofSensor.h"
#include "VL53L0XSensor.h"
#include "CylinderActuator.h"
#include "CargoSensor.h"
#include "JsonStatus.h"
#include "HealthMonitor.h"
#include "I2CBus.h"

// Phase 1: Foundation (Safety + Performance)
#include "SafetyController.h"
#include "DynamicAcceleration.h"
// ZeroCopyTelemetry is already in JsonStatus.h

// Phase 2: Intelligence (Adaptive Behavior)
#include "AdaptivePID.h"
#include "BatteryPredictor.h"

// Phase 3: Reliability (Self-Healing)
#include "I2CWatchdog.h"
#include "MotorHealthMonitor.h"

// Phase 4: Advanced (Debugging Tools)
#include "BlackBoxRecorder.h"
