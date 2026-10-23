// The settings a blackbox log's header records that a diff does not
// reproduce: the diff is applied in a sim-core config instance, every header
// value whose name is a Betaflight CLI setting is read back with `get`, and
// each one that differs becomes a `set` line citing the header. Together, the
// diff and these lines are the config the log flew (owner decision
// 2026-10-23: the Air65's sim config is the config its log flew).
//
//   node tools/config-from-log.mjs <log.BBL> --diff configs/<diff> --quadmath <clone>
//        [--log 0] [--out configs/<name>.from-header.txt]
//
// <log.BBL> is a path, or a name in SIM_CORE_LOGS (tools/logs.mjs).
// Header values are Betaflight's numbers; a setting backed by a lookup table
// (get returns a name) is compared through the names below where known and
// otherwise listed as not compared. Header lines that hold several values
// are compared only where they map to settings here (vbatcellvoltage).
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SimCore } from '../src/js/sim-core.js';
import { readLog } from './hover-from-log.mjs';
import { logPath as findLog } from './logs.mjs';

// Lookup tables for the header values that are table indexes (Betaflight 4.5
// cli/settings.c): index -> CLI name.
const OFF_ON = ['OFF', 'ON'];                                       // lookupTableOffOn
const LOWPASS = ['PT1', 'BIQUAD', 'PT2', 'PT3'];                     // lookupTableLowpassType
const TABLES = {
  dshot_bidir: OFF_ON, gyro_cal_on_first_arm: OFF_ON, pid_at_min_throttle: OFF_ON, rc_smoothing: OFF_ON,
  simplified_dterm_filter: OFF_ON, simplified_gyro_filter: OFF_ON, tpa_low_always: OFF_ON,
  use_integrated_yaw: OFF_ON, use_unsynced_pwm: OFF_ON,
  dterm_lpf1_type: LOWPASS, dterm_lpf2_type: LOWPASS, gyro_lpf1_type: LOWPASS, gyro_lpf2_type: LOWPASS,
  gyro_hardware_lpf: ['NORMAL', 'OPTION_1', 'OPTION_2'],             // lookupTableGyroHardwareLpf
  iterm_relax: ['OFF', 'RP', 'RPY', 'RP_INC', 'RPY_INC'],            // lookupTableItermRelax
  iterm_relax_type: ['GYRO', 'SETPOINT'],                            // lookupTableItermRelaxType
  rates_type: ['BETAFLIGHT', 'RACEFLIGHT', 'KISS', 'ACTUAL', 'QUICK'], // lookupTableRatesType
  rc_smoothing_debug_axis: ['ROLL', 'PITCH', 'YAW', 'THROTTLE'],     // lookupTableRcSmoothingDebug
  simplified_pids_mode: ['OFF', 'RP', 'RPY'],                        // lookupTableSimplifiedTuningPidsMode
  tpa_mode: ['PD', 'D'],                                             // lookupTableTpaMode
  motor_pwm_protocol: ['PWM', 'ONESHOT125', 'ONESHOT42', 'MULTISHOT', 'BRUSHED', 'DSHOT150', 'DSHOT300', 'DSHOT600', 'PROSHOT1000', 'DISABLED'], // lookupTablePwmProtocol
  throttle_limit_type: ['OFF', 'SCALE', 'CLIP'],
};
// Header values Betaflight logs scaled (blackbox/blackbox.c:1541): name -> divisor.
const SCALED = { acc_lpf_hz: 100 };
// Settings sim-core's config policy refuses on purpose (src/js/cli-policy.js):
// reported, never set.
const SIM_POLICY = {
  pid_process_denom: 'the sim runs the PID on every gyro sample, at SC_LOOP_HZ',
};
// Header lines with several values: name -> the settings, in order.
const SPLIT = {
  vbatcellvoltage: ['vbat_min_cell_voltage', 'vbat_warning_cell_voltage', 'vbat_max_cell_voltage'],
};

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

export async function configFromLog(file, quadmathDir, diff, module, li = 0) {
  const log = await readLog(file, quadmathDir, li);
  const core = await SimCore.load(module, { trace: false });
  const report = core.configure(diff);
  const lines = [];
  const notCompared = [];
  const policy = [];
  let compared = 0;
  const consider = (name, headerValue, headerKey) => {
    const have = core.get(name);
    if (have === undefined) return;
    let want = String(headerValue).trim();
    if (SCALED[name] && /^-?\d+$/.test(want)) want = String(Number(want) / SCALED[name]);
    if (!/^-?\d+(\.\d+)?$/.test(have) && want !== have) {
      if (!TABLES[name]) {
        notCompared.push(`${name} (header ${want}, Betaflight ${have})`);
        return;
      }
      want = TABLES[name][Number(want)] ?? want;
    }
    compared++;
    if (want === have) return;
    if (SIM_POLICY[name]) policy.push(`${name} ${want} (the sim keeps ${have}: ${SIM_POLICY[name]})`);
    else lines.push({ name, value: want, was: have, headerKey });
  };
  for (const [key, value] of Object.entries(log.rawHeader)) {
    if (SPLIT[key]) {
      String(value).split(',').forEach((v, i) => consider(SPLIT[key][i], v, key));
    } else if (!String(value).includes(',')) {
      consider(key, value, key);
    }
  }
  return { source: basename(file), lines, notCompared, policy, compared, rejected: report.lines.filter((l) => l.status === 'rejected' || l.status === 'error') };
}

async function main() {
  const a = args(process.argv.slice(2));
  const qm = a.quadmath ?? process.env.QUADMATH_DIR;
  if (!a._[0] || !qm || !a.diff) {
    console.error('usage: node tools/config-from-log.mjs <log.BBL> --diff configs/<diff> --quadmath <quadmath clone> [--out file] (or set QUADMATH_DIR)');
    process.exit(2);
  }
  const root = fileURLToPath(new URL('..', import.meta.url));
  const diff = readFileSync(resolve(root, a.diff), 'utf8');
  const module = await WebAssembly.compile(readFileSync(resolve(root, 'dist/sim-core.wasm')));
  const r = await configFromLog(findLog(a._[0]), qm, diff, module, Number(a.log ?? 0));
  for (const l of r.rejected) console.error(`warning: diff line ${l.n} ${l.status}: ${l.text} (${l.msg})`);
  console.error(`${r.source}: ${r.compared} header settings compared with ${a.diff}; ${r.lines.length} differ${r.policy.length ? `; differ but kept by sim policy: ${r.policy.join('; ')}` : ''}; ${r.notCompared.length} not compared${r.notCompared.length ? `: ${r.notCompared.join('; ')}` : ''}`);
  const text = [
    `# Settings the log header records and ${a.diff} does not reproduce (tools/config-from-log.mjs).`,
    `# From ${r.source}; each line cites its header entry and the value the diff left.`,
    `# ${r.compared} header settings compared, ${r.lines.length} differ.`,
    ...r.policy.map((p) => `# Differs, kept by sim policy: ${p}.`),
    ...(r.notCompared.length ? [`# Not compared (no lookup table here): ${r.notCompared.join('; ')}.`] : []),
    // A comment line above each: Betaflight's CLI takes '#' only at the start.
    ...r.lines.flatMap((l) => [`# log header ${l.headerKey}; the diff leaves ${l.was}`, `set ${l.name} = ${l.value}`]),
    '',
  ].join('\n');
  if (a.out) writeFileSync(a.out, text);
  else process.stdout.write(text);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
