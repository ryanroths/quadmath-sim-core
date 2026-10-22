// Config count check (C2, with C1's readback and C3's profiles): for every
// diff in the corpus,
//   - every line gets exactly the verdict the policy requires (pinned per
//     line, not only as a sum), so lines in = applied + rejected + errors +
//     comments, and a wrongly rejected tune line fails;
//   - every applied `set` that is not superseded by a later line in the same
//     scope reads back from the saved, rebooted config, in the scope
//     Betaflight gives the setting (master, profile N, rateprofile N), as the
//     value Betaflight stored: applied set keys = keys whose readback matches.
//
// Corpus: the two class diffs, WebFPV's six diffs at its pinned commit (read
// from the clone, see tests/lib/webfpv.mjs), and a synthetic diff with every
// line kind the plan lists for C2 plus the cases the review found.
//
//   node tests/node/config-count.test.mjs
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SimCore } from '../../src/js/sim-core.js';
import { sameSettingValue } from '../../src/js/cli-policy.js';
import { readPinned } from '../lib/webfpv.mjs';

const root = new URL('../../', import.meta.url);
const module = await WebAssembly.compile(await readFile(new URL('dist/sim-core.wasm', root)));

// Synthetic C2 lines, the verdict the policy (src/js/cli-policy.js and the
// plan's config table) requires for each, and whether a later line in the
// same scope supersedes it.
const SYNTHETIC = [
  ['# comment', 'comment'],
  ['', 'comment'],
  ['batch start', 'rejected'],
  ['board_name SITL', 'rejected'],
  ['set p_roll = 50', 'applied'],
  ['set dshot_idle_value = 500', 'applied', 'superseded'],    // master: the profile switch below does not scope it
  ['profile 1', 'applied'],
  ['set p_roll = 61', 'applied'],
  ['rateprofile 2', 'applied'],
  ['set roll_srate = 81', 'applied'],
  ['set rates_type = actual', 'applied'],
  ['feature -AIRMODE', 'applied', 'superseded'],
  ['feature AIRMODE', 'applied'],
  ['feature -ANTI_GRAVITY', 'applied'],
  ['feature GPS', 'rejected'],
  ['feature RX_SERIAL', 'rejected'],
  ['resource MOTOR 1 B06', 'rejected'],
  ['serial 0 64 115200 57600 0 115200', 'rejected'],
  ['aux 5 1 4 1700 2100 0 0', 'applied'],
  ['aux 6 77 1 1700 2100 0 0', 'rejected'],                   // no such box: Betaflight would keep a stale mode
  ['aux 7 0 14 1700 2100 0 0', 'rejected'],                   // beyond AUX12
  ['aux 8 1 2 1700 2100 0 99', 'rejected'],                   // no such linked box: Betaflight resets it
  ['aux 9 2 2 1700 2100 7 0', 'rejected'],                    // no such logic: Betaflight keeps a stale one
  ['map TAER1234', 'applied'],
  ['mixer QUADX', 'applied'],
  ['mixer TRI', 'rejected'],
  ['adjrange 0 0 5 1700 2100 1 5 0 0', 'applied'],
  ['set vbat_scale = 110', 'rejected'],
  ['set align_board_roll = 10', 'rejected'],
  ['set motor_pwm_protocol = PWM', 'rejected'],
  ['set pid_process_denom = 2', 'rejected'],
  ['frobnicate 1', 'rejected'],
  ['set no_such_key = 1', 'error'],
  ['set p_pitch = 999', 'error'],
  ['set p_yaw =', 'rejected'],                                // cliSet's atoi would store 0
  ['set i_yaw = 12abc', 'rejected'],                          // and 12 here
  ['set p_roll', 'rejected'],                                 // no '=': only prints
  ['set dshot_idle_value = 0550', 'applied'],
  ['set craft_name = MYQUAD', 'applied', 'superseded'],
  ['set craft_name = -', 'applied'],                          // '-' clears a string
  ['set gyro_notch1_hz = 100', 'rejected'],                   // zeroed at boot: cutoff >= centre (validateAndFixGyroConfig)
  ['set gyro_notch1_cutoff = 150', 'applied'],
  ['set d_roll = 33\r', 'applied'],
  ['set i_roll = 70 # tune note', 'applied'],                 // Betaflight cuts at '#'
  ['aux 10 13 3 1700 2100 # beeper on AUX4', 'applied'],
  ['set p-roll = 5', 'error'],                                // has '=', not a name: INVALID NAME
  [`set p_roll = ${'1'.repeat(250)}`, 'rejected'],
  ['set p_roll = 5é', 'rejected'],
  ['get p_roll ?', 'rejected'],
  ['save', 'comment'],
  ['batch end', 'rejected'],
];

