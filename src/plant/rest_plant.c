/*
 * M3 test plant: a quad resting level on the floor, motors captured but not
 * moving it. It exists only to bring Betaflight to arming and to watch the
 * motors answer the sticks. The real plant (RPM model, thrust, current, rigid
 * body, contact) replaces it in M4.
 *
 * Pack: the calibrated 65 mm bench build (data/bench/air65-analog-vci0702-30k.json
 * in quadmath), a 1S LiHV at rest at 4.20 V.
 *
 * This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
 */
#include "sc.h"

void sc_plant_init(void)
{
    for (int axis = 0; axis < 3; axis++) {
        sc_sensors.gyro_dps[axis] = 0.0;
        sc_sensors.acc_g[axis] = 0.0;
    }
    sc_sensors.acc_g[2] = 1.0;  // level, at rest: +1 g along body Z
    for (int i = 0; i < SC_MOTOR_COUNT; i++) {
        sc_sensors.erpm[i] = 0.0;
    }
    sc_sensors.vbat_v = 4.20;
    sc_sensors.current_a = 0.0;
}

void sc_plant_step(double dt_s)
{
    (void)dt_s;
}
