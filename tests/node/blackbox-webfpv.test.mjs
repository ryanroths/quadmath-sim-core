// Black box vs WebFPV (module sha256 08e995cb..., commit 518846c): X1 of the
// Phase 1 plan, on identical input. Tolerance: exact. Setpoints compare as
// float64 with Object.is (0 ulp); readback compares as strings.
//
//   F1  rate curve: every stick quantum on the 1/500 grid (1001 channel
//       values), every axis, every rate type, RC smoothing off.
//   F2  setpoint trajectory tick by tick through steps, ramps and reversals,
//       RC smoothing on (Betaflight's default), every rate type, after
//       aligning sim-core's 1-tick RC latency (WebFPV's is 0).
//   F4  config readback string-equal on WebFPV's settings keys that
//       Betaflight 4.5.1 also has. Where WebFPV is not Betaflight, the test
//       asserts Betaflight's behaviour instead (the plan's list, measured
//       2026-10-22): launch_angle_limit default, rpm_filter_weights naming,
//       out-of-range values (WebFPV stores 251 or clamps; Betaflight
//       refuses), and profile scoping (WebFPV has one profile).
//
// X2 (achieved full-stick rate) and X3 (feel bands) need a plant that
// rotates; they arrive with the M4 plant.
//
// Identical input means identical rcData: sim-core gets integer channels;
// WebFPV gets its ABI's sticks, which it maps back to the same channel values
// (tests/lib/webfpv.mjs). Frames on the 250 Hz grid, sticks still at t = 0.
//
//   node tests/node/blackbox-webfpv.test.mjs
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SimCore } from '../../src/js/sim-core.js';
import { WebFpv, loadWebfpvModule } from '../lib/webfpv.mjs';

const root = new URL('../../', import.meta.url);
const ours = await WebAssembly.compile(await readFile(new URL('dist/sim-core.wasm', root)));
const theirs = await loadWebfpvModule();
const air65 = await readFile(new URL('configs/65mm-air65-ryfly-1219s.diff', root), 'utf8');
const pids = air65.split('\n').filter((l) => /^set [pid]_(roll|pitch|yaw) =/.test(l)).join('\n');

const FRAME_TICKS = 4;   // 250 Hz frames at a 1 kHz loop

// One rate profile per Betaflight rate type, with different numbers per axis
// so an axis mix-up cannot pass.
const RATE_TYPES = {
  BETAFLIGHT: [[100, 70, 20], [120, 65, 10], [90, 60, 0]],
  RACEFLIGHT: [[37, 80, 50], [40, 70, 30], [35, 60, 0]],
  KISS: [[100, 70, 30], [110, 65, 15], [90, 55, 0]],
  ACTUAL: [[4, 74, 56], [7, 67, 40], [4, 70, 56]],
  QUICK: [[100, 67, 0], [120, 70, 25], [90, 60, 10]],
};
function ratesDiff(type, smoothing) {
  const axes = ['roll', 'pitch', 'yaw'];
  const lines = [pids, `set rates_type = ${type}`, `set rc_smoothing = ${smoothing}`];
  RATE_TYPES[type].forEach(([rc, s, e], i) => lines.push(`set ${axes[i]}_rc_rate = ${rc}`, `set ${axes[i]}_srate = ${s}`, `set ${axes[i]}_expo = ${e}`));
  return lines.join('\n');
}

