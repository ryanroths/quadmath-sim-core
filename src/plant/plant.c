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
 *   prop    thrust = kt w|w|, reaction torque = -spin kq w|w|
 *   pack    V = OCV(SoC) - I x cell IR, I = bench current x duty / reference
 *           duty, the reference being the hover duty on a full pack that sags
 *           at the bench current
 *
 * kt and kq are fixed by quadmath's thrust and yaw torque at full speed; R by
 * quadmath's loaded-speed fraction; J by quadmath's motor time constant at
 * hover. airframes/air65.json cites where each input comes from.
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
static double spoolOut[SC_MOTOR_COUNT];     // parity: quadmath motor output, signed
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
static double ocvCell(double soc)
{
    static const double SOC[7] = { 0.00, 0.05, 0.15, 0.40, 0.70, 0.90, 1.00 };
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
    derived[PD_DUTY_CURRENT_REF] = vHover / ((blk[PB_OCV + 6] - blk[PB_I_REF] * blk[PB_CELL_IR]) * cells);
}

static void publishSensors(void)
{
    const double g = model == SC_MODEL_REST ? 9.81 : blk[PB_GRAVITY];
    for (int axis = 0; axis < 3; axis++) {
        sc_sensors.gyro_dps[axis] = sc_plant.omega[axis] * (360.0 / TWO_PI);
        sc_sensors.acc_g[axis] = sc_plant.specificForce[axis] / g;
    }
    for (int i = 0; i < SC_MOTOR_COUNT; i++) {
        sc_sensors.rpm[i] = sc_plant.rpm[i];
    }
    sc_sensors.vbat_v = sc_plant.vbatLoaded;
    sc_sensors.current_a = sc_plant.amps;
}

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
    memset(spoolOut, 0, sizeof(spoolOut));
    memset(thrust, 0, sizeof(thrust));
    sc_plant.pos[0] = 0;
    sc_plant.pos[1] = 0;
    sc_plant.pos[2] = floorZ + FLOOR_PAD_M;
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
    publishSensors();
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
                                        && block[PB_CAPACITY_MAH] > 0 && block[PB_I_REF] >= 0 && block[PB_CELL_IR] >= 0)) {
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
    // The current stand-in's reference: a reachable duty (at most 1), on the
    // lower root of u (V - I(u) R) = hover volts, which needs iRef x cellIR at
    // most half the full-pack voltage. Otherwise refuse and keep the old block.
    if (m == SC_MODEL_PHYSICAL
        && !(derived[PD_DUTY_CURRENT_REF] > 0 && derived[PD_DUTY_CURRENT_REF] <= 1
             && 2 * blk[PB_I_REF] * blk[PB_CELL_IR] <= blk[PB_OCV + 6])) {
        memcpy(blk, prevBlk, sizeof(blk));
        model = prevModel;
        memset(derived, 0, sizeof(derived));
        derive();
        return SC_ERR_BAD_ARG;
    }
    restState();
    publishSensors();
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
    publishSensors();
}

void sc_plant_floor_moved(void)
{
    if (model == SC_MODEL_REST) {
        sc_plant.pos[2] = sc_world_floor_z() + FLOOR_PAD_M;
    }
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

// Physical motors and pack for one tick. Returns nothing; fills thrust[].
static void stepPhysical(const double duty[SC_MOTOR_COUNT], double dt)
{
    const double cells = blk[PB_CELLS];
    // Pack current: the bench cruise current scaled by duty over hover duty
    // (owner decision 2026-10-22, a stand-in until Phase 3).
    double meanDuty = 0;
    for (int i = 0; i < SC_MOTOR_COUNT; i++) {
        meanDuty += fabs(duty[i]);
    }
    meanDuty /= SC_MOTOR_COUNT;
    const double amps = blk[PB_I_REF] * meanDuty / derived[PD_DUTY_CURRENT_REF];
    const double volts = fmax(0, ocvCell(sc_plant.soc) * cells - amps * blk[PB_CELL_IR] * cells);
    sc_plant.amps = amps;
    sc_plant.vbatLoaded = volts;
    sc_plant.vbatFiltered = volts;
    sc_plant.mah += amps * dt / 3.6;
    sc_plant.soc = fmax(0, sc_plant.soc - amps * dt / (blk[PB_CAPACITY_MAH] * 3.6));

    const double kv = derived[PD_KV_RAD], kt = derived[PD_KT_MOTOR], r = derived[PD_R_WINDING];
    const double j = derived[PD_J_ROTOR], ktProp = derived[PD_KT_PROP], kqProp = derived[PD_KQ_PROP];
    const double a = kt / (j * r);
    for (int i = 0; i < SC_MOTOR_COUNT; i++) {
        double w = omegaMotor[i];
        // Back-EMF term implicit (it is the stiff part), prop drag explicit.
        w = (w + dt * (a * duty[i] * volts - kqProp * w * fabs(w) / j)) / (1 + dt * a / kv);
        omegaMotor[i] = w;
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
    const double m = blk[PB_MASS];
    const double g = blk[PB_GRAVITY];
    const double arm = derived[PD_ARM];

    // Ground effect from the position at the end of the last tick (QP:720-727);
    // not while 3D pulls down. Thrust and roll/pitch torque only.
    double ge = 1;
    const double clr = sc_world_clearance_at(p);
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
            const double w = omegaMotor[i];
            yaw = -spin(i) * derived[PD_KQ_PROP] * w * fabs(w);
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
    // adds energy to any tumble, x1e5 in 1 s at 147 rad/s of yaw, and with
    // quadratic-only drag nothing takes it out again. Six fixed-point
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
    if (p[2] <= sc_world_floor_z() + FLOOR_PAD_M + 0.015) {
        // Ground-contact brake, never an in-air damper.
        f[0] -= v[0] * 0.55 * m;
        f[1] -= v[1] * 0.55 * m;
    }
    for (int k = 0; k < 3; k++) {
        v[k] += f[k] * (dt / m);
        p[k] += v[k] * dt;
    }
    sc_plant.airborne = p[2] > sc_world_floor_z() + FLOOR_PAD_M + 0.04 || fabs(total) > m * g * 0.5;

    // Floor, boxes and triggers (H:3150-3204), then what an accelerometer reads:
    // the velocity change over the tick less gravity, in the body frame.
    sc_plant.contactFlags = sc_world_contact(p, v, om, dt, blk[PB_BOUNCE_SCALE], blk[PB_CRASH_SCALE], blk[PB_SPIN_SCALE]);
    const double sfWorld[3] = { (v[0] - vBefore[0]) / dt, (v[1] - vBefore[1]) / dt, (v[2] - vBefore[2]) / dt + g };
    qRotateInverse(q, sfWorld, sc_plant.specificForce);

    // Divergence guard (deliberate change 6): stop before NaN reaches Betaflight.
    if (!finite3(p) || !finite3(v) || !finite3(om) || !isfinite(q[0]) || fabs(om[0]) > DIVERGED_RAD_S
        || fabs(om[1]) > DIVERGED_RAD_S || fabs(om[2]) > DIVERGED_RAD_S) {
        sc_set_fault(SC_FAULT_PLANT_DIVERGED);      // the tick stops here
    }
    publishSensors();
}
