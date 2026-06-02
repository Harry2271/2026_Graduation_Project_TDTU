#pragma once

#include <stdint.h>
#include "config.h"

class MecanumDrive {
public:
    MecanumDrive();

    // vx:     forward (+) / backward (-), -255 to 255
    // vy:     strafe right (+) / left (-), -255 to 255
    // omega:  rotate CW (+) / CCW (-), -255 to 255
    void compute(int16_t vx, int16_t vy, int16_t omega,
                 int16_t speeds[MOTOR_COUNT]);

    void stop(int16_t speeds[MOTOR_COUNT]);

    static void normalize(int16_t speeds[MOTOR_COUNT], int16_t max_val = 255);
    static int16_t ramp(int16_t target, int16_t current, int16_t max_delta);

private:
    static int16_t clampInt(int32_t val, int16_t min_val, int16_t max_val);
};
