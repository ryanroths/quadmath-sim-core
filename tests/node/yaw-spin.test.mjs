// Yaw-spin recovery in the simulator build (patches/0004, owner 2026-11-23):
// the threshold is Betaflight's own, yaw_spin_recovery AUTO's rule off the
// pilot's yaw rate (fc/rc.c initYawSpinRecovery: the max yaw rate plus a
// quarter of it, at least 200 deg/s, within 500..1950), not a fixed number.
//
// Each case flies the owner's Air65 diff in acro into a wall at 4 m/s, yawed
// 25 degrees so one front duct leads off the CG's line (wall-hit's off-centre
// hit, which yaws the quad past 2000 deg/s), the throttle held. Betaflight's
// recovery shows in its output: while it is on, roll and pitch P, D and F and
// every I are zero (flight/pid.c), so the roll and pitch PID sums are exactly
// zero with the quad tumbling.
//
// Asserted, at two yaw rates (the diff's yaw_srate 70, and 130):
//   - the full-stick yaw setpoint is the rate (700, 1300 deg/s), and the
//     threshold the AUTO rule gives from it (900, 1625);
//   - the recovery comes on at the first tick Betaflight's filtered yaw gyro
//     is over that threshold, and not before;
//   - it goes off 21 ticks after the last tick the yaw was within 100 deg/s
//     of the threshold (Betaflight: 20 ms under threshold - 100);
//   - the two rates' recoveries differ (the higher threshold ends sooner);
// and with yaw_spin_recovery OFF the same hit never zeroes roll and pitch.
// Full yaw stick at the diff's rate, in a hover, stays under its threshold.
//
//   node tests/node/yaw-spin.test.mjs
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SimCore } from '../../src/js/sim-core.js';

const root = new URL('../../', import.meta.url);
const wasm = await readFile(new URL('dist/sim-core.wasm', root));
const baseDiff = await readFile(new URL('configs/air65-ryfly-2026-10-23.txt', root), 'utf8');
const air65 = JSON.parse(await readFile(new URL('airframes/air65.json', root), 'utf8'));
const val = (k) => air65.values[k].value;
assert.ok(baseDiff.includes('set yaw_srate = 70\n'), 'the diff sets yaw_srate 70');
assert.ok(!/yaw_spin_recovery|yaw_spin_threshold/.test(baseDiff), 'the diff leaves yaw_spin_recovery at AUTO');

const WALL_X = 1;
const WALL_ID = 7;
const world = { floorZ: 0, boxes: [{ min: [WALL_X, -10, 0], max: [WALL_X + 0.3, 10, 3], id: WALL_ID }] };
const HOVER = 0.371;            // the bench hover stick (tests/reference/air65-hover.json)
const AUX1 = 4;

const mul = (a, b) => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
];
const rotate = (q, v) => mul(mul(q, [0, ...v]), [q[0], -q[1], -q[2], -q[3]]).slice(1);
const pitchFor = (v) => Math.atan2(0.5 * val('airDensity') * val('cdAFront') * v * v, val('mass') * val('gravity'));
function leadingX(q) {
  const arm = val('wheelbase') / 2 * Math.SQRT1_2, R = val('ductOuterRadius');
  let best = -Infinity;
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    for (const z of [-val('hullBelow'), -val('hullBelow') + val('ductHeight')]) {
      for (let k = 0; k < 72; k++) {
        const a = (k / 72) * 2 * Math.PI;
        best = Math.max(best, rotate(q, [sx * arm + R * Math.cos(a), sy * arm + R * Math.sin(a), z])[0]);
      }
    }
  }
  return best;
}
// Betaflight 4.5.1 sensors/gyro.c initYawSpinRecovery, YAW_SPIN_RECOVERY_AUTO.
const autoThreshold = (maxYawRate) => Math.min(1950, Math.max(500, maxYawRate + Math.max(Math.trunc(maxYawRate / 4), 200)));

async function fly(diff) {
  const core = await SimCore.load(wasm, { trace: false });
  core.configure({ diff, plant: air65, world });
  const ch = [1500, 1500, 1500, 1000, 1000, 1000, 1000, 1000];
  const step = (ms, each) => {
    for (let k = 0; k < ms; k++) {
      if (core.simTimeUs % 4000 === 0) core.input(ch, core.simTimeUs);
      core.step(1);
      if (each) each();
    }
  };
  step(200);
  ch[AUX1] = 2000;
  step(300);
  assert.equal(core.fc.armed, true, `armed (flags ${core.fc.armingDisableFlags})`);
  // The pilot's yaw rate: Betaflight's setpoint at full yaw stick.
  ch[2] = 2000;
  step(150);
  const maxYawRate = Math.abs(core.fc.setpoint[2]);
  ch[2] = 1500;
  step(150);
  // The off-centre hit, flown: 4 m/s head on, yawed 25 degrees, the throttle held.
  const speed = 4;
  const yaw = 25 * Math.PI / 180;
  const pitch = pitchFor(speed);
  const q = mul([Math.cos(yaw / 2), 0, 0, Math.sin(yaw / 2)], [Math.cos(pitch / 2), 0, Math.sin(pitch / 2), 0]);
  ch[3] = Math.round(1000 + 1000 * HOVER * Math.sqrt(1 / Math.cos(pitch)));
  core.teleport({ pos: [WALL_X - 0.005 - leadingX(q), 0, 1], quat: q, vel: [speed, 0, 0] });
  core.events();
  const ticks = [];
  let hit = null;
  step(400, () => {
    for (const e of core.events()) if (e.kind === 'contact' && e.box === WALL_ID && hit === null) hit = ticks.length;
    const f = core.fc;
    ticks.push({
      yaw: f.gyroFiltered[2],
      zero: f.armed && f.pidSum[0] === 0 && f.pidSum[1] === 0,
      error: Math.max(Math.abs(f.setpoint[0] - f.gyroFiltered[0]), Math.abs(f.setpoint[1] - f.gyroFiltered[1])),
    });
  });
  assert.ok(hit !== null, 'hit the wall');
  // On: the first tick after the hit with roll and pitch both exactly zero
  // while the quad tumbles (more than 10 deg/s off its roll or pitch setpoint).
  let on = null;
  for (let i = hit; i < ticks.length && on === null; i++) if (ticks[i].zero && ticks[i].error > 10) on = i;
  let off = null;
  if (on !== null) for (let i = on; i < ticks.length && off === null; i++) if (!ticks[i].zero) off = i;
  return { maxYawRate, ticks, hit, on, off, peak: Math.max(...ticks.map((t) => Math.abs(t.yaw))) };
}

