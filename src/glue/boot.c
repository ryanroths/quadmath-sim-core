/*
 * Boot: Betaflight's init() (fc/init.c) for the subsystems sim-core compiles,
 * in the same order. Hardware-only steps (clocks, IO, buses, flash, SD, USB,
 * OSD, VTX, telemetry, LEDs strips) have no counterpart here.
 *
 * The EEPROM image is a RAM array (CONFIG_IN_RAM). sim-core.js writes the
 * saved image into a fresh instance before calling this, which is how config
 * survives a reinit the way it survives a reboot on hardware.
 *
 * This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
 */
#include <string.h>

#include "platform.h"

#include "build/debug.h"
#include "cli/settings.h"
#include "common/printf_serial.h"
#include "config/config.h"
#include "config/config_eeprom.h"
#include "config/feature.h"
#include "drivers/dshot.h"
#include "drivers/light_led.h"
#include "drivers/motor.h"
#include "fc/rc_controls.h"
#include "fc/runtime_config.h"
#include "fc/tasks.h"
#include "flight/failsafe.h"
#include "flight/imu.h"
#include "flight/mixer.h"
#include "flight/pid.h"
#include "flight/pid_init.h"
#include "flight/position.h"
#include "io/serial.h"
#include "pg/motor.h"
#include "pg/pg.h"
#include "rx/rx.h"
#include "sensors/acceleration.h"
#include "sensors/battery.h"
#include "sensors/boardalignment.h"
#include "sensors/gyro.h"
#include "sensors/gyro_init.h"
#include "sensors/initialisation.h"

#include "sc.h"

void sc_boot_betaflight(void)
{
    // fc/init.c:261-272
    printfSerialInit();
    tasksInitData();

    // fc/init.c:355, 386-398: defaults, then the EEPROM image or a fresh one.
    pgResetAll();
    initEEPROM();
    ensureEEPROMStructureIsValid();
    const bool readSuccess = readEEPROM();
    if (!readSuccess || !isEEPROMVersionValid()
        || strncasecmp(systemConfig()->boardIdentifier, TARGET_BOARD_IDENTIFIER, sizeof(TARGET_BOARD_IDENTIFIER))) {
        resetEEPROM();
    }

    // fc/init.c:406, the only place the runtime debug mode is set.
    debugMode = systemConfig()->debug_mode;

    // fc/init.c:413
    ledInit(statusLedConfig());

    // fc/init.c:529-546
    serialInit(featureIsEnabled(FEATURE_SOFTSERIAL), SERIAL_PORT_NONE);
    mixerInit(mixerConfig()->mixerMode);
    uint16_t idlePulse = motorConfig()->mincommand;
    if (featureIsEnabled(FEATURE_3D)) {
        idlePulse = flight3DConfig()->neutral3d;
    }
    motorDevInit(&motorConfig()->dev, idlePulse, getMotorCount());

    // fc/init.c:676-707
    initBoardAlignment(boardAlignment());
    if (!sensorsAutodetect()) {
        setArmingDisabled(ARMING_DISABLED_NO_GYRO);
    }
    gyroSetTargetLooptime(pidConfig()->pid_process_denom);
    validateAndFixGyroConfig();
    gyroSetTargetLooptime(pidConfig()->pid_process_denom);
    initDshotTelemetry(gyro.targetLooptime);
    gyroInitFilters();
    pidInit(currentPidProfile);
    mixerInitProfile();

    // fc/init.c:755-759
    imuInit();
    failsafeInit();
    rxInit();

    // fc/init.c:826-830
    gyroStartCalibration(false);
    positionInit();

    // fc/init.c:863, 983
    batteryInit();
    setArmingDisabled(ARMING_DISABLED_BOOT_GRACE_TIME);

    // fc/init.c:990-1002
    motorPostInit();
    motorEnable();
    tasksInit();
}

// The tick drives one gyro sample, filter pass and PID pass per tick. These
// are the conditions under which that matches the firmware; any failure means
// the config would fly differently, so boot refuses it. Returns 0 or the
// number of the first failed check.
int sc_boot_asserts(void)
{
    if (pidConfig()->pid_process_denom != 1) {
        return 1;
    }
    if (gyro.sampleRateHz != SC_LOOP_HZ) {
        return 2;
    }
    if (gyro.targetLooptime != SC_TICK_US) {
        return 3;
    }
    if (acc.sampleRateHz != (SC_LOOP_HZ < 1000 ? SC_LOOP_HZ : 1000)) {
        return 4;
    }
    if (!isMotorProtocolDshot()) {
        return 5;
    }
    return 0;
}

// Settings whose parameter group no compiled file registers. cli.c writes
// through pgFind() without a NULL check (cli/cli.c:750-758), so this must be 0.
int sc_pg_missing_count(void)
{
    int missing = 0;
    for (unsigned i = 0; i < valueTableEntryCount; i++) {
        if (!pgFind(valueTable[i].pgn)) {
            missing++;
        }
    }
    return missing;
}
