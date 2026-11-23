// The pack under the frame (v0.9.0, owner 2026-11-23): the airframe's
// packDrop, packLength, packWidth and packX put the pack's underside's four
// corners into the footprint, so the quad sits on the pack and two ducts as a
// whoop does. Until the owner's measurements (D2) both airframes keep the
// pack out (length and width 0); this test flies an EXAMPLE pack, not a
// measured one: 3 mm below the duct bottoms, 45 x 12 mm, centred.
//
// Asserted, motors off on the Air65:
//   - the footprint has 9 points with the pack and 5 without;
//   - with no pack a level drop rests level, as before;
//   - with the pack (flat, centred) it sits on the pack, the ducts packDrop
//     off the floor, no point under the floor, at rest within 2 s;
//   - a skid landing (1 m/s down, 3 m/s forward) slides as far with the pack
//     as without, and neither tips: the floor's friction is Coulomb
//     (floorFriction 0.2, 2026-11-23), so it does not depend on what touches,
//     and its moment about the CG (mu times the CG's height over the floor)
//     is far inside the pack's half length. (Under quadmath's drag of 0.85
//     of the speed a tick, the pack tripped the skid: 19.3 degrees, 3.2
//     without.);
//   - a level 2 m/s drop onto the pack takes the impact pulse (contactPulse):
//     its peak specific force is below the one-tick answer's (contactPulse 0).
//
//   node tests/node/pack-contact.test.mjs
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SimCore } from '../../src/js/sim-core.js';

const root = new URL('../../', import.meta.url);
const wasm = await readFile(new URL('dist/sim-core.wasm', root));
const diff = await readFile(new URL('configs/air65-ryfly-2026-10-23.txt', root), 'utf8');
const air65 = JSON.parse(await readFile(new URL('airframes/air65.json', root), 'utf8'));
const EXAMPLE = { packDrop: 0.003, packLength: 0.045, packWidth: 0.012, packX: 0 };

const withValues = (base, set) => {
  const out = JSON.parse(JSON.stringify(base));
  for (const [k, v] of Object.entries(set)) out.values[k].value = v;
  return out;
};
const upZ = (q) => 1 - 2 * (q[1] * q[1] + q[2] * q[2]);
const tiltDeg = (q) => Math.acos(Math.max(-1, Math.min(1, upZ(q)))) * 180 / Math.PI;
const G = air65.values.gravity.value;

// A motors-off drop: posed with its lowest point `gap` above the floor at
// `vel`, flown `ms`; returns the trace.
async function drop(plant, { vel, gap = 0.002, ms = 2000 }) {
  const core = await SimCore.load(wasm, { trace: false });
  core.configure({ diff, plant, world: { floorZ: 0, boxes: [] } });
  core.step(100);
  // Level, the lowest point is the duct bottoms or the pack's underside.
  const pv = plant.values;
  const low = pv.hullBelow.value + (pv.packLength.value > 0 && pv.packWidth.value > 0 ? Math.max(0, pv.packDrop.value) : 0);
  core.teleport({ pos: [0, 0, low + gap], quat: [1, 0, 0, 0], vel });
  core.events();
  const trace = [];
  let rest = 0, restAt = null;
  for (let t = 0; t < ms; t++) {
    core.step(1);
    const s = core.state;
    const lowZ = Math.min(...core.footprint.map((p) => p[2]));
    trace.push({ t, pos: [...s.pos], quat: [...s.quat], az: Math.hypot(...s.specificForce), lowZ, n: core.footprint.length });
    rest = Math.hypot(...s.vel) < 0.005 && Math.hypot(...s.omega) < 0.02 ? rest + 1 : 0;
    if (rest === 200 && restAt === null) restAt = (t - 199) / 1000;
  }
  return { trace, restAt, end: trace[trace.length - 1] };
}

const bare = air65;
const packed = withValues(air65, EXAMPLE);

