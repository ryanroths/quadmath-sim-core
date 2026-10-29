/*
 * The plant (see plant.h for the three models and the block layout).
 *
 * The rigid body, layout, drag, ground effect and contact are ported from
 * quadmath's quadphysics.js, sim.html and sim-whoop.js (origin/main de9b15d,
 * "QP", "H" and "W" below). The physical motor and pack are the owner's M4
 * model (PROGRESS.md 2026-10-22 decisions):
 *
 *   motor   J dw/dt = Kt (u V - w / Kv) / R - kq w|w|      (KV x effective
 *           voltage, first-order lag, loaded by prop drag torque)
 *   prop    thrust = kt w|w|, reaction torque on the frame
 *           = -spin (kq w|w| + J dw/dt): the prop's drag and the rotor's own
 *           acceleration (owner decision 2026-10-23)
 *   pack    V = OCV(SoC) - I x cell IR, I = bench current x duty / reference
 *           duty, the reference being the hover duty on a full pack that sags
 *           at the bench current
 *
 * kt is fixed by the airframe's full thrust tmax at w_full = loadFraction x KV
 * x vRefCell, kq by kqRatio on that thrust (yaw torque at full speed), R by
 * loadFraction taken as the static full-throttle point, and J by the motor
 * time constant tau at hover. airframes/air65.json cites where each input
 * comes from (for the Air65, tmax carries the thrust coefficient measured in
 * the owner's bench hover, and loadFraction is that hover's measured ratio;
 * kqRatio and tau are quadmath's).
 *
 * Frames: quadmath's module frame, X forward, Y left, Z up (QP:3). Body rates
 * in that frame are Betaflight's gyro axes directly: roll + right wing down,
 * pitch + nose down, yaw + nose left (Betaflight target/SITL/sitl.c:142-145).
 *
 * This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
 */
#include <math.h>
#include <string.h>

#include "sc.h"
#include "plant.h"

#define TWO_PI 6.283185307179586
#define RPM_PER_RAD_S (60.0 / TWO_PI)
#define FLOOR_PAD_M 0.01            // QP:90 FLOOR_CLEARANCE_M
#define DIVERGED_RAD_S 200.0        // PROGRESS.md deliberate change 6
#define GROUND_SCRUB 7.3            // H:3199, per second (as world.c TUMBLE_DECAY)
#define FOOTPRINT_POINTS 5
#define HULL_BOXES 4                // solids held off by the footprint's hull, a tick
#define HULL_PASSES 4               // top-ups of the hull contacts' pushes, a tick
#define DUCT_RIMS 2                 // a duct's side: its bottom and top rims
#define WALL_NORMALS 4              // the vertical faces a box has: -x, +x, -y, +y
#define EDGE_POINTS 16              // duct sides into a box's vertical edge, a tick
#define NEAR_LEVELS 8               // box tops and bottoms within the rims' height looked at, a tick
#define LEVEL_POINTS 32             // duct sides just above a top or below a bottom, a tick
#define LEVEL_EPS 2e-5              // m past a top or bottom: past world.c's 5 um seam window
#define NEAR_EDGES 128              // vertical edges of the boxes near the quad looked at, a tick
#define SIDE_POINTS (SC_MOTOR_COUNT * DUCT_RIMS * WALL_NORMALS + SC_MOTOR_COUNT + EDGE_POINTS + LEVEL_POINTS)
// The points, the ducts' side points, the points the points' push carried
// into the solid, up to SC_HULL_HOLD hold points for each hull contact, the
// points again after the hull's push.
#define CONTACTS (FOOTPRINT_POINTS + SIDE_POINTS + FOOTPRINT_POINTS + SC_HULL_HOLD * HULL_BOXES + FOOTPRINT_POINTS)
#define CONTACT_SWEEPS 32
#define PINCH_BIAS_MAX 0.1          // m/s: a contact's push left undone is moved out no faster
#define SLIP_MIN 1e-6               // m/s: a contact arriving slower along the surface is static
#define CARRY_MIN 1e-4              // m (world.c ON_FACE_WU): a carry the next tick's resolution reaches
#define CONTACT_SPIN_CAP 150.0      // rad/s, below the divergence guard (as world.c)
#define ON_FACE_M 1e-4              // m (world.c ON_FACE_WU): on a face

sc_plant_state_t sc_plant;

static int model = SC_MODEL_REST;
static double blk[PB_LEN];
static double derived[PD_LEN];
static bool mode3d;
static bool propsOut;

// Motor layout, Betaflight QUADX order (QP:425-432): positions per axis and
// spin seen from the top, +1 counter-clockwise. Props-in by default; Betaflight
// yaw_motors_reversed flips every spin (props-out).
static const double MOTOR_X[SC_MOTOR_COUNT] = { -1, 1, -1, 1 };
static const double MOTOR_Y[SC_MOTOR_COUNT] = { -1, -1, 1, 1 };
static const double SPIN_PROPS_IN[SC_MOTOR_COUNT] = { -1, 1, 1, -1 };

// Rigid body and actuators.
static double omegaMotor[SC_MOTOR_COUNT];   // physical: rotor speed, rad/s, signed
static double motorAccel[SC_MOTOR_COUNT];   // physical: rotor dw/dt this tick, rad/s^2
static double spoolOut[SC_MOTOR_COUNT];     // parity: quadmath motor output, signed
// Physical: the actuator stage (PB_MOTOR_DELAY, PB_ELEC_TAU). The delay line
// holds the last delayTicks commanded duties per motor; dutyElec is the duty
// after the electrical lag.
#define SC_DELAY_TICKS_MAX 64
static double dutyLine[SC_DELAY_TICKS_MAX][SC_MOTOR_COUNT];
static int dutyLineAt;
static int delayTicks;
static double dutyElec[SC_MOTOR_COUNT];
static double thrust[SC_MOTOR_COUNT];       // N, before ground effect
static double battCharge;                   // parity battery state
static double battVoltage;

static double override[SC_MOTOR_COUNT];     // NAN = Betaflight drives the motor
static bool posePending;
static double poseNext[10];

static double clampd(double v, double lo, double hi)
{
    return v < lo ? lo : v > hi ? hi : v;
}

static double spin(int i)
{
    return propsOut ? -SPIN_PROPS_IN[i] : SPIN_PROPS_IN[i];
}

// v' = q v q* for q = (w, x, y, z) body to world (QP:145-156).
static void qRotate(const double q[4], const double v[3], double out[3])
{
    const double w = q[0], x = q[1], y = q[2], z = q[3];
    const double tx = 2 * (y * v[2] - z * v[1]);
    const double ty = 2 * (z * v[0] - x * v[2]);
    const double tz = 2 * (x * v[1] - y * v[0]);
    out[0] = v[0] + w * tx + (y * tz - z * ty);
    out[1] = v[1] + w * ty + (z * tx - x * tz);
    out[2] = v[2] + w * tz + (x * ty - y * tx);
}

static void qRotateInverse(const double q[4], const double v[3], double out[3])
{
    const double qc[4] = { q[0], -q[1], -q[2], -q[3] };
    qRotate(qc, v, out);
}

// First-order quaternion step with the new body rates, then normalise (QP:165-175).
static void qIntegrate(double q[4], const double om[3], double dt)
{
    const double hx = om[0] * dt * 0.5, hy = om[1] * dt * 0.5, hz = om[2] * dt * 0.5;
    const double dx = q[0] * hx + q[2] * hz - q[3] * hy;
    const double dy = q[0] * hy + q[3] * hx - q[1] * hz;
    const double dz = q[0] * hz + q[1] * hy - q[2] * hx;
    const double dw = -q[1] * hx - q[2] * hy - q[3] * hz;
    q[1] += dx;
    q[2] += dy;
    q[3] += dz;
    q[0] += dw;
    double n = sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
    if (!(n > 0)) {
        n = 1;
    }
    for (int i = 0; i < 4; i++) {
        q[i] /= n;
    }
}

// Open-circuit voltage per cell, linear between the seven SoC points (W:160-176).
// Below SoC 0 (a physical pack past its capacity; the parity battery stops at
// 0) it follows the over-discharge points down to SC_SOC_FLOOR.
static double ocvCell(double soc)
{
    static const double SOC[7] = { 0.00, 0.05, 0.15, 0.40, 0.70, 0.90, 1.00 };
    static const double OVER[4] = { 0.00, -0.05, -0.10, -0.15 };
    if (soc < 0) {
        const double u = fmax(soc, SC_SOC_FLOOR);
        double hi = blk[PB_OCV];
        for (int i = 0; i < 3; i++) {
            const double lo = blk[PB_OCV_OVER + i];
            if (u >= OVER[i + 1]) {
                return hi + (lo - hi) * ((OVER[i] - u) / (OVER[i] - OVER[i + 1]));
            }
            hi = lo;
        }
        return blk[PB_OCV_OVER + 2];
    }
    const double u = clampd(soc, 0, 1);
    for (int i = 0; i < 6; i++) {
        if (u >= SOC[i] && u <= SOC[i + 1]) {
            const double span = SOC[i + 1] - SOC[i];
            return blk[PB_OCV + i] + (blk[PB_OCV + i + 1] - blk[PB_OCV + i]) * ((u - SOC[i]) / span);
        }
    }
    return blk[PB_OCV + 6];
}

static void derive(void)
{
    const double m = blk[PB_MASS], wb = blk[PB_WHEELBASE], h = wb * blk[PB_BOX_HEIGHT_RATIO];
    // Flat-box inertia (QP:434-440) and the quad-X arm (QP:425).
    derived[PD_IXX] = (m / 12) * (wb * wb + h * h);
    derived[PD_IYY] = (m / 12) * (wb * wb + h * h);
    derived[PD_IZZ] = (m / 12) * (wb * wb * 2);
    derived[PD_ARM] = wb / (2 * sqrt(2.0));
    if (model != SC_MODEL_PHYSICAL) {
        return;
    }
    const double cells = blk[PB_CELLS];
    const double kv = blk[PB_KV] * TWO_PI / 60;
    const double ktMotor = 1 / kv;
    const double vRef = blk[PB_V_REF_CELL] * cells;
    const double lf = blk[PB_LOAD_FRACTION];
    const double wFull = lf * kv * vRef;
    const double ktProp = blk[PB_TMAX] / (wFull * wFull);
    const double kqProp = blk[PB_KQ_RATIO] * (wb / 2) * ktProp;
    // At full throttle the motor torque Kt (V - w/Kv) / R meets the prop's
    // kq w^2 at w = lf x Kv x V.
    const double r = ktMotor * vRef * (1 - lf) / (kqProp * wFull * wFull);
    const double wHover = sqrt(m * blk[PB_GRAVITY] / (4 * ktProp));
    // Small-signal time constant of J dw/dt = Kt (V - w/Kv) / R - kq w^2 at hover.
    const double j = blk[PB_TAU] * (ktMotor / (r * kv) + 2 * kqProp * wHover);
    derived[PD_KV_RAD] = kv;
    derived[PD_KT_MOTOR] = ktMotor;
    derived[PD_OMEGA_FULL] = wFull;
    derived[PD_KT_PROP] = ktProp;
    derived[PD_KQ_PROP] = kqProp;
    derived[PD_R_WINDING] = r;
    derived[PD_J_ROTOR] = j;
    derived[PD_OMEGA_HOVER] = wHover;
    const double vHover = wHover / kv + r * kqProp * wHover * wHover / ktMotor;
    derived[PD_DUTY_HOVER] = vHover / vRef;
    derived[PD_AMPS_FULL] = blk[PB_I_QUIESCENT] + blk[PB_I_HOVER] * pow(wFull * RPM_PER_RAD_S / blk[PB_RPM_HOVER], blk[PB_CURRENT_EXP]);
    delayTicks = (int)lround(blk[PB_MOTOR_DELAY] * SC_LOOP_HZ);
}

