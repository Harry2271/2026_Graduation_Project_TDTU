#pragma once

#include <Arduino.h>
#include <ESP32Servo.h>

// ============================================================
// RoboticArm — 5-DOF Arm Control
// ============================================================
// Hardware: 3×MG996R (base/shoulder/elbow, 180° range)
//           2×SG90 (wrist_pitch/gripper, 0-180°)
// PWM: ESP32 LEDC channels (6 channels needed)
// Safety: soft limits per joint, speed ramp (10°/tick @ 50Hz)
// ============================================================

constexpr uint8_t ARM_JOINT_COUNT = 5;

enum class ArmJoint : uint8_t {
    BASE = 0,          // MG996R — horizontal rotation
    SHOULDER = 1,      // MG996R — vertical lift
    ELBOW = 2,         // MG996R — vertical bend
    WRIST_PITCH = 3,   // SG90 — end effector pitch
    GRIPPER = 4        // SG90 — open/close
};

struct JointLimits {
    float min_deg;      // Minimum angle (degrees)
    float max_deg;      // Maximum angle (degrees)
    uint16_t min_us;    // PWM pulse width at min_deg (microseconds)
    uint16_t max_us;    // PWM pulse width at max_deg (microseconds)
};

struct ArmState {
    float joints[ARM_JOINT_COUNT];  // Current joint angles (degrees)
    bool is_moving;                 // Any joint in motion
    uint32_t last_cmd_ms;           // Timestamp of last command
};

class RoboticArm {
public:
    RoboticArm();

    // Initialization
    void begin();

    // Motion control
    void moveTo(const float target_joints[ARM_JOINT_COUNT]);
    void grip(bool close);  // Alias for gripper control
    void home();            // Safe park position

    // State query
    ArmState getState() const;
    bool isMoving() const { return m_is_moving; }
    float getJointAngle(ArmJoint joint) const;

    // Per-tick update (call from main loop at ~50Hz)
    void update(uint32_t now_ms);

private:
    // Hardware
    Servo m_servos[ARM_JOINT_COUNT];

    // State
    float m_current_joints[ARM_JOINT_COUNT];   // Current angles
    float m_target_joints[ARM_JOINT_COUNT];    // Target angles
    bool m_is_moving;
    uint32_t m_last_cmd_ms;
    uint32_t m_last_update_ms;

    // Joint configuration — constexpr tables for compile-time validation
    static constexpr uint8_t SERVO_PINS[ARM_JOINT_COUNT] = {
        18,  // BASE — GPIO18 (USB D-, safe when CDC disabled)
        19,  // SHOULDER — GPIO19 (USB D+, safe when CDC disabled)
        33,  // ELBOW — GPIO33 (free GPIO, no conflicts)
        7,   // WRIST_PITCH — GPIO7 (free GPIO, replaces input-only GPIO34)
        0    // GRIPPER — GPIO0 (BOOT strapping pin, safe after boot as output)
    };

    static constexpr JointLimits JOINT_LIMITS[ARM_JOINT_COUNT] = {
        // BASE (MG996R)
        { .min_deg = 0.0f,   .max_deg = 180.0f, .min_us = 500,  .max_us = 2500 },
        // SHOULDER (MG996R)
        { .min_deg = 0.0f,   .max_deg = 180.0f, .min_us = 500,  .max_us = 2500 },
        // ELBOW (MG996R)
        { .min_deg = 0.0f,   .max_deg = 180.0f, .min_us = 500,  .max_us = 2500 },
        // WRIST_PITCH (SG90)
        { .min_deg = 0.0f,   .max_deg = 180.0f, .min_us = 500,  .max_us = 2400 },
        // GRIPPER (SG90)
        { .min_deg = 10.0f,  .max_deg = 170.0f, .min_us = 500,  .max_us = 2400 }
    };

    static constexpr float HOME_POSITION[ARM_JOINT_COUNT] = {
        90.0f,   // BASE — centered
        45.0f,   // SHOULDER — low safe angle
        90.0f,   // ELBOW — neutral
        90.0f,   // WRIST_PITCH — level
        170.0f   // GRIPPER — open
    };

    static constexpr float RAMP_RATE_DEG_PER_TICK = 10.0f;  // 10°/tick @ 50Hz = 500°/s

    // Helpers
    float clampJoint(ArmJoint joint, float angle_deg) const;
    uint16_t angleToMicroseconds(ArmJoint joint, float angle_deg) const;
    void writeServo(ArmJoint joint, float angle_deg);
    bool allJointsAtTarget() const;
};
