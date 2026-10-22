/*
 * Sim clock for Betaflight. The tick sets sc_time_us; nothing else moves it,
 * and Betaflight's delays never advance it.
 *
 * This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
 */
#include "platform.h"

#include "drivers/time.h"

#include "sc.h"

uint64_t sc_time_us;

timeUs_t micros(void)
{
    return (timeUs_t)sc_time_us;
}

// Its own 32-bit count, wrapping after 49.7 days like the firmware's
// sysTickUptime, not micros() / 1000 (which would wrap after 71.6 minutes).
timeMs_t millis(void)
{
    return (timeMs_t)(sc_time_us / 1000u);
}

void delay(timeMs_t ms)
{
    UNUSED(ms);
}

void delayMicroseconds(timeUs_t us)
{
    UNUSED(us);
}
