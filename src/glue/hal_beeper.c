/*
 * The beeper: the simulated board has no buzzer. Betaflight's beeper state
 * machine (io/beeper.c) runs as it does on a quad; its pin writes land here
 * and go nowhere. The state is a readout, FC_BEEPER (abi.c, isBeeperOn()),
 * for the page to play.
 *
 * This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
 */
#include <stdbool.h>

#include "platform.h"

#include "common/utils.h"
#include "drivers/sound_beeper.h"

void beeperInit(const struct beeperDevConfig_s *beeperDevConfig)
{
    UNUSED(beeperDevConfig);
}

void systemBeep(bool on)
{
    UNUSED(on);
}

void systemBeepToggle(void)
{
}
