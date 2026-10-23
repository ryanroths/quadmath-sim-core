/*
 * The exported ABI (sc_*), version 1. Everything sim-core.js calls goes
 * through here. Names follow the Phase 1 plan's ABI table (PROGRESS.md).
 *
 * This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
 */
#include <emscripten/emscripten.h>
#include <math.h>
#include <string.h>

#include "platform.h"

#include "build/debug.h"
#include "config/feature.h"
#include "fc/core.h"
#include "fc/rc.h"
#include "fc/rc_controls.h"
#include "fc/rc_modes.h"
#include "fc/runtime_config.h"
#include "flight/failsafe.h"
#include "flight/imu.h"
#include "flight/mixer.h"
#include "flight/pid.h"
#include "flight/rpm_filter.h"
#include "rx/rx.h"
#include "sensors/acceleration.h"
#include "sensors/battery.h"
#include "sensors/gyro.h"

#include "sc.h"
#include "plant/plant.h"

extern uint8_t eepromData[EEPROM_SIZE];

// Scratch memory for passing strings and channel arrays across the boundary.
static uint8_t scScratch[4096];

// State block v1: the plant, SI units, module frame. Index = meaning.
enum {
    ST_T_US = 0,
    ST_POS = 1,
    ST_VEL = 4,
    ST_QUAT = 7,
    ST_OMEGA = 11,
    ST_SPECIFIC_FORCE = 14,
    ST_MOTOR_DSHOT = 17,
    ST_MOTOR_OUT = 21,
    ST_MOTOR_DIR = 25,
    ST_RPM = 29,
    ST_THRUST_N = 33,
    ST_VBAT_LOADED = 37,
    ST_AMPS = 38,
    ST_MAH = 39,
    ST_SOC = 40,
    ST_GROUND_CLEARANCE = 41,
    ST_AIRBORNE = 42,
    ST_CONTACT_FLAGS = 43,
    ST_FAULT = 44,
    ST_LEN = 45,
};

// Betaflight readouts v1. The plan's list, then what the OSD and the tests
// read beyond it (motorsEnabled onwards).
enum {
    FC_ARMED = 0,
    FC_ARMING_DISABLE_FLAGS = 1,
    FC_FLIGHT_MODE_FLAGS = 2,
    FC_FAILSAFE_PHASE = 3,
    FC_VBAT = 4,
    FC_AMPS = 5,
    FC_MAH_DRAWN = 6,
    FC_CELLS = 7,
    FC_SETPOINT = 8,
    FC_GYRO_FILTERED = 11,
    FC_PID_SUM = 14,
    FC_RC_COMMAND = 17,
    FC_MOTOR = 21,
    FC_DEBUG = 25,
    FC_DEBUG_MODE = 33,
    FC_MOTORS_ENABLED = 34,
    FC_RC_DATA = 35,            // functions AETR, AUX1..AUX4
    FC_RX_SIGNAL = 43,
    FC_ATTITUDE = 44,           // roll, pitch, yaw, degrees
    FC_AIRMODE = 47,            // the plan's mode list beyond flightModeFlags
    FC_CRASH_FLIP = 48,
    FC_MODE_3D = 49,
    FC_RPM_FILTER = 50,         // isRpmFilterEnabled()
    FC_ACC = 51,                // Betaflight's accelerometer, g (acc.accADC / acc_1G)
    FC_LEN = 54,
};

static double scState[ST_LEN];
static double scFc[FC_LEN];

#define SC_EVENT_CAP 1024
static double scEvents[SC_EVENT_CAP * SC_EVENT_DOUBLES];
static int scEventCount;
static int scEventsDropped;

static sc_sha256_t scTrace;
static bool scTraceOn;
static uint8_t scTraceDigest[32];