// rate: what the gyro reads, rad/s, body frame. A tick passes the rate the
// attitude turned with (sc_plant_step); everything else, the body rate.
static void publishSensors(const double rate[3])
{
    const double g = model == SC_MODEL_REST ? 9.81 : blk[PB_GRAVITY];
    for (int axis = 0; axis < 3; axis++) {
        sc_sensors.gyro_dps[axis] = rate[axis] * (360.0 / TWO_PI);
        sc_sensors.acc_g[axis] = sc_plant.specificForce[axis] / g;
    }
    for (int i = 0; i < SC_MOTOR_COUNT; i++) {
        sc_sensors.rpm[i] = sc_plant.rpm[i];
    }
    sc_sensors.vbat_v = sc_plant.vbatLoaded;
    sc_sensors.current_a = sc_plant.amps;
}

static double restHeightAt(const double q[4]);

// At rest on the floor, level, motors stopped, full pack.
static void restState(void)
{
    const double floorZ = sc_world_floor_z();
    memset(sc_plant.vel, 0, sizeof(sc_plant.vel));
    memset(sc_plant.omega, 0, sizeof(sc_plant.omega));
    memset(sc_plant.motorOut, 0, sizeof(sc_plant.motorOut));
    memset(sc_plant.rpm, 0, sizeof(sc_plant.rpm));
    memset(sc_plant.thrustN, 0, sizeof(sc_plant.thrustN));
    memset(omegaMotor, 0, sizeof(omegaMotor));
    memset(motorAccel, 0, sizeof(motorAccel));
    memset(spoolOut, 0, sizeof(spoolOut));
    memset(thrust, 0, sizeof(thrust));
    memset(dutyLine, 0, sizeof(dutyLine));
    dutyLineAt = 0;
    memset(dutyElec, 0, sizeof(dutyElec));
    // The physical model stands on its duct bottoms; quadmath's CG point
    // stands FLOOR_PAD_M up (QP:90), the same 10 mm for the Air65.
    static const double level[4] = { 1, 0, 0, 0 };
    const double rest = restHeightAt(level);
    sc_world_set_rest_height(rest);
    sc_plant.pos[0] = 0;
    sc_plant.pos[1] = 0;
    sc_plant.pos[2] = floorZ + rest;
    sc_plant.quat[0] = 1;
    sc_plant.quat[1] = sc_plant.quat[2] = sc_plant.quat[3] = 0;
    sc_plant.specificForce[0] = sc_plant.specificForce[1] = 0;
    sc_plant.specificForce[2] = model == SC_MODEL_REST ? 9.81 : blk[PB_GRAVITY];
    sc_plant.amps = 0;
    sc_plant.mah = 0;
    sc_plant.soc = 1;
    sc_plant.groundClearance = 0;
    sc_plant.airborne = false;
    sc_plant.contactFlags = 1;
    battCharge = 1;
    if (model == SC_MODEL_REST) {
        sc_plant.vbatLoaded = 4.20;
    } else {
        sc_plant.vbatLoaded = ocvCell(1) * blk[PB_CELLS];
    }
    battVoltage = sc_plant.vbatLoaded;
    sc_plant.vbatFiltered = sc_plant.vbatLoaded;
    // Spawning inside a trigger or on the floor is not an entry.
    sc_world_pose_sync(sc_plant.pos);
}

void sc_plant_override(int motor, double duty)
{
    const double d = duty >= -1 && duty <= 1 ? duty : NAN;
    for (int i = 0; i < SC_MOTOR_COUNT; i++) {
        if (motor < 0 || motor == i) {
            override[i] = d;
        }
    }
}

void sc_plant_init(void)
{
    memset(&sc_plant, 0, sizeof(sc_plant));
    model = SC_MODEL_REST;
    sc_plant_override(-1, NAN);
    posePending = false;
    sc_world_reset();
    restState();
    publishSensors(sc_plant.omega);
}

int sc_plant_configure(const double *block, int count)
{
    if (!block || count != PB_LEN) {
        return SC_ERR_BAD_ARG;
    }
    for (int i = 0; i < PB_LEN; i++) {
        if (!isfinite(block[i])) {
            return SC_ERR_BAD_ARG;
        }
    }
    const int m = (int)block[PB_MODEL];
    if (m != block[PB_MODEL] || m < SC_MODEL_REST || m > SC_MODEL_PARITY) {
        return SC_ERR_BAD_ARG;
    }
    if (m != SC_MODEL_REST) {
        if (!(block[PB_MASS] > 0 && block[PB_WHEELBASE] > 0 && block[PB_PROP_DIAMETER] > 0 && block[PB_TMAX] > 0
              && block[PB_TAU] > 0 && block[PB_GRAVITY] > 0 && block[PB_CELLS] >= 1)) {
            return SC_ERR_BAD_ARG;
        }
        if (m == SC_MODEL_PHYSICAL && !(block[PB_KV] > 0 && block[PB_V_REF_CELL] > 0 && block[PB_LOAD_FRACTION] > 0
                                        && block[PB_LOAD_FRACTION] < 1 && block[PB_KQ_RATIO] > 0
                                        && block[PB_CAPACITY_MAH] > 0 && block[PB_I_HOVER] >= 0 && block[PB_CELL_IR] >= 0
                                        && block[PB_DUCT_RADIUS] > 0 && block[PB_HULL_BELOW] > 0
                                        && block[PB_HULL_ABOVE] > 0 && block[PB_RPM_HOVER] > 0
                                        && block[PB_CURRENT_EXP] > 0 && block[PB_I_QUIESCENT] >= 0
                                        && block[PB_MOTOR_DELAY] >= 0
                                        && block[PB_MOTOR_DELAY] * SC_LOOP_HZ < SC_DELAY_TICKS_MAX + 0.5
                                        && block[PB_ELEC_TAU] >= 0
                                        && block[PB_OCV_OVER] >= 0 && block[PB_OCV_OVER] <= block[PB_OCV]
                                        && block[PB_OCV_OVER + 1] >= 0 && block[PB_OCV_OVER + 1] <= block[PB_OCV_OVER]
                                        && block[PB_OCV_OVER + 2] >= 0 && block[PB_OCV_OVER + 2] <= block[PB_OCV_OVER + 1]
                                        && block[PB_DUCT_HEIGHT] >= 0 && block[PB_WALL_FRICTION] >= 0
                                        && block[PB_WALL_RESTITUTION] >= 0 && block[PB_WALL_RESTITUTION] <= 1)) {
            return SC_ERR_BAD_ARG;
        }
    }
    double prevBlk[PB_LEN];
    memcpy(prevBlk, blk, sizeof(blk));
    const int prevModel = model;
    memcpy(blk, block, sizeof(blk));
    model = m;
    memset(derived, 0, sizeof(derived));
    derive();
    // A pack that can hold the hover current (quiescent plus motors): the
    // reference's reachable duty, on the lower root of u (V - I(u) R) = hover
    // volts, needs hover current x cellIR at
    // most half the full-pack voltage. Otherwise refuse and keep the old block.
    if (m == SC_MODEL_PHYSICAL
        && !(2 * (blk[PB_I_HOVER] + blk[PB_I_QUIESCENT]) * blk[PB_CELL_IR] <= blk[PB_OCV + 6])) {
        memcpy(blk, prevBlk, sizeof(blk));
        model = prevModel;
        memset(derived, 0, sizeof(derived));
        derive();
        return SC_ERR_BAD_ARG;
    }
    restState();
    publishSensors(sc_plant.omega);
    return SC_OK;
}

const double *sc_plant_derived(void)
{
    return derived;
}

int sc_plant_model(void)
{
    return model;
}

void sc_plant_follow_betaflight(bool is3d, bool isPropsOut)
{
    mode3d = is3d;
    propsOut = isPropsOut;
}

void sc_plant_battery_carry(double soc, double vbat_filtered)
{
    sc_plant.soc = soc;
    battCharge = soc;
    if (model == SC_MODEL_PHYSICAL) {
        // The physical pack's state is its charge; its voltage follows from it.
        sc_plant.vbatLoaded = ocvCell(soc) * blk[PB_CELLS];
    } else {
        sc_plant.vbatLoaded = vbat_filtered;    // rest plant, parity: as carried
    }
    battVoltage = sc_plant.vbatLoaded;
    sc_plant.vbatFiltered = sc_plant.vbatLoaded;
    publishSensors(sc_plant.omega);
}

void sc_plant_floor_moved(void)
{
    if (model == SC_MODEL_REST) {
        sc_plant.pos[2] = sc_world_floor_z() + FLOOR_PAD_M;
    }
    sc_world_set_rest_height(restHeightAt(sc_plant.quat));
    sc_world_edge_sync(sc_plant.pos);
}

void sc_plant_pose(const double pos[3], const double quat[4], const double vel[3])
{
    memcpy(poseNext, pos, 3 * sizeof(double));
    memcpy(poseNext + 3, quat, 4 * sizeof(double));
    memcpy(poseNext + 7, vel, 3 * sizeof(double));
    posePending = true;
}

// DShot value and spin direction to a signed duty -1..1 (PROGRESS.md "Motor
// command decoding"; Betaflight drivers/dshot.c dshotConvertFromExternal).
static double dutyOf(int i)
{
    if (!isnan(override[i])) {
        return override[i];
    }
    const double v = sc_motor_value[i];
    if (!sc_motors_enabled || v < 48) {
        return 0;
    }
    if (mode3d) {
        return v >= 1048 ? clampd((v - 1048) / 999.0, 0, 1) : -clampd((v - 48) / 999.0, 0, 1);
    }
    return clampd((v - 48) / 1999.0, 0, 1) * (sc_motor_dir[i] < 0 ? -1 : 1);
}

