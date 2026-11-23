// A level slide on the floor, motors off (owner, 2026-11-23): the floor's
// friction is Coulomb (the airframe's floorFriction), so it does not depend
// on the tick rate. Until v0.9.0 the floor took 0.85 of the speed along it
// every tick, quadmath's drag at its 240 Hz: at sim-core's 1 kHz a 2 m/s
// slide stopped in about 2 cm.
//
// Asserted, both whoops, posed level on the floor at 2 m/s forward:
//   - it slides 0.5 to 1 m before it stops (the owner's provisional target
//     until the slide video); the air's drag is in that, as on the quad;
//   - it stays level and on the floor;
//   - with floorFriction halved, it slows by half floorFriction times g less
//     as it passes 1 m/s (within 2 %; the drag, the same at the same speed,
//     drops out): Coulomb friction, a deceleration, not a fraction of the
//     speed a tick.
//
//   node tests/node/floor-slide.test.mjs
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SimCore } from '../../src/js/sim-core.js';

const root = new URL('../../', import.meta.url);
const wasm = await readFile(new URL('dist/sim-core.wasm', root));
const quads = [
  ['Air65', 'airframes/air65.json', 'configs/air65-ryfly-2026-10-23.txt'],
  ['Fractal75', 'airframes/fractal75.json', 'configs/fractal75-ryfly-2026-11-03.txt'],
];
const V0 = 2;               // m/s
const AT = 1;               // m/s: the speed the two frictions' decelerations are compared at

async function slide(air, diff) {
  const v = (k) => air.values[k].value;
  const core = await SimCore.load(wasm, { trace: false });
  core.configure({ diff, plant: air, world: { floorZ: 0, boxes: [] } });
  core.step(100);
  // Level, the duct bottoms 0.2 mm over the floor.
  core.teleport({ pos: [0, 0, v('hullBelow') + 0.0002], quat: [1, 0, 0, 0], vel: [V0, 0, 0] });
  core.step(1);
  const x0 = core.state.pos[0];
  const vx = [];
  let stopMs = null, tiltMax = 0, zMax = 0;
  for (let t = 1; t <= 3000; t++) {
    core.step(1);
    const s = core.state;
    const up = 1 - 2 * (s.quat[1] ** 2 + s.quat[2] ** 2);
    tiltMax = Math.max(tiltMax, Math.acos(Math.min(1, up)) * 180 / Math.PI);
    if (t > 50) zMax = Math.max(zMax, s.pos[2] - v('hullBelow'));
    vx.push(s.vel[0]);
    if (Math.hypot(s.vel[0], s.vel[1]) < 0.005) {
      stopMs = t;
      break;
    }
  }
  // The deceleration as it passes AT: the speed lost over the 20 ms around it.
  const i = vx.findIndex((x) => x < AT);
  const decel = i >= 10 && i + 10 < vx.length ? (vx[i - 10] - vx[i + 10]) / 0.02 : NaN;
  return { slid: core.state.pos[0] - x0, stopMs, tiltMax, zMax, decel };
}

for (const [name, airframeFile, diffFile] of quads) {
  const air = JSON.parse(await readFile(new URL(airframeFile, root), 'utf8'));
  const diff = await readFile(new URL(diffFile, root), 'utf8');
  const v = (k) => air.values[k].value;
  // No pack in either airframe yet: the duct bottoms are the lowest points.
  assert.ok(!(v('packLength') > 0 && v('packWidth') > 0), `${name}: no pack (the pose puts the duct bottoms lowest)`);
  const run = await slide(air, diff);
  const half = JSON.parse(JSON.stringify(air));
  half.values.floorFriction.value = v('floorFriction') / 2;
  const halfRun = await slide(half, diff);
  const want = v('floorFriction') / 2 * v('gravity');
  const apart = run.decel - halfRun.decel;
  console.log(`${name}: a level 2 m/s slide, motors off, goes ${run.slid.toFixed(3)} m and stops at ${run.stopMs} ms (floorFriction ${v('floorFriction')}); tilt at most ${run.tiltMax.toFixed(2)} deg. At ${AT} m/s it slows at ${run.decel.toFixed(3)} m/s^2, and at ${halfRun.decel.toFixed(3)} with floorFriction halved (slides ${halfRun.slid.toFixed(3)} m): ${apart.toFixed(3)} apart, half floorFriction x g is ${want.toFixed(3)}`);
  assert.ok(run.stopMs !== null, `${name}: stops within 3 s`);
  assert.ok(run.slid >= 0.5 && run.slid <= 1, `${name}: slides 0.5 to 1 m (${run.slid.toFixed(3)})`);
  assert.ok(run.tiltMax < 0.5 && run.zMax < 1e-4, `${name}: level and on the floor (tilt ${run.tiltMax.toFixed(2)} deg, ${(run.zMax * 1e3).toFixed(3)} mm up)`);
  assert.ok(Math.abs(apart - want) < 0.02 * want, `${name}: Coulomb (${apart.toFixed(3)} against ${want.toFixed(3)} m/s^2)`);
}
console.log('floor slide: ok');