static void fillState(void)
{
    double *s = scState;
    s[ST_T_US] = (double)sc_time_us;
    for (int i = 0; i < 3; i++) {
        s[ST_POS + i] = sc_plant.pos[i];
        s[ST_VEL + i] = sc_plant.vel[i];
        s[ST_OMEGA + i] = sc_plant.omega[i];
        s[ST_SPECIFIC_FORCE + i] = sc_plant.specificForce[i];
    }
    for (int i = 0; i < 4; i++) {
        s[ST_QUAT + i] = sc_plant.quat[i];
    }
    for (int i = 0; i < SC_MOTOR_COUNT; i++) {
        s[ST_MOTOR_DSHOT + i] = sc_motor_value[i];
        s[ST_MOTOR_OUT + i] = sc_plant.motorOut[i];
        s[ST_MOTOR_DIR + i] = sc_motor_dir[i];
        s[ST_RPM + i] = sc_plant.rpm[i];
        s[ST_THRUST_N + i] = sc_plant.thrustN[i];
    }
    s[ST_VBAT_LOADED] = sc_plant.vbatLoaded;
    s[ST_AMPS] = sc_plant.amps;
    s[ST_MAH] = sc_plant.mah;
    s[ST_SOC] = sc_plant.soc;
    s[ST_GROUND_CLEARANCE] = sc_plant.groundClearance;
    s[ST_AIRBORNE] = sc_plant.airborne ? 1 : 0;
    s[ST_CONTACT_FLAGS] = sc_plant.contactFlags;
    s[ST_FAULT] = sc_fault_state;
}

static void fillFc(void)
{
    double *f = scFc;
    f[FC_ARMED] = ARMING_FLAG(ARMED) ? 1 : 0;
    f[FC_ARMING_DISABLE_FLAGS] = (double)getArmingDisableFlags();
    f[FC_FLIGHT_MODE_FLAGS] = (double)flightModeFlags;
    f[FC_FAILSAFE_PHASE] = (double)failsafePhase();
    f[FC_VBAT] = getBatteryVoltage() / 100.0;
    f[FC_AMPS] = getAmperage() / 100.0;
    f[FC_MAH_DRAWN] = getMAhDrawn();
    f[FC_CELLS] = getBatteryCellCount();
    for (int axis = 0; axis < 3; axis++) {
        f[FC_SETPOINT + axis] = getSetpointRate(axis);
        f[FC_GYRO_FILTERED + axis] = gyro.gyroADCf[axis];
        f[FC_PID_SUM + axis] = pidData[axis].Sum;
    }
    for (int i = 0; i < 4; i++) {
        f[FC_RC_COMMAND + i] = rcCommand[i];
        f[FC_MOTOR + i] = motor[i];
    }
    for (int i = 0; i < 8; i++) {
        f[FC_DEBUG + i] = debug[i];
        f[FC_RC_DATA + i] = rcData[i];
    }
    f[FC_DEBUG_MODE] = debugMode;
    f[FC_MOTORS_ENABLED] = sc_motors_enabled ? 1 : 0;
    f[FC_RX_SIGNAL] = rxIsReceivingSignal() ? 1 : 0;
    f[FC_ATTITUDE] = attitude.values.roll / 10.0;
    f[FC_ATTITUDE + 1] = attitude.values.pitch / 10.0;
    f[FC_ATTITUDE + 2] = attitude.values.yaw / 10.0;
    f[FC_AIRMODE] = airmodeIsEnabled() ? 1 : 0;
    f[FC_CRASH_FLIP] = isFlipOverAfterCrashActive() ? 1 : 0;
    f[FC_MODE_3D] = featureIsEnabled(FEATURE_3D) ? 1 : 0;
    f[FC_RPM_FILTER] = isRpmFilterEnabled() ? 1 : 0;
    for (int axis = 0; axis < 3; axis++) {
        f[FC_ACC + axis] = acc.dev.acc_1G ? acc.accADC[axis] / acc.dev.acc_1G : 0;
    }
}

void sc_event_push(int kind, const double *values, int n)
{
    if (scEventCount >= SC_EVENT_CAP) {
        scEventsDropped++;
        return;
    }
    double *e = &scEvents[scEventCount * SC_EVENT_DOUBLES];
    memset(e, 0, SC_EVENT_DOUBLES * sizeof(double));
    e[0] = (double)sc_time_us;
    e[1] = kind;
    for (int i = 0; i < n && i < SC_EVENT_DOUBLES - 2; i++) {
        e[2 + i] = values[i];
    }
    scEventCount++;
}

