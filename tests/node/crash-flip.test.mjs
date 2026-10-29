// Turtle on a flat floor: Betaflight's crash flip (FLIP OVER AFTER CRASH) on
// the owner's Air65 diff, configs/air65-ryfly-2026-10-23.txt, which puts it on
// AUX3. The Air65 rests inverted on the PR #3 contact footprint; AUX3 high
// and an arm put Betaflight in crash flip; a full roll stick has it upright
// within 500 ms; with AUX3 low and the sticks centred it rests upright. Then,
// with crash flip entered after a throttle move, Betaflight's output stays
// finite, and its gyro saturates at the ICM-42688-P's full scale.
//
//   node tests/node/crash-flip.test.mjs
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SimCore } from '../../src/js/sim-core.js';

const root = new URL('../../', import.meta.url);
const core = await SimCore.load(await readFile(new URL('dist/sim-core.wasm', root)), { trace: false });
const diff = await readFile(new URL('configs/air65-ryfly-2026-10-23.txt', root), 'utf8');
const air65 = JSON.parse(await readFile(new URL('airframes/air65.json', root), 'utf8'));
const r = core.configure({ diff, plant: air65, world: { floorZ: 0 } });
// The diff's hardware lines (resources, OSD, VTX) have no sim target; its four
// aux lines all apply, and sim-core adds none.
const auxLines = r.lines.filter((l) => /^aux\s/.test(l.text));
assert.equal(auxLines.length, 4);
assert.ok(auxLines.every((l) => l.status === 'applied'), auxLines.map((l) => `${l.text}: ${l.status}`).join('; '));
assert.deepEqual(r.added, []);

const upZ = () => {
  const [, x, y] = core.state.quat;
  return 1 - 2 * (x * x + y * y);
};
const omega = () => Math.hypot(...core.state.omega);
// Roll, pitch, yaw, throttle, AUX1 (ARM), AUX2 (ANGLE), AUX3 (BEEPER, FLIP
// OVER AFTER CRASH), AUX4. A new sample every 4 ms, 1 ms ticks.
const ch = [1500, 1500, 1500, 1000, 1000, 1000, 1000, 1000];
const AUX1 = 4;
const AUX3 = 6;
function run(ms, each) {
  for (let k = 0; k < ms; k++) {
    if (k % 4 === 0) core.input(ch, core.simTimeUs);
    core.step(1);
    if (each) each(k + 1);
  }
}

// Inverted (180 degrees about body X), dropped from 5 cm onto the floor.
core.teleport({ pos: [0, 0, 0.05], quat: [0, 1, 0, 0] });
run(1500);
assert.ok(upZ() < -0.99, `rests inverted (up Z ${upZ().toFixed(3)})`);
// On the canopy: the CG hullAbove up (values.hullAbove, 18 mm shipped; the
// measured 30.2 mm is held in measured.hullAbove, #15), within 1 mm.
assert.ok(Math.abs(core.state.pos[2] - air65.values.hullAbove.value) < 1e-3 && omega() < 0.01, `at rest on the floor (z ${core.state.pos[2].toFixed(4)} m, |omega| ${omega().toFixed(4)})`);
console.log(`inverted at rest: up Z ${upZ().toFixed(3)}, z ${core.state.pos[2].toFixed(4)} m`);

// AUX3 high, then arm with the throttle low.
ch[AUX3] = 2000;
run(100);
ch[AUX1] = 2000;
run(300);
assert.equal(core.fc.armed, true, `armed (flags ${core.fc.armingDisableFlags})`);
assert.equal(core.fc.crashFlip, true, 'armed into crash flip');

// Full roll: upright within 500 ms.
ch[0] = 2000;
let uprightMs = null;
run(500, (ms) => {
  if (uprightMs === null && upZ() > 0.9) uprightMs = ms;
});
assert.ok(uprightMs !== null, `upright within 500 ms of full roll (up Z ${upZ().toFixed(3)})`);
console.log(`full roll: upright (up Z > 0.9) at ${uprightMs} ms`);

// AUX3 low, sticks centred: it rests upright. (Betaflight leaves crash flip
// only on a disarm; with the sticks centred its motors stay off.)
ch[0] = 1500;
ch[AUX3] = 1000;
let minUp = 1;
run(1500, (ms) => {
  if (ms > 500) minUp = Math.min(minUp, upZ());
});
assert.ok(minUp > 0.95, `rests upright over the last second (lowest up Z ${minUp.toFixed(3)})`);
assert.ok(omega() < 0.01, `at rest (|omega| ${omega().toFixed(4)} rad/s)`);
assert.ok(core.state.pos[2] < 0.03, `on the floor (z ${core.state.pos[2].toFixed(4)} m)`);
assert.ok(core.state.motorOut.every((m) => Math.abs(m) < 0.01), `motors off with the sticks centred (${core.state.motorOut.map((m) => m.toFixed(3))})`);
console.log(`AUX3 low, sticks centred: up Z ${upZ().toFixed(3)}, z ${core.state.pos[2].toFixed(4)} m, armed ${core.fc.armed}, crash flip ${core.fc.crashFlip}`);

// The disarm that ends crash flip.
ch[AUX1] = 1000;
run(100);
assert.equal(core.fc.armed, false);
assert.equal(core.fc.crashFlip, false, 'a disarm ends crash flip');

