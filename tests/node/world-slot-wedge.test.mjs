// World contact, review round 3's open high finding (PROGRESS.md 2026-10-23):
// a motors-off quad wedged across a slot about 40 mm wide never comes to
// rest. Known failing: the owner's decision is a failing test and a note, no
// fix yet. Skipped in npm test (tests/run-all.mjs) pending issue #5,
// https://github.com/ryanroths/quadmath-sim-core/issues/5;
// run it directly, or SC_RUN_KNOWN_FAILING=1 npm test.
//
// The reviewer's repro, no map file needed: two floor-standing boxes 42.9 mm
// apart (the garage's west wall end, box 3, and the crate beside it, box 62),
// the quad posed motors off lying on its side across the gap, rims on the
// floor against the crate's face, canopy against the wall's face. 30 s. The
// bounds are the ones the reviewer's candidate fix met: after the first 2 s,
// no CONTACT event, |omega| under 0.2 rad/s, and no footprint point more than
// 0.1 mm into either box.
//
//   node tests/node/world-slot-wedge.test.mjs
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SimCore } from '../../src/js/sim-core.js';

const root = new URL('../../', import.meta.url);
const module = await WebAssembly.compile(await readFile(new URL('dist/sim-core.wasm', root)));
const air65 = JSON.parse(await readFile(new URL('airframes/air65.json', root), 'utf8'));
const diff = await readFile(new URL('configs/65mm-air65-ryfly-1219s.diff', root), 'utf8');
const v = air65.values;

const wall = { min: [-6.0571, 1.2143, 0], max: [-5.9429, 3.0, 3.0] };
const crate = { min: [-6.0557, 0.5143, 0], max: [-5.8986, 1.1714, 0.6286] };
const pose = { pos: [-5.999529, 1.19693, 0.027042], quat: [-0.36572, 0.60528, -0.60491, -0.36601], vel: [0, 0, 0] };

// The footprint in the body frame (rims in motor order, then the canopy),
// as the plant places it, rotated by quat w x y z into the world.
const reach = (v.wheelbase.value / 2 + v.ductOuterRadius.value) * Math.SQRT1_2;
const body = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([a, b]) => [a * reach, b * reach, -v.hullBelow.value]).concat([[0, 0, v.hullAbove.value]]);
function rotate([w, x, y, z], p) {
  const t = [2 * (y * p[2] - z * p[1]), 2 * (z * p[0] - x * p[2]), 2 * (x * p[1] - y * p[0])];
  return [p[0] + w * t[0] + y * t[2] - z * t[1], p[1] + w * t[1] + z * t[0] - x * t[2], p[2] + w * t[2] + x * t[1] - y * t[0]];
}
// How far p is inside box b, m (0 outside): the nearest face.
const depth = (b, p) => Math.max(0, Math.min(...[0, 1, 2].flatMap((a) => [p[a] - b.min[a], b.max[a] - p[a]])));

const core = await SimCore.load(module, { trace: false });
core.configure({ diff, plant: air65, world: { floorZ: 0, boxes: [wall, crate] } });
core.teleport(pose);
core.motorOverride(-1, 0);
core.events();
const SECS = 30;
const contactsPerSec = new Array(SECS).fill(0);
const omegaPerSec = new Array(SECS).fill(0);
let deepest = 0;
for (let k = 0; k < SECS * 1000; k++) {
  core.step(1);
  const sec = Math.floor(k / 1000);
  contactsPerSec[sec] += core.events().filter((e) => e.kind === 'contact').length;
  const s = core.state;
  omegaPerSec[sec] = Math.max(omegaPerSec[sec], Math.hypot(...s.omega));
  if (k >= 2000) {
    for (const p of body.map((q) => rotate(s.quat, q).map((u, a) => u + s.pos[a]))) deepest = Math.max(deepest, depth(wall, p), depth(crate, p));
  }
}
const lateContacts = contactsPerSec.slice(2).reduce((a, b) => a + b, 0);
const lateOmega = Math.max(...omegaPerSec.slice(2));
console.log(`slot wedge, motors off, ${SECS} s: CONTACT events per second ${JSON.stringify(contactsPerSec)}`);
console.log(`   max |omega| per second ${JSON.stringify(omegaPerSec.map((x) => +x.toFixed(2)))}; after 2 s: ${lateContacts} CONTACT events, |omega| up to ${lateOmega.toFixed(3)} rad/s, deepest point ${(deepest * 1e3).toFixed(3)} mm`);
assert.equal(lateContacts, 0, 'no CONTACT event after the first 2 s (round 3 high finding, known failing: issue #5)');
assert.ok(lateOmega < 0.2, `|omega| under 0.2 rad/s after the first 2 s (${lateOmega.toFixed(3)})`);
assert.ok(deepest <= 1e-4, `no point more than 0.1 mm in a box (${(deepest * 1e3).toFixed(3)} mm)`);
console.log('world-slot-wedge: at rest across the slot: PASS');