void sc_trace_tick(void)
{
    if (!scTraceOn) {
        return;
    }
    fillState();
    fillFc();
    sc_sha256_update(&scTrace, scState, sizeof(scState));
    sc_sha256_update(&scTrace, scFc, sizeof(scFc));
}

EMSCRIPTEN_KEEPALIVE int sc_abi_version(void) { return SC_ABI_VERSION; }
EMSCRIPTEN_KEEPALIVE int sc_loop_hz(void) { return SC_LOOP_HZ; }
EMSCRIPTEN_KEEPALIVE uint8_t *sc_scratch_ptr(void) { return scScratch; }
EMSCRIPTEN_KEEPALIVE int sc_scratch_size(void) { return (int)sizeof(scScratch); }
EMSCRIPTEN_KEEPALIVE uint8_t *sc_eeprom_ptr(void) { return eepromData; }
EMSCRIPTEN_KEEPALIVE int sc_eeprom_size(void) { return EEPROM_SIZE; }

// Boots Betaflight from whatever is in eepromData (zeros = factory defaults).
EMSCRIPTEN_KEEPALIVE int sc_boot(void)
{
    sc_time_us = SC_BOOT_EPOCH_US;
    sc_fault_state = SC_FAULT_NONE;
    sc_reboot_flag = false;
    scEventCount = 0;
    scEventsDropped = 0;
    sc_plant_init();
    sc_boot_betaflight();
    sc_tick_init();
    if (sc_fault_state == SC_FAULT_NONE) {
        const int failed = sc_boot_asserts();
        if (failed) {
            sc_set_fault(SC_FAULT_BOOT_ASSERT_BASE + failed);
        }
    }
    return sc_fault_state;
}

EMSCRIPTEN_KEEPALIVE int sc_pg_missing(void) { return sc_pg_missing_count(); }

// Config instance only: the flight instance never enters the CLI.
EMSCRIPTEN_KEEPALIVE void sc_cli_enter(void) { sc_cli_port_enter(); }

// Applies one CLI line of len bytes at ptr. Returns 0 when Betaflight accepted
// it, 1 when Betaflight printed ###ERROR for it, <0 for a bad call.
EMSCRIPTEN_KEEPALIVE int sc_cli_line(const char *ptr, int len)
{
    if (!ptr || len < 0 || len > 255) {
        return SC_ERR_BAD_ARG;
    }
    char line[256];
    memcpy(line, ptr, (size_t)len);
    const int before = sc_log_len();
    const int rc = sc_cli_feed(line, len);
    if (rc != SC_OK) {
        return rc;
    }
    // The CLI echoes the typed line first (cli/cli.c processCharacter), so
    // skip it; Betaflight's errors start a line of their own ("###ERROR IN").
    const char *log = sc_log_ptr();
    const int end = sc_log_len();
    int i = before;
    while (i < end && log[i] != '\n') {
        i++;
    }
    for (i++; i + 8 <= end; i++) {
        if (log[i - 1] == '\n' && memcmp(&log[i], "###ERROR", 8) == 0) {
            return 1;
        }
    }
    return 0;
}

EMSCRIPTEN_KEEPALIVE const char *sc_cli_log_ptr(void) { return sc_log_ptr(); }
EMSCRIPTEN_KEEPALIVE int sc_cli_log_len(void) { return sc_log_len(); }
EMSCRIPTEN_KEEPALIVE int sc_cli_log_truncated(void) { return sc_log_truncated(); }
EMSCRIPTEN_KEEPALIVE void sc_cli_log_clear(void) { sc_log_clear(); }
EMSCRIPTEN_KEEPALIVE int sc_reboot_requested(void) { return sc_reboot_flag; }

// Battery carried across a reinit: soc2[0] state of charge, soc2[1] filtered
// pack voltage. Only after sc_boot and before the first tick.
EMSCRIPTEN_KEEPALIVE int sc_battery_carry(const double *soc2)
{
    if (sc_time_us != SC_BOOT_EPOCH_US) {
        return SC_ERR_BAD_STATE;
    }
    // A flat physical pack publishes 0 V; its carry uses only the charge.
    if (!soc2 || !(soc2[0] >= 0.0 && soc2[0] <= 1.0) || !(soc2[1] >= 0.0 && soc2[1] < 100.0)) {
        return SC_ERR_BAD_ARG;
    }
    sc_plant_battery_carry(soc2[0], soc2[1]);
    return SC_OK;
}

