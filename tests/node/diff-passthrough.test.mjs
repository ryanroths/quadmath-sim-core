// C1 diff passthrough, runtime effect, on the flight instance (configure ends
// in save and a reboot, so this is not just `get`):
//   1. Two diffs that differ only in rate lines: the max roll rate Betaflight
//      commands differs by the ratio of the diffs' max rates within 2%.
//      Both pairs use ACTUAL rates, where the max rate is srate x 10 deg/s, so
//      the diff ratio is the srate ratio. Pairs: WebFPV's own check-12
//      fixtures (srate 67 vs 84) and the 65 mm class diff with every roll
//      rate line changed (srate 74 vs 92).
//   2. dshot_bidir ON turns Betaflight's RPM filter on; OFF leaves it off.
//   3. A P change moves the PID output for the same stick step.
//
// "Max roll rate" here is Betaflight's setpoint at full stick. The achieved
// rate on the Air65 plant (F3) is checked in tests/gate-plant.mjs.
//
//   node tests/node/diff-passthrough.test.mjs
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SimCore } from '../../src/js/sim-core.js';
import { readPinned } from '../lib/webfpv.mjs';

const root = new URL('../../', import.meta.url);
const module = await WebAssembly.compile(await readFile(new URL('dist/sim-core.wasm', root)));
const air65 = await readFile(new URL('configs/65mm-air65-ryfly-1219s.diff', root), 'utf8');

const RATE_KEY = /^set\s+(rates_type|(roll|pitch|yaw)_(rc_rate|srate|expo|rate_limit)|quickrates_rc_expo)\s*=/;
const TOLERANCE = 0.02;

// The lines that differ between two diffs, outside comments; all must be rates.
function differingLines(a, b) {
  const strip = (t) => t.split('\n').map((l) => l.replace(/\r$/, ''));
  const la = strip(a);
  const lb = strip(b);
  assert.equal(la.length, lb.length, 'same line count');
  return la.flatMap((l, i) => (l === lb[i] || l.trim().startsWith('#') ? [] : [[l, lb[i]]]));
}

function srate(diff) {
  const m = diff.match(/^set\s+roll_srate\s*=\s*(\d+)/m);
  assert.ok(m && /^set\s+rates_type\s*=\s*ACTUAL/m.test(diff), 'pair uses ACTUAL rates');
  return Number(m[1]);
}

// Full right and full left roll, held 300 ms with RC smoothing on, on a
// fresh flight instance of the diff.
async function maxRollRate(diff) {
  const core = await SimCore.load(module);
  const report = core.configure(diff);
  // WebFPV's fixtures carry keys Betaflight 4.5.1 does not have (battery_capacity;
  // Betaflight's is bat_capacity). Betaflight refuses those; the rates must land.
  const errors = report.lines.filter((l) => l.status === 'error');
  for (const l of errors) assert.ok(!RATE_KEY.test(l.text.trim()), `rate line refused: ${l.text} ${l.msg}`);
  const rateLines = report.lines.filter((l) => RATE_KEY.test(l.text.trim()));
  assert.ok(rateLines.length > 0 && rateLines.every((l) => l.status === 'applied'), 'every rate line applied');
  const out = { errors: errors.map((l) => `${l.text.trim()} (${l.msg})`) };
  for (const [side, ch] of [['right', 2000], ['left', 1000]]) {
    core.input([ch, 1500, 1500, 1000]);
    core.step(300);
    out[side] = core.fc.setpoint[0];
    core.input([1500, 1500, 1500, 1000]);
    core.step(300);
  }
  out.curve = core.rateCurve(0, 3).map((p) => p.rate);
  return out;
}

const pairs = [
  { name: 'WebFPV config-baseline vs config-rates-b', a: readPinned('tests/fixtures/config-baseline.diff'), b: readPinned('tests/fixtures/config-rates-b.diff') },
  {
    name: '65mm class diff vs its roll rates changed',
    a: air65,
    b: air65.replace('set roll_rc_rate = 4', 'set roll_rc_rate = 7').replace('set roll_expo = 56', 'set roll_expo = 30')
      .replace('set roll_srate = 74', 'set roll_srate = 92'),
  },
];

for (const p of pairs) {
  const changed = differingLines(p.a, p.b);
  assert.ok(changed.length > 0, 'the pair differs');
  for (const [la, lb] of changed) assert.ok(RATE_KEY.test(la) && RATE_KEY.test(lb), `only rate lines differ: '${la}' vs '${lb}'`);
  const expected = srate(p.b) / srate(p.a);
  const ra = await maxRollRate(p.a);
  const rb = await maxRollRate(p.b);
  for (const side of ['right', 'left']) {
    const ratio = rb[side] / ra[side];
    const err = Math.abs(ratio / expected - 1);
    console.log(`${p.name}: ${side} ${ra[side].toFixed(3)} -> ${rb[side].toFixed(3)} deg/s, ratio ${ratio.toFixed(5)} vs diff ${expected.toFixed(5)} (${(err * 100).toFixed(3)}%)`);
    assert.ok(err <= TOLERANCE, `${p.name} ${side}: within 2%`);
  }
  console.log(`  rateCurve probe (-1, 0, 1): A ${ra.curve.map((v) => v.toFixed(2)).join(' ')}  B ${rb.curve.map((v) => v.toFixed(2)).join(' ')}`);
  assert.ok(Math.abs((rb.curve[2] / ra.curve[2]) / expected - 1) <= TOLERANCE, 'probe agrees');
  console.log(`  changed lines: ${changed.map(([la, lb]) => `'${la}' -> '${lb}'`).join(', ')}`);
  if (ra.errors.length) console.log(`  refused by Betaflight in both (not rates): ${ra.errors.join('; ')}`);
}

// 2. dshot_bidir reaches the RPM filter.
for (const bidir of ['OFF', 'ON']) {
  const core = await SimCore.load(module);
  core.configure(`${air65}\nset dshot_bidir = ${bidir}`);
  console.log(`dshot_bidir ${bidir}: get ${core.get('dshot_bidir')}, Betaflight RPM filter ${core.fc.rpmFilter ? 'on' : 'off'}`);
  assert.equal(core.fc.rpmFilter, bidir === 'ON');
}

// 3. P moves the PID output: same armed roll step, p_roll 54 vs 81.
const pidAfterStep = async (p) => {
  const core = await SimCore.load(module);
  core.configure(air65.replace('set p_roll = 54', `set p_roll = ${p}`));
  core.input([1500, 1500, 1500, 1000, 2000]);
  core.step(50);
  core.input([1500, 1500, 1500, 1500, 2000]);
  core.step(200);
  core.input([1600, 1500, 1500, 1500, 2000]);
  core.step(9);
  return core.fc;
};
const p54 = await pidAfterStep(54);
const p81 = await pidAfterStep(81);
console.log(`p_roll 54 vs 81, 9 ms after a roll step: setpoint ${p54.setpoint[0].toFixed(2)} vs ${p81.setpoint[0].toFixed(2)}, pidSum ${p54.pidSum[0].toFixed(3)} vs ${p81.pidSum[0].toFixed(3)}`);
assert.equal(p54.armed && p81.armed, true);
assert.equal(p54.setpoint[0], p81.setpoint[0], 'same setpoint: rates untouched');
assert.ok(p81.pidSum[0] > p54.pidSum[0], 'more P, more PID output for the same error');

console.log('diff-passthrough: PASS');
