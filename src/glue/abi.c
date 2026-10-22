/*
 * The exported ABI (sc_*). Everything sim-core.js calls goes through here.
 * Version 1, partial: enough to boot, configure through the CLI, feed sticks,
 * step, and read Betaflight's and the plant's state.
 *
 * This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
 */
#include <emscripten/emscripten.h>
#include <string.h>

#include "platform.h"

#include "fc/rc.h"
#include "fc/rc_controls.h"
#include "fc/runtime_config.h"
#include "flight/failsafe.h"
#include "flight/imu.h"
#include "flight/mixer.h"
#include "rx/rx.h"
#include "sensors/battery.h"
#include "sensors/gyro.h"

#include "sc.h"

extern uint8_t eepromData[EEPROM_SIZE];

// Scratch memory for passing strings and channel arrays across the boundary.
static uint8_t scScratch[4096];

static double scState[64];

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
    sc_fault = SC_FAULT_NONE;
    sc_reboot_requested = false;
    sc_plant_init();
    sc_boot_betaflight();
    sc_tick_init();
    if (sc_fault == SC_FAULT_NONE) {
        const int failed = sc_boot_asserts();
        if (failed) {
            sc_fault = SC_FAULT_BOOT_ASSERT_BASE + failed;
        }
    }
    return sc_fault;
}

EMSCRIPTEN_KEEPALIVE int sc_pg_missing(void) { return sc_pg_missing_count(); }

EMSCRIPTEN_KEEPALIVE void sc_cli_begin(void) { sc_cli_enter(); }

// Applies one CLI line held in scratch. Returns 0 when Betaflight accepted it,
// 1 when Betaflight printed ###ERROR for it, <0 for a bad call.
EMSCRIPTEN_KEEPALIVE int sc_cli_line(int len)
{
    if (len < 0 || len >= (int)sizeof(scScratch)) {
        return SC_ERR_BAD_ARG;
    }
    const int before = sc_log_len();
    const int rc = sc_cli_feed((const char *)scScratch, len);
    if (rc != SC_OK) {
        return rc;
    }
    const char *log = sc_log_ptr();
    for (int i = before; i + 8 <= sc_log_len(); i++) {
        if (memcmp(&log[i], "###ERROR", 8) == 0) {
            return 1;
        }
    }
    return 0;
}

EMSCRIPTEN_KEEPALIVE const char *sc_log_ptr_export(void) { return sc_log_ptr(); }
EMSCRIPTEN_KEEPALIVE int sc_log_len_export(void) { return sc_log_len(); }
EMSCRIPTEN_KEEPALIVE int sc_log_truncated_export(void) { return sc_log_truncated(); }
EMSCRIPTEN_KEEPALIVE void sc_log_clear_export(void) { sc_log_clear(); }
EMSCRIPTEN_KEEPALIVE int sc_reboot_pending(void) { return sc_reboot_requested; }

// One input sample from scratch: n uint16 channel values (1000..2000),
// stamped at sim time tUs.
EMSCRIPTEN_KEEPALIVE int sc_input(double tUs, int n)
{
    // Whole microseconds only: a fractional stamp would land in an earlier
    // frame than it names.
    if (!(tUs >= 0.0) || tUs > 9007199254740991.0 || tUs != (double)(uint64_t)tUs
        || n < 4 || n > SC_RC_CHANNELS) {
        return SC_ERR_BAD_ARG;
    }
    uint16_t ch[SC_RC_CHANNELS];
    memcpy(ch, scScratch, (size_t)n * sizeof(uint16_t));
    return sc_input_push((uint64_t)tUs, ch, n);
}

// 250, 500 or 1000 Hz, and only if frames land on whole ticks.
EMSCRIPTEN_KEEPALIVE int sc_rx_rate(int hz)
{
    if ((hz != 250 && hz != 500 && hz != 1000) || hz > SC_LOOP_HZ || ((1000000 / hz) % SC_TICK_US) != 0) {
        return SC_ERR_BAD_ARG;
    }
    sc_rx_set_rate(hz);
    return SC_OK;
}

EMSCRIPTEN_KEEPALIVE void sc_rx_link_export(int up) { sc_rx_link(up != 0); }

EMSCRIPTEN_KEEPALIVE int sc_step(int ticks) { return ticks > 0 ? sc_tick_run(ticks) : 0; }
EMSCRIPTEN_KEEPALIVE int sc_fault_code(void) { return sc_fault; }
EMSCRIPTEN_KEEPALIVE double sc_time(void) { return (double)sc_time_us; }

// State block v1 (partial). Index = meaning; frozen once the ABI is.
EMSCRIPTEN_KEEPALIVE double *sc_state(void)
{
    double *s = scState;
    memset(scState, 0, sizeof(scState));
    s[0] = (double)sc_time_us;
    s[1] = ARMING_FLAG(ARMED) ? 1 : 0;
    s[2] = (double)getArmingDisableFlags();
    s[3] = (double)flightModeFlags;
    s[4] = (double)failsafePhase();
    for (int i = 0; i < SC_MOTOR_COUNT; i++) {
        s[5 + i] = sc_motor_value[i];       // DShot value sent to the ESC
        s[10 + i] = motor[i];               // Betaflight mixer output
    }
    s[9] = sc_motors_enabled ? 1 : 0;
    for (int axis = 0; axis < 3; axis++) {
        s[14 + axis] = getSetpointRate(axis);
        s[17 + axis] = gyro.gyroADCf[axis];
    }
    for (int i = 0; i < 4; i++) {
        s[20 + i] = rcCommand[i];
        s[24 + i] = rcData[i];
    }
    s[28] = getBatteryVoltage() / 100.0;
    s[29] = getBatteryCellCount();
    s[30] = getAmperage() / 100.0;
    s[31] = rxIsReceivingSignal() ? 1 : 0;
    s[32] = attitude.values.roll / 10.0;
    s[33] = attitude.values.pitch / 10.0;
    s[34] = attitude.values.yaw / 10.0;
    for (int i = 0; i < 4; i++) {
        s[35 + i] = rcData[4 + i];
    }
    return s;
}