// Points.
{
  const a = await SimCore.load(wasm, { trace: false });
  a.configure({ diff, plant: bare, world: { floorZ: 0, boxes: [] } });
  const b = await SimCore.load(wasm, { trace: false });
  b.configure({ diff, plant: packed, world: { floorZ: 0, boxes: [] } });
  console.log(`footprint: ${a.footprint.length} points without the pack, ${b.footprint.length} with it`);
  assert.equal(a.footprint.length, 5, 'five points without the pack');
  assert.equal(b.footprint.length, 9, 'nine points with the pack');
}

// Rest.
const flat = await drop(bare, { vel: [0, 0, -0.3] });
const onPack = await drop(packed, { vel: [0, 0, -0.3] });
console.log(`level drop at 0.3 m/s, motors off: no pack rests ${tiltDeg(flat.end.quat).toFixed(3)} deg tilted, CG ${(flat.end.pos[2] * 1e3).toFixed(2)} mm up, at rest ${flat.restAt} s; the example pack rests ${tiltDeg(onPack.end.quat).toFixed(2)} deg tilted, CG ${(onPack.end.pos[2] * 1e3).toFixed(2)} mm up, lowest point ${(Math.min(...onPack.trace.map((r) => r.lowZ)) * 1e6).toFixed(2)} um, at rest ${onPack.restAt} s`);
assert.ok(tiltDeg(flat.end.quat) < 0.01, 'no pack: rests level');
// A flat pack centred under the CG is a stable base of its own: the quad sits
// on it, the ducts packDrop off the floor (it tips onto two ducts only with
// the CG or the pack off centre, or when it skids, below).
const sit = air65.values.hullBelow.value + EXAMPLE.packDrop;
assert.ok(tiltDeg(onPack.end.quat) < 1 && Math.abs(onPack.end.pos[2] - sit) < 2e-4, `the pack: sits on it, the CG ${(sit * 1e3).toFixed(1)} mm up (${(onPack.end.pos[2] * 1e3).toFixed(2)})`);
assert.ok(Math.min(...onPack.trace.map((r) => r.lowZ)) > -1e-6, 'the pack: no point under the floor');
assert.ok(onPack.restAt !== null && onPack.restAt < 2, 'the pack: at rest within 2 s');

// Skid landing.
const pitchMax = (r) => Math.max(...r.trace.map((x) => tiltDeg(x.quat)));
const skidBare = await drop(bare, { vel: [3, 0, -1], ms: 1500 });
const skidPack = await drop(packed, { vel: [3, 0, -1], ms: 1500 });
const slide = (r) => r.end.pos[0] - r.trace[0].pos[0];
console.log(`skid landing 1 m/s down, 3 m/s forward, motors off: no pack tips at most ${pitchMax(skidBare).toFixed(1)} deg, slides ${slide(skidBare).toFixed(3)} m; the example pack tips at most ${pitchMax(skidPack).toFixed(1)} deg, slides ${slide(skidPack).toFixed(3)} m, ends ${tiltDeg(skidPack.end.quat).toFixed(1)} deg tilted`);
assert.ok(Math.abs(slide(skidPack) - slide(skidBare)) < 0.02 * slide(skidBare), 'a skid slides as far on the pack as on the ducts (Coulomb)');
assert.ok(pitchMax(skidPack) < 1 && pitchMax(skidBare) < 1, 'neither tips on a skid: mu x the CG height is inside the base');

// The pulse on the pack's corners.
const peak = (r) => Math.max(...r.trace.slice(0, 60).map((x) => x.az)) / G;
const pulsed = await drop(packed, { vel: [0, 0, -2], ms: 300 });
const oneTick = await drop(withValues(packed, { contactPulse: 0 }), { vel: [0, 0, -2], ms: 300 });
console.log(`level 2 m/s drop onto the pack: peak specific force ${peak(pulsed).toFixed(1)} g with the impact pulse (contactPulse ${packed.values.contactPulse.value * 1e3} ms), ${peak(oneTick).toFixed(1)} g in one tick`);
assert.ok(peak(pulsed) < 0.5 * peak(oneTick), 'a pack-first landing takes the impact pulse');

console.log('pack contact (example pack): ok');
