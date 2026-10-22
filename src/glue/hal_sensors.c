/*
 * Sensors for Betaflight: the virtual gyro and accelerometer, the gyro sample
 * rate, and the battery ADC. Values come from the plant (sc_sensors) and enter
 * through the same paths a board's drivers use.
 *
 * This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
 */
#include <math.h>

#include "platform.h"

#include "drivers/accgyro/accgyro.h"
#include "drivers/accgyro/accgyro_virtual.h"
#include "drivers/adc.h"
#include "sensors/acceleration.h"
#include "sensors/current.h"
#include "sensors/voltage.h"

#include "sc.h"

sc_sensors_t sc_sensors;

// The real function (gyro_sync.c, not compiled: it hard-codes 8 kHz for a
// virtual gyro) also sets the accelerometer rate as a side effect. Without
// that, acc.sampleRateHz is 0, the acc LPF is off and angle mode's
// rescheduleTask(TASK_ATTITUDE, ...) divides by zero (fc/core.c).
uint16_t gyroSetSampleRate(gyroDev_t *gyro)
{
    gyro->gyroRateKHz = SC_LOOP_HZ >= 8000 ? GYRO_RATE_8_kHz : GYRO_RATE_1_kHz;
    gyro->mpuDividerDrops = 0;
    gyro->accSampleRateHz = SC_LOOP_HZ < 1000 ? SC_LOOP_HZ : 1000;
    return SC_LOOP_HZ;
}

static int16_t clampInt16(double v)
{
    if (!(v > -32767.0)) {
        return -32767;
    }
    if (v > 32767.0) {
        return 32767;
    }
    return (int16_t)lrint(v);
}

// Called by the tick at the start of every tick: the latest plant state
// arrives in the sensor registers, as an interrupt-driven read would.
void sc_sensors_to_betaflight(void)
{
    if (virtualGyroDev) {
        // GYRO_SCALE_2000DPS is 2000 / 32768 deg/s per count.
        const double countsPerDps = 32768.0 / 2000.0;
        virtualGyroSet(virtualGyroDev,
                       clampInt16(sc_sensors.gyro_dps[0] * countsPerDps),
                       clampInt16(sc_sensors.gyro_dps[1] * countsPerDps),
                       clampInt16(sc_sensors.gyro_dps[2] * countsPerDps));
    }
    if (virtualAccDev) {
        const double counts1G = acc.dev.acc_1G;
        virtualAccSet(virtualAccDev,
                      clampInt16(sc_sensors.acc_g[0] * counts1G),
                      clampInt16(sc_sensors.acc_g[1] * counts1G),
                      clampInt16(sc_sensors.acc_g[2] * counts1G));
    }
}

uint16_t getVrefMv(void)
{
    return 3300;
}

static uint16_t clampAdc(double counts)
{
    if (!(counts > 0.0)) {
        return 0;
    }
    if (counts > 4095.0) {
        return 4095;
    }
    return (uint16_t)lrint(counts);
}

// Inverse of voltageAdcToVoltage() (sensors/voltage.c) and
// currentMeterADCToCentiamps() (sensors/current.c), with the active config,
// so Betaflight's own conversion recovers the plant's values.
uint16_t adcGetChannel(uint8_t channel)
{
    if (channel == ADC_BATTERY) {
        const voltageSensorADCConfig_t *c = voltageSensorADCConfig(VOLTAGE_SENSOR_ADC_VBAT);
        if (!c->vbatscale || !c->vbatresdivval || !c->vbatresdivmultiplier) {
            return 0;
        }
        const double centivolts = sc_sensors.vbat_v * 100.0;
        const double counts = centivolts * c->vbatresdivmultiplier * 0xFFF * c->vbatresdivval
                              / ((double)c->vbatscale * getVrefMv() / 10.0);
        return clampAdc(counts);
    }
    if (channel == ADC_CURRENT) {
        const currentSensorADCConfig_t *c = currentSensorADCConfig();
        if (!c->scale) {
            return 0;
        }
        const double centiamps = sc_sensors.current_a * 100.0;
        const double millivolts = (centiamps * 10.0 - c->offset) * c->scale / 10000.0;
        return clampAdc(millivolts * 4096.0 / getVrefMv());
    }
    return 0;
}

ADCDevice adcDeviceByInstance(ADC_TypeDef *instance)
{
    UNUSED(instance);
    return ADCDEV_1;
}
