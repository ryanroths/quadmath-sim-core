/*
 * M3 test plant: a quad resting level on the floor, motors captured but not
 * moving it. It exists only to bring Betaflight to arming and to watch the
 * motors answer the sticks. The real plant (RPM model, thrust, current, rigid
 * body, contact) replaces it in M4.
 *
 * Pack: the calibrated 65 mm bench build (data/bench/air65-analog-vci0702-30k.json
 * in quadmath), a 1S LiHV at rest at 4.20 V. It does not drain; a carried pack
 * (sc_plant_battery_carry) rests at the carried voltage.
 *
 * This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
 */
#include <string.h>

#include "sc.h"

#define REST_PACK_FULL_V 4.20
#define GRAVITY_MS2 9.81

sc_plant_state_t sc_plant;

static void publishSensors(void)
{
    for (int axis = 0; axis < 3; axis++) {
        sc_sensors.gyro_dps[axis] = 0.0;
        sc_sensors.acc_g[axis] = sc_plant.specificForce[axis] / GRAVITY_MS2;
    }
    for (int i = 0; i < SC_MOTOR_COUNT; i++) {
        sc_sensors.erpm[i] = 0.0;
    }
    sc_sensors.vbat_v = sc_plant.vbatLoaded;
    sc_sensors.current_a = sc_plant.amps;
}

void sc_plant_init(void)
{
    memset(&sc_plant, 0, sizeof(sc_plant));
    sc_plant.quat[0] = 1.0;
    sc_plant.specificForce[2] = GRAVITY_MS2;    // level, at rest: the floor pushes up 1 g
    sc_plant.vbatLoaded = REST_PACK_FULL_V;
    sc_plant.vbatFiltered = REST_PACK_FULL_V;
    sc_plant.soc = 1.0;
    sc_plant.contactFlags = 1;                  // on the floor
    publishSensors();
}

void sc_plant_battery_carry(double soc, double vbat_filtered)
{
    sc_plant.soc = soc;
    sc_plant.vbatFiltered = vbat_filtered;
    sc_plant.vbatLoaded = vbat_filtered;    // at rest: no load, no sag
    publishSensors();
}

void sc_plant_step(double dt_s)
{
    (void)dt_s;
}