// Runs one channel-frame script on both sims, tick by tick. frames[f] is
// [roll, pitch, yaw, throttle] channel values for RX frame f. Returns the
// setpoint per tick per axis for each side.
async function runBoth(diff, frames) {
  const core = await SimCore.load(ours, { trace: false });
  const report = core.configure(diff);
  assert.equal(report.errors + report.rejected, 0, `sim-core took every line: ${JSON.stringify(report.lines.filter((l) => l.status !== 'applied'))}`);
  const w = new WebFpv(theirs, diff);
  assert.equal(w.counts().unknown, 0, 'WebFPV recognised every key');
  const t0 = core.simTimeUs;
  const a = [[], [], []];
  const b = [[], [], []];
  frames.forEach((ch, f) => {
    core.input(ch, t0 + f * FRAME_TICKS * 1000);
    w.frame(f * FRAME_TICKS / 1000, ch);
    for (let k = 0; k < FRAME_TICKS; k++) {
      core.step(1);
      w.step(1);
      const sp = core.fc.setpoint;
      for (let axis = 0; axis < 3; axis++) {
        a[axis].push(sp[axis]);
        b[axis].push(w.setpoint(axis));
      }
    }
  });
  return { ours: a, theirs: b };
}

// Ticks where sim-core's value one tick later is not WebFPV's (0 ulp).
function mismatches(r, axis, lag) {
  const out = [];
  for (let i = 0; i + lag < r.ours[axis].length; i++) {
    if (!Object.is(r.ours[axis][i + lag], r.theirs[axis][i])) out.push(i);
  }
  return out;
}

const still = (n) => Array.from({ length: n }, () => [1500, 1500, 1500, 1000]);

// F1: for each rate type and axis, still for 25 frames, then every channel
// value from 1000 to 2000, one frame each.
let f1Points = 0;
for (const type of Object.keys(RATE_TYPES)) {
  for (let axis = 0; axis < 3; axis++) {
    const frames = still(25);
    for (let k = -500; k <= 500; k++) {
      const ch = [1500, 1500, 1500, 1000];
      ch[axis] = 1500 + k;
      frames.push(ch);
    }
    const r = await runBoth(ratesDiff(type, 'OFF'), frames);
    const bad = mismatches(r, axis, 1);
    const quanta = frames.slice(25).map((_, f) => r.theirs[axis][(25 + f) * FRAME_TICKS]);
    f1Points += quanta.length;
    const span = `${Math.min(...quanta).toFixed(1)}..${Math.max(...quanta).toFixed(1)} deg/s`;
    console.log(`F1 ${type.padEnd(10)} axis ${axis}: 1001 quanta, ${r.ours[axis].length} ticks, ${span}, mismatching ticks ${bad.length}`);
    assert.equal(bad.length, 0, `F1 ${type} axis ${axis}: first mismatch at tick ${bad[0]}`);
    for (const other of [0, 1, 2].filter((x) => x !== axis)) assert.equal(mismatches(r, other, 1).length, 0);
  }
}

// F2: smoothing on, steps of several sizes both ways, a ramp through every
// 4th quantum, a reversal, release; each axis in turn.
function f2Frames() {
  const frames = still(50);
  for (let axis = 0; axis < 3; axis++) {
    const at = (v, n) => {
      for (let i = 0; i < n; i++) {
        const ch = [1500, 1500, 1500, 1000];
        ch[axis] = v;
        frames.push(ch);
      }
    };
    at(1650, 30);
    at(1150, 30);
    for (let v = 1150; v <= 2000; v += 4) at(v, 1);
    at(2000, 30);
    at(1000, 30);
    at(1500, 40);
  }
  return frames;
}
let f2Ticks = 0;
for (const type of Object.keys(RATE_TYPES)) {
  const r = await runBoth(ratesDiff(type, 'ON'), f2Frames());
  const counts = [0, 1, 2].map((axis) => mismatches(r, axis, 1).length);
  const unaligned = [0, 1, 2].map((axis) => mismatches(r, axis, 0).length);
  f2Ticks += r.ours[0].length;
  console.log(`F2 ${type.padEnd(10)} ${r.ours[0].length} ticks: mismatching ticks after the 1-tick shift ${counts.join('/')} (without the shift ${unaligned.join('/')})`);
  counts.forEach((c, axis) => assert.equal(c, 0, `F2 ${type} axis ${axis}`));
  assert.ok(unaligned.every((c) => c > 0), 'the 1-tick RC latency is real: unshifted traces differ');
}