// Body drag (QP:202-243): quadratic in |v| per body axis (frontal X/Y, plan
// Z), the linear skin term and the disc multiplier, all from the block.
static void dragForce(const double vWorld[3], const double q[4], double meanOut, double fWorld[3])
{
    double vb[3];
    qRotateInverse(q, vWorld, vb);
    const double t = clampd(meanOut, 0, 1);
    const double chop = blk[PB_DISC_END] > 0 ? fmax(0, 1 - t / blk[PB_DISC_END]) : 0;
    const double disc = 1 + blk[PB_DISC_K] * chop * chop;
    const double speed = sqrt(vb[0] * vb[0] + vb[1] * vb[1] + vb[2] * vb[2]);
    const double qd = 0.5 * blk[PB_AIR_DENSITY] * speed;
    const double fb[3] = {
        -(qd * blk[PB_CDA_FRONT] * disc + blk[PB_SKIN_B]) * vb[0],
        -(qd * blk[PB_CDA_FRONT] * disc + blk[PB_SKIN_B]) * vb[1],
        -(qd * blk[PB_CDA_PLAN] * disc + blk[PB_SKIN_B]) * vb[2],
    };
    qRotate(q, fb, fWorld);
}

// The actuator: the duty Betaflight commands this tick in; out, the duty the
// ESC switches (after a delay of delayTicks whole ticks: a ring of commanded
// duties, zero after a reset) and the drive the winding sees (after the
// electrical lag, backward Euler as the parity spool, stepParity). Either
// stage at 0 passes its input through untouched.
static void actuate(const double cmd[SC_MOTOR_COUNT], double esc[SC_MOTOR_COUNT], double out[SC_MOTOR_COUNT],
                    double dt)
{
    for (int i = 0; i < SC_MOTOR_COUNT; i++) {
        esc[i] = cmd[i];
    }
    if (delayTicks > 0) {
        for (int i = 0; i < SC_MOTOR_COUNT; i++) {
            const double late = dutyLine[dutyLineAt][i];
            dutyLine[dutyLineAt][i] = cmd[i];
            esc[i] = late;
        }
        dutyLineAt = (dutyLineAt + 1) % delayTicks;
    }
    const double tau = blk[PB_ELEC_TAU];
    for (int i = 0; i < SC_MOTOR_COUNT; i++) {
        out[i] = esc[i];
    }
    if (tau > 0) {
        for (int i = 0; i < SC_MOTOR_COUNT; i++) {
            dutyElec[i] += (esc[i] - dutyElec[i]) * (dt / (tau + dt));
            out[i] = dutyElec[i];
        }
    }
}

// Physical motors and pack for one tick. Returns nothing; fills thrust[].
static void stepPhysical(const double cmd[SC_MOTOR_COUNT], double dt)
{
    // The actuator stage (off by default): esc, the duty each ESC switches
    // this tick, which decides whether the pack supplies its motor; duty, the
    // drive its winding sees.
    double esc[SC_MOTOR_COUNT];
    double duty[SC_MOTOR_COUNT];
    actuate(cmd, esc, duty, dt);
    const double cells = blk[PB_CELLS];
    // Pack current (owner decisions 2026-10-23, from the hover and punch logs):
    // the quiescent current (the electronics, motors or not), plus each rotor's
    // quarter of the motor current at hover, scaled by (rpm / rpm at
    // hover)^exponent; last tick's rpm.
    // A rotor at duty 0 draws nothing from the pack: the averaged motor below
    // sees duty x pack voltage, so at duty 0 its winding is shorted and brakes
    // the rotor, and its ESC draws duty x the winding current, none. Duty 0 is
    // DShot 0 (disarmed, motor stop, crash flip's idle pair) and DShot 48, the
    // armed floor under dynamic idle (flight/mixer_init.c:342-343); one step
    // up, the power law applies in full.
    double amps = blk[PB_I_QUIESCENT];
    for (int i = 0; i < SC_MOTOR_COUNT; i++) {
        if (esc[i] == 0) continue;
        const double rpm = fabs(omegaMotor[i]) * RPM_PER_RAD_S;
        amps += 0.25 * blk[PB_I_HOVER] * pow(rpm / blk[PB_RPM_HOVER], blk[PB_CURRENT_EXP]);
    }
    const double volts = fmax(0, ocvCell(sc_plant.soc) * cells - amps * blk[PB_CELL_IR] * cells);
    sc_plant.amps = amps;
    sc_plant.vbatLoaded = volts;
    sc_plant.vbatFiltered = volts;
    sc_plant.mah += amps * dt / 3.6;
    sc_plant.soc = fmax(SC_SOC_FLOOR, sc_plant.soc - amps * dt / (blk[PB_CAPACITY_MAH] * 3.6));

    const double kv = derived[PD_KV_RAD], kt = derived[PD_KT_MOTOR], r = derived[PD_R_WINDING];
    const double j = derived[PD_J_ROTOR], ktProp = derived[PD_KT_PROP], kqProp = derived[PD_KQ_PROP];
    const double a = kt / (j * r);
    for (int i = 0; i < SC_MOTOR_COUNT; i++) {
        const double before = omegaMotor[i];
        double w = before;
        // Back-EMF term implicit (it is the stiff part), prop drag explicit.
        w = (w + dt * (a * duty[i] * volts - kqProp * w * fabs(w) / j)) / (1 + dt * a / kv);
        omegaMotor[i] = w;
        motorAccel[i] = (w - before) / dt;
        const double t = ktProp * w * fabs(w);
        thrust[i] = w < 0 ? t * blk[PB_REVERSE_SCALE] : t;
        sc_plant.motorOut[i] = w / derived[PD_OMEGA_FULL];
        sc_plant.rpm[i] = fabs(w) * RPM_PER_RAD_S;
    }
}

// quadmath's motor spool, thrust and battery, for P2 and P3 (QP:283-305,
// W:181-207). The battery runs when PB_HOVER_SECONDS > 0.
static void stepParity(const double duty[SC_MOTOR_COUNT], double dt)
{
    double sagFactor = 1;
    if (blk[PB_HOVER_SECONDS] > 0) {
        // Load is last tick's |thrust| over full thrust (H:4191-4192).
        double load = 0;
        for (int i = 0; i < SC_MOTOR_COUNT; i++) {
            load += fabs(sc_plant.thrustN[i]);
        }
        load = clampd(load / (SC_MOTOR_COUNT * blk[PB_TMAX]), 0, 1);
        const double hoverS = fmax(20, blk[PB_HOVER_SECONDS]);
        battCharge = fmax(0, battCharge - dt * (0.25 + 1.5 * load) / hoverS);
        const double ocv = ocvCell(battCharge) * blk[PB_CELLS];
        const double ir = blk[PB_SAG_DROP] * blk[PB_SAG_SCALE] * (1.0 + 0.35 * (1 - battCharge));
        const double vInst = ocv - load * ir;
        battVoltage = battVoltage + (vInst - battVoltage) * (dt / (0.15 + dt));
        const double full = blk[PB_OCV + 6] * blk[PB_CELLS];
        const double f = fmax(0.45, battVoltage / full);
        sagFactor = f * f;
        sc_plant.soc = battCharge;
        sc_plant.vbatLoaded = battVoltage;
        sc_plant.vbatFiltered = battVoltage;
    }
    const double base = blk[PB_TAU];
    for (int i = 0; i < SC_MOTOR_COUNT; i++) {
        const double cmd = duty[i];
        double out = spoolOut[i];
        const bool sameSign = cmd == 0 || out == 0 || (cmd < 0) == (out < 0);
        const bool speedingUp = sameSign && fabs(cmd) > fabs(out);
        const double tau = speedingUp ? base : base * blk[PB_TAU_DOWN_MULT];
        out += (cmd - out) * (dt / (tau + dt));
        spoolOut[i] = out;
        const double mag = fabs(out);
        double t = 0;
        if (mag >= 1e-12) {
            t = (out < 0 ? -blk[PB_REVERSE_SCALE] : 1) * blk[PB_TMAX] * sagFactor * mag * mag;
        }
        thrust[i] = t;
        sc_plant.motorOut[i] = out;
        sc_plant.rpm[i] = 0;
    }
}

static bool finite3(const double v[3])
{
    return isfinite(v[0]) && isfinite(v[1]) && isfinite(v[2]);
}

static double dot3(const double a[3], const double b[3])
{
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

static void cross3(const double a[3], const double b[3], double out[3])
{
    out[0] = a[1] * b[2] - a[2] * b[1];
    out[1] = a[2] * b[0] - a[0] * b[2];
    out[2] = a[0] * b[1] - a[1] * b[0];
}

// The inverse inertia in the world frame applied to v: R I^-1 R^T v.
static void invInertiaWorld(const double q[4], const double v[3], double out[3])
{
    double vb[3];
    qRotateInverse(q, v, vb);
    vb[0] /= derived[PD_IXX];
    vb[1] /= derived[PD_IYY];
    vb[2] /= derived[PD_IZZ];
    qRotate(q, vb, out);
}

// The velocity change at offset r from the CG (world frame) for an impulse
// j there: K j = j / m + (I^-1 (r x j)) x r.
static void contactResponse(const double q[4], const double r[3], const double j[3], double out[3])
{
    double rj[3], w[3], wr[3];
    cross3(r, j, rj);
    invInertiaWorld(q, rj, w);
    cross3(w, r, wr);
    for (int a = 0; a < 3; a++) {
        out[a] = j[a] / blk[PB_MASS] + wr[a];
    }
}

// The impulse j at offset r that changes that point's velocity by e: K j = e,
// K symmetric positive definite, solved by Cramer's rule.
static void contactImpulse(const double q[4], const double r[3], const double e[3], double j[3])
{
    double k[3][3];
    for (int c = 0; c < 3; c++) {
        double unit[3] = { 0, 0, 0 }, col[3];
        unit[c] = 1;
        contactResponse(q, r, unit, col);
        for (int row = 0; row < 3; row++) {
            k[row][c] = col[row];
        }
    }
    const double det = k[0][0] * (k[1][1] * k[2][2] - k[1][2] * k[2][1])
                       - k[0][1] * (k[1][0] * k[2][2] - k[1][2] * k[2][0])
                       + k[0][2] * (k[1][0] * k[2][1] - k[1][1] * k[2][0]);
    for (int c = 0; c < 3; c++) {
        double m[3][3];
        for (int row = 0; row < 3; row++) {
            for (int col = 0; col < 3; col++) {
                m[row][col] = col == c ? e[row] : k[row][col];
            }
        }
        j[c] = (m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
                + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]))
               / det;
    }
}

// The footprint in the body frame: the duct rims on the arm diagonals at the
// duct bottom, and the canopy top.
static void footprintBody(double body[FOOTPRINT_POINTS][3])
{
    const double reach = (blk[PB_WHEELBASE] * 0.5 + blk[PB_DUCT_RADIUS]) * sqrt(0.5);
    for (int i = 0; i < SC_MOTOR_COUNT; i++) {
        body[i][0] = MOTOR_X[i] * reach;
        body[i][1] = MOTOR_Y[i] * reach;
        body[i][2] = -blk[PB_HULL_BELOW];
    }
    body[4][0] = 0;
    body[4][1] = 0;
    body[4][2] = blk[PB_HULL_ABOVE];
}

