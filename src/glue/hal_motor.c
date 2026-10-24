/*
 * Motor output for Betaflight: a DShot "ESC" that hands Betaflight's motor
 * values to the plant and returns the plant's eRPM as bidirectional DShot
 * telemetry, decoded by Betaflight's own code (drivers/dshot.c).
 *
 * This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
 */
#include <math.h>
#include <string.h>

#include "platform.h"

#include "drivers/dshot.h"
#include "drivers/dshot_command.h"
#include "drivers/motor.h"
#include "drivers/time.h"
#include "drivers/pwm_output.h"
#include "pg/motor.h"

#include "sc.h"

// Storage Betaflight's motor and DShot code expects a board to provide.
FAST_DATA_ZERO_INIT pwmOutputPort_t motors[MAX_SUPPORTED_MOTORS];
FAST_DATA_ZERO_INIT bool useDshotTelemetry = false;

// Same layout as dshotDMAHandlerCycleCounters_t (drivers/pwm_output_dshot_shared.h,
// whose header needs DMA types). Only the CLI's DShot telemetry info reads it.
typedef struct {
    uint32_t irqAt;
    uint32_t changeDirectionCompletedAt;
} scDshotDmaCounters_t;
FAST_DATA_ZERO_INIT scDshotDmaCounters_t dshotDMAHandlerCycleCounters;

float sc_motor_value[SC_MOTOR_COUNT];
int8_t sc_motor_dir[SC_MOTOR_COUNT] = { 1, 1, 1, 1 };
bool sc_motors_enabled;

static motorDevice_t scMotorDevice;

// Bidirectional DShot replies carry the eRPM period in microseconds as
// "eeem mmmm mmmm": mantissa << exponent. 0x0fff means no rotation.
static uint16_t erpmToTelemetryValue(double erpm)
{
    if (!(erpm >= 1.0)) {
        return 0x0fff;
    }
    uint32_t period = (uint32_t)(60000000.0 / erpm + 0.5);
    unsigned exponent = 0;
    while ((period >> exponent) > 0x1ff && exponent < 7) {
        exponent++;
    }
    uint32_t mantissa = period >> exponent;
    if (mantissa > 0x1ff) {
        mantissa = 0x1ff;
    }
    if (mantissa == 0) {
        mantissa = 1;
    }
    return (uint16_t)((exponent << 9) | mantissa);
}

static void scMotorPostInit(void) {}

static bool scMotorEnable(void)
{
    sc_motors_enabled = true;
    return true;
}

static void scMotorDisable(void)
{
    sc_motors_enabled = false;
}

static bool scMotorIsEnabled(uint8_t index)
{
    UNUSED(index);
    return sc_motors_enabled;
}

// Called by motorWriteAll() before each write, as on hardware, where the ESC's
// reply to the previous frame is decoded here.
static bool scMotorDecodeTelemetry(void)
{
    if (!useDshotTelemetry) {
        return true;
    }
    // The ESC reports electrical rpm; Betaflight divides by its own
    // motor_poles / 2 (drivers/dshot.c), so encode with the same count.
    const double polePairs = motorConfig()->motorPoleCount / 2.0;
    for (int i = 0; i < SC_MOTOR_COUNT; i++) {
        dshotTelemetryState.motorState[i].rawValue = erpmToTelemetryValue(sc_sensors.rpm[i] * polePairs);
        dshotTelemetryState.motorState[i].telemetryTypes = DSHOT_NORMAL_TELEMETRY_MASK;
    }
    dshotTelemetryState.readCount++;
    dshotTelemetryState.rawValueState = DSHOT_RAW_VALUE_STATE_NOT_PROCESSED;
    return true;
}

// A DShot frame carries an 11-bit integer; the ESC never sees a fraction.
static void scMotorWrite(uint8_t index, float value)
{
    if (index < SC_MOTOR_COUNT) {
        sc_motor_value[index] = (float)lrintf(value);
    }
}

static void scMotorWriteInt(uint8_t index, uint16_t value)
{
    scMotorWrite(index, (float)value);
}

static void scMotorUpdateComplete(void) {}

static void scMotorShutdown(void)
{
    for (int i = 0; i < SC_MOTOR_COUNT; i++) {
        sc_motor_value[i] = 0.0f;
    }
}

motorDevice_t *dshotPwmDevInit(const struct motorDevConfig_s *motorConfig, uint16_t idlePulse, uint8_t motorCount,
                               bool useUnsyncedPwm)
{
    UNUSED(idlePulse);
    UNUSED(motorCount);
    UNUSED(useUnsyncedPwm);

    useDshotTelemetry = motorConfig->useDshotTelemetry;

    memset(&scMotorDevice, 0, sizeof(scMotorDevice));
    scMotorDevice.vTable.postInit = scMotorPostInit;
    scMotorDevice.vTable.convertExternalToMotor = dshotConvertFromExternal;
    scMotorDevice.vTable.convertMotorToExternal = dshotConvertToExternal;
    scMotorDevice.vTable.enable = scMotorEnable;
    scMotorDevice.vTable.disable = scMotorDisable;
    scMotorDevice.vTable.isMotorEnabled = scMotorIsEnabled;
    scMotorDevice.vTable.decodeTelemetry = scMotorDecodeTelemetry;
    scMotorDevice.vTable.write = scMotorWrite;
    scMotorDevice.vTable.writeInt = scMotorWriteInt;
    scMotorDevice.vTable.updateComplete = scMotorUpdateComplete;
    scMotorDevice.vTable.shutdown = scMotorShutdown;
    return &scMotorDevice;
}

// Non-DShot protocols are rejected at config time; Betaflight falls back to
// its null motor device if one ever gets here.
motorDevice_t *motorPwmDevInit(const struct motorDevConfig_s *motorDevConfig, uint16_t idlePulse, uint8_t motorCount,
                               bool useUnsyncedPwm)
{
    UNUSED(motorDevConfig);
    UNUSED(idlePulse);
    UNUSED(motorCount);
    UNUSED(useUnsyncedPwm);
    return NULL;
}

// Betaflight sends spin-direction commands only for crash flip when 3D is
// off (fc/core.c); 3D direction is in the DShot value range instead.
void dshotCommandWrite(uint8_t index, uint8_t motorCount, uint8_t command, dshotCommandType_e commandType)
{
    UNUSED(commandType);
    int8_t dir = 0;
    if (command == DSHOT_CMD_SPIN_DIRECTION_NORMAL) {
        dir = 1;
    } else if (command == DSHOT_CMD_SPIN_DIRECTION_REVERSED) {
        dir = -1;
    }
    if (dir == 0) {
        return;
    }
    for (int i = 0; i < SC_MOTOR_COUNT && i < motorCount; i++) {
        if (index == ALL_MOTORS || index == i) {
            sc_motor_dir[i] = dir;
        }
    }
}

// drivers/dshot_command.c is not compiled (it needs DMA output buffers); this
// is its rule: ESCs need 3 s after motors are enabled to detect the protocol.
#define DSHOT_PROTOCOL_DETECTION_DELAY_MS 3000
bool dshotStreamingCommandsAreEnabled(void)
{
    return motorIsEnabled() && motorGetMotorEnableTimeMs()
           && millis() > motorGetMotorEnableTimeMs() + DSHOT_PROTOCOL_DETECTION_DELAY_MS;
}

void dshotSetPidLoopTime(uint32_t pidLoopTime)
{
    UNUSED(pidLoopTime);
}
