/*
 * System, IO, LED, serial and MSP stubs: the parts of a flight controller
 * board that sim-core does not have. Each one stands for absent hardware,
 * not for Betaflight behaviour.
 *
 * This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
 */
#include <stddef.h>

#include "platform.h"

#include "drivers/io.h"
#include "drivers/serial.h"
#include "drivers/stack_check.h"
#include "drivers/system.h"
#include "drivers/timer.h"
#include "io/statusindicator.h"
#include "msp/msp.h"
#include "msp/msp_serial.h"

#include "sc.h"

int sc_fault_state;
bool sc_reboot_flag;

void sc_set_fault(int code)
{
    if (sc_fault_state != SC_FAULT_NONE || code == SC_FAULT_NONE) {
        return;
    }
    sc_fault_state = code;
    const double value = code;
    sc_event_push(SC_EVENT_FAULT, &value, 1);
}

// One "cycle" per simulated microsecond. Only the scheduler's own load and
// guard bookkeeping and the CLI status line read cycles.
uint32_t SystemCoreClock = 1000000;

uint32_t getCycleCounter(void)
{
    return (uint32_t)sc_time_us;
}

uint32_t clockMicrosToCycles(uint32_t micros)
{
    return micros;
}

int32_t clockCyclesToMicros(int32_t clockCycles)
{
    return clockCycles;
}

// A reboot ends this instance. sim-core.js copies the EEPROM image out and
// boots a fresh instance from it, as the firmware would after a reset.
void systemReset(void)
{
    sc_reboot_flag = true;
}

void systemResetToBootloader(bootloaderRequestType_e requestType)
{
    UNUSED(requestType);
    sc_log_appendf("sim-core: no bootloader; reboot to bootloader ignored\n");
}

void failureMode(failureMode_e mode)
{
    sc_set_fault(SC_FAULT_BF_FAILURE_BASE + (int)mode);
}

uint32_t stackTotalSize(void)
{
    return 0;
}

uint32_t stackHighMem(void)
{
    return 0;
}

// No timers, pins or LEDs.
const timerHardware_t *timerGetConfiguredByTag(ioTag_t ioTag)
{
    UNUSED(ioTag);
    return NULL;
}

void IOInit(IO_t io, resourceOwner_e owner, uint8_t index)
{
    UNUSED(io);
    UNUSED(owner);
    UNUSED(index);
}

IO_t IOGetByTag(ioTag_t tag)
{
    UNUSED(tag);
    return IO_NONE;
}

void IOConfigGPIO(IO_t io, ioConfig_t cfg)
{
    UNUSED(io);
    UNUSED(cfg);
}

void IOToggle(IO_t io)
{
    UNUSED(io);
}

void IOWrite(IO_t io, bool value)
{
    UNUSED(io);
    UNUSED(value);
}

void warningLedFlash(void) {}
void warningLedDisable(void) {}
void warningLedUpdate(void) {}

// No serial ports carry MSP, and there is no TCP serial in a browser.
serialPort_t *serTcpOpen(int id, serialReceiveCallbackPtr rxCallback, void *rxCallbackData,
                         uint32_t baudRate, portMode_e mode, portOptions_e options)
{
    UNUSED(id);
    UNUSED(rxCallback);
    UNUSED(rxCallbackData);
    UNUSED(baudRate);
    UNUSED(mode);
    UNUSED(options);
    return NULL;
}

void mspSerialProcess(mspEvaluateNonMspData_e evaluateNonMspData, mspProcessCommandFnPtr mspProcessCommandFn,
                      mspProcessReplyFnPtr mspProcessReplyFn)
{
    UNUSED(evaluateNonMspData);
    UNUSED(mspProcessCommandFn);
    UNUSED(mspProcessReplyFn);
}

mspResult_e mspFcProcessCommand(mspDescriptor_t srcDesc, mspPacket_t *cmd, mspPacket_t *reply,
                                mspPostProcessFnPtr *mspPostProcessFn)
{
    UNUSED(srcDesc);
    UNUSED(cmd);
    UNUSED(reply);
    UNUSED(mspPostProcessFn);
    return MSP_RESULT_NO_REPLY;
}

void mspFcProcessReply(mspPacket_t *reply)
{
    UNUSED(reply);
}
