#include "MecanumDrive.h"
#include "config.h"
#include <algorithm>

MecanumDrive::MecanumDrive()
{
}

void MecanumDrive::compute(int16_t vx, int16_t vy, int16_t omega,
                            int16_t speeds[MOTOR_COUNT])
{
    // Mecanum inverse kinematics (X-pattern layout):
    //
    //   FL =  vx - vy + omega
    //   FR =  vx + vy - omega
    //   RL =  vx + vy + omega
    //   RR =  vx - vy - omega
    //
    // All values in PWM units (-255 to 255)

    int16_t fl = clampInt((int32_t)vx - (int32_t)vy + (int32_t)omega, -MECANUM_MAX_SPEED, MECANUM_MAX_SPEED);
    int16_t fr = clampInt((int32_t)vx + (int32_t)vy - (int32_t)omega, -MECANUM_MAX_SPEED, MECANUM_MAX_SPEED);
    int16_t rl = clampInt((int32_t)vx + (int32_t)vy + (int32_t)omega, -MECANUM_MAX_SPEED, MECANUM_MAX_SPEED);
    int16_t rr = clampInt((int32_t)vx - (int32_t)vy - (int32_t)omega, -MECANUM_MAX_SPEED, MECANUM_MAX_SPEED);

    speeds[MOTOR_FL] = fl;
    speeds[MOTOR_FR] = fr;
    speeds[MOTOR_RL] = rl;
    speeds[MOTOR_RR] = rr;

    normalize(speeds, MECANUM_MAX_SPEED);
}

void MecanumDrive::normalize(int16_t speeds[MOTOR_COUNT], int16_t max_val)
{
    int16_t max_abs = 0;
    for (int i = 0; i < MOTOR_COUNT; i++) {
        max_abs = std::max(max_abs, (int16_t)abs(speeds[i]));
    }
    if (max_abs > max_val && max_abs > 0) {
        float scale = (float)max_val / (float)max_abs;
        for (int i = 0; i < MOTOR_COUNT; i++) {
            speeds[i] = (int16_t)(speeds[i] * scale);
        }
    }
}

int16_t MecanumDrive::ramp(int16_t target, int16_t current, int16_t max_delta)
{
    int16_t diff = target - current;
    if (diff >  max_delta) return current + max_delta;
    if (diff < -max_delta) return current - max_delta;
    return target;
}

void MecanumDrive::stop(int16_t speeds[MOTOR_COUNT])
{
    for (int i = 0; i < MOTOR_COUNT; i++) speeds[i] = 0;
}

int16_t MecanumDrive::clampInt(int32_t val, int16_t min_val, int16_t max_val)
{
    if (val < min_val) return min_val;
    if (val > max_val) return max_val;
    return (int16_t)val;
}