// What the policy requires for each line of a class diff or a WebFPV diff.
function expectedVerdict(line, { webfpv = false } = {}) {
  const t = line.replace(/\r$/, '').trim();
  if (t === '' || t.startsWith('#') || t === 'save') return 'comment';
  if (webfpv && /^(batch|board_name)\s/.test(t)) return 'rejected';
  if (webfpv && /^set\s+battery_capacity\s/.test(t)) return 'error';  // not a 4.5.1 key; Betaflight's is bat_capacity
  return 'applied';
}

const corpus = [
  ...['configs/65mm-air65-ryfly-1219s.diff', 'configs/75mm-meteor75pro-ryfly-hamo-45mm.diff'].map(async (p) => {
    const text = await readFile(new URL(p, root), 'utf8');
    return [p, text, text.split('\n').map((l) => expectedVerdict(l)), []];
  }),
  ...['configs/betaflight-default.diff', 'configs/whoop-champion.diff', 'configs/whoop-freestyle.diff', 'configs/whoop-racing.diff',
    'tests/fixtures/config-baseline.diff', 'tests/fixtures/config-rates-b.diff'].map(async (p) => {
    const text = readPinned(p);
    return [`WebFPV ${p}`, text, text.split('\n').map((l) => expectedVerdict(l, { webfpv: true })), []];
  }),
  ['synthetic C2', SYNTHETIC.map(([l]) => l).join('\n'), SYNTHETIC.map(([, v]) => v),
    SYNTHETIC.flatMap(([, , s], i) => (s ? [i + 1] : []))],
];

console.log('diff                                            lines applied rejected errors comments | set keys readback-ok superseded');
for (const [name, text, expect, supersededLines] of await Promise.all(corpus)) {
  const core = await SimCore.load(module);
  const r = core.configure(text);
  const n = text.split('\n').length;
  assert.equal(r.lines.length, n, `${name}: one verdict per line`);
  assert.equal(r.applied + r.rejected + r.errors + r.comments, n, `${name}: lines in = applied + rejected + errors + comments`);
  r.lines.forEach((l, i) => {
    assert.equal(l.status, expect[i], `${name} line ${l.n} '${l.text}': ${l.status} (${l.msg})`);
    if (l.status === 'rejected' || l.status === 'error') assert.ok(l.msg, `${name} line ${l.n}: a ${l.status} line says why`);
  });
  const superseded = r.lines.filter((l) => l.msg.startsWith('superseded by line')).map((l) => l.n);
  assert.deepEqual(superseded, supersededLines, `${name}: superseded lines`);

  // Readback of every applied set line still in force, in its own scope.
  const live = r.lines.filter((l) => l.status === 'applied' && l.setting && !superseded.includes(l.n));
  const setLines = r.lines.filter((l) => l.status === 'applied' && /^set\s/.test(l.text.trim()));
  assert.equal(live.length + setLines.filter((l) => superseded.includes(l.n)).length, setLines.length, `${name}: every applied set line has a scope`);
  let ok = 0;
  const bad = [];
  for (const l of live) {
    const s = l.setting;
    const where = s.scope === 'profile' ? { profile: s.index } : s.scope === 'rateprofile' ? { rateprofile: s.index } : {};
    const got = core.get(s.key, where);
    if (got !== undefined && sameSettingValue(s.value, got)) ok++;
    else bad.push(`line ${l.n} ${s.key} (${s.scope}${s.index ?? ''}): set ${s.value}, reads ${got}`);
  }
  console.log(`${name.padEnd(47)} ${String(n).padStart(5)} ${String(r.applied).padStart(7)} ${String(r.rejected).padStart(8)} ${String(r.errors).padStart(6)} ${String(r.comments).padStart(8)} | ${String(live.length).padStart(8)} ${String(ok).padStart(11)} ${String(superseded.length).padStart(10)}`);
  for (const b of bad) console.log(`   MISMATCH ${b}`);
  for (const l of r.lines.filter((x) => x.status === 'error')) console.log(`   error line ${l.n}: ${l.text.trim().slice(0, 60)} -- ${l.msg}`);
  assert.equal(ok, live.length, `${name}: every applied set reads back`);
}

// The values cliSet would have mangled ('' to 0, '12abc' to 12) were put back:
// profile 1 still holds the defaults for p_yaw and i_yaw. AIRMODE, switched
// off and then on again by the diff, is on.
{
  const synthetic = await SimCore.load(module);
  synthetic.configure(SYNTHETIC.map(([l]) => l).join('\n'));
  const defaults = await SimCore.load(module);
  defaults.configure('');
  const got = synthetic.get(['p_yaw', 'i_yaw'], { profile: 1 });
  const want = defaults.get(['p_yaw', 'i_yaw'], { profile: 1 });
  console.log(`rejected set lines left profile 1 at p_yaw ${got.p_yaw}, i_yaw ${got.i_yaw} (defaults ${want.p_yaw}, ${want.i_yaw}); airmode ${synthetic.fc.airmode}; craft_name '${synthetic.get('craft_name')}'`);
  assert.deepEqual(got, want);
  assert.equal(synthetic.fc.airmode, true);
}
console.log('config-count: PASS');
