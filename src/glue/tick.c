/*
 * The fixed tick. Each tick is one gyro/PID cycle of SC_TICK_US microseconds:
 *
 *   1. data arrives: plant state into the sensor registers, an RX frame on the
 *      RX grid (sample and hold over the time-stamped input ring)
 *   2. Betaflight's realtime tasks GYRO, FILTER, PID (fc/core.c)
 *   3. rxFrameCheck and the failsafe check, as scheduler() does after them
 *   4. every other enabled task that is due, in task-id order, through
 *      Betaflight's own schedulerExecuteTask and task table (fc/tasks.c)
 *   5. the plant integrates one tick
 *
 * Betaflight's scheduler() picks among due tasks by CPU load and busy-waits on
 * the cycle counter. This loop replaces only that choice, with a fixed order,
 * so a run is the same on every host.
 *
 * This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
 */
#include <string.h>

#include "platform.h"

#include "common/time.h"
#include "common/utils.h"
#include "config/feature.h"
#include "drivers/time.h"
#include "fc/core.h"
#include "fc/rc_controls.h"
#include "fc/rc_modes.h"
#include "fc/tasks.h"
#include "flight/failsafe.h"
#include "pg/rx.h"
#include "rx/rx.h"
#include "rx/msp.h"
#include "scheduler/scheduler.h"

#include "sc.h"

#define SC_INPUT_RING 1024

typedef struct {
    uint64_t tUs;
    uint16_t ch[SC_RC_CHANNELS];
} scInput_t;

static scInput_t inputRing[SC_INPUT_RING];
static uint32_t inputHead;   // next slot to write
static uint32_t inputTail;   // oldest sample not yet consumed
static uint64_t inputLastUs;
static bool inputAny;

// Raw frame sent to Betaflight. Until the host sends a sample it is neutral
// (neutralFrame): any map and stick settings boot to arm-ready or a switch.
static uint16_t rxFrame[SC_RC_CHANNELS];
static bool neutralValid;
static uint32_t rxPeriodUs = 4000;
static bool rxLinkUp = true;
static timeUs_t rxLastFrameUs;
static timeMs_t lastFailsafeCheckMs;

static timeUs_t scRxFrameTimeUs(void)
{
    return rxLastFrameUs;
}

void sc_rx_set_rate(int hz)
{
    rxPeriodUs = 1000000u / (uint32_t)hz;
}

void sc_rx_link_set(bool up)
{
    rxLinkUp = up;
}

int sc_input_push(uint64_t tUs, const uint16_t *ch, int n)
{
    if (n < 4 || n > SC_RC_CHANNELS) {
        return SC_ERR_BAD_ARG;
    }
    if (inputAny && tUs < inputLastUs) {
        return SC_ERR_BAD_ARG;
    }
    for (int i = 0; i < n; i++) {
        if (ch[i] < 750 || ch[i] > 2250) {
            return SC_ERR_BAD_ARG;
        }
    }
    if (inputHead - inputTail >= SC_INPUT_RING) {
        return SC_ERR_FULL;
    }
    scInput_t *s = &inputRing[inputHead % SC_INPUT_RING];
    s->tUs = tUs;
    for (int i = 0; i < SC_RC_CHANNELS; i++) {
        s->ch[i] = i < n ? ch[i] : 1000;
    }
    inputHead++;
    inputLastUs = tUs;
    inputAny = true;
    return SC_OK;
}

// Sticks on Betaflight's centre (mid_rc), aux low, and the throttle where
// Betaflight's own check (fc/rc_controls.c calculateThrottleStatus) reads it as
// low: below min_check, or on mid_rc for 3D unless 3D-switched mode or the 3D
// box is on. The box state is Betaflight's, evaluated from earlier frames.
// Laid out through the rcmap: rcmap[function] is the raw channel carrying
// ROLL, PITCH, YAW, THROTTLE, AUX1..AUX4 (rx/rx.c).
static void neutralFrame(void)
{
    // Low values stay inside the valid pulse window (rx_min_usec, rx/rx.c),
    // or Betaflight would treat the frame as signal loss.
    const uint16_t validMin = rxConfig()->rx_min_usec;
    const uint16_t mid = rxConfig()->midrc;
    const uint16_t belowMincheck = rxConfig()->mincheck > 1000 ? 1000 : rxConfig()->mincheck - 1;
    const uint16_t low = belowMincheck > validMin ? belowMincheck : validMin;
    const uint16_t auxLow = 1000 > validMin ? 1000 : validMin;
    const bool throttleMid = featureIsEnabled(FEATURE_3D) && !flight3DConfig()->switched_mode3d && !IS_RC_MODE_ACTIVE(BOX3D);
    for (int i = 0; i < SC_RC_CHANNELS; i++) {
        rxFrame[i] = auxLow;
    }
    for (int function = 0; function < RX_MAPPABLE_CHANNEL_COUNT; function++) {
        const uint8_t raw = rxConfig()->rcmap[function];
        if (raw >= SC_RC_CHANNELS) {
            continue;
        }
        if (function == ROLL || function == PITCH || function == YAW) {
            rxFrame[raw] = mid;
        } else if (function == THROTTLE) {
            rxFrame[raw] = throttleMid ? mid : low;
        }
    }
    // Whether these flight channels are valid pulses by Betaflight's rule
    // (rx/rx.c isPulseValid, static there). If not, the config can never
    // arm, and a failsafe switch on aux low must not hide that (sim-core.js).
    neutralValid = true;
    for (int function = ROLL; function <= THROTTLE; function++) {
        const uint8_t raw = rxConfig()->rcmap[function];
        const uint16_t v = raw < SC_RC_CHANNELS ? rxFrame[raw] : 0;
        if (v < rxConfig()->rx_min_usec || v > rxConfig()->rx_max_usec) {
            neutralValid = false;
        }
    }
}

