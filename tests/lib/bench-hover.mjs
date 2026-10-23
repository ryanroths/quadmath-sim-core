// The owner's bench hover (tests/reference/air65-hover.json) as a Betaflight
// config: the settings from its blackbox header that sit between the stick
// and the motors, as CLI lines to fly on top of the class diff, so the X3
// hover-stick comparison runs the same throttle path as the logged quad.
// The class diff sets PIDs and rates only.
//
// The idle floor comes from the logged motorOutput (blackbox/blackbox.c:
// 1345-1346, :1375, Betaflight's motor output range after idle). When the
// header gives neither dshot_idle_value nor dynamic idle on, the floor is set
// with the static idle that gives the same low end: DShot's low is
// 48 + idle / 10000 x 1999 (drivers/dshot.c:68). A logged low of 48 means
// dynamic idle (flight/mixer_init.c:342-343) or idle 0; at hover rpm both
// leave the floor at 48, so the hover is the same. The high end gives
// motor_output_limit the same way (drivers/dshot.c:60, :69).
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.

const DSHOT_MIN = 48;
const DSHOT_RANGE = 2047 - 48;
const THROTTLE_LIMIT_TYPE = ['OFF', 'SCALE', 'CLIP'];

export function benchThrottlePath(header) {
  const lines = [];
  for (const k of ['thrust_linear', 'vbat_sag_compensation', 'throttle_boost', 'thr_mid', 'thr_expo', 'motor_poles',
    'dyn_idle_min_rpm', 'dshot_idle_value', 'motor_output_limit', 'throttle_limit_percent']) {
    if (header[k] !== null && header[k] !== undefined) lines.push(`set ${k} = ${header[k]}`);
  }
  if (header.dshot_bidir !== null && header.dshot_bidir !== undefined) lines.push(`set dshot_bidir = ${header.dshot_bidir ? 'ON' : 'OFF'}`);
  if (header.throttle_limit_type !== null && header.throttle_limit_type !== undefined) {
    lines.push(`set throttle_limit_type = ${THROTTLE_LIMIT_TYPE[header.throttle_limit_type]}`);
  }
  // The warning cell voltage sets the range vbat_sag_compensation works over
  // (flight/mixer_init.c:350-354); the header logs it as vbatcellvoltage
  // min,warning,max (blackbox/blackbox.c:1388-1390).
  if (header.vbatcellvoltage && header.vbatcellvoltage[1] != null) {
    lines.push(`set vbat_warning_cell_voltage = ${header.vbatcellvoltage[1]}`);
  }
  const [low, high] = header.motorOutput;
  if (header.dshot_idle_value == null && !(header.dyn_idle_min_rpm > 0)) {
    lines.push(`set dshot_idle_value = ${Math.round(((low - DSHOT_MIN) * 10000) / DSHOT_RANGE)}`);
  }
  if (header.motor_output_limit == null) {
    lines.push(`set motor_output_limit = ${Math.round(100 * (1 - (2047 - high) / DSHOT_RANGE))}`);
  }
  return lines;
}

// The class diff with extra CLI lines before its save.
export function withSettings(diff, lines) {
  const out = diff.replace(/^save\s*$/m, () => `${lines.join('\n')}\nsave`);
  if (out === diff) throw new Error('diff has no save line to put the settings before');
  return out;
}