// F4: readback after the same diff, on every WebFPV key Betaflight has.
const BETAFLIGHT_DEFAULTS_DIFFER = {
  // Betaflight 4.5.1 flight/pid.c pgResetTemplate: launchControlAngleLimit = 0.
  launch_angle_limit: '0',
};
for (const [name, diff] of [['65mm class diff', air65], ['F1 KISS rates, smoothing OFF', ratesDiff('KISS', 'OFF')]]) {
  const core = await SimCore.load(ours, { trace: false });
  core.configure(diff);
  const w = new WebFpv(theirs, diff);
  const keys = w.keys();
  const got = core.get(keys);
  const notBetaflight = keys.filter((k) => got[k] === undefined);
  const compared = keys.filter((k) => got[k] !== undefined && !(k in BETAFLIGHT_DEFAULTS_DIFFER));
  const diffs = compared.filter((k) => got[k] !== w.get(k));
  console.log(`F4 ${name}: WebFPV keys ${keys.length}, not in Betaflight 4.5.1 ${notBetaflight.length} (${notBetaflight.join(' ')}), string-equal ${compared.length - diffs.length} of ${compared.length}`);
  for (const k of diffs) console.log(`   ${k}: WebFPV '${w.get(k)}' sim-core '${got[k]}'`);
  assert.equal(diffs.length, 0, 'F4 readback string-equal');
  assert.deepEqual(notBetaflight, ['rpm_filter_weights_1', 'rpm_filter_weights_2', 'rpm_filter_weights_3']);
  // Betaflight names it one array; WebFPV splits it in three.
  assert.equal(core.get('rpm_filter_weights'), notBetaflight.map((k) => w.get(k)).join(','));
  for (const [k, v] of Object.entries(BETAFLIGHT_DEFAULTS_DIFFER)) {
    console.log(`   ${k}: WebFPV '${w.get(k)}', sim-core '${got[k]}' (Betaflight default ${v})`);
    assert.equal(got[k], v);
  }
}

// F4, where WebFPV is not Betaflight: out-of-range values and profiles.
{
  const cases = [
    ['set p_roll = 251', 'p_roll', '251'],     // WebFPV stores it
    ['set roll_srate = 300', 'roll_srate', '255'], // WebFPV clamps
    ['set p_roll = -5', 'p_roll', '0'],        // WebFPV clamps
  ];
  for (const [line, key, webfpvValue] of cases) {
    const core = await SimCore.load(ours, { trace: false });
    const r = core.configure(line);
    const w = new WebFpv(theirs, line);
    const defaults = await SimCore.load(ours, { trace: false });
    defaults.configure('');
    console.log(`F4 '${line}': WebFPV ${w.get(key)}; Betaflight ${r.lines[0].status} (${r.lines[0].msg}), keeps ${core.get(key)}`);
    assert.equal(w.get(key), webfpvValue);
    assert.equal(r.lines[0].status, 'error');
    assert.match(r.lines[0].msg, /INVALID VALUE/);
    assert.equal(core.get(key), defaults.get(key));
  }
  const line = 'profile 1\nset p_roll = 61';
  const core = await SimCore.load(ours, { trace: false });
  core.configure(line);
  const w = new WebFpv(theirs, line);
  console.log(`F4 '${line.replace('\n', '; ')}': WebFPV p_roll ${w.get('p_roll')} (one profile); Betaflight profile 0 ${core.get('p_roll', { profile: 0 })}, profile 1 ${core.get('p_roll', { profile: 1 })}`);
  assert.equal(w.get('p_roll'), '61');
  assert.equal(core.get('p_roll', { profile: 1 }), '61');
  assert.notEqual(core.get('p_roll', { profile: 0 }), '61');
}

console.log(`blackbox-webfpv: F1 ${f1Points} curve points, F2 ${f2Ticks} ticks x 3 axes, F4 readback, all exact: PASS`);