// The CG's height above the floor when the lowest footprint point at attitude
// q touches it (hullBelow when level, hullAbove inverted): the rest height a
// pose or a floor move judges "on the floor" by. The other models rest their
// CG point FLOOR_PAD_M up whatever the attitude.
static double restHeightAt(const double q[4])
{
    if (model != SC_MODEL_PHYSICAL) {
        return FLOOR_PAD_M;
    }
    double body[FOOTPRINT_POINTS][3];
    footprintBody(body);
    double drop = -INFINITY;
    for (int k = 0; k < FOOTPRINT_POINTS; k++) {
        double r[3];
        qRotate(q, body[k], r);
        drop = fmax(drop, -r[2]);
    }
    return drop;
}

// A quantity round a duct's rim, a cos t + b sin t + c at the angle t from the
// body's x axis: how far a rim point is past a face, or its height. Each is
// one of these whatever the attitude, so its extremes and zeros are exact.
typedef struct {
    double a, b, c;
} scWave_t;

static double waveAt(const scWave_t *w, double t)
{
    return w->a * cos(t) + w->b * sin(t) + w->c;
}

// The wave at a linear measure of the rim's points: its value at the rim's
// centre (c), and along the rim's two in-plane axes times the radius.
static scWave_t waveOf(double centre, double alongX, double alongY, double radius)
{
    const scWave_t w = { radius * alongX, radius * alongY, centre };
    return w;
}

// The angles where w is v, appended at out; returns how many (0 or 2).
static int waveCrossing(const scWave_t *w, double v, double *out)
{
    const double m = hypot(w->a, w->b);
    if (!(m > 0) || fabs(w->c - v) > m) {
        return 0;
    }
    const double th = atan2(w->b, w->a), d = acos((v - w->c) / m);
    out[0] = th + d;
    out[1] = th - d;
    return 2;
}

// A duct's rim (0 bottom, 1 top) reaching toward a horizontal direction
// (world frame): the rim's point furthest that way, in the body frame. False
// when the rim lies square to it (the quad on its side against a wall: the
// rim is flat on it, and has no furthest point).
static bool rimToward(int motor, int rim, const double q[4], const double toward[3], double body[3])
{
    double tb[3];
    qRotateInverse(q, toward, tb);
    const double tl = hypot(tb[0], tb[1]);
    if (!(tl > 1e-6)) {
        return false;
    }
    body[0] = MOTOR_X[motor] * derived[PD_ARM] + blk[PB_DUCT_RADIUS] * tb[0] / tl;
    body[1] = MOTOR_Y[motor] * derived[PD_ARM] + blk[PB_DUCT_RADIUS] * tb[1] / tl;
    body[2] = -blk[PB_HULL_BELOW] + rim * blk[PB_DUCT_HEIGHT];
    return true;
}

// A duct's side point's push joins the CG's (the largest each way per axis),
// except down when the footprint stands on the floor or a box top this tick:
// squeezed into a slot lower than the quad, a top rim under the upper plate
// pushed the CG down and carried the rims 2 um into the lower plate. The
// floor wins; what the push leaves undone moves out as a pinch does (bias).
static void sidePush(const double push[3], bool floored, double hi[3], double lo[3])
{
    for (int a = 0; a < 3; a++) {
        hi[a] = fmax(hi[a], push[a]);
        if (!(a == 2 && floored)) {
            lo[a] = fmin(lo[a], push[a]);
        }
    }
}

// A duct's side point (body frame) against the box faces in faceMask among
// the boxes near the quad (world.c): when the world pushes it or turns its
// velocity, one contact as a footprint point's (rw, normal, target, slip,
// mu, push). Returns the world's flags; *added says the contact was made.
static uint32_t sideContact(const double body[3], int faceMask, const double p[3], const double v[3], const double q[4],
                            const double omW[3], const double p0[3], const double q0[4], double dt, double rw[3],
                            double normal[3], double target[3], double slip[3], double *mu, double push[3], bool *added)
{
    double rs[3], wxr[3], pt[3], vt[3], st[3];
    *added = false;
    // How far past the footprint this point can lead into a wall: a rim
    // reaches R (1 - cos 45 degrees) past the arm diagonal in its own plane,
    // and the top rim leads the bottom by the duct's height times its lean
    // (a top rim come down past a box's side 5.8 mm in, at 0.4 rad of roll,
    // was past a level band and never answered).
    {
        static const double BZ[3] = { 0, 0, 1 };
        double ez[3];
        qRotate(q, BZ, ez);
        const bool top = body[2] > -blk[PB_HULL_BELOW] + 0.5 * blk[PB_DUCT_HEIGHT];
        sc_world_set_side_reach(blk[PB_DUCT_RADIUS] * (1 - sqrt(0.5)) + (top ? blk[PB_DUCT_HEIGHT] * hypot(ez[0], ez[1]) : 0));
    }
    qRotate(q, body, rw);
    qRotate(q0, body, rs);
    cross3(omW, rw, wxr);
    for (int a = 0; a < 3; a++) {
        pt[a] = p[a] + rw[a];
        vt[a] = v[a] + wxr[a];
        st[a] = p0[a] + rs[a];
    }
    const double ptIn[3] = { pt[0], pt[1], pt[2] };
    const double vtIn[3] = { vt[0], vt[1], vt[2] };
    bool floorHit = false, scrub = false, wall = false;
    const uint32_t f = sc_world_point(pt, vt, st, dt, blk[PB_BOUNCE_SCALE], blk[PB_CRASH_SCALE], blk[PB_SPIN_SCALE],
                                      faceMask, blk[PB_WALL_RESTITUTION], &floorHit, &scrub, &wall);
    if (!f) {
        return 0;
    }
    double dp[3], dv[3];
    for (int a = 0; a < 3; a++) {
        dp[a] = pt[a] - ptIn[a];
        dv[a] = vt[a] - vtIn[a];
    }
    double len = sqrt(dot3(dp, dp));
    const double *dir = dp;
    if (!(len > 0)) {
        len = sqrt(dot3(dv, dv));
        dir = dv;
    }
    if (!(len > 0)) {
        return f;
    }
    for (int a = 0; a < 3; a++) {
        push[a] = dp[a];
        normal[a] = dir[a] / len;
        target[a] = vt[a];
    }
    const double vin = dot3(vtIn, normal);
    // A side point already leaving the face is only kept from moving into
    // it, not held at the speed it was leaving at (as the hull's contacts):
    // spun off a bench's end 8 m/s into it, ducts on its end and a leg's
    // side each held the speed they left at, fought through their lever
    // arms, and threw the quad to 13 m/s in a tick.
    if (vin >= 0) {
        const double tn = dot3(target, normal);
        for (int a = 0; a < 3; a++) {
            target[a] -= tn * normal[a];
        }
    }
    double sl[3];
    for (int a = 0; a < 3; a++) {
        sl[a] = vtIn[a] - vin * normal[a];
    }
    const double slen = sqrt(dot3(sl, sl));
    for (int a = 0; a < 3; a++) {
        slip[a] = slen > SLIP_MIN ? sl[a] / slen : 0;
    }
    *mu = wall ? blk[PB_WALL_FRICTION] : -1;
    *added = true;
    return f;
}

