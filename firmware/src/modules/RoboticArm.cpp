#include "RoboticArm.h"

// Out-of-line definitions for constexpr tables (required for ODR-use under C++11/14)
constexpr uint8_t RoboticArm::SERVO_PINS[ARM_JOINT_COUNT];
constexpr JointLimits RoboticArm::JOINT_LIMITS[ARM_JOINT_COUNT];
constexpr float RoboticArm::HOME_POSITION[ARM_JOINT_COUNT];

RoboticArm::RoboticArm()
    : m_is_moving(false)
    , m_last_cmd_ms(0)
    , m_last_update_ms(0)
{
    // Initialize joint arrays to home position
    for (uint8_t i = 0; i < ARM_JOINT_COUNT; i++) {
        m_current_joints[i] = HOME_POSITION[i];
        m_target_joints[i] = HOME_POSITION[i];
    }
}

void RoboticArm::begin()
{
    Serial.println("  [ARM] Robotic arm controller initialized");
    Serial.println("         Hardware: 3×MG996R + 2×SG90");

    // Attach servos to LEDC channels
    for (uint8_t i = 0; i < ARM_JOINT_COUNT; i++) {
        // ESP32Servo library auto-allocates LEDC channels
        // Default: 50Hz PWM frequency for hobby servos
        m_servos[i].attach(SERVO_PINS[i]);

        // Set initial position to home
        writeServo(static_cast<ArmJoint>(i), HOME_POSITION[i]);

        const char* joint_names[] = {"BASE", "SHOULDER", "ELBOW", "WRIST", "GRIPPER"};
        Serial.printf("         Joint %d (%s): GPIO%d → %.1f°\n",
                     i, joint_names[i], SERVO_PINS[i], HOME_POSITION[i]);
    }

    Serial.printf("         Ramp rate: %.1f°/tick (50Hz)\n", RAMP_RATE_DEG_PER_TICK);
    m_last_update_ms = millis();
}

void RoboticArm::moveTo(const float target_joints[ARM_JOINT_COUNT])
{
    m_last_cmd_ms = millis();

    // Clamp and store target angles
    for (uint8_t i = 0; i < ARM_JOINT_COUNT; i++) {
        m_target_joints[i] = clampJoint(static_cast<ArmJoint>(i), target_joints[i]);
    }

    m_is_moving = !allJointsAtTarget();

    if (m_is_moving) {
        Serial.printf("[ARM] moveTo: [%.1f, %.1f, %.1f, %.1f, %.1f]\n",
                     m_target_joints[0], m_target_joints[1], m_target_joints[2],
                     m_target_joints[3], m_target_joints[4]);
    }
}

void RoboticArm::grip(bool close)
{
    float gripper_angle = close ? JOINT_LIMITS[4].min_deg : JOINT_LIMITS[4].max_deg;
    float targets[ARM_JOINT_COUNT];

    // Copy current targets, only change gripper
    for (uint8_t i = 0; i < ARM_JOINT_COUNT; i++) {
        targets[i] = m_target_joints[i];
    }
    targets[4] = gripper_angle;

    moveTo(targets);

    Serial.printf("[ARM] Gripper: %s (%.1f°)\n", close ? "CLOSE" : "OPEN", gripper_angle);
}

void RoboticArm::home()
{
    moveTo(HOME_POSITION);
    Serial.println("[ARM] Homing to park position");
}

void RoboticArm::update(uint32_t now_ms)
{
    if (!m_is_moving) {
        return;
    }

    // Rate limiting: update at ~50Hz
    if (now_ms - m_last_update_ms < 20) {
        return;
    }
    m_last_update_ms = now_ms;

    // Ramp each joint toward target
    bool any_moving = false;
    for (uint8_t i = 0; i < ARM_JOINT_COUNT; i++) {
        float current = m_current_joints[i];
        float target = m_target_joints[i];
        float error = target - current;

        if (abs(error) < 1.0f) {
            // Close enough — snap to target
            m_current_joints[i] = target;
            writeServo(static_cast<ArmJoint>(i), target);
        } else {
            // Ramp toward target
            float step = (error > 0) ? RAMP_RATE_DEG_PER_TICK : -RAMP_RATE_DEG_PER_TICK;

            // Don't overshoot
            if (abs(step) > abs(error)) {
                step = error;
            }

            m_current_joints[i] += step;
            writeServo(static_cast<ArmJoint>(i), m_current_joints[i]);
            any_moving = true;
        }
    }

    m_is_moving = any_moving;

    if (!m_is_moving) {
        Serial.println("[ARM] Motion complete");
    }
}

ArmState RoboticArm::getState() const
{
    ArmState state;
    for (uint8_t i = 0; i < ARM_JOINT_COUNT; i++) {
        state.joints[i] = m_current_joints[i];
    }
    state.is_moving = m_is_moving;
    state.last_cmd_ms = m_last_cmd_ms;
    return state;
}

float RoboticArm::getJointAngle(ArmJoint joint) const
{
    return m_current_joints[static_cast<uint8_t>(joint)];
}

float RoboticArm::clampJoint(ArmJoint joint, float angle_deg) const
{
    const JointLimits& limits = JOINT_LIMITS[static_cast<uint8_t>(joint)];
    if (angle_deg < limits.min_deg) return limits.min_deg;
    if (angle_deg > limits.max_deg) return limits.max_deg;
    return angle_deg;
}

uint16_t RoboticArm::angleToMicroseconds(ArmJoint joint, float angle_deg) const
{
    const JointLimits& limits = JOINT_LIMITS[static_cast<uint8_t>(joint)];

    // Linear map: angle [min_deg, max_deg] → pulse width [min_us, max_us]
    float normalized = (angle_deg - limits.min_deg) / (limits.max_deg - limits.min_deg);
    uint16_t us = limits.min_us + normalized * (limits.max_us - limits.min_us);

    return us;
}

void RoboticArm::writeServo(ArmJoint joint, float angle_deg)
{
    uint8_t idx = static_cast<uint8_t>(joint);
    uint16_t us = angleToMicroseconds(joint, angle_deg);
    m_servos[idx].writeMicroseconds(us);
}

bool RoboticArm::allJointsAtTarget() const
{
    for (uint8_t i = 0; i < ARM_JOINT_COUNT; i++) {
        if (abs(m_current_joints[i] - m_target_joints[i]) >= 1.0f) {
            return false;
        }
    }
    return true;
}