// What sc_battery_carry takes, read from the running plant: out2[0] state of
// charge, out2[1] filtered pack voltage.
EMSCRIPTEN_KEEPALIVE int sc_battery_state(double *out2)
{
    if (!out2) {
        return SC_ERR_BAD_ARG;
    }
    out2[0] = sc_plant.soc;
    out2[1] = sc_plant.vbatFiltered;
    return SC_OK;
}

// Plant block v1 (src/plant/plant.h), count doubles. Only after sc_boot and
// before the first tick; it puts the quad at rest on the floor with a full
// pack (carry the battery after it).
EMSCRIPTEN_KEEPALIVE int sc_plant_set(const double *block, int count)
{
    if (sc_time_us != SC_BOOT_EPOCH_US) {
        return SC_ERR_BAD_STATE;
    }
    return sc_plant_configure(block, count);
}

EMSCRIPTEN_KEEPALIVE int sc_plant_len(void) { return PB_LEN; }

// Bench override, for plant tests only: motor (0..3, or -1 for all) runs at
// duty (-1..1) whatever Betaflight sends; a duty outside -1..1 clears it. The
// rest plant has no motors to override.
EMSCRIPTEN_KEEPALIVE int sc_motor_override(int motor, double duty)
{
    if (sc_plant_model() == SC_MODEL_REST) {
        return SC_ERR_BAD_STATE;
    }
    if (motor < -1 || motor >= SC_MOTOR_COUNT || !isfinite(duty)) {
        return SC_ERR_BAD_ARG;
    }
    sc_plant_override(motor, duty);
    return SC_OK;
}
EMSCRIPTEN_KEEPALIVE const double *sc_plant_derived_ptr(void) { return sc_plant_derived(); }
EMSCRIPTEN_KEEPALIVE int sc_plant_derived_len(void) { return PD_LEN; }

// World geometry, quantised: module-frame micrometres, box = x0 y0 z0 x1 y1 z1.
EMSCRIPTEN_KEEPALIVE void sc_world_clear(void)
{
    sc_world_reset();
    sc_plant_floor_moved();
}

// Whether the last sc_step stopped after a tick that entered a trigger.
EMSCRIPTEN_KEEPALIVE int sc_tick_stopped(void) { return sc_tick_stop; }
EMSCRIPTEN_KEEPALIVE void sc_world_floor(int zUm)
{
    sc_world_set_floor(zUm);
    sc_plant_floor_moved();
}

EMSCRIPTEN_KEEPALIVE int sc_world_box(const int32_t *boxUm, int kind, int id)
{
    return boxUm ? sc_world_add_box(boxUm, kind, id) : SC_ERR_BAD_ARG;
}

EMSCRIPTEN_KEEPALIVE int sc_world_trigger(const int32_t *boxUm, int id)
{
    return boxUm ? sc_world_add_trigger(boxUm, id) : SC_ERR_BAD_ARG;
}

// Ground clearance (m) at a module-frame point in micrometres.
EMSCRIPTEN_KEEPALIVE double sc_world_clearance(const int32_t *posUm)
{
    if (!posUm) {
        return NAN;
    }
    const double pos[3] = { posUm[0] * 1e-6, posUm[1] * 1e-6, posUm[2] * 1e-6 };
    return sc_world_clearance_at(pos);
}