// Contact through the footprint (owner decision 2026-10-23): four points on
// the duct rims along the arm diagonals at the duct bottom, and the canopy
// top. Each point meets the floor and boxes through quadmath's CG point's
// resolution (world.c), without the floor pad or the spin kick, and with the
// footprint-only box rules its header lists (a box standing on the floor
// reaches down to it, an inner face needs the travel with no slack, and an
// inner face crossed inside the solid ranks last); what the world does to
// the point becomes a rigid-body response through its lever arm:
//   - every point is tested on the pose the tick integrated to;
//   - the CG moves by the largest push out along each axis (opposite pushes
//     cancel), and a point that push carries more than CARRY_MIN into the
//     solid (wedged between boxes closer together than the footprint) is
//     resolved too, its push joining the others;
//   - CONTACT_SWEEPS projected Gauss-Seidel sweeps of impulses at the points
//     steer each point's velocity toward what the world gave it: along the
//     contact normal an accumulated push that never goes below zero (a later
//     sweep can take back what an earlier one over-gave, so four points at
//     rest share the load without creeping, but nothing pulls), with at
//     least the speed out (to PINCH_BIAS_MAX) that moves the part of its push
//     the CG's move left undone (a pinch: pushes that cancelled) in a tick;
//     across it the world's tangential target (its friction), a sliding
//     contact by one exact row along its slip, or on a wall Coulomb friction
//     toward no slip, at most PB_WALL_FRICTION times the contact's push so
//     far. A fixed sweep count keeps it deterministic.
// The spin now comes from the lever arms, so the duct-hit spin kick is not
// applied; the ground scrub (H:3196-3203) and the spin cap are.
// A box edge or corner can pass between the points (a shelf's front edge
// between the leading rim and the rest), so after the points' push the
// convex hull of the five points is tested against the boxes too (world.c
// sc_world_hull): a box it ends the tick deeper inside than it began, with no
// point inside it at the start or end of the tick that leaves it along the
// hull's separating axis, is pushed back by what it went deeper this tick
// (all of the overlap only if it began outside; a carried overlap is not
// pushed). The push is along the box face axis most along the hull's way
// out, or failing that the next most along it, any at least a quarter along
// it, whose push takes no point into a solid; if none qualifies there
// is no push, and the contact only stops the hull moving into the box. The
// box feature inside the hull (a corner, both ends of an edge across a face,
// or up to four corners of a box top between the rims) is one to four more
// contacts with the world's response, up to HULL_BOXES solids a tick, in the
// same sweeps, each given as speed out what the CG's move left undone of
// what it went deeper. The pushes add as the points' do, topped up where one
// contact's leaves another short. The hull's push moves the points too, so
// they are resolved again from where the points' push left them, each push
// one more contact (world.c chooses a push that takes no point into a solid,
// but a point lying on a seam plane is in none).
static uint32_t footprintContact(double p[3], double v[3], const double q[4], double om[3], const double p0[3],
                                 const double q0[4], double dt)
{
    double body[FOOTPRINT_POINTS][3];
    footprintBody(body);

    double omW[3];
    qRotate(q, om, omW);
    const double spinBefore = sqrt(dot3(om, om));
    double rw[CONTACTS][3], target[CONTACTS][3], normal[CONTACTS][3];
    double slip[CONTACTS][3];           // unit tangential slip at contact, or zero
    double mu[CONTACTS];                // a wall's Coulomb friction, or -1: the world's tangential target
    double r0[FOOTPRINT_POINTS][3];
    bool active[CONTACTS];
    double pushHi[3] = { 0, 0, 0 }, pushLo[3] = { 0, 0, 0 };
    double pushAt[CONTACTS][3];             // a contact's push out (a point's), or zero
    double fromAt[CONTACTS][3];             // the CG's move it was pushed from
    double bias[CONTACTS];                  // speed out a pinched point is given
    const double pIn[3] = { p[0], p[1], p[2] };
    memset(pushAt, 0, sizeof(pushAt));
    memset(fromAt, 0, sizeof(fromAt));
    memset(bias, 0, sizeof(bias));
    uint32_t flags = 0;
    bool anyFloor = false, anyScrub = false;
    for (int k = 0; k < FOOTPRINT_POINTS; k++) {
        active[k] = false;
        qRotate(q, body[k], rw[k]);
        double wxr[3], pt[3], vt[3], st[3];
        qRotate(q0, body[k], r0[k]);
        cross3(omW, rw[k], wxr);
        for (int a = 0; a < 3; a++) {
            pt[a] = p[a] + rw[k][a];
            vt[a] = v[a] + wxr[a];
            st[a] = p0[a] + r0[k][a];
        }
        const double ptIn[3] = { pt[0], pt[1], pt[2] };
        const double vtIn[3] = { vt[0], vt[1], vt[2] };
        bool floorHit = false, scrub = false, wall = false;
        const uint32_t f = sc_world_point(pt, vt, st, dt, blk[PB_BOUNCE_SCALE], blk[PB_CRASH_SCALE],
                                          blk[PB_SPIN_SCALE], SC_WORLD_ALL_FACES, blk[PB_WALL_RESTITUTION], &floorHit,
                                          &scrub, &wall);
        mu[k] = wall ? blk[PB_WALL_FRICTION] : -1;
        flags |= f;
        anyFloor = anyFloor || floorHit;
        anyScrub = anyScrub || scrub;
        if (!f) {
            continue;
        }
        double dp[3], dv[3];
        for (int a = 0; a < 3; a++) {
            dp[a] = pt[a] - ptIn[a];
            dv[a] = vt[a] - vtIn[a];
            pushHi[a] = fmax(pushHi[a], dp[a]);
            pushLo[a] = fmin(pushLo[a], dp[a]);
            pushAt[k][a] = dp[a];
        }
        // The contact normal: the way the point was pushed out, or failing
        // that (a touch with no push) the way its velocity was turned.
        double len = sqrt(dot3(dp, dp));
        const double *dir = dp;
        if (!(len > 0)) {
            len = sqrt(dot3(dv, dv));
            dir = dv;
        }
        if (!(len > 0)) {
            continue;
        }
        for (int a = 0; a < 3; a++) {
            normal[k][a] = dir[a] / len;
            target[k][a] = vt[a];
        }
        // The point's slip along the surface as it arrived: friction only
        // ever opposes it (with no slip, or under SLIP_MIN, it holds the
        // point, static). Stepped along the direction of a slip of
        // nanometres a second, numerical, a quad resting on a beam between
        // its rims turned at 2e-4 rad/s and crept 2 um in 7 s.
        const double vin = dot3(vtIn, normal[k]);
        double sl[3];
        for (int a = 0; a < 3; a++) {
            sl[a] = vtIn[a] - vin * normal[k][a];
        }
        const double slen = sqrt(dot3(sl, sl));
        for (int a = 0; a < 3; a++) {
            slip[k][a] = slen > SLIP_MIN ? sl[a] / slen : 0;
        }
        active[k] = true;
    }
    // The ducts' sides (owner decision 2026-10-28): each duct is a tube round
    // its motor, PB_DUCT_RADIUS out, from its bottom rim (PB_HULL_BELOW under
    // the CG) to its top rim (PB_DUCT_HEIGHT up). A box's vertical face meets
    // it first where each rim reaches furthest toward the face, so for each
    // face normal a box can have (-x, +x, -y, +y) and each rim, that rim's
    // point furthest along the normal's opposite is a contact point, meeting
    // only faces with that normal, among the boxes near the quad. As the quad
    // turns, the point runs round the rim: a wall rolls the duct off it, where
    // the rim point on the arm diagonal caught it like a corner. Both rims
    // meet a wall the quad is level against, so the push is spread up the
    // duct's side, not all on its bottom 10 mm under the CG, which pitched
    // every wall hit into a flip. With a rim's plane square to the face (the
    // quad on its side against it) the rim lies flat on it and has no
    // furthest point: the other normals' points on that rim are there. A
    // duct of no height (PB_DUCT_HEIGHT 0) has no side: the footprint alone.
    int contacts = FOOTPRINT_POINTS;
    double nearLo[3], nearHi[3];
    const double span = blk[PB_WHEELBASE] * 0.5 + blk[PB_DUCT_RADIUS] + blk[PB_HULL_BELOW] + blk[PB_DUCT_HEIGHT];
    for (int a = 0; a < 3; a++) {
        nearLo[a] = fmin(p[a], p0[a]) - span;
        nearHi[a] = fmax(p[a], p0[a]) + span;
    }
    if (blk[PB_DUCT_HEIGHT] > 0 && sc_world_near(nearLo, nearHi)) {
        static const double WALL_N[WALL_NORMALS][3] = { { -1, 0, 0 }, { 1, 0, 0 }, { 0, -1, 0 }, { 0, 1, 0 } };
        static const double DOWN[3] = { 0, 0, -1 }, UP[3] = { 0, 0, 1 };
        // A duct's top rim meets box undersides too, as the rims and the
        // canopy do (their response): risen into a deck's underside proud of
        // a wall, a top rim's side point found the deck's face the shallower
        // once it was deeper than the overhang, and was shoved out sideways
        // (8 mm). Its highest point is one more side point, for an underside
        // alone. Box tops stay the rims' (the floor, as before).
        const int under = sc_world_face_bit(DOWN);
        for (int i = 0; i < SC_MOTOR_COUNT; i++) {
            for (int rim = 0; rim < DUCT_RIMS; rim++) {
                for (int w = 0; w <= WALL_NORMALS; w++) {
                    if (w == WALL_NORMALS && rim == 0) {
                        continue;       // the highest point: the top rim's only
                    }
                    double toward[3], body[3];
                    for (int a = 0; a < 3; a++) {
                        toward[a] = w < WALL_NORMALS ? -WALL_N[w][a] : UP[a];
                    }
                    if (!rimToward(i, rim, q, toward, body)) {
                        continue;
                    }
                    const int mask = w < WALL_NORMALS ? sc_world_face_bit(WALL_N[w]) | (rim ? under : 0) : under;
                    const int c = contacts;
                    bool added;
                    flags |= sideContact(body, mask, p, v, q, omW, p0, q0, dt, rw[c], normal[c],
                                         target[c], slip[c], &mu[c], pushAt[c], &added);
                    if (added) {
                        sidePush(pushAt[c], anyFloor || anyScrub, pushHi, pushLo);
                        active[c] = true;
                        contacts++;
                    }
                }
            }
        }
        // A box's vertical edge (a post's corner, a door jamb) meets a rim
        // between the points above, up to R (1 - cos 45 degrees) = 5.3 mm
        // round from them (a duct cut a door jamb's corner 1.2 mm deep). Of
        // the rim's points past both faces at the edge (within the box's
        // height), found round the rim in EDGE_STEPS and refined, the
        // deepest past each face among those past the other is the push
        // through that face that takes the whole rim out of the corner: the
        // smaller of the two is an edge point, leaving through its face
        // (pushed out by the point deepest past both, through one face, an
        // arc beside it stayed past both, 0.5 to 1.4 mm). Edges come from the
        // boxes near the quad, those within the rims' height and reach; at
        // most EDGE_POINTS a tick, of the first NEAR_EDGES.
        const double reach = blk[PB_DUCT_RADIUS];
        double centreBody[SC_MOTOR_COUNT][DUCT_RIMS][3], centre[SC_MOTOR_COUNT][DUCT_RIMS][3];
        double rimLo[SC_MOTOR_COUNT][DUCT_RIMS], rimHi[SC_MOTOR_COUNT][DUCT_RIMS];
        double zlo = INFINITY, zhi = -INFINITY;
        {
            // A rim's height span: its centre's, plus or minus the duct
            // radius times how far its plane leans from level.
            static const double BX[3] = { 1, 0, 0 }, BY[3] = { 0, 1, 0 };
            double ux[3], uy[3];
            qRotate(q, BX, ux);
            qRotate(q, BY, uy);
            const double half = reach * hypot(ux[2], uy[2]) + ON_FACE_M;
            for (int i = 0; i < SC_MOTOR_COUNT; i++) {
                for (int rim = 0; rim < DUCT_RIMS; rim++) {
                    centreBody[i][rim][0] = MOTOR_X[i] * derived[PD_ARM];
                    centreBody[i][rim][1] = MOTOR_Y[i] * derived[PD_ARM];
                    centreBody[i][rim][2] = -blk[PB_HULL_BELOW] + rim * blk[PB_DUCT_HEIGHT];
                    qRotate(q, centreBody[i][rim], centre[i][rim]);
                    rimLo[i][rim] = p[2] + centre[i][rim][2] - half;
                    rimHi[i][rim] = p[2] + centre[i][rim][2] + half;
                    zlo = fmin(zlo, rimLo[i][rim]);
                    zhi = fmax(zhi, rimHi[i][rim]);
                }
            }
        }
        // A rim's point furthest toward a wall can lie where the wall's face
        // is a seam, under a table top standing against the wall (a T-join),
        // and the rest of the rim past the face, above the top, then goes
        // unanswered: a duct sat 1.4 mm into the wall over a table. So for
        // each box top the rim spans, its point just above the top furthest
        // toward each wall normal is a side point too, and just below each
        // bottom (a deck or shelf against a wall). At most LEVEL_POINTS a
        // tick, of the first NEAR_LEVELS heights.
        {
            double levels[NEAR_LEVELS];
            int kinds[NEAR_LEVELS];
            const int levelCount = sc_world_near_levels(zlo, zhi, levels, kinds, NEAR_LEVELS);
            double ux[3], uy[3];
            static const double BX[3] = { 1, 0, 0 }, BY[3] = { 0, 1, 0 };
            qRotate(q, BX, ux);
            qRotate(q, BY, uy);
            int made = 0;
            for (int l = 0; l < levelCount && made < LEVEL_POINTS; l++) {
                for (int i = 0; i < SC_MOTOR_COUNT && made < LEVEL_POINTS; i++) {
                    for (int rim = 0; rim < DUCT_RIMS && made < LEVEL_POINTS; rim++) {
                        if (levels[l] < rimLo[i][rim] || levels[l] > rimHi[i][rim]) {
                            continue;
                        }
                        const scWave_t pz = waveOf(p[2] + centre[i][rim][2], ux[2], uy[2], reach);
                        double cross[2];
                        if (waveCrossing(&pz, levels[l] + kinds[l] * LEVEL_EPS, cross) != 2) {
                            continue;       // the rim does not reach past the top or bottom
                        }
                        for (int w = 0; w < WALL_NORMALS && made < LEVEL_POINTS; w++) {
                            // Of the two crossings, the one further toward the wall.
                            const double toward[3] = { -WALL_N[w][0], -WALL_N[w][1], -WALL_N[w][2] };
                            const scWave_t pt = waveOf(0, dot3(toward, ux), dot3(toward, uy), reach);
                            const double a = waveAt(&pt, cross[0]) >= waveAt(&pt, cross[1]) ? cross[0] : cross[1];
                            const double body[3] = { centreBody[i][rim][0] + reach * cos(a),
                                                     centreBody[i][rim][1] + reach * sin(a), centreBody[i][rim][2] };
                            made++;
                            const int c = contacts;
                            bool added;
                            flags |= sideContact(body, sc_world_face_bit(WALL_N[w]) | (rim ? under : 0), p, v, q, omW, p0,
                                                 q0, dt, rw[c], normal[c], target[c], slip[c], &mu[c], pushAt[c], &added);
                            if (added) {
                                sidePush(pushAt[c], anyFloor || anyScrub, pushHi, pushLo);
                                active[c] = true;
                                contacts++;
                            }
                        }
                    }
                }
            }
        }
        double edges[NEAR_EDGES][8];
        int edgeMask[NEAR_EDGES];
        const int edgeCount = sc_world_near_edges(p, derived[PD_ARM] * sqrt(2.0) + reach, zlo, zhi, edges, edgeMask,
                                                  NEAR_EDGES);
        int tried = 0;
        for (int e = 0; e < edgeCount && tried < EDGE_POINTS; e++) {
            for (int i = 0; i < SC_MOTOR_COUNT && tried < EDGE_POINTS; i++) {
                for (int rim = 0; rim < DUCT_RIMS && tried < EDGE_POINTS; rim++) {
                    if (edges[e][3] < rimLo[i][rim] || edges[e][2] > rimHi[i][rim]) {
                        continue;           // above or below the rim
                    }

                    // Past the x face, past the y face, and the height, round
                    // the rim: waves, so the extremes of the lesser of the two
                    // depths, and of each depth where the other is past its
                    // face, both within the box's height, are at a wave's
                    // peak, where two waves cross, or where a bound is met
                    // (sampled 32 times round, a 1 mm cut into a corner, 6
                    // degrees of rim, went unseen).
                    double ux[3], uy[3];
                    {
                        static const double BX[3] = { 1, 0, 0 }, BY[3] = { 0, 1, 0 };
                        qRotate(q, BX, ux);
                        qRotate(q, BY, uy);
                    }
                    const scWave_t px = waveOf(-edges[e][4] * (p[0] + centre[i][rim][0] - edges[e][0]), -edges[e][4] * ux[0],
                                               -edges[e][4] * uy[0], reach);
                    const scWave_t py = waveOf(-edges[e][5] * (p[1] + centre[i][rim][1] - edges[e][1]), -edges[e][5] * ux[1],
                                               -edges[e][5] * uy[1], reach);
                    const scWave_t pz = waveOf(p[2] + centre[i][rim][2], ux[2], uy[2], reach);
                    // The rim must reach past both faces' planes (a tilted
                    // rim's centre can be beside one face and the edge more
                    // than R off, and still cut the corner: dropped by a
                    // distance test, a duct sat 5 mm in a corner).
                    if (!(px.c + hypot(px.a, px.b) > 0 && py.c + hypot(py.a, py.b) > 0)) {
                        continue;
                    }
                    const scWave_t pd = { px.a - py.a, px.b - py.b, px.c - py.c };
                    double cand[17];
                    int nc = 0;
                    cand[nc++] = atan2(px.b, px.a);
                    cand[nc++] = atan2(py.b, py.a);
                    cand[nc++] = atan2(pz.b, pz.a);
                    nc += waveCrossing(&pd, 0, cand + nc);
                    nc += waveCrossing(&px, 0, cand + nc);
                    nc += waveCrossing(&py, 0, cand + nc);
                    nc += waveCrossing(&pz, edges[e][2], cand + nc);
                    nc += waveCrossing(&pz, edges[e][3], cand + nc);
                    nc += waveCrossing(&px, edges[e][6], cand + nc);
                    nc += waveCrossing(&py, edges[e][7], cand + nc);
                    // A top rim risen under the box (a deck's corner over it):
                    // how far above its bottom the rim gets among its points
                    // past both faces, the push down that clears it (the
                    // third face; box tops stay the rims').
                    double both = -INFINITY, deepest[3] = { -INFINITY, -INFINITY, -INFINITY }, at[3] = { 0, 0, 0 };
                    for (int k = 0; k < nc; k++) {
                        const double z = waveAt(&pz, cand[k]);
                        if (z < edges[e][2] - ON_FACE_M || z > edges[e][3] + ON_FACE_M) {
                            continue;       // above or below the box
                        }
                        const double past[2] = { waveAt(&px, cand[k]), waveAt(&py, cand[k]) };
                        if (past[0] > edges[e][6] || past[1] > edges[e][7]) {
                            continue;       // past the box's far side: not in it
                        }
                        both = fmax(both, fmin(past[0], past[1]));
                        for (int g = 0; g < 2; g++) {
                            if (past[1 - g] > -1e-12 && past[g] > deepest[g]) {
                                deepest[g] = past[g];
                                at[g] = cand[k];
                            }
                        }
                        if (rim && past[0] > -1e-12 && past[1] > -1e-12 && z - edges[e][2] > deepest[2]) {
                            deepest[2] = z - edges[e][2];
                            at[2] = cand[k];
                        }
                    }
                    if (!(both > 0)) {
                        continue;           // not past both faces: clear of the edge
                    }
                    int f = deepest[0] <= deepest[1] ? 0 : 1;
                    if (rim && deepest[2] > 0 && deepest[2] < deepest[f]) {
                        f = 2;
                    }
                    const double body[3] = { centreBody[i][rim][0] + reach * cos(at[f]),
                                             centreBody[i][rim][1] + reach * sin(at[f]), centreBody[i][rim][2] };
                    double pt[3];
                    qRotate(q, body, pt);
                    for (int a = 0; a < 3; a++) {
                        pt[a] += p[a];
                    }
                    if (!sc_world_edge_open(e, pt)) {
                        continue;           // a seam of a wall in pieces: inside the wall, not a corner
                    }
                    const double face[3] = { f == 0 ? edges[e][4] : 0, f == 1 ? edges[e][5] : 0, f == 2 ? -1 : 0 };
                    tried++;
                    const int c = contacts;
                    bool added;
                    flags |= sideContact(body, sc_world_face_bit(face) | SC_WORLD_EDGE_FLAG, p, v, q, omW, p0, q0, dt,
                                         rw[c], normal[c], target[c], slip[c], &mu[c], pushAt[c], &added);
                    if (added) {
                        sidePush(pushAt[c], anyFloor || anyScrub, pushHi, pushLo);
                        active[c] = true;
                        contacts++;
                    }
                }
            }
        }
    }
    // Opposite pushes on one axis: a quad wedged in a gap narrower than its
    // footprint stays put (they cancel); a quad whose CG is inside a box (a
    // pose into the solid) leaves by the larger push.
    const bool embedded = sc_world_inside(p);
    // The push carries every point with the CG: one it carries into the
    // solid (wedged between boxes closer together than the footprint, the
    // far side's push drove it in) is resolved too, from where its own
    // resolution left it, and its push joins the others, so the two cancel
    // this tick and the pinch below turns the quad. A tick at a time, each
    // pushing the other way, a rim lying on the floor in a gap 2.5 mm
    // narrower than the rims was carried into the box beside it, out of
    // reach of the next tick's resolution, and went 8.8 mm in. Only on a
    // tick a point met a box, and only a point carried more than CARRY_MIN
    // (the next tick's resolution reaches that far through a face; the walk
    // over the boxes for every point cost a quad resting on a table edge
    // 7 us a tick with 1088 boxes in the map). Not with the CG in or on a box
    // (a pose on a seam inside a wall: the points on both sides cancelled
    // and it never came out).
    double net[3];
    for (int a = 0; a < 3; a++) {
        net[a] = pushHi[a] + pushLo[a];
    }
    int inSolid = -1;                   // the CG in or on a box, found when first needed
    for (int k = 0; k < FOOTPRINT_POINTS && (flags & 2) && (net[0] != 0 || net[1] != 0 || net[2] != 0); k++) {
        double pt[3], st[3], vt[3], wxr[3], carry[3];
        for (int a = 0; a < 3; a++) {
            carry[a] = net[a] - pushAt[k][a];
            st[a] = p[a] + rw[k][a] + pushAt[k][a];
            pt[a] = p[a] + rw[k][a] + net[a];
        }
        if (!(dot3(carry, carry) > CARRY_MIN * CARRY_MIN)) {
            continue;
        }
        if (inSolid < 0) {
            inSolid = sc_world_in_solid(p);
        }
        if (inSolid) {
            break;
        }
        if (!sc_world_point_in(pt)) {
            continue;
        }
        cross3(omW, rw[k], wxr);
        for (int a = 0; a < 3; a++) {
            vt[a] = v[a] + wxr[a];
        }
        const double ptIn[3] = { pt[0], pt[1], pt[2] };
        const double vtIn[3] = { vt[0], vt[1], vt[2] };
        bool floorHit = false, scrub = false, wall = false;
        flags |= sc_world_point(pt, vt, st, dt, blk[PB_BOUNCE_SCALE], blk[PB_CRASH_SCALE], blk[PB_SPIN_SCALE],
                                SC_WORLD_ALL_FACES, blk[PB_WALL_RESTITUTION], &floorHit, &scrub, &wall);
        anyFloor = anyFloor || floorHit;
        anyScrub = anyScrub || scrub;
        double dp[3];
        for (int a = 0; a < 3; a++) {
            dp[a] = pt[a] - ptIn[a];
        }
        const double len = sqrt(dot3(dp, dp));
        if (!(len > 0)) {
            continue;
        }
        const int c = contacts++;
        mu[c] = wall ? blk[PB_WALL_FRICTION] : -1;
        const double vin = dot3(vtIn, dp) / len;
        double sl[3];
        for (int a = 0; a < 3; a++) {
            pushHi[a] = fmax(pushHi[a], dp[a]);
            pushLo[a] = fmin(pushLo[a], dp[a]);
            rw[c][a] = rw[k][a];
            normal[c][a] = dp[a] / len;
            target[c][a] = vt[a];
            sl[a] = vtIn[a] - vin * normal[c][a];
            pushAt[c][a] = dp[a];
            fromAt[c][a] = net[a];
        }
        const double slen = sqrt(dot3(sl, sl));
        for (int a = 0; a < 3; a++) {
            slip[c][a] = slen > SLIP_MIN ? sl[a] / slen : 0;
        }
        active[c] = true;
    }
    for (int a = 0; a < 3; a++) {
        if (embedded && pushHi[a] > 0 && pushLo[a] < 0) {
            p[a] += pushHi[a] >= -pushLo[a] ? pushHi[a] : pushLo[a];
        } else {
            p[a] += pushHi[a] + pushLo[a];
        }
    }
    // The hull, on the pose the points' push left (rims round the base, then
    // the canopy), and on the pose the tick began at.
    static const int HULL_ORDER[SC_HULL_POINTS] = { 0, 1, 3, 2, 4 };
    double hullEnd[SC_HULL_POINTS][3], hullStart[SC_HULL_POINTS][3];
    for (int j = 0; j < SC_HULL_POINTS; j++) {
        for (int a = 0; a < 3; a++) {
            hullEnd[j][a] = p[a] + rw[HULL_ORDER[j]][a];
            hullStart[j][a] = p0[a] + r0[HULL_ORDER[j]][a];
        }
    }
    sc_hull_contact_t hull[HULL_BOXES];
    const int hullCount = sc_world_hull(hullEnd, hullStart, hull, HULL_BOXES);
    double hullHi[3] = { 0, 0, 0 }, hullLo[3] = { 0, 0, 0 };
    for (int j = 0; j < hullCount; j++) {
        for (int a = 0; a < 3; a++) {
            hullHi[a] = fmax(hullHi[a], hull[j].push[a]);
            hullLo[a] = fmin(hullLo[a], hull[j].push[a]);
        }
        for (int m = 0; m < hull[j].points; m++) {
            const int k = contacts++;
            mu[k] = -1;
            double wxr[3], vt[3], vtIn[3];
            for (int a = 0; a < 3; a++) {
                rw[k][a] = hull[j].point[m][a] - p[a];
            }
            cross3(omW, rw[k], wxr);
            for (int a = 0; a < 3; a++) {
                vt[a] = v[a] + wxr[a];
                vtIn[a] = vt[a];
            }
            bool scrub = false;
            flags |= sc_world_hull_hit(&hull[j], vt, blk[PB_BOUNCE_SCALE], blk[PB_CRASH_SCALE],
                                       blk[PB_SPIN_SCALE], &scrub, normal[k]);
            anyScrub = anyScrub || scrub;
            // What it went deeper this tick, from where the points' push
            // left the CG: what the CG's move leaves of it is given as speed
            // out in the sweeps. With no push allowed (wedged against a box
            // on the far side), only stopping the hull moving into the box
            // let the overlap each tick gained stay: a leg's edge went 30 mm
            // into the hull, 0.035 mm a tick, between two gym bench legs.
            const double vin = dot3(vtIn, normal[k]);
            double sl[3];
            for (int a = 0; a < 3; a++) {
                target[k][a] = vt[a];
                sl[a] = vtIn[a] - vin * normal[k][a];
                pushAt[k][a] = hull[j].gain * hull[j].normal[a];
                fromAt[k][a] = p[a] - pIn[a];
            }
            const double slen = sqrt(dot3(sl, sl));
            for (int a = 0; a < 3; a++) {
                slip[k][a] = slen > SLIP_MIN ? sl[a] / slen : 0;
            }
            active[k] = true;
        }
    }
    // The pushes add up as the points' do (the largest each way per axis),
    // but on an oblique separating axis one contact's push can leave another
    // short of what it went deeper this tick: each contact the sum leaves
    // short is topped up along its own push, HULL_PASSES passes. Opposite
    // pushes on its axis (wedged) still cancel. One contact is as before.
    // Wedged on the end of a bench plank beside a leg (a slot narrower than
    // the footprint), each push alone was cancelled or not allowed, and the
    // plank went 26 mm into the hull in 4 s, between two rims.
    double hullPush[3];
    for (int a = 0; a < 3; a++) {
        hullPush[a] = hullHi[a] + hullLo[a];
    }
    for (int pass = 0; pass < HULL_PASSES && hullCount > 1; pass++) {
        for (int j = 0; j < hullCount; j++) {
            const double want = dot3(hull[j].push, hull[j].normal);     // what it went deeper this tick
            int ax = 0;
            for (int a = 1; a < 3; a++) {
                if (fabs(hull[j].push[a]) > fabs(hull[j].push[ax])) {
                    ax = a;
                }
            }
            if (!(want > 0) || (hullHi[ax] > 0 && hullLo[ax] < 0)) {
                continue;
            }
            const double got = dot3(hullPush, hull[j].normal);
            if (got < want) {
                for (int a = 0; a < 3; a++) {
                    hullPush[a] += (want - got) / want * hull[j].push[a];
                }
            }
        }
    }
    const double pHull[3] = { p[0], p[1], p[2] };
    bool hullMoved = false;
    for (int a = 0; a < 3; a++) {
        p[a] += hullPush[a];
        hullMoved = hullMoved || p[a] != pHull[a];
    }
    // The hull's push moves the points too: each is resolved again, from
    // where the points' push left it to where the hull's push carried it, and
    // what the world does to it is one more contact, the CG moving by the
    // largest push each way as before. world.c pushes the hull only along an
    // axis that takes no point into a solid, but a point lying on a seam
    // plane is in none: a rim on a desk top beside a keyboard was carried
    // 1.3 mm under the keyboard's edge, and the next tick found it deep in
    // the solid and pushed it out through the bottom of the desk (29 mm).
    if (hullMoved) {
        double reHi[3] = { 0, 0, 0 }, reLo[3] = { 0, 0, 0 };
        for (int k = 0; k < FOOTPRINT_POINTS; k++) {
            double wxr[3], pt[3], vt[3], st[3];
            cross3(omW, rw[k], wxr);
            for (int a = 0; a < 3; a++) {
                pt[a] = p[a] + rw[k][a];
                vt[a] = v[a] + wxr[a];
                st[a] = pHull[a] + rw[k][a];
            }
            const double ptIn[3] = { pt[0], pt[1], pt[2] };
            const double vtIn[3] = { vt[0], vt[1], vt[2] };
            bool floorHit = false, scrub = false, wall = false;
            flags |= sc_world_point(pt, vt, st, dt, blk[PB_BOUNCE_SCALE], blk[PB_CRASH_SCALE], blk[PB_SPIN_SCALE],
                                    SC_WORLD_ALL_FACES, blk[PB_WALL_RESTITUTION], &floorHit, &scrub, &wall);
            anyFloor = anyFloor || floorHit;
            anyScrub = anyScrub || scrub;
            double dp[3];
            for (int a = 0; a < 3; a++) {
                dp[a] = pt[a] - ptIn[a];
                reHi[a] = fmax(reHi[a], dp[a]);
                reLo[a] = fmin(reLo[a], dp[a]);
            }
            const double len = sqrt(dot3(dp, dp));
            if (!(len > 0)) {
                continue;
            }
            const int c = contacts++;
            mu[c] = wall ? blk[PB_WALL_FRICTION] : -1;
            const double vin = dot3(vtIn, dp) / len;
            double sl[3];
            for (int a = 0; a < 3; a++) {
                rw[c][a] = rw[k][a];
                normal[c][a] = dp[a] / len;
                target[c][a] = vt[a];
                sl[a] = vtIn[a] - vin * normal[c][a];
            }
            const double slen = sqrt(dot3(sl, sl));
            for (int a = 0; a < 3; a++) {
                slip[c][a] = slen > SLIP_MIN ? sl[a] / slen : 0;
            }
            active[c] = true;
        }
        for (int a = 0; a < 3; a++) {
            p[a] += reHi[a] + reLo[a];
        }
    }
    // A pinch: points pushed out of boxes on opposite sides, their pushes
    // cancelled in the CG's, so each kept the part of its push the CG did
    // not take and stayed in. That much is moved out through the sweeps (at
    // most PINCH_BIAS_MAX), where the lever arms turn the quad out of both
    // boxes; so is what a hull contact went deeper and the CG's move left
    // undone. Two rims creeping into a slab's underside and a step's side
    // 21 mm apart took the CG into the slab; a point whose push the CG took
    // whole is as before.
    if (!embedded) {
        double moved[3];
        for (int a = 0; a < 3; a++) {
            moved[a] = p[a] - pIn[a];
        }
        for (int c = 0; c < contacts; c++) {
            const double len = sqrt(dot3(pushAt[c], pushAt[c]));
            if (!active[c] || !(len > 0)) {
                continue;
            }
            double rel[3];
            for (int a = 0; a < 3; a++) {
                rel[a] = moved[a] - fromAt[c][a];
            }
            const double left = len - dot3(rel, pushAt[c]) / len;
            if (left > 0) {
                bias[c] = fmin(left / dt, PINCH_BIAS_MAX);
            }
        }
    }
    double pushed[CONTACTS];
    double rubbed[CONTACTS][3];
    memset(pushed, 0, sizeof(pushed));
    memset(rubbed, 0, sizeof(rubbed));
    for (int sweep = 0; sweep < CONTACT_SWEEPS; sweep++) {
        for (int k = 0; k < contacts; k++) {
            if (!active[k]) {
                continue;
            }
            const double *n = normal[k];
            const double tn = dot3(target[k], n);
            const double tnOut = fmax(tn, bias[k]);
            double wxr[3], vp[3], kn[3], j[3], rj[3], dw[3], e[3];
            // Across the normal first: the tangential target, by an impulse in
            // the tangent plane.
            cross3(omW, rw[k], wxr);
            for (int a = 0; a < 3; a++) {
                vp[a] = v[a] + wxr[a];
            }
            double vn = dot3(vp, n);
            // A wall's Coulomb friction steers toward no slip at all, never
            // with more than mu times the push the contact has so far.
            const bool coulomb = mu[k] >= 0;
            const double cap = coulomb ? mu[k] * pushed[k] : 0;
            for (int a = 0; a < 3; a++) {
                e[a] = (coulomb ? 0 : target[k][a] - tn * n[a]) - (vp[a] - vn * n[a]);
            }
            if (dot3(e, e) > 0) {
                if (coulomb && dot3(slip[k], slip[k]) > 0) {
                    double ks[3];
                    contactResponse(q, rw[k], slip[k], ks);
                    const double before = dot3(rubbed[k], slip[k]);
                    const double along = fmax(-cap, fmin(0, before + dot3(e, slip[k]) / dot3(ks, slip[k])));
                    for (int a = 0; a < 3; a++) {
                        j[a] = (along - before) * slip[k][a];
                        rubbed[k][a] = along * slip[k][a];
                    }
                } else if (coulomb) {
                    contactImpulse(q, rw[k], e, j);
                    const double jn = dot3(j, n);
                    double total[3];
                    for (int a = 0; a < 3; a++) {
                        total[a] = rubbed[k][a] + j[a] - jn * n[a];
                    }
                    const double size = sqrt(dot3(total, total));
                    const double keep = size > cap ? cap / size : 1;
                    for (int a = 0; a < 3; a++) {
                        total[a] *= keep;
                        j[a] = total[a] - rubbed[k][a];
                        rubbed[k][a] = total[a];
                    }
                } else if (dot3(slip[k], slip[k]) > 0) {
                    // Sliding: one row along the slip, stepped exactly, its
                    // accumulated friction kept opposing the arrival slip (it
                    // never pushes the point along its own slip, which would
                    // add energy through the lever arm). Solving the whole
                    // tangential error (K j = e) and keeping the part along
                    // the slip moved the slip by (s.K s)(s.K^-1 s) times its
                    // error, about 2 for a rim on the floor at a lean, and a
                    // row stepped twice its error grows: rims on the floor
                    // and one on a deck side, motors off, went from 0.07 m/s
                    // and 1.8 rad/s to 2.6 m/s and 117 rad/s in one tick.
                    double ks[3];
                    contactResponse(q, rw[k], slip[k], ks);
                    const double before = dot3(rubbed[k], slip[k]);
                    const double along = fmin(0, before + dot3(e, slip[k]) / dot3(ks, slip[k]));
                    for (int a = 0; a < 3; a++) {
                        j[a] = (along - before) * slip[k][a];
                        rubbed[k][a] = along * slip[k][a];
                    }
                } else {
                    contactImpulse(q, rw[k], e, j);
                    const double jn = dot3(j, n);
                    for (int a = 0; a < 3; a++) {
                        j[a] -= jn * n[a];
                    }
                }
                cross3(rw[k], j, rj);
                invInertiaWorld(q, rj, dw);
                for (int a = 0; a < 3; a++) {
                    v[a] += j[a] / blk[PB_MASS];
                    omW[a] += dw[a];
                }
            }
            // Then along it: the accumulated push, clamped at zero.
            cross3(omW, rw[k], wxr);
            for (int a = 0; a < 3; a++) {
                vp[a] = v[a] + wxr[a];
            }
            vn = dot3(vp, n);
            contactResponse(q, rw[k], n, kn);
            const double total = fmax(0, pushed[k] + (tnOut - vn) / dot3(kn, n));
            const double dl = total - pushed[k];
            pushed[k] = total;
            for (int a = 0; a < 3; a++) {
                j[a] = dl * n[a];
            }
            cross3(rw[k], j, rj);
            invInertiaWorld(q, rj, dw);
            for (int a = 0; a < 3; a++) {
                v[a] += j[a] / blk[PB_MASS];
                omW[a] += dw[a];
            }
        }
    }
    qRotateInverse(q, omW, om);
    const double spin = sqrt(dot3(om, om));
    const double cap = fmax(CONTACT_SPIN_CAP, spinBefore);
    if (spin > cap) {
        for (int a = 0; a < 3; a++) {
            om[a] *= cap / spin;        // a crash is a crash, never the divergence fault
        }
    }
    if (anyScrub) {
        const double k = exp(-dt * GROUND_SCRUB);
        om[0] *= k;
        om[1] *= k;
        om[2] *= k;
    }
    sc_world_after_points(p, anyFloor);
    return flags;
}