bool sc_neutral_frame_valid(void)
{
    return neutralValid;
}

// On every RX-grid tick the latest sample stamped at or before t becomes the
// current frame; later samples wait for their own frame. The radio keeps
// producing samples during a link loss, so they are consumed either way, and
// only the transmission to Betaflight stops.
static void rxGridTick(uint64_t t)
{
    if (!inputAny) {
        neutralFrame();
    }
    while (inputTail != inputHead && inputRing[inputTail % SC_INPUT_RING].tUs <= t) {
        memcpy(rxFrame, inputRing[inputTail % SC_INPUT_RING].ch, sizeof(rxFrame));
        inputTail++;
    }
    if (rxLinkUp) {
        rxMspFrameReceive(rxFrame, SC_RC_CHANNELS);
        rxLastFrameUs = (timeUs_t)t;
    }
}

static bool taskEnabled(taskId_e id)
{
    taskInfo_t info;
    getTaskInfo(id, &info);
    return info.isEnabled;
}

static void runSlackTasks(timeUs_t now)
{
    for (int id = 0; id < TASK_COUNT; id++) {
        if (id == TASK_GYRO || id == TASK_FILTER || id == TASK_PID) {
            continue;
        }
        if (!taskEnabled((taskId_e)id)) {
            continue;
        }
        task_t *task = getTask((unsigned)id);
        if (task->attribute->checkFunc) {
            // Event driven (RX): run each state while the task signals work,
            // as the scheduler does across its passes inside one cycle.
            for (int n = 0; n < 4; n++) {
                if (!task->attribute->checkFunc(now, cmpTimeUs(now, task->lastExecutedAtUs))) {
                    break;
                }
                schedulerExecuteTask(task, now);
            }
        } else if (cmpTimeUs(now, task->lastExecutedAtUs) >= task->attribute->desiredPeriodUs) {
            schedulerExecuteTask(task, now);
        }
    }
}

void sc_tick_init(void)
{
    neutralFrame();
    rxRuntimeState.rcFrameTimeUsFn = scRxFrameTimeUs;
    lastFailsafeCheckMs = millis();
}

static void tickOnce(void)
{
    const uint64_t t = sc_time_us;

    // 1. Data arrives.
    sc_sensors_to_betaflight();
    if ((t % rxPeriodUs) == 0) {
        rxGridTick(t);
    }

    const timeUs_t now = micros();

    // 2. Realtime tasks, gated as scheduler() gates them (scheduler.c:525-531).
    if (taskEnabled(TASK_GYRO)) {
        schedulerExecuteTask(getTask(TASK_GYRO), now);
        if (gyroFilterReady()) {
            schedulerExecuteTask(getTask(TASK_FILTER), now);
        }
        if (pidLoopReady()) {
            schedulerExecuteTask(getTask(TASK_PID), now);
        }
    }

    // 3. As scheduler() does after the realtime tasks.
    rxFrameCheck(now, cmpTimeUs(now, getTask(TASK_RX)->lastExecutedAtUs));
    if (cmp32(millis(), lastFailsafeCheckMs) > PERIOD_RXDATA_FAILURE) {
        failsafeCheckDataFailurePeriod();
        failsafeUpdateState();
        lastFailsafeCheckMs = millis();
    }

    // 4. Everything else that is due.
    runSlackTasks(now);

    // 5. The plant moves on by one tick; the clock follows it.
    sc_plant_step(SC_TICK_US * 1e-6);
    sc_time_us = t + SC_TICK_US;
    sc_trace_tick();
}

int sc_tick_run(int ticks)
{
    int ran = 0;
    while (ran < ticks && sc_fault_state == SC_FAULT_NONE && !sc_reboot_flag) {
        tickOnce();
        ran++;
    }
    return ran;
}