// A pose event at the next tick boundary: position in micrometres, quaternion
// (w x y z) in units of 1e-9, velocity in micrometres per second. The rest
// plant never moves, so it refuses one.
EMSCRIPTEN_KEEPALIVE int sc_pose(const int32_t *posUm, const int32_t *quatE9, const int32_t *velUmS)
{
    if (sc_plant_model() == SC_MODEL_REST) {
        return SC_ERR_BAD_STATE;
    }
    if (!posUm || !quatE9 || !velUmS) {
        return SC_ERR_BAD_ARG;
    }
    double q[4];
    double n = 0;
    for (int i = 0; i < 4; i++) {
        q[i] = quatE9[i] * 1e-9;
        n += q[i] * q[i];
    }
    if (!(n > 0)) {
        return SC_ERR_BAD_ARG;
    }
    n = sqrt(n);
    for (int i = 0; i < 4; i++) {
        q[i] /= n;
    }
    const double pos[3] = { posUm[0] * 1e-6, posUm[1] * 1e-6, posUm[2] * 1e-6 };
    const double vel[3] = { velUmS[0] * 1e-6, velUmS[1] * 1e-6, velUmS[2] * 1e-6 };
    sc_plant_pose(pos, q, vel);
    return SC_OK;
}

// One 16-channel sample in raw channel order, stamped at sim time tUs. Stamps
// never go backwards. Accepts 750..2250 per channel (Betaflight's own pulse
// checks decide the rest); sim-core.js narrows that to 1000..2000.
EMSCRIPTEN_KEEPALIVE int sc_input(const uint16_t *ch16, double tUs)
{
    // Whole microseconds only: a fractional stamp would land in an earlier
    // frame than it names.
    if (!ch16 || !(tUs >= 0.0) || tUs > 9007199254740991.0 || tUs != (double)(uint64_t)tUs) {
        return SC_ERR_BAD_ARG;
    }
    uint16_t ch[SC_RC_CHANNELS];
    memcpy(ch, ch16, sizeof(ch));
    return sc_input_push((uint64_t)tUs, ch, SC_RC_CHANNELS);
}

// 250, 500 or 1000 Hz, and only if frames land on whole ticks.
EMSCRIPTEN_KEEPALIVE int sc_set_rx_rate(int hz)
{
    if ((hz != 250 && hz != 500 && hz != 1000) || hz > SC_LOOP_HZ || ((1000000 / hz) % SC_TICK_US) != 0) {
        return SC_ERR_BAD_ARG;
    }
    sc_rx_set_rate(hz);
    return SC_OK;
}

EMSCRIPTEN_KEEPALIVE void sc_rx_link(int up) { sc_rx_link_set(up != 0); }

// 1 when the boot frame's sticks and throttle are valid pulses for this config.
EMSCRIPTEN_KEEPALIVE int sc_neutral_valid(void) { return sc_neutral_frame_valid() ? 1 : 0; }

EMSCRIPTEN_KEEPALIVE int sc_step(int ticks) { return ticks > 0 ? sc_tick_run(ticks) : 0; }
EMSCRIPTEN_KEEPALIVE int sc_fault(void) { return sc_fault_state; }
EMSCRIPTEN_KEEPALIVE double sc_time(void) { return (double)sc_time_us; }

EMSCRIPTEN_KEEPALIVE double *sc_state_ptr(void)
{
    fillState();
    return scState;
}

EMSCRIPTEN_KEEPALIVE int sc_state_len(void) { return ST_LEN; }

EMSCRIPTEN_KEEPALIVE double *sc_fc_ptr(void)
{
    fillFc();
    return scFc;
}

EMSCRIPTEN_KEEPALIVE int sc_fc_len(void) { return FC_LEN; }

EMSCRIPTEN_KEEPALIVE double *sc_events_ptr(void) { return scEvents; }
EMSCRIPTEN_KEEPALIVE int sc_events_len(void) { return scEventCount; }
EMSCRIPTEN_KEEPALIVE int sc_events_dropped(void) { return scEventsDropped; }

EMSCRIPTEN_KEEPALIVE void sc_events_clear(void)
{
    scEventCount = 0;
    scEventsDropped = 0;
}

// Starts the trace hash over: every tick from here on adds the state and
// Betaflight blocks as they stand at the end of the tick.
EMSCRIPTEN_KEEPALIVE void sc_trace_start(void)
{
    sc_sha256_init(&scTrace);
    scTraceOn = true;
}

// NULL until sc_trace_start: no hash covers a run that was not traced.
EMSCRIPTEN_KEEPALIVE const uint8_t *sc_trace_digest(void)
{
    if (!scTraceOn) {
        return NULL;
    }
    sc_sha256_final(&scTrace, scTraceDigest);
    return scTraceDigest;
}