void sc_plant_step(double dt)
{
    if (model == SC_MODEL_REST) {
        return;
    }
    if (posePending) {
        memcpy(sc_plant.pos, poseNext, 3 * sizeof(double));
        memcpy(sc_plant.quat, poseNext + 3, 4 * sizeof(double));
        memcpy(sc_plant.vel, poseNext + 7, 3 * sizeof(double));
        posePending = false;
        sc_world_set_rest_height(restHeightAt(sc_plant.quat));
        sc_world_pose_sync(sc_plant.pos);
    }
    double duty[SC_MOTOR_COUNT];
    double collective = 0;
    for (int i = 0; i < SC_MOTOR_COUNT; i++) {
        duty[i] = dutyOf(i);
        collective += duty[i];
    }
    if (model == SC_MODEL_PHYSICAL) {
        stepPhysical(duty, dt);
    } else {
        stepParity(duty, dt);
    }

    double *p = sc_plant.pos, *v = sc_plant.vel, *q = sc_plant.quat, *om = sc_plant.omega;
    // The pose at the start of the tick, for where each footprint point was.
    const double pStart[3] = { p[0], p[1], p[2] };
    const double qStart[4] = { q[0], q[1], q[2], q[3] };
    const double m = blk[PB_MASS];
    const double g = blk[PB_GRAVITY];
    const double arm = derived[PD_ARM];

    // Ground effect from the position at the end of the last tick (QP:720-727);
    // not while 3D pulls down. Thrust and roll/pitch torque only.
    double ge = 1;
    const double clr = model == SC_MODEL_PHYSICAL ? sc_world_hull_clearance(p, blk[PB_HULL_BELOW])
                                                  : sc_world_clearance_at(p);
    sc_plant.groundClearance = clr;
    if (blk[PB_GROUND_K] > 0 && !(mode3d && collective < 0)) {
        const double ceil = blk[PB_PROP_DIAMETER];
        if (clr < ceil) {
            const double x = 1 - fmax(0, clr) / ceil;
            ge = 1 + blk[PB_GROUND_K] * x * x;
        }
    }

    // Torques, body frame (QP:730-740).
    double total = 0;
    double tq[3] = { 0, 0, 0 };
    for (int i = 0; i < SC_MOTOR_COUNT; i++) {
        const double t = thrust[i] * ge;
        total += t;
        tq[0] += MOTOR_Y[i] * arm * t;
        tq[1] -= MOTOR_X[i] * arm * t;
        double yaw;
        if (model == SC_MODEL_PHYSICAL) {
            // The motor's torque on its rotor is the prop's drag plus what
            // accelerates the rotor; the frame takes the opposite.
            const double w = omegaMotor[i];
            yaw = -spin(i) * (derived[PD_KQ_PROP] * w * fabs(w) + derived[PD_J_ROTOR] * motorAccel[i]);
        } else {
            yaw = -spin(i) * blk[PB_KQ_RATIO] * thrust[i] * (blk[PB_WHEELBASE] * 0.5);
        }
        tq[2] += yaw;
        sc_plant.thrustN[i] = thrust[i];
    }
    for (int k = 0; k < 3; k++) {
        tq[k] += -blk[PB_AERO_B] * om[k] - blk[PB_AERO_C] * om[k] * fabs(om[k]);
    }

    // Euler's equations with the gyroscopic term. The parity model keeps
    // quadmath's explicit step (QP:744-748). The physical model takes the
    // implicit midpoint (deliberate change, PROGRESS.md M4): the explicit step
    // adds energy to any tumble, x1e5 in 1 s at 147 rad/s of yaw, more than
    // any damping takes out again. Six fixed-point
    // iterations hold energy and |L| to 1e-6 over 1 s at 150 rad/s.
    const double inertia[3] = { derived[PD_IXX], derived[PD_IYY], derived[PD_IZZ] };
    const double om0[3] = { om[0], om[1], om[2] };
    const int iterations = model == SC_MODEL_PHYSICAL ? 6 : 1;
    for (int it = 0; it < iterations; it++) {
        double mid[3];
        for (int k = 0; k < 3; k++) {
            mid[k] = model == SC_MODEL_PHYSICAL ? (om0[k] + om[k]) * 0.5 : om0[k];
        }
        const double iw[3] = { inertia[0] * mid[0], inertia[1] * mid[1], inertia[2] * mid[2] };
        const double cross[3] = {
            mid[1] * iw[2] - mid[2] * iw[1],
            mid[2] * iw[0] - mid[0] * iw[2],
            mid[0] * iw[1] - mid[1] * iw[0],
        };
        for (int k = 0; k < 3; k++) {
            om[k] = om0[k] + ((tq[k] - cross[k]) / inertia[k]) * dt;
        }
    }
    qIntegrate(q, om, dt);
    // The gyro reads the rate the attitude turned with this tick. The contact
    // solve below then changes the body rate for the next tick without turning
    // the attitude; reporting that rate instead gave Betaflight rotation that
    // never happened (up to 2800 deg/s apart from the attitude's on a floor
    // strike), and its estimate walked off the attitude on the floor. In the
    // air, with no contact, the two are the same rate.
    const double omAttitude[3] = { om[0], om[1], om[2] };

    // Forces, world frame (QP:753-768).
    const double vBefore[3] = { v[0], v[1], v[2] };
    const double up[3] = { 0, 0, total };
    double f[3];
    qRotate(q, up, f);
    f[2] -= m * g;
    double meanOut = 0;
    for (int i = 0; i < SC_MOTOR_COUNT; i++) {
        meanOut += fabs(sc_plant.motorOut[i]);
    }
    meanOut /= SC_MOTOR_COUNT;
    double drag[3];
    dragForce(v, q, meanOut, drag);
    for (int k = 0; k < 3; k++) {
        f[k] += drag[k];
    }
    // Near the ground: quadmath's test is the CG over the floor (QP:720-727);
    // the physical model's is its hull clearance, the same datum as its ground
    // effect, so a box top counts as the floor does (the Air65's hullBelow is
    // quadmath's 10 mm pad, so over the floor nothing changes).
    const bool physical = model == SC_MODEL_PHYSICAL;
    if (physical ? clr <= 0.015 : p[2] <= sc_world_floor_z() + FLOOR_PAD_M + 0.015) {
        // Ground-contact brake, never an in-air damper.
        f[0] -= v[0] * 0.55 * m;
        f[1] -= v[1] * 0.55 * m;
    }
    for (int k = 0; k < 3; k++) {
        v[k] += f[k] * (dt / m);
        p[k] += v[k] * dt;
    }
    sc_plant.airborne = (physical ? clr + (p[2] - pStart[2]) > 0.04 : p[2] > sc_world_floor_z() + FLOOR_PAD_M + 0.04)
                        || fabs(total) > m * g * 0.5;

    // Floor, boxes and triggers (H:3150-3204), then what an accelerometer reads:
    // the velocity change over the tick less gravity, in the body frame.
    if (model == SC_MODEL_PHYSICAL) {
        sc_plant.contactFlags = footprintContact(p, v, q, om, pStart, qStart, dt);
    } else {
        sc_plant.contactFlags = sc_world_contact(p, v, om, dt, blk[PB_BOUNCE_SCALE], blk[PB_CRASH_SCALE],
                                                 blk[PB_SPIN_SCALE]);
    }
    const double sfWorld[3] = { (v[0] - vBefore[0]) / dt, (v[1] - vBefore[1]) / dt, (v[2] - vBefore[2]) / dt + g };
    qRotateInverse(q, sfWorld, sc_plant.specificForce);

    // Divergence guard (deliberate change 6): stop before NaN reaches Betaflight.
    if (!finite3(p) || !finite3(v) || !finite3(om) || !isfinite(q[0]) || fabs(om[0]) > DIVERGED_RAD_S
        || fabs(om[1]) > DIVERGED_RAD_S || fabs(om[2]) > DIVERGED_RAD_S) {
        sc_set_fault(SC_FAULT_PLANT_DIVERGED);      // the tick stops here
    }
    publishSensors(omAttitude);
}