// ---- No NaN in Betaflight's output, the gyro saturating as the ICM-42688-P ----
// Crash flip entered right after the throttle moved (armed on its back, a
// throttle punch, disarm, flip switch, arm): Betaflight 4.5.1 scales anti-
// gravity's throttle derivative in place every PID loop and skips its update
// in crash flip, so that left-over derivative went to inf and the P and I
// terms to NaN (patches/0003). Every tick from here on, every PID, setpoint,
// gyro, attitude and motor value is finite. debug_mode GYRO_RAW puts the int16
// counts Betaflight read in debug[0..2]: within int16, saturated at 32767 and
// -32768 (+1999.94 / -2000.00 deg/s) while the quad turns faster than that,
// and otherwise the rotation the attitude made over the tick before, floor
// contacts included (the plant once reported the rate after the contact solve,
// which the attitude never turned with, and Betaflight's estimate walked off
// on the floor).
const raw = await SimCore.load(await readFile(new URL('dist/sim-core.wasm', root)), { trace: false });
raw.configure({ diff: `${diff}\nset debug_mode = GYRO_RAW\n`, plant: air65, world: { floorZ: 0 } });
const fields = ['pidSum', 'setpoint', 'gyroFiltered', 'attitude', 'motor', 'rcCommand'];
let ticks = 0;
let fastest = 0;
let onFloor = 0;
const counts = { max: -Infinity, min: Infinity };
// The body rate (deg/s) of the plant's first-order attitude step from qa to qb:
// qb is qa (1, w dt / 2) normalised, so w = 2 v / (s dt) for (s, v) = qa* qb.
const stepRate = (qa, qb) => {
  const [aw, ax, ay, az] = qa;
  const [bw, bx, by, bz] = qb;
  const w = aw * bw + ax * bx + ay * by + az * bz;
  const v = [aw * bx - ax * bw - ay * bz + az * by, aw * by + ax * bz - ay * bw - az * bx, aw * bz - ax * by + ay * bx - az * bw];
  return v.map((c) => (2 * c / (w * 0.001)) * 180 / Math.PI);
};
let lastRate = null;
let lastContact = false;
let jumped = false;    // a teleport lands on the next tick: no rate across it
function fly(ms) {
  for (let k = 0; k < ms; k++) {
    if (k % 4 === 0) raw.input(ch, raw.simTimeUs);
    const qa = Array.from(raw.state.quat);
    raw.step(1);
    const f = raw.fc;
    // Betaflight read, at the start of this tick, what the last tick published.
    if (lastRate) {
      for (let axis = 0; axis < 3; axis++) {
        const want = Math.max(-32768, Math.min(32767, Math.round(lastRate[axis] * 32768 / 2000)));
        assert.ok(Math.abs(f.debug[axis] - want) <= 1, `gyro counts ${f.debug[axis]} against the attitude's ${lastRate[axis].toFixed(2)} deg/s (axis ${axis}${lastContact ? ', on the floor' : ''})`);
      }
      if (lastContact) onFloor++;
    }
    lastRate = jumped ? null : stepRate(qa, Array.from(raw.state.quat));
    jumped = false;
    lastContact = raw.state.contactFlags !== 0;
    for (const name of fields) {
      const bad = Array.from(f[name]).find((x) => !Number.isFinite(x));
      assert.equal(bad, undefined, `fc.${name} finite at ${raw.simTimeUs} us (${Array.from(f[name])})`);
    }
    for (let axis = 0; axis < 3; axis++) {
      const c = f.debug[axis];
      assert.ok(Number.isInteger(c) && c >= -32768 && c <= 32767, `gyro counts ${c}`);
      counts.max = Math.max(counts.max, c);
      counts.min = Math.min(counts.min, c);
    }
    fastest = Math.max(fastest, ...raw.state.omega.map((w) => Math.abs(w) * 180 / Math.PI));
    ticks++;
  }
}
ch.fill(1000, 3);
ch[0] = ch[1] = ch[2] = 1500;
raw.teleport({ pos: [0, 0, 0.05], quat: [0, 1, 0, 0] });
jumped = true;
fly(1500);
ch[AUX1] = 2000;
fly(300);
assert.equal(raw.fc.armed, true, 'armed on its back (small_angle 180)');
ch[3] = 2000;
fly(50);
ch[AUX1] = 1000;
ch[AUX3] = 2000;
fly(50);
ch[3] = 1000;
fly(20);
ch[AUX1] = 2000;
fly(100);
assert.equal(raw.fc.crashFlip, true, 'armed into crash flip');
ch[3] = 2000;
ch[0] = 2000;
fly(1000);
// The other way: back on its back, roll left.
ch[0] = 1500;
ch[3] = 1000;
ch[AUX1] = 1000;
fly(200);
raw.teleport({ pos: [0, 0, 0.05], quat: [0, 1, 0, 0] });
jumped = true;
fly(1500);
ch[AUX1] = 2000;
fly(300);
ch[3] = 2000;
ch[0] = 1000;
fly(1000);
assert.ok(fastest > 2100, `the flips turn faster than the gyro's range (${fastest.toFixed(0)} deg/s)`);
assert.equal(counts.max, 32767, 'saturates at +full scale');
assert.equal(counts.min, -32768, 'saturates at -full scale');
assert.ok(onFloor > 1000, `checked on the floor too (${onFloor} ticks)`);
console.log(`${ticks} ticks, every PID, setpoint, gyro, attitude and motor value finite; gyro counts ${counts.min}..${counts.max} with the quad at up to ${fastest.toFixed(0)} deg/s, and the attitude's own rotation on every tick (${onFloor} on the floor)`);
console.log('crash flip: ok');