const cases = [];
for (const srate of [70, 130]) {
  const r = await fly(baseDiff.replace('set yaw_srate = 70\n', `set yaw_srate = ${srate}\n`));
  const threshold = autoThreshold(r.maxYawRate);
  const over = r.ticks.findIndex((t, i) => i >= r.hit && Math.abs(t.yaw) > threshold);
  let lastNear = null;
  if (r.off !== null) for (let i = r.off - 1; i >= r.on && lastNear === null; i--) if (Math.abs(r.ticks[i].yaw) >= threshold - 100) lastNear = i;
  console.log(`yaw_srate ${srate}: full-stick yaw ${r.maxYawRate.toFixed(0)} deg/s, AUTO threshold ${threshold}; the hit yaws the gyro to ${r.peak.toFixed(0)} deg/s. Over the threshold from tick ${over} (yaw ${r.ticks[over].yaw.toFixed(0)}, the tick before ${r.ticks[over - 1].yaw.toFixed(0)}); recovery on at tick ${r.on}, off at tick ${r.off} (yaw ${r.off === null ? '-' : r.ticks[r.off].yaw.toFixed(0)}), the yaw last within 100 of the threshold at tick ${lastNear}`);
  assert.equal(r.maxYawRate, srate * 10, `yaw_srate ${srate}: the full-stick yaw rate`);
  assert.ok(over > 0, `yaw_srate ${srate}: the hit yaws past the threshold`);
  assert.equal(r.on, over, `yaw_srate ${srate}: recovery on at the first tick over ${threshold} deg/s`);
  assert.ok(r.off !== null && lastNear !== null, `yaw_srate ${srate}: recovery ends`);
  assert.equal(r.off, lastNear + 21, `yaw_srate ${srate}: recovery off 20 ms after the yaw fell under ${threshold - 100} deg/s`);
  cases.push({ srate, threshold, ...r });
}
assert.deepEqual(cases.map((c) => c.threshold), [900, 1625], 'the AUTO thresholds');
assert.ok(cases[1].off < cases[0].off, 'the higher threshold lets go sooner');

// yaw_spin_recovery OFF: the same hit never zeroes roll and pitch.
{
  const r = await fly(`${baseDiff}\nset yaw_spin_recovery = OFF\n`);
  console.log(`yaw_spin_recovery OFF: the hit yaws the gyro to ${r.peak.toFixed(0)} deg/s; roll and pitch zeroed at tick ${r.on}`);
  assert.equal(r.on, null, 'OFF: no recovery');
}

// Full yaw stick in a hover at the diff's rate stays under its threshold.
{
  const core = await SimCore.load(wasm, { trace: false });
  core.configure({ diff: baseDiff, plant: air65, world: { floorZ: 0, boxes: [] } });
  const ch = [1500, 1500, 1500, 1000, 1000, 1000, 1000, 1000];
  const step = (ms, each) => {
    for (let k = 0; k < ms; k++) {
      if (core.simTimeUs % 4000 === 0) core.input(ch, core.simTimeUs);
      core.step(1);
      if (each) each();
    }
  };
  step(200);
  ch[AUX1] = 2000;
  step(300);
  ch[3] = Math.round(1000 + 1000 * HOVER);
  core.teleport({ pos: [0, 0, 1.5], quat: [1, 0, 0, 0], vel: [0, 0, 0] });
  step(500);
  let peak = 0;
  for (const yawStick of [2000, 1000]) {
    ch[2] = yawStick;
    step(1000, () => { peak = Math.max(peak, Math.abs(core.fc.gyroFiltered[2])); });
  }
  console.log(`full yaw stick both ways for 1 s each, hovering: yaw gyro at most ${peak.toFixed(0)} deg/s (threshold ${cases[0].threshold})`);
  assert.ok(peak > 600 && peak < cases[0].threshold, 'full yaw stick stays under the threshold');
}
console.log('yaw-spin recovery: ok');
