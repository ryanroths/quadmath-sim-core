// M4 plant and world through the JS API: the contact, trigger, pose and pack
// behaviours the M4 review found wrong, each pinned by a check, and the
// argument checking of configure(), teleport(), motorOverride(), clearanceAt()
// and plantBlock().
//
//   node tests/node/plant-world.test.mjs
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { SimCore, plantBlock, sticksToChannels as ch } from '../../src/js/sim-core.js';
import * as feel from '../lib/feel.mjs';

const root = new URL('../../', import.meta.url);
const module = await WebAssembly.compile(await readFile(new URL('dist/sim-core.wasm', root)));
const air65 = JSON.parse(await readFile(new URL('airframes/air65.json', root), 'utf8'));
const diff = await readFile(new URL('configs/65mm-air65-ryfly-1219s.diff', root), 'utf8');
const maxAbs = (v) => Math.max(...v.map(Math.abs));
const kinds = (events, kind) => events.filter((e) => e.kind === kind);
// The footprint (airframe; owner decision 2026-10-23): the CG stands REST
// above what it rests on, and the four duct-rim points sit REACH from the CG
// along x and along y (yaw 0). Contact checks look at the footprint.
const REST = air65.values.hullBelow.value;
const REACH = (air65.values.wheelbase.value / 2 + air65.values.ductOuterRadius.value) * Math.SQRT1_2;
const footMax = (core, a) => Math.max(...core.footprint.map((p) => p[a]));
const footMin = (core, a) => Math.min(...core.footprint.map((p) => p[a]));
const footInside = (core, boxes, tol = 1e-3) => core.footprint.some((p) => boxes.some((b) => [0, 1, 2].every((a) => p[a] > b.min[a] + tol && p[a] < b.max[a] - tol)));

async function flight(world, plant = air65) {
  const core = await SimCore.load(module, { trace: false });
  core.configure({ diff, plant, world });
  return core;
}
const HOVER_DUTY_NO_SAG = (await flight({ floorZ: -100 })).plantDerived.dutyHover;

// Fixed motor duties in the presses below are written as the duty they had
// when last checked, against a hover duty of 0.2949 there: the duty that holds
// the quad up on a full pack sagging at the hover current (loadFraction 0.81,
// cellIR 64.3 mOhm, 4.2 A at hover). D() keeps each press the same multiple of
// that hover duty as the plant's constants move (from 2026-10-23), so a press
// above hover stays as far above it, whatever the motor model and the sag.
const DUTY_CHECKED_AT = 0.2949;
const HOVER_DUTY = (() => {
  const v = air65.values;
  const full = v.ocv.value[6];
  return (HOVER_DUTY_NO_SAG * v.vRefCell.value) / (full - (v.iHover.value + v.iQuiescent.value) * v.cellIR.value);
})();
const D = (duty) => (duty * HOVER_DUTY) / DUTY_CHECKED_AT;

// Checks open for the owner: recorded where they fail, so every later section
// still runs, and failed together at the end unless the owner has put them
// under investigation (tests/x3-signoff.json, 'plant-world <check>').
const open = [];
const investigation = JSON.parse(await readFile(new URL('tests/x3-signoff.json', root), 'utf8')).underInvestigation ?? {};

// 1. Resting disarmed on a box top: no yaw spin-up (sim.html makes every tick
// there a duct hit with a yaw kick; the soft path and scrub now apply).
{
  const core = await flight({ floorZ: 0, boxes: [{ min: [1, -1, 0], max: [3, 1, 0.5] }] });
  core.teleport({ pos: [2, 0, 0.5 + REST] });
  core.events();
  core.step(10_000);
  const s = core.state;
  const ev = core.events();
  console.log(`box top, 10 s disarmed: omega ${s.omega.map((v) => v.toExponential(2)).join(' ')} rad/s, z ${s.pos[2].toFixed(4)} m, contact flags ${s.contactFlags}, acc ${core.fc.acc.map((v) => v.toFixed(3)).join(' ')} g, contact events ${kinds(ev, 'contact').length}`);
  assert.ok(maxAbs(s.omega) < 1e-3, 'no spin-up resting on a box top');
  assert.ok(Math.abs(s.pos[2] - (0.5 + REST)) < 1e-3 && Math.abs(footMin(core, 2) - 0.5) < 1e-3, 'stands on the box top');
  assert.equal(s.contactFlags, 2);
  assert.ok(Math.abs(core.fc.acc[2] - 1) < 0.01, 'Betaflight reads 1 g');
  assert.equal(kinds(ev, 'contact').length, 1, 'one contact event for the landing');
}

// 2. A fast shallow crash into the floor: a crash event, never the divergence
// fault (the contact spin kick is capped below the 200 rad/s guard). The rims
// start 0.02 m above the floor, as quadmath's CG point did above its 10 mm
// pad. Level, the four rims land together and the floor gives the quad little
// or no spin (19, 0 and 0 rad/s), so the cap (plant.c CONTACT_SPIN_CAP: a
// contact leaves |omega| at most 150 rad/s) is held by the same three crashes
// flared 0.4 rad back from the travel, the trailing rims first. Their lever
// arms alone spin the quad at 245, 447 and 505 rad/s on the first touch (a
// scratch wasm with the cap patched out), each past the guard on one axis; a
// capped tick on the floor ends at 150 rad/s less one tick of ground scrub,
// 148.9.
for (const vel of [[18, 0, -8], [30, 10, -15], [0, 25, -20]]) {
  for (const flare of [0, 0.4]) {
    // Flared: the body's up leans away from the horizontal travel (dx, dy),
    // about the axis (dy, -dx); the trailing rims hang
    // REST cos + REACH (|dx| + |dy|) sin below the CG.
    const h = Math.hypot(vel[0], vel[1]);
    const [dx, dy] = [vel[0] / h, vel[1] / h];
    const quat = [Math.cos(flare / 2), dy * Math.sin(flare / 2), -dx * Math.sin(flare / 2), 0];
    const hang = REST * Math.cos(flare) + REACH * (Math.abs(dx) + Math.abs(dy)) * Math.sin(flare);
    const core = await flight(undefined);
    core.teleport({ pos: [0, 0, 0.02 + hang], quat, vel });
    let peak = 0;
    let low = Infinity;
    for (let k = 0; k < 200; k++) {
      core.step(1);
      peak = Math.max(peak, Math.hypot(...core.state.omega));
      low = Math.min(low, footMin(core, 2));
    }
    const crashes = kinds(core.events(), 'contact').filter((e) => e.crashed);
    console.log(`crash at ${vel.join(' ')} m/s, flared ${flare} rad: peak |omega| ${peak.toFixed(3)} rad/s, crash events ${crashes.length} (on the floor ${crashes.filter((e) => e.box === -1).length}), lowest rim ${low.toExponential(1)} m, fault ${core.fault}`);
    assert.equal(core.fault, 0);
    assert.ok(peak <= 150, 'contact leaves body rates at or below the cap');
    assert.ok(crashes.length >= 1 && crashes.every((e) => e.box === -1), 'reported as a crash, on the floor');
    // On the floor at some tick's end and never through it.
    assert.ok(Math.abs(low) < 1e-6, 'the footprint reached the floor and stayed on it');
    if (flare) assert.ok(peak > 140, 'the flared crash reaches the cap');
  }
}

// 3. Triggers: arriving by pose is not an entry (portal pairs no longer
// ping-pong); flying in is, once.
{
  const portals = { floorZ: -100, triggers: [{ min: [9, -1, -1], max: [11, 1, 1], id: 1 }, { min: [19, -1, -1], max: [21, 1, 1], id: 2 }] };
  const core = await flight(portals);
  core.teleport({ pos: [8.9, 0, 0], vel: [5, 0, 0] });
  let warps = 0;
  const seen = [];
  for (let k = 0; k < 200; k++) {
    core.step(1);
    for (const e of kinds(core.events(), 'trigger')) {
      seen.push(e.id);
      // quadmath's portal: put the quad at the other portal's centre.
      core.teleport({ pos: e.id === 1 ? [20, 0, 0] : [10, 0, 0], vel: [0, 0, 0] });
      warps++;
    }
  }
  console.log(`portals: trigger events ${JSON.stringify(seen)} in 200 ms`);
  assert.deepEqual(seen, [1], 'flying into portal 1 fires once; arriving at portal 2 by pose does not');
  assert.equal(warps, 1);
  const s = core.state;
  assert.ok(Math.abs(s.pos[0] - 20) < 1e-3, 'stayed at portal 2');
}

// 4. The rest plant never moves: it refuses a pose and an override, and rests
// on whatever floor the world gives.
{
  const core = await SimCore.load(module, { trace: false });
  core.configure({ diff, world: { floorZ: 2 } });
  console.log(`rest plant on a floor at 2 m: z ${core.state.pos[2]}`);
  assert.ok(Math.abs(core.state.pos[2] - 2.01) < 1e-9, 'rests on the world floor');
  assert.throws(() => core.teleport({ pos: [5, 5, 5] }), /needs a plant/);
  assert.throws(() => core.motorOverride(-1, 1), /needs a plant/);
  assert.equal(core.flight.sc_pose(core.flight.sc_scratch_ptr(), core.flight.sc_scratch_ptr(), core.flight.sc_scratch_ptr()), -2, 'C refuses a pose too');
  assert.equal(core.flight.sc_motor_override(0, 1), -2, 'and an override');
}

// 5. configure() refused in JS leaves the previous plant, airframe and world.
{
  const core = await SimCore.load(module, { trace: false });
  core.configure({ diff });
  assert.throws(() => core.configure({ diff, plant: air65, world: { boxes: [{ min: [0, 0], max: [1, 1] }] } }), /needs 3 numbers/);
  assert.equal(core.plant, null, 'still the rest plant');
  assert.equal(core.airframe, null);
  assert.equal(core.compat.twr, null);
  core.configure({ diff, plant: air65 });
  const block = core.plant;
  assert.throws(() => core.configure({ diff, world: { triggers: [{ min: [0, 0, 0], max: [1, 1, 1], id: 'gate-A' }] } }), /not a 32-bit integer/);
  assert.equal(core.plant, block, 'the Air65 block stays');
  core.reinit();
  assert.ok(core.plantDerived.kvRad > 0, 'and still boots the physical plant');
}

// 6. Argument checking.
{
  const core = await flight({ floorZ: -100 });
  for (const [what, fn, re] of [
    ['teleport pos of 2', () => core.teleport({ pos: [0, 0] }), /needs 3 numbers/],
    ['teleport vel of 2', () => core.teleport({ pos: [0, 0, 0], vel: [0, 0] }), /needs 3 numbers/],
    ['teleport quat of 3', () => core.teleport({ pos: [0, 0, 0], quat: [1, 0, 0] }), /needs 4 numbers/],
    ['clearanceAt of 2', () => core.clearanceAt([0, 0]), /needs 3 numbers/],
    ['duty above 1', () => core.motorOverride(0, 1.0000001), /duty/],
    ["motor 'all'", () => core.motorOverride('all', 0.5), /motor/],
    ['motor 1.7', () => core.motorOverride(1.7, 0.5), /motor/],
    ['trigger id 3e9', () => core.configure({ diff, plant: air65, world: { triggers: [{ min: [0, 0, 0], max: [1, 1, 1], id: 3e9 }] } }), /32-bit/],
    ['box kind 0.5', () => core.configure({ diff, plant: air65, world: { boxes: [{ min: [0, 0, 0], max: [1, 1, 1], kind: 0.5 }] } }), /32-bit/],
  ]) {
    assert.throws(fn, re, what);
  }
  const shifted = structuredClone(air65);
  shifted.values.mass.value = [0.03, 0.065];
  shifted.values.wheelbase.value = [];
  assert.throws(() => plantBlock(shifted), /'mass'/, 'array values cannot shift into a neighbour');
  const short = structuredClone(air65);
  short.values.ocv.value = short.values.ocv.value.slice(0, 6);
  assert.throws(() => plantBlock(short), /needs 7 numbers/);
  console.log('argument checks: 11 refusals as expected');
}

// 7. compat.twr reads the block the plant flies, not the caller's object.
{
  const af = structuredClone(air65);
  const core = await flight({ floorZ: -100 }, af);
  core.teleport({ pos: [0, 0, 0] });
  core.motorOverride(-1, 0.5);
  core.step(200);
  const before = core.compat.twr;
  af.values.mass.value = 1;
  console.log(`compat.twr ${before.toFixed(4)} before and ${core.compat.twr.toFixed(4)} after editing the caller's airframe`);
  assert.equal(core.compat.twr, before);
}

// 8. lerpState() does not draw a streak across a teleport.
{
  const core = await flight({ floorZ: -100 });
  core.teleport({ pos: [0, 0, 1] });
  core.advance(5);
  core.teleport({ pos: [50, 0, 2] });
  const ran = core.advance(1.5);
  const lerp = core.lerpState();
  console.log(`teleport then advance(1.5 ms): ${ran} tick, alpha ${core.alpha.toFixed(2)}, lerp x ${lerp.pos[0].toFixed(3)}, state x ${core.state.pos[0].toFixed(3)}`);
  assert.equal(ran, 1);
  assert.ok(core.alpha > 0.4, 'mid-tick');
  assert.deepEqual(lerp.pos, core.state.pos, 'drawn at the new pose');
  core.advance(1);
  assert.notDeepEqual(core.lerpState().pos, core.state.pos, 'interpolation resumes on the next frame');
}

// 9. A flat pack (0 V) carries across a reinit: exactly the 2 % pack less
// what the quiescent current drew while Betaflight booted.
{
  const core = await flight(undefined);
  assert.doesNotThrow(() => core.reinit({ battery: { soc: 0.02, vbatFiltered: 0 } }));
  const cap = air65.values.capacityMah.value;
  assert.ok(core.state.mah > 0, 'the quiescent current drew while Betaflight booted');
  assert.ok(Math.abs(core.battery.soc - (0.02 - core.state.mah / cap)) <= 1e-12, `flat pack carried (soc ${core.battery.soc}, ${core.state.mah} mAh drawn)`);
}

// 10. At hover on a full pack the current model draws the logged hover
// current: iQuiescent plus iHover at rpmHover (owner decisions 2026-10-23),
// with the rotors at the plant's hover rpm.
{
  const sim = await feel.simCoreSim(SimCore, module, { diff, airframe: air65 });
  const h = feel.hoverTrim(sim);
  sim.fly(() => ({ t: h.throttle }), 3000);
  const s = sim.core.state;
  const d = sim.core.plantDerived;
  const iRef = air65.values.iHover.value + air65.values.iQuiescent.value;
  console.log(`hover stick ${h.quantum}: ${s.amps.toFixed(3)} A at ${s.vbatLoaded.toFixed(3)} V (bench ${iRef} A); rotors at ${Math.round(s.rpm.reduce((a, b) => a + b) / 4)} rpm (rpmHover ${air65.values.rpmHover.value}); no-sag hover duty ${d.dutyHover.toFixed(4)}, ${d.ampsFull.toFixed(1)} A at full throttle`);
  assert.equal(h.diverged, null);
  assert.ok(Math.abs(s.amps - iRef) / iRef < 0.03, 'hover current within 3% of the bench current');
}

// 11. A pose at resting height on a floor whose height does not round
// cleanly is still on the floor: no floorTouch.
for (const floorZ of [0.1, 0.07, -0.08, 2.03]) {
  const core = await flight({ floorZ });
  core.step(20);
  const rest = core.state.pos.slice();
  core.teleport({ pos: [0, 0, floorZ + 2] });
  core.step(5);
  core.events();
  core.teleport({ pos: rest });
  core.step(5);
  const touches = kinds(core.events(), 'floorTouch').length;
  assert.equal(touches, 0, `floor ${floorZ}: a pose onto the floor is not a touch`);
}
console.log('pose onto the floor at 0.1, 0.07, -0.08, 2.03 m: no floorTouch');

// 12. Booting inside a trigger is not an entry, on configure, reinit or edit.
{
  const core = await flight({ floorZ: 0, triggers: [{ min: [-1, -1, 0], max: [1, 1, 2], id: 42 }] });
  assert.deepEqual(kinds(core.events(), 'trigger'), [], 'configure');
  core.reinit();
  assert.deepEqual(kinds(core.events(), 'trigger'), [], 'reinit');
  core.edit(['set gyro_lpf1_static_hz = 250']);
  assert.deepEqual(kinds(core.events(), 'trigger'), [], 'edit');
  console.log('spawn inside a trigger: no trigger event on configure, reinit or edit');
}

// 13. Landing with the duct rims close to a box-top edge is a landing on the
// top, not a side hit that sinks through the box.
for (const [footX, vz, crash] of [[1.0005, -1, false], [1.002, -3, true], [2.9995, -1, false]]) {
  const core = await flight({ floorZ: 0, boxes: [{ min: [1, -1, 0], max: [3, 1, 0.75], id: 4 }] });
  // The near pair of duct rims at footX, 5 cm above the top.
  const x = footX < 2 ? footX + REACH : footX - REACH;
  core.teleport({ pos: [x, 0, 0.8 + REST], vel: [0, 0, vz] });
  core.events();
  core.step(1000);
  const s = core.state;
  const c = kinds(core.events(), 'contact');
  console.log(`landing with the duct rims at x ${footX} m, ${vz} m/s: z ${s.pos[2].toFixed(4)} after 1 s, first contact ${c[0].impactMs.toFixed(3)} m/s crashed ${c[0].crashed}`);
  assert.ok(footMin(core, 2) >= 0.749 && s.pos[2] >= 0.75 + REST - 1e-3, 'stands on the top face');
  const landing = Math.sqrt(vz * vz + 2 * 9.81 * 0.05);    // after the 5 cm drop
  assert.ok(Math.abs(c[0].impactMs - landing) < 0.05, `impact is the landing speed (${landing.toFixed(3)} m/s)`);
  assert.equal(c[0].crashed, crash);
}

// 14. The rest plant follows the floor back when the world is cleared.
{
  const core = await SimCore.load(module, { trace: false });
  core.configure({ diff, world: { floorZ: 2 } });
  core.flight.sc_world_clear();
  assert.ok(Math.abs(core.state.pos[2] - 0.01) < 1e-9, 'back on the default floor');
}

// 15. A plant the JS cannot clone, or C refuses, leaves the previous config.
{
  const core = await SimCore.load(module, { trace: false });
  core.configure({ diff });
  assert.throws(() => core.configure({ diff, plant: { ...structuredClone(air65), describe() {} } }));
  assert.equal(core.plant, null, 'still the rest plant after a clone failure');
  for (const [field, value] of [['iHover', 70], ['cellIR', 0.6], ['cellIR', 0.9], ['rpmHover', 0], ['currentExponent', 0], ['iQuiescent', -0.1], ['motorDelay', -0.001], ['motorDelay', 0.0645], ['motorDelay', 1e300], ['electricalTau', -0.001]]) {
    const bad = structuredClone(air65);
    bad.values[field].value = value;
    assert.throws(() => core.configure({ diff, plant: bad }), /plant block refused/, `${field} ${value}: the pack cannot hold the hover current, or the current model is out of range`);
    assert.equal(core.plant, null);
  }
  console.log('uncloneable plant, three hover currents the pack cannot hold and two current models out of range: refused, previous config kept');
}

// 16. A unit quaternion an ulp past 1 is accepted.
{
  const core = await flight({ floorZ: -100 });
  assert.doesNotThrow(() => core.teleport({ pos: [0, 0, 0], quat: [1.0000000000000002, 0, 0, 0] }));
  assert.throws(() => core.teleport({ pos: [0, 0, 0], quat: [1.01, 0, 0, 0] }), /quaternion/);
}

// 17. A portal flown at any frame time warps on the same tick. The trigger
// tick ends advance(); the host follows advance()'s frame loop (drain events,
// teleport, then advance(0) while alpha >= 1), and the pose lands on the next
// tick. One trace hash across frame times and first-frame phases, including
// frames where the trigger is the second-to-last tick.
{
  const portalRun = async (frameMs, firstMs = frameMs) => {
    const core = await SimCore.load(module);
    core.configure({ diff, plant: air65, world: { floorZ: -100, triggers: [{ min: [-1, -1, 0.3], max: [1, 1, 1], id: 1 }] } });
    core.teleport({ pos: [0, 0, 0] });
    core.motorOverride(-1, 0.6);
    const end = core.simTimeUs + 1_500_000;
    const tickMs = core.tickUs / 1000;
    let warps = 0;
    let warpTick = null;
    const handle = () => {
      for (const e of kinds(core.events(), 'trigger')) {
        const s = core.state;
        core.teleport({ pos: [5, 0, 0.6], quat: s.quat, vel: s.vel });
        warps++;
        warpTick = e.tUs;
      }
    };
    let frame = firstMs;
    const t0 = core.simTimeUs;
    let givenUs = 0;
    while (core.simTimeUs < end) {
      const left = (end - core.simTimeUs) / 1000 - core.alpha * tickMs;
      const dt = Math.min(frame, left + 1e-4);
      givenUs += dt * 1000;
      core.advance(dt);
      handle();
      while (core.alpha >= 1) {
        core.advance(0);
        handle();
      }
      // Frame time is never lost: what ran plus what waits is what was given.
      assert.ok(Math.abs(core.simTimeUs - t0 + core.alpha * core.tickUs - givenUs) < 1e-3, 'a trigger stop keeps the unrun ticks');
      frame = frameMs;
    }
    assert.equal(warps, 1);
    assert.equal(core.simTimeUs, end);
    return { hash: core.traceHash(), warpTick, z: core.state.pos[2] };
  };
  const hashes = new Map();
  const runs = [[1], [2], [3], [4], [1000 / 144], [1000 / 60], [1000 / 30], [1000 / 144, 1.5], [1000 / 60, 11.5], [1000 / 60, 3.2]];
  for (const [frameMs, firstMs] of runs) {
    const r = await portalRun(frameMs, firstMs);
    hashes.set(r.hash, (hashes.get(r.hash) || 0) + 1);
    console.log(`portal at ${frameMs.toFixed(2)} ms frames${firstMs ? `, first ${firstMs} ms` : ''}: warp at ${r.warpTick} us, end z ${r.z.toFixed(5)}, hash ${r.hash.slice(0, 16)}`);
  }
  assert.equal(hashes.size, 1, 'one trace across frame times and phases');

  // Directly: step(3) whose middle tick enters the trigger runs 2 ticks.
  const core = await SimCore.load(module, { trace: false });
  core.configure({ diff, plant: air65, world: { floorZ: -100, triggers: [{ min: [-1, -1, 0.3], max: [1, 1, 1], id: 1 }] } });
  core.teleport({ pos: [0, 0, 0] });
  core.motorOverride(-1, 0.6);
  while (!kinds(core.events(), 'trigger').length) core.step(1);
  const triggerUs = core.simTimeUs - core.tickUs;
  const probe = await SimCore.load(module, { trace: false });
  probe.configure({ diff, plant: air65, world: { floorZ: -100, triggers: [{ min: [-1, -1, 0.3], max: [1, 1, 1], id: 1 }] } });
  probe.teleport({ pos: [0, 0, 0] });
  probe.motorOverride(-1, 0.6);
  probe.step((triggerUs - probe.simTimeUs) / probe.tickUs - 1);
  assert.equal(probe.step(3), 2, 'stops after the trigger tick in the middle of step(3)');
  assert.equal(probe.simTimeUs, triggerUs + probe.tickUs);
  assert.equal(probe.step(1), 1, 'and the next step(1) runs');
}

// 18. Seams: sliding over two flush box tops is one surface, and a table
// against a taller box holds the quad on the table.
{
  const flushBoxes = [{ min: [1, -1, 0], max: [2, 1, 0.5], id: 10 }, { min: [2, -1, 0], max: [3, 1, 0.5], id: 11 }];
  const flush = await flight({ floorZ: 0, boxes: flushBoxes });
  flush.teleport({ pos: [1.97 - REACH, 0, 0.5005 + REST], vel: [5, 0, -0.5] });
  flush.events();
  flush.step(300);
  const fs1 = flush.state;
  const fev = kinds(flush.events(), 'contact');
  const one = await flight({ floorZ: 0, boxes: [{ min: [1, -1, 0], max: [3, 1, 0.5], id: 10 }] });
  one.teleport({ pos: [1.97 - REACH, 0, 0.5005 + REST], vel: [5, 0, -0.5] });
  one.step(300);
  console.log(`flush tops: x ${fs1.pos[0].toFixed(6)} z ${fs1.pos[2].toFixed(4)} after 300 ms (one box: x ${one.state.pos[0].toFixed(6)}), contacts ${JSON.stringify(fev.map((e) => [e.box, Number(e.impactMs.toFixed(3)), e.crashed]))}`);
  assert.ok(Math.abs(fs1.pos[0] - one.state.pos[0]) < 1e-6, 'slides across the seam as across one box');
  assert.ok(footMin(flush, 2) >= 0.499);
  assert.ok(fev.every((e) => !e.crashed && e.impactMs < 1), 'no hit at the seam');
  // At 6 m/s, the leading duct rims landing at every offset short of the
  // seam: never a crash on box 11.
  for (let footX = 1.9; footX < 1.996; footX += 0.005) {
    const c = await flight({ floorZ: 0, boxes: flushBoxes });
    c.teleport({ pos: [footX - REACH, 0, 0.5005 + REST], vel: [6, 0, -0.5] });
    c.events();
    c.step(200);
    assert.ok(kinds(c.events(), 'contact').every((e) => !e.crashed), `no crash at the seam with the rims from x ${footX}`);
  }

  const tableBoxes = [{ min: [1, -1, 0], max: [2, 1, 0.5], id: 1 }, { min: [2, -1, 0], max: [2.2, 1, 2], id: 2 }];
  const table = await flight({ floorZ: 0, boxes: tableBoxes });
  table.teleport({ pos: [1.985 - REACH, 0, 0.5005 + REST], vel: [2, 0, -0.3] });
  table.events();
  table.step(1000);
  const ts = table.state;
  const tev = table.events();
  console.log(`table against a wall: x ${ts.pos[0].toFixed(4)} z ${ts.pos[2].toFixed(4)} after 1 s, rims to x ${footMax(table, 0).toFixed(4)}, ${kinds(tev, 'contact').length} contact events`);
  assert.ok(footMin(table, 2) >= 0.499 && footMax(table, 0) <= 2.0001, 'stays on the table, at the wall');
  assert.ok(kinds(tev, 'contact').length < 10, 'no event flood');

  const backyard = JSON.parse(await readFile(new URL('tests/fixtures/maps/backyard.json', root), 'utf8'));
  const yardBoxes = backyard.boxes.map((b) => ({ min: b.um.slice(0, 3).map((v) => v * 1e-6), max: b.um.slice(3).map((v) => v * 1e-6) }));
  const yard = await flight({ floorZ: 0, boxes: yardBoxes });
  yard.teleport({ pos: [-2.3623 - REACH, 5.5, 0.0635 + REST], vel: [5, 0, -0.3] });
  yard.events();
  yard.step(1000);
  const ys = yard.state;
  const yev = yard.events();
  console.log(`backyard deck seam: x ${ys.pos[0].toFixed(4)} z ${ys.pos[2].toFixed(4)} after 1 s, ${kinds(yev, 'contact').length} contact events, dropped ${kinds(yev, 'dropped').length}`);
  assert.ok(footMin(yard, 2) > 0.05 && !footInside(yard, yardBoxes), 'does not sink through the deck');
  assert.ok(kinds(yev, 'contact').length < 10);
}

// 19. A fast skim along the floor into a box standing on it bounces off the
// side; a pose low inside such a box comes out, not under the floor.
// The leading duct rims start where the CG point did, 13.47 mm short of the
// side and 0.61 mm above the floor, so on one tick the floor stops them on the
// box's bottom plane and they reach the side: the floor must not hide the side.
{
  const skim = await flight({ floorZ: 0, boxes: [{ min: [2, -1, 0], max: [3, 1, 0.5], id: 5 }] });
  skim.teleport({ pos: [1.98653 - REACH, 0, 0.00061 + REST], vel: [12, 0, -0.5] });
  skim.events();
  let hit;
  for (let k = 0; k < 20 && !hit; k++) {
    skim.step(1);
    hit = kinds(skim.events(), 'contact').find((e) => e.box === 5);
  }
  const sk = skim.state;
  // Rims on the side's plane and on the floor plane: the hit was at the foot of the side.
  const atFoot = skim.footprint.filter((p) => Math.abs(p[0] - 2) < 1e-3 && Math.abs(p[2]) < 1e-6).length;
  console.log(`floor skim into a box: ${hit ? `hit at ${hit.impactMs.toFixed(2)} m/s` : 'no hit'}, contact flags ${sk.contactFlags}, rims to x ${footMax(skim, 0).toFixed(5)} z ${footMin(skim, 2).toFixed(5)} after it, ${atFoot} at the foot of the side, vx ${sk.vel[0].toFixed(3)}`);
  assert.ok(hit, 'the rims reach the side of box 5');
  assert.equal(sk.contactFlags, 3, 'on the tick the floor stops them');
  assert.ok(atFoot >= 2, 'at the foot of the side, on the floor plane');
  assert.ok(footMax(skim, 0) <= 2, 'pushed back out of the side');
  assert.ok(sk.vel[0] < 0, 'bounced');

  // The duct rims 50 mm up inside a box standing on the floor, all five
  // points inside: the bottom would be the nearest way out if the box had one.
  const low = await flight({ floorZ: 0, boxes: [{ min: [2, -0.5, 0], max: [3, 0.5, 0.4], id: 6 }] });
  low.teleport({ pos: [2.5, 0, 0.05 + REST] });
  low.events();
  low.step(1);
  const out = kinds(low.events(), 'contact').filter((e) => e.box === 6);
  const inside = (p) => p[0] > 2 && p[0] < 3 && Math.abs(p[1]) < 0.5 && p[2] < 0.4 - 1e-9;
  console.log(`pose low inside a grounded box: footprint out at z ${footMin(low, 2).toFixed(3)}..${footMax(low, 2).toFixed(3)}, CG ${low.state.pos.map((v) => v.toFixed(3)).join(' ')}, ${out.length} contact with it`);
  assert.equal(out.length, 1, 'the box pushed the pose out');
  assert.ok(!low.footprint.some(inside), 'not left inside the box');
  assert.ok(footMin(low, 2) >= -1e-9, 'not under the floor');
}

// 20. Clearing the world while airborne is not a floor leave.
{
  const core = await flight({ floorZ: 0 });
  core.teleport({ pos: [0, 0, 2] });
  core.step(5);
  core.events();
  core.flight.sc_world_clear();
  core.step(2);
  assert.deepEqual(core.events().map((e) => e.kind), [], 'no events from the clear');
}

// 21. Stacked boxes: the top of a box with another on it is not a surface.
// Sliding down a wall of two stacked blocks stays on its face, as on a
// one-piece wall, and the garage's crate stack does not swallow a fall past it.
{
  // Tilted 0.8 rad into the wall (+x), the two leading duct rims start where
  // the old CG point did: 1 mm from the face, 60 mm above the seam between
  // the blocks at z 0.5. The wall's friction on the pressed rims holds the
  // slide to some 20 mm/s, so it runs 7 s and the rims cross the seam at
  // about 2.8 s. The press is 1.100 x the hover duty (D(0.3245)): the wall's
  // friction holds the quad on the face from about 1.12 x up (a stick-slip
  // edge), so the press sits clear of it. At loadFraction 0.81 the old
  // D(0.35) slid past at 4.7 s.
  const tilt = 0.8;
  const lead = [REACH * Math.cos(tilt) - REST * Math.sin(tilt), -REACH * Math.sin(tilt) - REST * Math.cos(tilt)];
  const slide = async (boxes) => {
    const core = await flight({ floorZ: 0, boxes });
    core.teleport({ pos: [1.999 - lead[0], 0, 0.56 - lead[1]], vel: [0.5, 0, -0.3], quat: [Math.cos(tilt / 2), 0, Math.sin(tilt / 2), 0] });
    core.motorOverride(-1, D(0.3245));
    const path = [];
    let maxX = -Infinity;
    let inside = 0;
    let slid = Infinity;
    for (let k = 0; k < 7000; k++) {
      core.step(1);
      const fp = core.footprint;
      path.push(fp);
      maxX = Math.max(maxX, footMax(core, 0));
      if (footInside(core, boxes)) inside++;
      // The lowest a leading rim (motors 1 and 3) got while on the face.
      for (const p of [fp[1], fp[3]]) if (Math.abs(p[0] - 2) < 1e-6) slid = Math.min(slid, p[2]);
    }
    return { path, maxX, inside, slid };
  };
  const stacked = await slide([{ min: [2, -1, 0], max: [2.2, 1, 0.5] }, { min: [2, -1, 0.5], max: [2.2, 1, 1] }]);
  const whole = await slide([{ min: [2, -1, 0], max: [2.2, 1, 1] }]);
  const apart = Math.max(...stacked.path.map((fp, k) => Math.max(...fp.map((p, i) => maxAbs(p.map((v, a) => v - whole.path[k][i][a]))))));
  console.log(`slide down a wall: stacked blocks, rims to x ${stacked.maxX.toFixed(7)} and down the face to z ${stacked.slid.toFixed(4)} (one-piece: ${whole.slid.toFixed(4)}), footprints ${apart} m apart over 7 s`);
  assert.ok(stacked.maxX <= 2.001 && stacked.inside === 0, 'stays on the face of the stacked wall');
  assert.ok(apart < 1e-9, 'as on a one-piece wall');
  assert.ok(stacked.slid < 0.49, 'and it did slide: the leading rims on the face (to 1 um) 10 mm past the seam');

  // The garage's crate bin: the old CG point fell at 5.5 m/s past the top of
  // its side crates and hit the inner face of the front stack (box 73, x
  // 3.321429) 4 mm under the seam between its bottom two crates (z 0.12),
  // from 1.5 mm above the seam the tick before: the tick that must find the
  // face, not the top of 73 under crate 77. At that attitude the footprint
  // is 73 mm across and would land on the side crates from the old pose, so
  // the fall is moved 100 mm to -y (the front stack spans the bin): the
  // leading rim (motor 0, lowest x) starts where the old CG did and meets
  // the same face on the same tick, from the same height.
  const garage = JSON.parse(await readFile(new URL('tests/fixtures/maps/garage.json', root), 'utf8'));
  const gboxes = garage.boxes.map((b, i) => ({ min: b.um.slice(0, 3).map((v) => v * 1e-6), max: b.um.slice(3).map((v) => v * 1e-6), id: i }));
  const depthInside = (p, boxes) => Math.max(0, ...boxes.map((b) => Math.min(...[0, 1, 2].map((a) => Math.min(p[a] - b.min[a], b.max[a] - p[a])))));
  const gq = [0.97603, -0.07663, -0.2037, 0];
  const [w, x, y, z] = gq.map((v) => v / Math.hypot(...gq));
  const r0 = [-REACH, -REACH, -REST];
  const t = [2 * (y * r0[2] - z * r0[1]), 2 * (z * r0[0] - x * r0[2]), 2 * (x * r0[1] - y * r0[0])];
  const lead0 = [r0[0] + w * t[0] + (y * t[2] - z * t[1]), r0[1] + w * t[1] + (z * t[0] - x * t[2]), r0[2] + w * t[2] + (x * t[1] - y * t[0])];
  const g = await flight({ floorZ: 0, boxes: gboxes });
  g.teleport({ pos: [3.43485 - lead0[0], 0.07222 - lead0[1], 0.51497 - lead0[2]], vel: [-1.667, -2.063, -5.546], quat: gq });
  g.events();
  let gd = 0;
  let hit = null;
  let prev = null;
  for (let k = 0; k < 1000; k++) {
    g.step(1);
    const fp = g.footprint;
    gd = Math.max(gd, ...fp.map((p) => depthInside(p, gboxes)));
    // The first touch of box 73: which point is on its front face, and where it was the tick before.
    if (!hit && kinds(g.events(), 'contact').some((e) => e.box === 73)) {
      const i = fp.findIndex((p) => Math.abs(p[0] - 3.321429) < 1e-4);
      hit = i < 0 ? { at: null } : { at: fp[i], from: prev[i] };
    }
    prev = fp;
  }
  console.log(`garage crate stack: front face met at ${hit?.at ? `${hit.at.map((v) => v.toFixed(5)).join(' ')} from z ${hit.from[2].toFixed(5)}` : 'nowhere'}, at ${g.state.pos.map((v) => v.toFixed(4)).join(' ')} after 1 s, footprint at most ${(gd * 1000).toFixed(3)} mm inside a box`);
  assert.ok(gd < 1e-3, 'not left inside the crates');
  assert.ok(hit?.at && hit.at[2] > 0.11 && hit.at[2] < 0.12 && hit.from[2] > 0.12, 'and a rim did meet the front stack just under the seam, from above it');
}

// 22. A box standing exactly on the floor plane is solid at floor level.
// The floor is on the box's bottom plane. Pitched 0.5 rad toward the box,
// the quad stands on its two front duct rims on that plane, 5 mm short of the
// side where the CG point stood; thrust drives them into the side at floor
// level for 3 s.
{
  const core = await flight({ floorZ: 0, boxes: [{ min: [2, -1, 0], max: [2.3, 1, 0.5], id: 5 }] });
  const a = 0.5;
  // The front rims (body +x, at -REST) pitched a about y: ahead of and below the CG.
  const ahead = REACH * Math.cos(a) - REST * Math.sin(a);
  const below = REACH * Math.sin(a) + REST * Math.cos(a);
  core.teleport({ pos: [1.995 - ahead, 0, below], quat: [Math.cos(a / 2), 0, Math.sin(a / 2), 0], vel: [0.5, 0, 0] });
  core.events();
  core.motorOverride(-1, D(0.33));
  const c = [];
  let deepest = -Infinity;    // farthest x of any point below the top
  let hitAtFoot = false;      // a rim at the foot of the side when the hit came
  let pressed = 0;            // ticks a rim lay on the floor plane against the side, touching both
  for (let t = 0; t < 3000; t++) {
    core.step(1);
    const hits = kinds(core.events(), 'contact').filter((e) => e.box === 5);
    const fp = core.footprint;
    if (hits.length && !c.length) hitAtFoot = fp.some((p) => Math.abs(p[0] - 2) < 1e-3 && Math.abs(p[2]) < 1e-3);
    if (core.state.contactFlags === 3 && fp.some((p) => Math.abs(p[0] - 2) < 1e-3 && Math.abs(p[2]) < 1e-6)) pressed++;
    c.push(...hits);
    deepest = Math.max(deepest, ...fp.filter((p) => p[2] < 0.499).map((p) => p[0]));
  }
  console.log(`box on the floor plane: rims to x ${footMax(core, 0).toFixed(4)} z ${footMin(core, 2).toFixed(4)} after 3 s, deepest below the top x ${deepest.toFixed(4)}, ${c.length} contacts with it, first at the foot of the side ${hitAtFoot}, ${pressed} ticks on the floor plane against the side`);
  assert.ok(c.length >= 1, 'the hit is reported');
  assert.ok(hitAtFoot, 'by a rim at the foot of the side');
  assert.ok(pressed >= 1000, 'held on the floor plane against the side for at least 1 s');
  assert.ok(deepest <= 2.001, 'kept out of the box');
}

// 23. Setting the floor again while resting on a box is not a new contact.
// The CG REST above the top puts the duct rims on it (the CG on the top would
// put them 10 mm inside, a pose-out on the first tick).
{
  const core = await flight({ floorZ: 0, boxes: [{ min: [1, -1, 0], max: [3, 1, 0.5], id: 9 }] });
  const poseZ = 0.5 + REST;
  core.teleport({ pos: [2, 0, poseZ] });
  core.step(1);
  const rise = core.state.pos[2] - poseZ;
  const touch = kinds(core.events(), 'contact');
  core.step(499);
  core.events();
  const rims = () => core.footprint.slice(0, 4);
  const onTop = () => rims().every((p) => Math.abs(p[2] - 0.5) < 1e-3 && p[0] > 1 && p[0] < 3 && Math.abs(p[1]) < 1) && core.state.contactFlags === 2;
  const restedBefore = onTop();
  for (let k = 0; k < 3; k++) {
    core.flight.sc_world_floor(0);
    core.step(100);
  }
  const ev = kinds(core.events(), 'contact');
  console.log(`floor set while resting on a box: first tick ${JSON.stringify(touch.map((e) => [e.box, Number(e.impactMs.toFixed(4))]))}, CG rise ${(rise * 1000).toFixed(3)} mm, rims at z ${footMin(core, 2).toFixed(4)}..${Math.max(...rims().map((p) => p[2])).toFixed(4)} on the top before ${restedBefore} and after ${onTop()}, ${ev.length} contacts from 3 floor calls`);
  assert.ok(touch.length === 1 && touch[0].box === 9, 'the rims touch box 9 on the first tick');
  assert.ok(Math.abs(rise) < 1e-6, 'and start on its top, not inside it');
  assert.ok(restedBefore, 'resting on the top before the floor calls');
  assert.deepEqual(ev, [], 'no contact from a floor call');
  assert.ok(onTop(), 'and still resting on it');
}

// 24. Flown from the spawn in Betaflight angle mode (host altitude hold),
// pitch only and roll only, into the walls of every quadmath map: the quad
// ends in front of a wall, never inside one or outside the map. The spawn
// sits on the module axes, where seven of the maps split their walls.
{
  const mapBoxes = async (id) => JSON.parse(await readFile(new URL(`tests/fixtures/maps/${id}.json`, root), 'utf8')).boxes
    .map((b) => ({ min: b.um.slice(0, 3).map((v) => v * 1e-6), max: b.um.slice(3).map((v) => v * 1e-6) }));
  const inside = (p, boxes) => boxes.some((b) => [0, 1, 2].every((a) => p[a] > b.min[a] + 1e-3 && p[a] < b.max[a] - 1e-3));
  const hold = { garage: 1.0, gym: 4.0, living: 1.6, office: 1.0, room: 1.0, trainer: 1.0, warehouse: 1.5 };
  let flights = 0;
  for (const [id, zHold] of Object.entries(hold)) {
    const boxes = await mapBoxes(id);
    const lo = [0, 1].map((a) => Math.min(...boxes.map((b) => b.min[a])));
    const hi = [0, 1].map((a) => Math.max(...boxes.map((b) => b.max[a])));
    for (const sticks of [{ pitch: 0.3 }, { roll: 0.3 }, { roll: -0.3 }]) {
      const c = await flight({ floorZ: 0, boxes });
      const chs = (s) => ch(s, [2000, 2000]);
      c.input(chs({ throttle: 0 }));
      c.step(100);
      const perSecond = new Array(15).fill(0);
      for (let ms = 0; ms < 14000; ms++) {
        if (ms % 4 === 0) {
          const s = c.state;
          const thr = Math.max(0, Math.min(1, 0.38 + 0.25 * (zHold - s.pos[2]) - 0.15 * s.vel[2]));
          c.input(chs(ms < 2000 ? { throttle: thr } : { throttle: thr + 0.05, ...sticks }));
        }
        c.step(1);
        for (const e of kinds(c.events(), 'contact')) perSecond[Math.floor(ms / 1000)]++;
      }
      const p = c.state.pos;
      const escaped = p[0] < lo[0] || p[0] > hi[0] || p[1] < lo[1] || p[1] > hi[1];
      assert.ok(!escaped && !inside(p, boxes), `${id} ${JSON.stringify(sticks)}: ended at ${p.map((v) => v.toFixed(4)).join(' ')}`);
      assert.ok(Math.max(...perSecond) <= 10, `${id} ${JSON.stringify(sticks)}: ${Math.max(...perSecond)} contacts in one second against the wall`);
      flights++;
    }
  }
  console.log(`spawn flights into the walls: ${flights} flights in 7 maps, each ended in front of a wall, at most 10 contacts a second`);
}

// 25. Pressed into a wall while resting on a table flush against it, the quad
// stays on the table; it slides into an object standing on a shelf and stops
// at its face; clipping a box's top edge on the way up adds no climb.
{
  for (const order of [0, 1]) {
    const pair = [{ min: [1, -1, 0], max: [2, 1, 0.5], id: 1 }, { min: [2, -1, 0], max: [2.2, 1, 2], id: 2 }];
    const core = await flight({ floorZ: 0, boxes: order ? pair.reverse() : pair });
    core.teleport({ pos: [1.99 - 1.1 * REACH, 0, 0.5 + 1.5 * REST], quat: [Math.cos(0.26), 0, Math.sin(0.26), 0] });
    core.motorOverride(-1, D(0.3));
    core.step(3000);
    const s = core.state;
    console.log(`pressed into the wall from the table (box order ${order ? 'wall first' : 'table first'}): x ${s.pos[0].toFixed(4)} z ${s.pos[2].toFixed(4)}, rims to x ${footMax(core, 0).toFixed(4)}, lowest point z ${footMin(core, 2).toFixed(4)} after 3 s`);
    assert.ok(footMin(core, 2) >= 0.499 && footMax(core, 0) <= 2.0001 && !footInside(core, pair), 'stays on the table, at the wall');
  }

  const living = JSON.parse(await readFile(new URL('tests/fixtures/maps/living.json', root), 'utf8')).boxes
    .map((b) => ({ min: b.um.slice(0, 3).map((v) => v * 1e-6), max: b.um.slice(3).map((v) => v * 1e-6) }));
  const tv = await flight({ floorZ: 0, boxes: living });
  tv.teleport({ pos: [3.17 - 1.1 * REACH, 0.2, 0.405714 + 1.5 * REST], quat: [Math.cos(0.26), 0, Math.sin(0.26), 0] });
  tv.motorOverride(-1, D(0.3));
  tv.step(6000);
  console.log(`slid along the TV stand into the TV: x ${tv.state.pos[0].toFixed(4)} z ${tv.state.pos[2].toFixed(4)}, rims to x ${footMax(tv, 0).toFixed(4)} after 6 s`);
  assert.ok(!footInside(tv, living), 'stopped at the TV, not under it or in it');
  assert.ok(footMax(tv, 0) <= 3.1867 || footMin(tv, 2) > 0.5, 'stopped at the TV');

  const clip = await flight({ floorZ: 0, boxes: [{ min: [2, -1, 0], max: [3, 1, 0.5], id: 3 }] });
  clip.teleport({ pos: [1.999 - REACH, 0, 0.4965 + REST], vel: [3, 0, 3] });
  clip.events();
  clip.step(1);
  const cs = clip.state;
  const ce = kinds(clip.events(), 'contact');
  console.log(`top edge clipped climbing at 3 m/s: vz ${cs.vel[2].toFixed(3)}, contact ${JSON.stringify(ce.map((e) => [Number(e.impactMs.toFixed(3)), e.crashed]))}`);
  // The rims cross x = 2 at z 0.4975, below the edge, at 3 m/s: a side hit
  // (a crash by quadmath's threshold), never an upward kick off the top.
  assert.ok(cs.vel[2] <= 3.001, 'no extra climb from the clip');
}

// 26. Corners and edges where boxes overlap or meet: a room corner, a wall
// under a ceiling slab or a deck, a crate stack's inner line, a T-join of a
// table against a split wall, a pose inside two overlapping boxes, and the
// office fixture's 1 um rounding gap above the door. Never pushed through a
// wall, never left inside, never up onto a slab from below. Each flight puts
// its leading footprint point where quadmath's CG point started, starts with
// no point inside a box (no pose-out on the first tick) unless the pose inside
// is the case, checks the footprint on every tick, and checks that it reached
// the corner, edge, line, seam or gap it is named for.
{
  const mapBoxes = async (id) => JSON.parse(await readFile(new URL(`tests/fixtures/maps/${id}.json`, root), 'utf8')).boxes
    .map((b) => ({ min: b.um.slice(0, 3).map((v) => v * 1e-6), max: b.um.slice(3).map((v) => v * 1e-6) }));
  const tilt = (az, ang) => [Math.cos(ang / 2), Math.sin(ang / 2) * -Math.sin(az), Math.sin(ang / 2) * Math.cos(az), 0];
  // The footprint in the body frame (motor order, then the canopy top), as
  // core.footprint builds it. A pose takes effect at the next tick, so where
  // it puts the footprint is worked out here.
  const body = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([x, y]) => [x * REACH, y * REACH, -REST])
    .concat([[0, 0, air65.values.hullAbove.value]]);
  const rot = (q, v) => {
    const [w, x, y, z] = q;
    const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
    return [v[0] + w * t[0] + y * t[2] - z * t[1], v[1] + w * t[1] + z * t[0] - x * t[2], v[2] + w * t[2] + x * t[1] - y * t[0]];
  };
  // The CG that puts footprint point k at p, at attitude q.
  const placing = (k, p, q) => rot(q, body[k]).map((r, a) => p[a] - r);
  // The points a pose puts strictly inside a box (a point on a face, to the
  // 1 um pose quantum, is not inside).
  const posedInside = (pos, q, b) => body.map((r) => rot(q, r).map((v, a) => v + pos[a]))
    .filter((p) => [0, 1, 2].every((a) => p[a] > b.min[a] + 1e-6 && p[a] < b.max[a] - 1e-6));
  const startsInside = (pos, q, boxes) => boxes.some((b) => posedInside(pos, q, b).length > 0);
  const contactIds = (core) => kinds(core.events(), 'contact').map((e) => e.box);

  // Garage corner: wall box 0 (face x = 5.942857) meets wall box 6 (face
  // y = 2.942857). The leading rim (motor 3, +x +y) starts where the CG
  // point did, 43 mm from each wall, leaning 0.3 rad into the corner. Open
  // loop, a wall pushing on a rim below the CG tips the quad further in, so
  // it is pressed in for about 0.2 s, then tumbles out of the corner and
  // across the floor; all 3 s are checked.
  const garage = await mapBoxes('garage');
  const gq = [Math.cos(0.15), -0.707 * Math.sin(0.15), 0.707 * Math.sin(0.15), 0];
  const gPos = placing(3, [5.9, 2.9, 1.0], gq);
  assert.ok(!startsInside(gPos, gq, garage), 'garage corner pose starts outside every box');
  const gc = await flight({ floorZ: 0, boxes: garage });
  gc.teleport({ pos: gPos, quat: gq });
  gc.events();
  gc.motorOverride(-1, D(0.3));
  let gx = -Infinity;
  let gy = -Infinity;
  let gPressed = 0;
  let gIn = 0;
  const gIds = new Set();
  for (let k = 0; k < 3000; k++) {
    gc.step(1);
    const x = footMax(gc, 0);
    const y = footMax(gc, 1);
    gx = Math.max(gx, x);
    gy = Math.max(gy, y);
    if (Math.abs(x - 5.942857) < 3e-3 && Math.abs(y - 2.942857) < 3e-3) gPressed++;
    if (footInside(gc, garage)) gIn++;
    for (const id of contactIds(gc)) gIds.add(id);
  }
  console.log(`garage corner, 3 s leaning in: footprint to x ${gx.toFixed(5)} y ${gy.toFixed(5)}, ${gPressed} ms within 3 mm of both walls, contacts on boxes ${[...gIds].join(' ')}, ${gIn} ticks inside a box, end ${gc.state.pos.map((v) => v.toFixed(4)).join(' ')}`);
  assert.ok(gx > 5.94 && gy > 2.94 && gPressed >= 100 && gIds.has(0) && gIds.has(6), 'pressed into the garage corner');
  assert.ok(gx < 5.943 && gy < 2.943 && gIn === 0, 'held in the corner, inside the room');

  // Room corner: wall box 4 (face x = -2.398429, down to y = -1.828857) meets
  // wall box 10 (face y = -1.788857). The leading rim (motor 0, -x -y) starts
  // where the CG point did, 9 mm off wall 10 and 48 mm off wall 4, drifting
  // into the corner and leaning 0.3 rad every 30 degrees round. Behind a wall
  // is HEAD's clause on the footprint: a point at or past wall 4's face and
  // one past wall 4's end. In the corner: points on both faces at once.
  const room = await mapBoxes('room');
  const corner = [room[4], room[10]];
  let out = 0;
  let reached = 0;
  let cornerMs = 0;
  for (const duty of [D(0.28), D(0.34)]) {
    for (let az = 0; az < 360; az += 30) {
      const q = tilt(az * Math.PI / 180, 0.3);
      const pos = placing(0, [-2.35, -1.78, 0.4], q);
      assert.ok(!startsInside(pos, q, corner), `room corner pose at ${az} degrees starts outside the walls`);
      const c = await flight({ floorZ: 0, boxes: corner });
      c.teleport({ pos, quat: q, vel: [-0.35, -0.35, 0] });
      c.motorOverride(-1, duty);
      let bad = false;
      let both = 0;
      for (let k = 0; k < 1500; k++) {
        c.step(1);
        const x = footMin(c, 0);
        const y = footMin(c, 1);
        if ((x < -2.39843 + 1e-4 && y < -1.828857 - 1e-4) || footInside(c, corner)) bad = true;
        if (Math.abs(x + 2.398429) < 1e-4 && Math.abs(y + 1.788857) < 1e-4) both++;
      }
      if (bad) out++;
      if (both) reached++;
      cornerMs += both;
    }
  }
  console.log(`room corner (boxes 4 and 10), 24 presses: ${reached} pressed into the corner, ${cornerMs} ms in all, ${out} went behind or inside a wall`);
  assert.ok(reached >= 4 && cornerMs >= 1000, 'the presses reach the room corner');
  assert.equal(out, 0);

  // A wall meeting a ceiling slab above or a deck: the +x duct rims start
  // where the CG point did, 50 mm from the wall, and the canopy top 50 mm
  // under the slab, leaning 0.2 rad into the wall; pressed up into the edge,
  // then eased off.
  for (const [name, boxes, slab] of [
    ['ceiling slab on a wall', [{ min: [2, -1, 0], max: [2.1, 1, 3] }, { min: [-1, -1, 2.965714], max: [2.05, 1, 3.034286] }], 1],
    ['deck against a wall', [{ min: [1, -1, 0.9], max: [2, 1, 0.94] }, { min: [2, -1, 0], max: [2.08, 1, 2.4] }], 0],
  ]) {
    const slabBottom = boxes[slab].min[2];
    const q = [Math.cos(0.1), 0, Math.sin(0.1), 0];
    const pos = [placing(1, [1.95, 0, 0], q)[0], 0, placing(4, [0, 0, slabBottom - 0.05], q)[2]];
    assert.ok(!startsInside(pos, q, boxes), `${name}: starts outside both boxes`);
    const c = await flight({ floorZ: 0, boxes });
    c.teleport({ pos, quat: q });
    c.events();
    let maxX = -Infinity;
    let maxZ = -Infinity;
    let inEdge = 0;
    let inside = 0;
    const ids = new Set();
    for (let k = 0; k < 7000; k++) {
      c.motorOverride(-1, k < 3000 ? D(0.45) : D(0.45 - 0.12 * ((k - 3000) / 4000)));
      c.step(1);
      const x = footMax(c, 0);
      const z = footMax(c, 2);
      maxX = Math.max(maxX, x);
      maxZ = Math.max(maxZ, z);
      if (k < 3000 && Math.abs(x - 2) < 1e-4 && Math.abs(z - slabBottom) < 1e-4) inEdge++;
      if (footInside(c, boxes)) inside++;
      for (const id of contactIds(c)) ids.add(id);
    }
    console.log(`${name}: pressed up into the edge 3 s (${inEdge} ms on the wall and the slab at once), then eased off 4 s: footprint max x ${maxX.toFixed(5)}, max z ${maxZ.toFixed(5)} (slab bottom ${slabBottom}), contacts on boxes ${[...ids].join(' ')}, ${inside} ticks inside, end ${c.state.pos.map((v) => v.toFixed(4)).join(' ')}`);
    assert.ok(inEdge >= 1000 && ids.has(0) && ids.has(1), 'pressed into the edge');
    assert.ok(maxX <= 2.0001 && inside === 0, 'never through the wall');
    assert.ok(maxZ <= slabBottom + 1e-4, 'never up onto the slab');
  }

  // The garage crate stack (boxes 73-88): hollow crates in layers, their +y
  // side built of boxes meeting on the layer seam (the top of box 80, z =
  // 0.24) and the line x = 3.65. The leading rim (motor 1, +x -y) starts
  // where the CG point did, 22.5 mm off that side at 6 m/s into it, and hits
  // it 2.4 mm under the seam, on box 80, as the CG point did.
  const crate = garage[80];
  const cq = [0.99427, 0.0982, -0.04214, 0];
  const cPos = placing(1, [3.60055, 0.28684, 0.23521], cq);
  assert.ok(!startsInside(cPos, cq, garage), 'crate pose starts outside every box');
  const cl = await flight({ floorZ: 0, boxes: garage });
  cl.teleport({ pos: cPos, vel: [2.552, -5.415, 0.503], quat: cq });
  cl.events();
  cl.motorOverride(-1, D(0.4));
  let cHit = null;
  let cIn = 0;
  for (let k = 0; k < 2000; k++) {
    cl.step(1);
    if (footInside(cl, garage)) cIn++;
    const ids = contactIds(cl);
    if (!cHit && ids.length) cHit = { k, ids, side: cl.footprint.filter((p) => Math.abs(p[1] - crate.max[1]) < 1e-4) };
  }
  console.log(`garage crate line: first contact in tick ${cHit && cHit.k + 1} on boxes ${cHit && cHit.ids.join(' ')}, points on the crate side ${cHit && cHit.side.map((p) => `x ${p[0].toFixed(4)} z ${p[2].toFixed(4)}`).join(', ')} (seam z ${crate.max[2].toFixed(4)}); ${cIn} ticks inside a box in 2 s, end ${cl.state.pos.map((v) => v.toFixed(4)).join(' ')}`);
  assert.ok(cHit && cHit.k < 10 && cHit.ids.every((id) => id >= 73 && id <= 88)
    && cHit.side.some((p) => p[0] > crate.min[0] && p[0] < crate.max[0] && Math.abs(p[2] - crate.max[2]) < 5e-3), 'hit the crate side at the layer seam');
  assert.equal(cIn, 0, 'not held inside the crate stack');

  // T-join: a table (box 1) against a wall split at y = 0 (boxes 2 and 3).
  // The leading rim (motor 1, +x -y) rests where the CG point did: on the
  // table top 10 mm from the wall, on the seam, leaning 0.52 rad into it.
  const tjBoxes = [{ min: [1, -1, 0], max: [2, 1, 0.5], id: 1 }, { min: [2, -1, 0], max: [2.2, 0, 2], id: 2 }, { min: [2, 0, 0], max: [2.2, 1, 2], id: 3 }];
  const tq = [Math.cos(0.26), 0, Math.sin(0.26), 0];
  const tPos = placing(1, [1.99, 0, 0.5], tq);
  assert.ok(!startsInside(tPos, tq, tjBoxes), 'T-join pose starts outside the boxes');
  const tj = await flight({ floorZ: 0, boxes: tjBoxes });
  tj.teleport({ pos: tPos, quat: tq });
  tj.events();
  tj.motorOverride(-1, D(0.3));
  let tLow = Infinity;
  let tFar = -Infinity;
  let tIn = 0;
  let tJoin = 0;
  let tc = 0;
  const tIds = new Set();
  for (let k = 0; k < 3000; k++) {
    tj.step(1);
    tLow = Math.min(tLow, footMin(tj, 2));
    tFar = Math.max(tFar, footMax(tj, 0));
    if (footInside(tj, tjBoxes)) tIn++;
    if (tj.footprint.some((p) => p[0] > 2 - 1e-4 && Math.abs(p[1]) < 1e-3 && Math.abs(p[2] - 0.5) < 1e-4)) tJoin++;
    const ids = contactIds(tj);
    tc += ids.length;
    for (const id of ids) tIds.add(id);
  }
  console.log(`T-join (table against a split wall), pressed 3 s: x ${tj.state.pos[0].toFixed(4)} z ${tj.state.pos[2].toFixed(4)}, footprint lowest z ${tLow.toFixed(5)}, to x ${tFar.toFixed(5)}, ${tJoin} ms with a rim in the join, ${tc} contacts on boxes ${[...tIds].join(' ')}, ${tIn} ticks inside`);
  assert.ok(tJoin >= 1000 && (tIds.has(2) || tIds.has(3)), 'pressed into the T-join');
  assert.ok(tLow >= 0.499 && tFar <= 2.0001 && tIn === 0 && tc < 10, 'stays on the table, at the wall, in few contacts');

  // A pose inside two overlapping boxes (backyard boxes 3 and 4 overlap by
  // 63 mm in x): the footprint starts inside both, which is the case here.
  // The pose's hit pushes it out on the first tick and it stays out.
  const yard = await mapBoxes('backyard');
  const yPos = [-7.475, -0.7649, 1.549];
  const yIn = [3, 4].map((i) => posedInside(yPos, [1, 0, 0, 0], yard[i]).length);
  const py = await flight({ floorZ: 0, boxes: yard });
  py.teleport({ pos: yPos });
  py.events();
  py.step(1);
  const yIds = contactIds(py);
  let yLeft = footInside(py, yard) ? 1 : 0;
  for (let k = 1; k < 300; k++) {
    py.step(1);
    if (footInside(py, yard)) yLeft++;
  }
  console.log(`pose inside backyard boxes 3 and 4 (${yIn.join(' and ')} footprint points in them): first-tick contact on boxes ${yIds.join(' ')}, ${yLeft} ticks of 300 inside, end ${py.state.pos.map((v) => v.toFixed(4)).join(' ')}`);
  assert.ok(yIn[0] > 0 && yIn[1] > 0 && yIds.some((id) => id === 3 || id === 4), 'the pose starts inside both boxes');
  assert.equal(yLeft, 0, 'a pose inside two overlapping boxes comes out');

  // The office door lintel: wall box 3 starts at y = -3.371428 and the lintel
  // above the door (box 5) ends 1 um short of it, both with their face at
  // x = -6.52. The leading rim (motor 0, -x -y) starts where the CG point did,
  // 20 mm off the face, dy off the gap, at 2, 5 and 8 m/s into the wall, at
  // the CG point's pitch. Level in yaw, both -x rims meet the wall together,
  // and the one 72 mm along, on box 3, holds the quad whether or not the gap
  // does (a world with the gap opened to 20 um passed), so the quad is yawed
  // -0.1 rad and the rim on the gap meets the wall alone, 7 mm ahead of the
  // next point. Through: past x = -6.75 as before, into a box, or into the
  // gap (the wall above the door taken as one solid).
  const office = await mapBoxes('office');
  const seam = office[3].min[1];
  const face = office[3].max[0];
  assert.ok(Math.abs(seam - office[5].max[1] - 1e-6) < 1e-9 && office[5].max[0] === face
    && office[5].min[2] < 2.2 && office[5].max[2] > 2.2, 'the lintel ends 1 um short of the wall, flush with its face, at the height flown');
  const above = { min: office[5].min, max: [face, office[3].max[1], office[5].max[2]] };
  const lq = [Math.cos(0.05) * Math.cos(0.075), Math.sin(0.05) * Math.sin(0.075), -Math.cos(0.05) * Math.sin(0.075), -Math.sin(0.05) * Math.cos(0.075)];
  let through = 0;
  let onGap = 0;
  let lead = Infinity;
  for (const dy of [1e-6, -1e-6, 3e-4, 1e-3, -1e-3, 2e-3, -2e-3]) {
    for (const v of [2, 5, 8]) {
      const pos = placing(0, [-6.5, seam + dy, 2.2], lq);
      assert.ok(!startsInside(pos, lq, office), 'lintel pose starts outside every box');
      const c = await flight({ floorZ: 0, boxes: office });
      c.teleport({ pos, vel: [-v, 0, 0], quat: lq });
      c.events();
      c.motorOverride(-1, D(0.34));
      let bad = false;
      let hit = null;
      for (let k = 0; k < 2000; k++) {
        c.step(1);
        if (footMin(c, 0) < -6.75 || footInside(c, office) || footInside(c, [above])) bad = true;
        const ids = contactIds(c);
        if (!hit && ids.length) hit = { ids, fp: c.footprint };
      }
      if (bad) through++;
      // The first contact is the leading rim's alone, on the wall face, on
      // the gap (to the 1 um pose quantum), on box 3 on one side of it and
      // box 5 on the other.
      if (!hit) continue;
      const [rim, ...rest] = hit.fp;
      lead = Math.min(lead, ...rest.map((p) => p[0] - face));
      if (Math.abs(rim[0] - face) < 1e-4 && Math.abs(rim[1] - seam - dy) < 1e-6 && rest.every((p) => p[0] > face + 1e-4)
        && hit.ids.every((id) => (Math.abs(dy) < 1e-5 ? id === 3 || id === 5 : id === (dy > 0 ? 3 : 5)))) onGap++;
    }
  }
  console.log(`office door lintel, 21 hits along the 1 um gap: ${onGap} first touched the wall with the leading rim alone on the gap (the next point ${(lead * 1e3).toFixed(1)} mm or more behind), ${through} went through, into the wall or into the gap`);
  assert.equal(onGap, 21, 'every hit lands on the gap');
  assert.equal(through, 0);
}

// 27. Nanometres from a wall: a quad sliding down a wall face, its leading
// duct rim a few nm inside the face where a table meets the wall, still
// lands on the table's top; pressed up the face into a deck, it meets the
// deck's bottom. Near-level tilts into the wall, a level press and a drop
// all hold.
//   The old CG point sat on the face x = 2 exactly, and the leading rim does
// now, to the picometre: the pose keeps the CG in whole micrometres, so the
// quad is yawed just past 45 deg (one rim leading, REACH * sqrt 2 ahead of
// the CG) until that rim is a whole number of micrometres ahead, on the
// quaternion as the pose rounds it. A rim rubbing along the face takes the
// wall's friction at its lever arm, which tips the quad off the face within
// 5 to 25 ms (from the old 300 and 50 mm the rim met the table or deck up
// to 36 mm from the wall), so the presses start 2 mm from the table or deck,
// at least as fast as the old 300 mm fall, 50 mm climb and level press got
// there in free flight (2.34, 1.18 to 1.52 and 0.59 m/s): 2.4 m/s down onto
// the table, 1.6 m/s up into the deck, 0.6 m/s for the level press. Onto the
// table they also come at 0.2 m/s, so the rim has been pressed nm into the
// wall when it lands. The drop keeps its 50 mm at 2 m/s. From below it is
// the canopy, 28 mm above the rims and 50 mm from the wall, that meets the
// deck: at these attitudes no footprint point reaches the deck/wall seam
// from below.
{
  const deck = [{ min: [1, -1, 0.9], max: [2, 1, 0.94], id: 1 }, { min: [2, -1, 0], max: [2.08, 1, 2.4], id: 2 }];
  const table = [{ min: [1, -1, 0], max: [2, 1, 0.5], id: 1 }, { min: [2, -1, 0], max: [2.2, 1, 2], id: 2 }];
  const CANOPY = air65.values.hullAbove.value;
  // Pitched tilt into +x after a yaw: the leading rim (motor 1) and the
  // canopy from the CG, on the quaternion the plant gets (1e-9 steps, normalised).
  const pose = (tilt, yaw) => {
    const [cp, sp, cy, sy] = [Math.cos(tilt / 2), Math.sin(tilt / 2), Math.cos(yaw / 2), Math.sin(yaw / 2)];
    const quat = [cp * cy, sp * sy, sp * cy, cp * sy];
    const r = quat.map((v) => Math.round(v * 1e9) * 1e-9);
    const n = Math.sqrt(r.reduce((s, v) => s + v * v, 0));
    const [w, x, y, z] = r.map((v) => v / n);
    const rot = (v) => {
      const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
      return [v[0] + w * t[0] + (y * t[2] - z * t[1]), v[1] + w * t[1] + (z * t[0] - x * t[2]), v[2] + w * t[2] + (x * t[1] - y * t[0])];
    };
    return { quat, rim: rot([REACH, -REACH, -REST]), canopy: rot([0, 0, CANOPY]) };
  };
  const onFace = (tilt) => {
    const ahead = Math.floor(pose(tilt, Math.PI / 4).rim[0] * 1e6 + 1e-9) * 1e-6;
    let lo = Math.PI / 4;
    let hi = pose(tilt, lo).rim[0] <= ahead ? lo : lo + 0.05;
    while (hi > lo && hi - lo > 1e-15) {
      const m = (lo + hi) / 2;
      if (pose(tilt, m).rim[0] > ahead) lo = m;
      else hi = m;
    }
    return { ...pose(tilt, hi), cgX: 2 - ahead };
  };
  // Flies one approach and checks the footprint every tick: on the table no
  // point more than 1 mm below its top, under the deck none above its
  // bottom, none past the wall face or inside a box. Returns where the
  // leading rim was when the quad first met the table or deck (box 1).
  const fly = async (boxes, tilt, duty, at, vel, ms) => {
    const fromTable = boxes === table;
    const { quat, rim, canopy, cgX } = onFace(tilt);
    const c = await flight({ floorZ: 0, boxes });
    const rimStart = Math.round(cgX * 1e6) * 1e-6 + rim[0];
    assert.ok(rimStart <= 2 && rimStart > 2 - 1e-12, `leading rim starts on the face (x - 2 = ${rimStart - 2})`);
    c.teleport({ pos: [cgX, 0, fromTable ? at - rim[2] : at - canopy[2]], quat, vel });
    c.events();
    if (duty) c.motorOverride(-1, duty);
    let met = null;
    let bad = 0;
    for (let k = 0; k < ms; k++) {
      c.step(1);
      const fp = c.footprint;
      if (!met && kinds(c.events(), 'contact').some((e) => e.box === 1)) {
        met = { x: fp[1][0] - 2, gap: fromTable ? fp[1][2] - 0.5 : 0.9 - fp[4][2] };
      }
      if (fromTable ? footMin(c, 2) < 0.499 : footMax(c, 2) > 0.9 + 1e-4) bad++;
      else if (footMax(c, 0) > 2.0001 || footInside(c, boxes)) bad++;
    }
    return { bad, met };
  };
  const runs = [];
  for (const tilt of [1e-5, 1e-4, 1e-3]) {
    for (const duty of [0, D(0.15), D(0.25)]) for (const vz of [-0.2, -2.4]) runs.push(await fly(table, tilt, duty, 0.502, [0, 0, vz], 2000));
    for (const duty of [D(0.5), D(0.62)]) runs.push(await fly(deck, tilt, duty, 0.898, [0, 0, 1.6], 3000));
  }
  runs.push(await fly(deck, 0, 0.45, 0.898, [1e-6, 0, 0.6], 1000));
  runs.push(await fly(table, 0, 0, 0.55, [1e-6, 0, -2], 1000));
  const bad = runs.reduce((n, r) => n + r.bad, 0);
  const met = runs.filter((r) => r.met).map((r) => r.met);
  const worstX = Math.max(...met.map((m) => Math.abs(m.x)));
  const worstGap = Math.max(...met.map((m) => Math.abs(m.gap)));
  console.log(`deck and table against a wall, ${runs.length} near-level presses and drops along the wall face: ${bad} ticks through, in or past; ${met.length} met the table or deck, the leading rim then within ${(worstX * 1e9).toFixed(1)} nm of the wall face and ${(worstGap * 1e6).toFixed(3)} um of the table top or deck bottom`);
  assert.equal(bad, 0);
  // Non-vacuity: every run met the table or deck with the leading rim on the
  // wall face (within the 29 nm world.c counts as lying on it), on the table
  // at its top (the seam), under the deck with the canopy at its bottom.
  assert.ok(met.length === runs.length && worstX < 3e-8 && worstGap < 1e-6, 'met at the wall face');
}

// 28. A split wall answers a hit as the same wall in one piece does: aimed
// hits on and near the seam, head-on and oblique, give the same events,
// crash flags and velocities; halves that overlap by 1 um hold too.
{
  const one = [{ min: [2, -1, 0], max: [2.2, 1, 2], id: 1 }];
  const split = [{ min: [2, -1, 0], max: [2.2, 0, 2], id: 1 }, { min: [2, 0, 0], max: [2.2, 1, 2], id: 1 }];
  const faceX = split[0].min[0];
  const seamY = split[0].max[1];
  // Each aim is where the CG point was, taken by a +x duct rim three ways.
  // Level at yaw 0: rim 1 (y -REACH from the CG) or rim 3 (y +REACH), so its
  // partner meets the wall 72 mm along, on one half; the CG is quantised to
  // 1 um, so this rim is within 0.4 um of the aim. Yawed 45 deg: rim 1 alone
  // leads, L = wheelbase/2 + duct radius ahead of the CG and level with it in
  // y, both whole micrometres, so it is on the aim itself (on the seam plane
  // for the first). Every footprint point starts clear of the wall.
  const L = REACH * Math.SQRT2;
  const yaw45 = [Math.cos(Math.PI / 8), 0, 0, Math.sin(Math.PI / 8)];
  const level = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([x, y]) => [x * REACH, y * REACH]);
  const yawed = [[0, -L], [L, 0], [-L, 0], [0, L]];
  const start = (pos, rims) => rims.map(([x, y]) => [pos[0] + x, pos[1] + y, pos[2] - REST]);
  const clear = (pts, boxes) => pts.every((p) => boxes.every((b) => [0, 1, 2].some((a) => p[a] < b.min[a] || p[a] > b.max[a])));
  const hit = async (boxes, rim, vel, m) => {
    const c = await flight({ floorZ: 0, boxes });
    const turned = m === 'yawed';
    const pos = turned ? [rim[0] - L, rim[1], rim[2] + REST] : [rim[0] - REACH, rim[1] - (m === 1 ? -1 : 1) * REACH, rim[2] + REST];
    const k0 = turned ? 1 : m;
    let prev = start(pos, turned ? yawed : level);
    assert.ok(clear(prev, boxes), 'the pose starts clear of the wall');
    c.teleport({ pos, quat: turned ? yaw45 : [1, 0, 0, 0], vel });
    c.events();
    const ev = [];
    let seam = Infinity;
    for (let k = 0; k < 30; k++) {
      c.step(1);
      const got = kinds(c.events(), 'contact');
      ev.push(...got);
      // The aimed rim's path over the tick it met the wall face: how far from
      // the y = 0 seam (zero if it crossed it in that tick).
      const p = c.footprint;
      if (got.some((e) => e.box === 1) && p[k0][0] >= faceX - 1e-4) {
        const [y0, y1] = [prev[k0][1] - seamY, p[k0][1] - seamY];
        seam = Math.min(seam, y0 * y1 <= 0 ? 0 : Math.min(Math.abs(y0), Math.abs(y1)));
      }
      prev = p;
    }
    return { ev: ev.map((e) => [e.box, Number(e.impactMs.toFixed(6)), e.crashed]), vel: c.state.vel, pos: c.state.pos, seam };
  };
  let differ = 0;
  let worst = 0;
  let onSeam = Infinity;
  for (const [rim, vel] of [
    [[1.99, 0, 1], [3, 0, 0]], [[1.99, 0.00005, 1], [3, 0, 0]], [[1.99, -0.00005, 1], [3, 0, 0]],
    [[1.9995, -0.0002, 1], [3, 0.3, 0]], [[1.999, -0.0045, 1], [5, 5, 0]], [[1.999, -0.005, 1], [2, 6, 0]],
    [[1.999, 0.004, 1], [4, -3, 0]],
  ]) {
    for (const m of [1, 3, 'yawed']) {
      const a = await hit(one, rim, vel, m);
      const b = await hit(split, rim, vel, m);
      // Not vacuous: the aimed rim met the wall (box 1) on or beside the seam.
      assert.ok(a.ev.length > 0 && b.ev.length > 0 && b.seam <= 1.5e-3, `rim ${m} aimed at ${JSON.stringify(rim)} met the wall ${b.seam} m from the seam`);
      worst = Math.max(worst, b.seam);
      if (m === 'yawed' && rim[1] === 0) onSeam = b.seam;
      const same = JSON.stringify(a.ev) === JSON.stringify(b.ev) && a.vel.every((v, k) => Math.abs(v - b.vel[k]) < 1e-9)
        && a.pos.every((v, k) => Math.abs(v - b.pos[k]) < 1e-9);
      if (!same) {
        differ++;
        console.log(`  split wall differs, rim ${m} at ${JSON.stringify([rim, vel])}: one ${JSON.stringify(a.ev)} vs split ${JSON.stringify(b.ev)}, vel ${a.vel.map((v) => v.toFixed(6))} vs ${b.vel.map((v) => v.toFixed(6))}`);
      }
    }
  }
  console.log(`split wall vs one piece, 21 aimed rim hits on and near the seam (each met the wall within ${(worst * 1e3).toFixed(3)} mm of it, the yawed head-on rim ${onSeam.toExponential(1)} m off the seam plane): ${differ} differ`);
  assert.equal(differ, 0);
  // On the seam plane: within 1 nm, where world.c sees the point lying on
  // both halves' inner faces.
  assert.ok(onSeam <= 1e-9, 'the yawed head-on rim met the wall on the seam plane');

  // Halves overlapping by 1 um: rim 3 at 5 m/s, 10 um from the seam beside
  // the overlap (rim 1 meets the y < 0 half 72 mm along), then near hover for
  // 2 s. No footprint point past the face at any tick, and a crash reported.
  const lap = [{ min: [2, -1, 0], max: [2.2, 0.000001, 2], id: 1 }, { min: [2, 0, 0], max: [2.2, 1, 2], id: 2 }];
  const overlap = await flight({ floorZ: 0, boxes: lap });
  const lapPos = [1.99 - REACH, 0.00001 - REACH, 1 + REST];
  assert.ok(clear(start(lapPos, level), lap), 'the pose starts clear of the wall');
  overlap.teleport({ pos: lapPos, vel: [5, 0, 0] });
  overlap.events();
  overlap.motorOverride(-1, D(0.32));
  let maxX = -Infinity;
  let atSeam = Infinity;
  const le = [];
  for (let k = 0; k < 2000; k++) {
    overlap.step(1);
    const got = kinds(overlap.events(), 'contact');
    le.push(...got);
    const r = overlap.footprint[3];
    if (got.some((e) => e.box === 1 || e.box === 2) && r[0] >= lap[1].min[0] - 1e-4) atSeam = Math.min(atSeam, Math.abs(r[1] - lap[1].min[1]));
    maxX = Math.max(maxX, footMax(overlap, 0));
  }
  const crash = le.some((e) => (e.box === 1 || e.box === 2) && e.crashed);
  console.log(`halves overlapping by 1 um, rim 3 at 5 m/s ${(atSeam * 1e6).toFixed(1)} um from the seam: footprint max x ${maxX.toFixed(6)} over 2 s, crash reported ${crash}`);
  assert.ok(atSeam <= 2e-5, 'rim 3 met the wall beside the overlap');
  assert.ok(maxX <= 2.00001 && crash);
}

// 29. Where a split wall meets a ceiling, sliding up the wall into the ceiling
// beside the seam is the same as with the wall in one piece; a hit on a
// column behind a catwalk is on the column; a concave corner with a split
// post holds no invisible ledge; and poses deep in the solid, on a seam
// plane, come out.
{
  const mapBoxes = async (id) => JSON.parse(await readFile(new URL(`tests/fixtures/maps/${id}.json`, root), 'utf8')).boxes
    .map((b, i) => ({ min: b.um.slice(0, 3).map((v) => v * 1e-6), max: b.um.slice(3).map((v) => v * 1e-6), id: i }));
  const room = await mapBoxes('room');
  const merged = [{ min: [0, 1, 2].map((a) => Math.min(room[0].min[a], room[1].min[a], room[2].min[a])), max: [0, 1, 2].map((a) => Math.max(room[0].max[a], room[1].max[a], room[2].max[a])), id: 0 }, ...room.slice(3)];
  // Yawed 45 deg and pitched 90 deg nose up, the quad stands on its tail with
  // its belly to the +x wall (room boxes 0..2, split at y = 0): the four duct
  // rims lie in one plane REST ahead of the CG, rim 1 on top, L = wheelbase/2
  // + duct radius above the CG and level with it in y, rims 0 and 3 L to
  // either side, rim 2 L below; the canopy is hullAbove behind. REST and L
  // are whole micrometres, so rim 1 is exactly where the CG point was: on the
  // wall face, 0.5 mm under the ceiling (box 12), beside the seam, rising into
  // the edge, while the other rims slide up the face. Contacts are compared
  // by surface (a wall piece or the ceiling), impact and crash flag.
  const L = REACH * Math.SQRT2;
  const c22 = Math.cos(Math.PI / 8);
  const s22 = Math.sin(Math.PI / 8);
  const up = [c22 * Math.SQRT1_2, -s22 * Math.SQRT1_2, -c22 * Math.SQRT1_2, s22 * Math.SQRT1_2];
  const wallX = room[0].min[0];
  const seamY = room[1].max[1];
  const ceilZ = room[12].min[2];
  const surface = (e) => (e.box >= 0 && e.box <= 2 ? 'wall' : e.box);
  const past = (pts, boxes) => pts.some((p) => boxes.some((b) => [0, 1, 2].every((a) => p[a] > b.min[a] + 1e-9 && p[a] < b.max[a] - 1e-9)));
  let differ = 0;
  let worst = 0;
  let hitMin = Infinity;
  for (const [rimY, vel] of [[0.00002, [0, 0, 3]], [0.00009, [0, 0, 3]], [-0.002, [0, 4, 3]]]) {
    const pos = [wallX - REST, seamY + rimY, ceilZ - 5e-4 - L];
    // No footprint point starts inside a box: the rims on the wall face, rim 1
    // under the ceiling.
    const startPts = [[REST, -L, 0], [REST, 0, L], [REST, 0, -L], [REST, L, 0], [-air65.values.hullAbove.value, 0, 0]].map((r) => r.map((v, k) => pos[k] + v));
    assert.ok(!past(startPts, room) && !past(startPts, merged), 'the pose starts with no footprint point inside a box');
    const run = async (boxes) => {
      const c = await flight({ floorZ: 0, boxes });
      c.teleport({ pos, quat: up, vel });
      c.events();
      // The first tick: rim 1 still on the face of a wall piece (within 1 nm)
      // and pushed down to the ceiling, and how far from the seam it was over
      // the tick (zero if it crossed it).
      c.step(1);
      const r = c.footprint[1];
      const onWall = boxes.some((w) => w.id <= 2 && Math.abs(r[0] - w.min[0]) <= 1e-9 && [1, 2].every((k) => r[k] >= w.min[k] && r[k] <= w.max[k]));
      const inEdge = onWall && Math.abs(r[2] - ceilZ) <= 1e-6;
      const [y0, y1] = [pos[1] - seamY, r[1] - seamY];
      const edge = y0 * y1 <= 0 ? 0 : Math.min(Math.abs(y0), Math.abs(y1));
      const first = kinds(c.events(), 'contact');
      const ev = [...first];
      for (let k = 1; k < 20; k++) {
        c.step(1);
        ev.push(...kinds(c.events(), 'contact'));
      }
      return { ev: ev.map((e) => [surface(e), Number(e.impactMs.toFixed(6)), e.crashed]), first: first.map((e) => [surface(e), e.impactMs]), vel: c.state.vel, pos: c.state.pos, inEdge, edge };
    };
    const a = await run(room);
    const b = await run(merged);
    // Not vacuous: with the wall split, rim 1 met the ceiling on the first
    // tick in the edge, within 0.1 mm of the seam, and the ceiling (at the
    // rise speed) and a wall piece both reported a touch on that tick.
    const ceiling = a.first.find((e) => e[0] === 12);
    assert.ok(a.inEdge && a.edge <= 1e-4 && ceiling && ceiling[1] > 2.9 && a.first.some((e) => e[0] === 'wall'), `rim 1 at y ${rimY} in the wall-ceiling edge ${a.edge} m from the seam: ${JSON.stringify(a.first)}`);
    worst = Math.max(worst, a.edge);
    hitMin = Math.min(hitMin, ceiling[1]);
    if (JSON.stringify(a.ev) !== JSON.stringify(b.ev) || a.vel.some((v, k) => Math.abs(v - b.vel[k]) > 1e-9) || a.pos.some((v, k) => Math.abs(v - b.pos[k]) > 1e-9)) {
      differ++;
      console.log(`  up the wall into the ceiling beside the seam differs at ${JSON.stringify([rimY, vel])}: split ${JSON.stringify(a.ev)} vs one piece ${JSON.stringify(b.ev)}, vel ${a.vel.map((v) => v.toFixed(6))} vs ${b.vel.map((v) => v.toFixed(6))}`);
    }
  }
  console.log(`up a split wall into the ceiling beside its seam, 3 aimed (rim 1 on the wall face hit the ceiling at ${hitMin.toFixed(3)} m/s or more, within ${(worst * 1e3).toFixed(3)} mm of the seam): ${differ} differ from the wall in one piece`);
  assert.equal(differ, 0);

  const warehouse = await mapBoxes('warehouse');
  const wh = await flight({ floorZ: 0, boxes: warehouse });
  wh.teleport({ pos: [4.458, -6.8956 - REACH, 1.21146 + REST], vel: [0.003, 11, 0.0024] });
  wh.events();
  wh.step(2);
  const whe = kinds(wh.events(), 'contact');
  console.log(`warehouse column behind the catwalk at 11 m/s: ${JSON.stringify(whe.map((e) => [e.box, Number(e.impactMs.toFixed(3)), e.crashed]))}`);
  assert.ok(whe.some((e) => e.box === 40 && e.crashed && e.impactMs > 10.9), 'the crash is on the column, at the hit speed');

  // The concave corner with a split post: the post fills the corner behind
  // both walls, so its faces toward the room are inner faces, and is split at
  // 1.5 m. A rim pressed into the corner edge as it climbs past the split
  // lies on the post's two inner faces once the walls push it back, and only
  // world.c's concave-edge test (PROGRESS.md round 8) keeps the upper piece's
  // bottom face, an inner face too, from pushing it back down onto the split:
  // the invisible ledge. Aimed hits, with the quad level and square to the
  // walls so that the corner rim (rim 3, +x +y) leads into both walls at once,
  // the motors at the hover duty (spun up away from the walls first): rim 3
  // starts 0.18 to 0.23 mm short of both walls and 2.1 to 2.8 mm below the
  // split, and reaches the corner edge in the tick that takes it from 0.15 to
  // 0.40 mm below the split to 0.23 to 0.40 mm past it, farther than it goes
  // into the corner (20 to 25 um). edge: that tick ends with rim 3 on the
  // post's edge. Each hit runs 50 ms, against the post in one piece; the
  // control, the post above the split 1 mm proud of the walls, is a real
  // ledge and must be caught. held: the upper piece reported a contact with
  // rim 3 in the corner below the split (the footprint's hull, #38, rises
  // from rim 3 toward the canopy and meets the 1 mm overhang before rim 3
  // reaches the split).
  const walls = [{ min: [-1, 1, 0], max: [2, 1.1, 3] }, { min: [2, -1, 0], max: [2.1, 1, 3] }];
  const lower = { min: [2, 1, 0], max: [2.1, 1.1, 1.5] };
  const posts = {
    split: [lower, { min: [2, 1, 1.5], max: [2.1, 1.1, 3] }],
    whole: [{ min: [2, 1, 0], max: [2.1, 1.1, 3] }],
    ledge: [lower, { min: [1.999, 0.999, 1.5], max: [2.1, 1.1, 3] }],
  };
  const corner = async (post, [gap, below, vz]) => {
    const boxes = [...walls, ...post];
    const c = await flight({ floorZ: 0, boxes });
    c.teleport({ pos: [0, 0, 1] });
    c.motorOverride(-1, c.plantDerived.dutyHover);
    c.step(300);
    c.teleport({ pos: [2 - gap - REACH, 1 - gap - REACH, 1.5 - below + REST], vel: [0.05, 0.05, vz] });
    let edge = null;
    let held = false;
    for (let k = 0; k < 50; k++) {
      const z0 = c.footprint[3][2];
      c.step(1);
      const p = c.footprint[3];
      if (edge === null && z0 < 1.5 && p[2] >= 1.5 - 1e-9) edge = Math.abs(p[0] - post[0].min[0]) < 1e-9 && Math.abs(p[1] - post[0].min[1]) < 1e-9;
      if (kinds(c.events(), 'contact').some((e) => e.box === 3) && p[0] > 1.999 && p[1] > 0.999 && p[2] < 1.5) held = true;
    }
    return { z: c.footprint[3][2], edge, held, inside: footInside(c, boxes) };
  };
  const noLedge = (r, one) => r.z > 1.5005 && Math.abs(r.z - one.z) < 5e-3;
  for (const [k, hit] of [[225e-6, 2.25e-3, 0.5], [225e-6, 2.14e-3, 0.5], [180e-6, 2.79e-3, 0.8]].entries()) {
    const split = await corner(posts.split, hit);
    const whole = await corner(posts.whole, hit);
    const ledge = k ? null : await corner(posts.ledge, hit);
    console.log(`concave corner, rim 3 into the edge climbing past a post split at 1.5 m ${JSON.stringify(hit)}: on the edge crossing the split ${split.edge}, rim 3 z after 50 ms ${split.z.toFixed(6)} (post in one piece ${whole.z.toFixed(6)}${ledge ? `; post 1 mm proud above the split ${ledge.z.toFixed(6)}` : ''}), a rim inside a wall ${split.inside || whole.inside}`);
    assert.ok(split.edge && whole.edge, 'rim 3 crosses the split on the corner edge');
    // A ledge holds the rim at the split; the climb past it may differ by the
    // touches along the post's seam.
    assert.ok(noLedge(split, whole), 'no ledge at the split');
    assert.ok(!split.inside && !whole.inside, 'no rim inside the walls');
    if (ledge) assert.ok((ledge.edge || ledge.held) && !noLedge(ledge, whole), 'the check sees a real ledge at the split');
  }

  // Deep in the solid: every point within 1 mm (27 samples) is inside some
  // box. A per-box inset misses a point on a seam; a point on a surface, or
  // in the open at a concave corner, is not deep.
  const deep = (p, boxes) => {
    for (let k = 0; k < 27; k++) {
      const q = [p[0] + ((k % 3) - 1) * 1e-3, p[1] + ((Math.floor(k / 3) % 3) - 1) * 1e-3, p[2] + (Math.floor(k / 9) - 1) * 1e-3];
      if (!boxes.some((b) => [0, 1, 2].every((a) => q[a] >= b.min[a] && q[a] <= b.max[a]))) return false;
    }
    return true;
  };
  const garage = await mapBoxes('garage');
  let stuck = 0;
  for (const [boxes, pos] of [[room, [0.0002, 1.788979, 2.43827]], [room, [2.42, 0, 1.0]], [room, [2.42, 0.00003, 1.0]], [room, [2.4, 0, 1.0]], [garage, [3.65, -0.203788, 0.2]], [garage, [6.0, 0, 1.0]], [garage, [3.321429, -0.2, 0.24]], [garage, [3.321429, -0.2, 0.12]], [garage, [3.321491, -0.167793, 0.119945]]]) {
    const c = await flight({ floorZ: 0, boxes });
    c.teleport({ pos });
    c.step(300);
    if (c.footprint.some((p) => deep(p, boxes))) {
      stuck++;
      console.log(`  pose at ${pos.join(' ')} still inside at ${c.state.pos.map((v) => v.toFixed(4)).join(' ')}`);
    }
  }
  console.log(`poses deep in the solid, on or near seam planes, 9: ${stuck} with a footprint point still deep inside after 300 ms`);
  assert.equal(stuck, 0);
}


// 30. Rotor reaction torque (owner decision 2026-10-23): spinning one rotor up
// from rest in free air turns the frame by J dw/dt on the first tick, the
// same way the prop's drag torque turns it once the rotor is running.
{
  const core = await flight({ floorZ: -100 });
  core.teleport({ pos: [0, 0, 0] });
  core.step(1);
  const d = core.plantDerived;
  core.motorOverride(0, 1);
  core.step(1);
  const w1 = (core.state.rpm[0] * 2 * Math.PI) / 60;
  const yaw1 = core.state.omega[2];
  const expected = (d.jRotor * w1) / d.izz;
  core.step(200);
  const yaw200 = core.state.omega[2];
  console.log(`reaction torque: rotor 0 at ${w1.toFixed(1)} rad/s after one tick turns the frame ${yaw1.toExponential(3)} rad/s in yaw (J dw / Izz ${expected.toExponential(3)}); after 200 ms ${yaw200.toFixed(3)} rad/s`);
  assert.ok(Math.abs(Math.abs(yaw1) - expected) < 0.05 * expected, 'the first tick is the rotor reaction');
  assert.ok(Math.sign(yaw1) === Math.sign(yaw200), 'the same way as the drag torque');
}

// 31. A crash on a second rim: rolled -0.25 rad, rims 2 and 3 (+y) land hard
// but under crash speed, and rims 0 and 1 slam down 5 ms later above it
// (2.65 m/s at the Air65's crashScale, world.c CRASH_SPEED_WU / WS). Inside
// the 50 ms gap that makes a second touch of the floor the same contact, so
// world.c touchFace upgrades it: one more CONTACT event, crashed. Motors 2
// and 3 at 0.6 lift the +y side, so the landing impulse and the thrust both
// swing rims 0 and 1 down. The control, motors off and a slower descent: rims
// 0 and 1 land hard (over the 1.29 m/s hard landing) but under crash speed,
// inside the gap, and no second event comes, so the crash above is the
// upgrade's and not a new contact.
{
  const CRASH_MS = (9 / 3.5) * air65.values.crashScale.value;   // world.c CRASH_SPEED_WU 9 / WS 3.5
  const HARD_MS = 4.5 / 3.5;                                    // world.c HARD_LANDING_WU 4.5 / WS 3.5
  const roll = -0.25;
  const on = (z) => Math.abs(z) < 1e-6;                         // on the floor (z = 0), not above or through it
  async function land(vz, lift) {
    const core = await flight({ floorZ: 0 });
    core.teleport({ pos: [0, 0, 0.06], quat: [Math.cos(roll / 2), Math.sin(roll / 2), 0, 0], vel: [0, 0, vz] });
    [0, 0, lift, lift].forEach((duty, i) => core.motorOverride(i, duty));
    const contacts = [];
    let high = null;     // rims 0 and 1 reaching the floor: the tick, and rim 0's speed over the tick before
    let z2 = null;
    let z1 = null;       // rim 0's height at the end of the tick before last and of the last tick
    for (let k = 0; k < 100; k++) {
      core.step(1);
      const fp = core.footprint;
      for (const e of kinds(core.events(), 'contact')) contacts.push({ ...e, k, rims: fp.slice(0, 4).map((p) => p[2]) });
      if (!high && on(fp[0][2]) && on(fp[1][2])) high = { k, speed: (z2 - z1) / 1e-3 };
      [z2, z1] = [z1, fp[0][2]];
    }
    return { contacts, high, fault: core.fault };
  }
  const show = (e) => `${e.impactMs.toFixed(3)} m/s at ${e.k} ms${e.crashed ? ' crashed' : ''} (rims ${e.rims.map((v) => (v * 1e3).toFixed(1)).join(' ')} mm)`;

  const slam = await land(-2.4, 0.6);
  const [first] = slam.contacts;
  const crash = slam.contacts.find((e) => e.crashed);
  console.log(`second rim: contacts ${slam.contacts.map(show).join(', ')}; rims 0 and 1 down at ${slam.high?.k} ms, ${slam.high?.speed.toFixed(3)} m/s; crash speed ${CRASH_MS.toFixed(3)} m/s, fault ${slam.fault}`);
  assert.equal(slam.fault, 0);
  assert.ok(first && first.box === -1 && !first.crashed && first.impactMs > HARD_MS && first.impactMs < CRASH_MS, 'the low rims land hard, under crash speed');
  assert.ok(on(first.rims[2]) && on(first.rims[3]) && first.rims[0] > 5e-3 && first.rims[1] > 5e-3, 'the first contact is rims 2 and 3');
  assert.ok(crash && crash.box === -1 && crash.impactMs > CRASH_MS, 'the second rim landing is reported as a crash');
  assert.ok(on(crash.rims[0]) && on(crash.rims[1]), 'the crash is rims 0 and 1');
  assert.ok(crash.k - first.k < 50, 'inside the same-contact gap: only the upgrade reports it');

  const soft = await land(-1.6, 0);
  console.log(`control: contacts ${soft.contacts.map(show).join(', ')}; rims 0 and 1 down at ${soft.high?.k} ms, ${soft.high?.speed.toFixed(3)} m/s, fault ${soft.fault}`);
  assert.equal(soft.fault, 0);
  assert.ok(soft.contacts.length === 1 && !soft.contacts[0].crashed && on(soft.contacts[0].rims[2]) && on(soft.contacts[0].rims[3]), 'one contact, rims 2 and 3, not a crash');
  assert.ok(soft.high && soft.high.k - soft.contacts[0].k < 50 && soft.high.speed > HARD_MS, 'rims 0 and 1 land hard inside the gap');
}

// 32. A pose on the floor at any attitude is on the floor: after a flight in
// the air, the quad posed inverted on its canopy, or tipped 0.5 rad onto two
// duct rims, is no floorTouch, then or as it settles (plant.c restHeightAt: a
// pose is judged by the height its lowest footprint point needs, not the
// level rest height). Control: the same poses 0.2 mm up land, one touch each.
{
  const hullAbove = air65.values.hullAbove.value;
  const tip = 0.5;
  for (const floorZ of [0, 0.07]) {
    for (const [name, z, quat, lowest] of [
      ['inverted on the canopy', hullAbove, [0, 1, 0, 0], [4]],
      ['tipped 0.5 rad onto two rims', REACH * Math.sin(tip) + REST * Math.cos(tip), [Math.cos(tip / 2), 0, Math.sin(tip / 2), 0], [1, 3]],
    ]) {
      const touches = [];
      for (const lift of [0, 2e-4]) {
        const core = await flight({ floorZ });
        core.teleport({ pos: [0, 0, floorZ + 2] });
        core.step(5);
        core.events();
        core.teleport({ pos: [0.3, -0.2, floorZ + z + lift], quat });
        core.step(1);
        if (!lift) {
          // Really on the floor: the canopy, or the two rims, on it, the rest of
          // the footprint clear of it, and the floor holding it.
          const h = core.footprint.map((p) => p[2] - floorZ);
          assert.ok(h.every((v, k) => (lowest.includes(k) ? Math.abs(v) < 1e-6 : v > 0.02)) && (core.state.contactFlags & 1), `floor ${floorZ}, ${name}: posed on the floor`);
        }
        core.step(499);
        touches.push(kinds(core.events(), 'floorTouch').length);
      }
      console.log(`floor ${floorZ}, posed ${name} after a flight: ${touches[0]} floorTouch in 500 ms (posed 0.2 mm up: ${touches[1]})`);
      assert.equal(touches[0], 0, `floor ${floorZ}, ${name}: a pose onto the floor is not a touch`);
      assert.equal(touches[1], 1, `floor ${floorZ}, ${name}: posed above the floor it lands`);
    }
  }
}

// 33. Ground effect over a box top is ground effect over the floor (world.c
// sc_world_hull_clearance: one datum on both, the CG's height above what is
// underneath less hullBelow). Resting on either the hull clearance is 0; at
// the same height above either the motors at a fixed duty lift the same; on
// the same throttle Betaflight hovers in ground effect at the same height
// above either. Control: the lift 10 mm higher (where quadmath's CG datum
// put a box top) is far from the box top's. The floor is raised to the box
// top's height, so both fly at the same absolute height and differ only in
// what is underneath. The hovers start in the air, 15 mm up: resting on the
// floor and on a box top leave last-bit different states (two contact code
// paths), which the 3 s closed-loop hover grows to some 5 um (seen with the
// rpm-based current model, 2026-10-23); that is rounding, not the datum.
{
  const top = 0.5;
  const at = [0.2, -0.1];
  const surfaces = [[top, { floorZ: top }], [top, { floorZ: 0, boxes: [{ min: [-1, -1, 0], max: [1, 1, top], id: 7 }] }]];
  const rest = [];
  for (const [surface, world] of surfaces) {
    const c = await flight(world);
    c.teleport({ pos: [...at, surface + REST] });
    c.step(50);
    rest.push([c.state.groundClearance, c.state.contactFlags]);
  }
  console.log(`resting disarmed: hull clearance on the floor ${rest[0][0].toExponential(2)} m (contact flags ${rest[0][1]}), on a box top ${rest[1][0].toExponential(2)} m (flags ${rest[1][1]})`);
  assert.ok(rest[0][1] === 1 && rest[1][1] === 2, 'resting on the floor, and on the box top');
  assert.ok(Math.abs(rest[0][0]) < 1e-9 && Math.abs(rest[1][0]) < 1e-9, 'hull clearance 0 on both');

  // The specific force one tick after a pose h above the surface, the motors
  // spun up first at the plant's hover duty (dutyHover, no sag).
  const lift = async (surface, world, h) => {
    const c = await flight(world);
    c.teleport({ pos: [...at, surface + REST] });
    c.motorOverride(-1, c.plantDerived.dutyHover);
    c.step(300);
    c.teleport({ pos: [...at, surface + REST + h] });
    c.step(1);
    return { clr: c.state.groundClearance, sf: c.state.specificForce[2] };
  };
  const free = (await lift(top, surfaces[0][1], 0.1)).sf;
  for (const h of [0.005, 0.015]) {
    const f = await lift(top, surfaces[0][1], h);
    const b = await lift(top, surfaces[1][1], h);
    const cg = await lift(top, surfaces[0][1], h + REST);
    console.log(`${h * 1000} mm up at the hover duty: lift ${f.sf.toFixed(6)} over the floor, ${b.sf.toFixed(6)} over the box top (${(f.sf - b.sf).toExponential(2)}), clearance ${f.clr.toFixed(6)} and ${b.clr.toFixed(6)}; ground effect adds ${(f.sf - free).toFixed(4)} m/s2; over the floor 10 mm higher (quadmath's CG datum's box top) ${(cg.sf - b.sf).toFixed(4)} off`);
    assert.ok(Math.abs(f.clr - h) < 1e-9 && Math.abs(b.clr - h) < 1e-9, 'the clearance is the height above the surface');
    assert.ok(f.sf - free > 0.05, 'in ground effect');
    assert.ok(Math.abs(f.sf - b.sf) < 1e-9, 'the same lift over the box top');
    assert.ok(Math.abs(cg.sf - b.sf) > 0.05, 'the CG datum would not match');
  }

  // Betaflight in angle mode on a throttle just under the free-air hover,
  // armed 1 m up (nothing touches), then posed 15 mm above each surface: the
  // height above it, every tick for 3 s.
  const hoverThr = feel.hoverTrim(await feel.simCoreSim(SimCore, module, { diff, airframe: air65 })).throttle;
  const hover = async (surface, world) => {
    const c = await flight(world);
    c.teleport({ pos: [...at, surface + 1] });
    const chs = (st) => ch(st, [2000, 2000]);
    c.input(chs({ throttle: 0 }));
    c.step(100);
    c.teleport({ pos: [...at, surface + REST + 0.015] });
    const z = [];
    for (let ms = 0; ms < 3000; ms++) {
      if (ms % 4 === 0) c.input(chs({ throttle: hoverThr - 0.005 }));
      c.step(1);
      z.push(c.state.pos[2] - surface);
    }
    return { z, clr: c.state.groundClearance };
  };
  const hf = await hover(top, surfaces[0][1]);
  const hb = await hover(top, surfaces[1][1]);
  const dz = Math.max(...hf.z.map((v, k) => Math.abs(v - hb.z[k])));
  const ceiling = air65.values.propDiameter.value;
  // The quad does not settle in 3 s: it bobs through ground effect (0 to
  // 32 mm before round 4, 0 to 49 mm after, touching the floor). Its
  // clearance over the last 500 ms is held to the band by its envelope, the
  // lowest and the highest both inside (owner decision 2026-10-24).
  const clrs = hf.z.map((v) => v - REST);
  const last = clrs.slice(-500);
  const lo = Math.min(...last);
  const hi = Math.max(...last);
  console.log(`throttle ${(hoverThr - 0.005).toFixed(4)} (free-air hover ${hoverThr.toFixed(4)}) for 3 s: over the last 500 ms ${(lo * 1000).toFixed(2)} to ${(hi * 1000).toFixed(2)} mm over the floor (over the 3 s ${(Math.max(0, Math.min(...clrs)) * 1000).toFixed(2)} to ${(Math.max(...clrs) * 1000).toFixed(2)} mm; ends ${(hf.clr * 1000).toFixed(2)} mm, ${(hb.clr * 1000).toFixed(2)} mm over the box top), heights apart at most ${dz.toExponential(2)} m`);
  assert.ok(dz < 1e-9, 'the same hover over the box top');
  if (!(lo > 0.001 && hi < ceiling)) open.push({ key: 'plant-world #33 ground effect envelope', what: `#33 off the floor, in ground effect over the last 500 ms: ${(lo * 1000).toFixed(2)} to ${(hi * 1000).toFixed(2)} mm, band 1 mm to ${(ceiling * 1000).toFixed(0)} mm` });
}

// 34. A footprint point lying on a face with no speed into it touches the
// face but is not pushed: the canopy lying on a post's face as the quad drops
// and drifts along it, and on a wall's face while the rims rest on the floor,
// runs as it does with that box removed (world.c sc_world_point writes back
// only what the world changed: a world-unit round trip on an untouched axis
// read as a push, a phantom contact that fought the floor's; the second case
// is the one that shows it, the first checks a lying touch on its own).
// Control: the same box 1 um into the canopy pushes.
{
  const X = 1.234567;
  const Y = 0.3;
  const run = async (boxes, pos, vel, duty) => {
    const c = await flight({ floorZ: 0, boxes });
    c.teleport({ pos, vel });
    c.events();
    if (duty) c.motorOverride(-1, duty);
    const trace = [];
    let lying = 0;
    for (let k = 0; k < 300; k++) {
      c.step(1);
      const s = c.state;
      trace.push([...s.pos, ...s.vel, ...s.quat, ...s.omega]);
      if ((s.contactFlags & 2) && Math.abs(c.footprint[4][0] - X) < 1e-9) lying++;
    }
    return { trace, lying, contacts: kinds(c.events(), 'contact') };
  };
  const apart = (a, b) => Math.max(...a.trace.map((row, i) => Math.max(...row.map((v, k) => Math.abs(v - b.trace[i][k])))));
  for (const [name, box, pos, vel, duty] of [
    ['dropping and drifting along a post', { min: [X, Y - 0.02, 0], max: [X + 0.1, Y + 0.02, 3], id: 8 }, [X, Y, 1.2], [0, 0.03, 0.5], D(0.2)],
    ['on a wall, the rims resting on the floor', { min: [X, Y - 0.5, 0.02], max: [X + 0.3, Y + 0.5, 1], id: 9 }, [X, Y, REST], [0, 0, 0], 0],
  ]) {
    const on = await run([box], pos, vel, duty);
    const none = await run([], pos, vel, duty);
    const into = await run([{ ...box, min: [X - 1e-6, box.min[1], box.min[2]] }], pos, vel, duty);
    const hit = on.contacts.filter((e) => e.box === box.id);
    console.log(`canopy lying on a face, ${name}: on it ${on.lying}/300 ticks, contacts ${JSON.stringify(hit.map((e) => [e.impactMs.toExponential(1), e.crashed]))}; apart from the run without the box ${apart(on, none).toExponential(2)} (box 1 um into the canopy: ${apart(into, none).toExponential(2)})`);
    assert.ok(on.lying === 300 && hit.length === 1 && hit[0].impactMs < 1e-9 && !hit[0].crashed, 'the canopy lies on the face throughout, touching it at no speed');
    assert.ok(apart(on, none) < 1e-9, 'as if the box were not there');
    assert.ok(apart(into, none) > 1e-7, 'a real contact there shows');
  }
}

// 35. A box lifted off the floor by less than world.c's grounding tolerance
// (ON_FACE_WU, 0.1 mm) stands on it: it has no bottom face, so it reaches
// down to the floor, or a rim lying on the floor under it is outside the
// 5 um near-box window (PAST_WU) and slides under the side. The press of 22
// against the box on the floor plane and lifted 6, 20, 50 and 99 um: the
// same footprint path every tick, the front rims held on the floor at the
// foot of the side.
{
  const a = 0.5;
  const ahead = REACH * Math.cos(a) - REST * Math.sin(a);
  const below = REACH * Math.sin(a) + REST * Math.cos(a);
  const rows = [];
  for (const lift of [0, 6e-6, 20e-6, 50e-6, 99e-6]) {
    const core = await flight({ floorZ: 0, boxes: [{ min: [2, -1, lift], max: [2.3, 1, 0.5], id: 5 }] });
    core.teleport({ pos: [1.995 - ahead, 0, below], quat: [Math.cos(a / 2), 0, Math.sin(a / 2), 0], vel: [0.5, 0, 0] });
    core.events();
    core.motorOverride(-1, D(0.33));
    const path = [];
    let deepest = -Infinity;    // farthest x of any point below the top
    let pressed = 0;            // ticks a rim lay on the floor against the side, touching both
    let hits = 0;
    for (let t = 0; t < 3000; t++) {
      core.step(1);
      hits += kinds(core.events(), 'contact').filter((e) => e.box === 5).length;
      const fp = core.footprint;
      path.push(fp);
      if (core.state.contactFlags === 3 && fp.some((p) => Math.abs(p[0] - 2) < 1e-3 && Math.abs(p[2]) < 1e-6)) pressed++;
      deepest = Math.max(deepest, ...fp.filter((p) => p[2] < 0.499).map((p) => p[0]));
    }
    rows.push({ lift, path, deepest, pressed, hits });
  }
  const [flat] = rows;
  for (const r of rows) r.apart = Math.max(...r.path.map((fp, k) => Math.max(...fp.map((p, i) => maxAbs(p.map((v, ax) => v - flat.path[k][i][ax]))))));
  const lifted = rows.slice(1);
  console.log(`boxes lifted ${lifted.map((r) => r.lift * 1e6).join(', ')} um off the floor, pressed into at floor level for 3 s: deepest below the top x ${lifted.map((r) => r.deepest.toFixed(6)).join(', ')}; ${lifted.map((r) => r.pressed).join(', ')} ticks on the floor against the side (on the floor plane ${flat.pressed}); footprints at most ${Math.max(...lifted.map((r) => r.apart)).toExponential(2)} m from the floor-plane box's`);
  assert.ok(flat.pressed >= 1000 && flat.deepest <= 2.000001, 'the box on the floor plane holds the rims at its foot');
  for (const r of lifted) {
    assert.ok(r.deepest <= 2.000001, `lifted ${r.lift * 1e6} um: kept out from under the box`);
    assert.ok(r.apart < 1e-9 && r.hits === flat.hits, `lifted ${r.lift * 1e6} um: as the box on the floor plane`);
  }
}

// 36. The concave corner with a split post (29), entered deeper than the rim
// climbs past the split: rim 3 more than 5 um into the corner (world.c's
// near-box window, PAST_WU) and less far past the split than into it. Only
// the upper post piece is then near, and all three of its faces the rim
// came through this tick are inner faces: the post's two toward the room
// (the walls continue past them) and its bottom (the lower piece does). The
// bottom was the shallowest and held the rim at the split, an invisible
// ledge with a contact on the upper piece; the rim crossed the split inside
// the solid, so world.c ranks that face after the others (crossedInside).
// Aimed hits as in 29, rim 3 into the corner square or skewed: the same
// footprint path and contacts as the post in one piece. Control: the post
// above the split 1 mm proud of the walls is a real ledge and holds the rim.
{
  const walls = [{ min: [-1, 1, 0], max: [2, 1.1, 3] }, { min: [2, -1, 0], max: [2.1, 1, 3] }];
  const lower = { min: [2, 1, 0], max: [2.1, 1.1, 1.5] };
  const posts = {
    split: [lower, { min: [2, 1, 1.5], max: [2.1, 1.1, 3] }],
    whole: [{ min: [2, 1, 0], max: [2.1, 1.1, 3] }],
    ledge: [lower, { min: [1.999, 0.999, 1.5], max: [2.1, 1.1, 3] }],
  };
  const corner = async (post, [gx, gy, below]) => {
    const boxes = [...walls, ...post].map((b, id) => ({ ...b, id }));
    const c = await flight({ floorZ: 0, boxes });
    c.teleport({ pos: [0, 0, 1] });
    c.motorOverride(-1, c.plantDerived.dutyHover);
    c.step(300);
    c.teleport({ pos: [2 - gx - REACH, 1 - gy - REACH, 1.5 - below + REST], vel: [0.05, 0.05, 0.5] });
    c.events();
    const path = [];
    const ev = [];
    let cross = null;
    for (let k = 0; k < 50; k++) {
      c.step(1);
      ev.push(...kinds(c.events(), 'contact').map((e) => [k, e.box, Number(e.impactMs.toFixed(6)), e.crashed]));
      const p = c.footprint[3];
      const [p1, p2] = [path[k - 1]?.[3], path[k - 2]?.[3]];
      // The tick rim 3 crosses the split: where the two ticks before put it
      // without the walls (at their speed), and whether it ends on the edge.
      if (!cross && p2 && p1[2] < 1.5 && p[2] >= 1.5 - 1e-9) {
        cross = { into: Math.min(2 * p1[0] - p2[0] - 2, 2 * p1[1] - p2[1] - 1), past: 2 * p1[2] - p2[2] - 1.5, edge: Math.abs(p[0] - 2) < 1e-9 && Math.abs(p[1] - 1) < 1e-9 };
      }
      path.push(c.footprint);
    }
    return { path, ev, cross, z: c.footprint[3][2], inside: footInside(c, boxes) };
  };
  const hits = [[225e-6, 225e-6, 2.473e-3], [200e-6, 200e-6, 2.463e-3], [240e-6, 240e-6, 2.48e-3], [200e-6, 230e-6, 2.47e-3], [230e-6, 200e-6, 2.48e-3]];
  let worst = 0;
  for (const [k, hit] of hits.entries()) {
    const split = await corner(posts.split, hit);
    const whole = await corner(posts.whole, hit);
    const apart = Math.max(...split.path.map((fp, t) => Math.max(...fp.map((p, i) => maxAbs(p.map((v, a) => v - whole.path[t][i][a]))))));
    worst = Math.max(worst, apart);
    const c = split.cross;
    console.log(`  rim 3 ${(c.into * 1e6).toFixed(1)} um into the corner, ${(c.past * 1e6).toFixed(1)} um past the split, on the edge ${c.edge}: z after 50 ms ${split.z.toFixed(6)} (post in one piece ${whole.z.toFixed(6)}), footprints ${apart.toExponential(2)} m apart, contacts ${JSON.stringify(split.ev.map((e) => e[1]))} (one piece ${JSON.stringify(whole.ev.map((e) => e[1]))})`);
    // Not vacuous: deeper into the corner than the window, less far past the split.
    assert.ok(c.edge && whole.cross.edge && c.into > 5e-6 && c.past > 0 && c.past < c.into, `hit ${JSON.stringify(hit)} is in the corner past the window and less far past the split`);
    assert.ok(apart < 1e-9 && JSON.stringify(split.ev) === JSON.stringify(whole.ev), `hit ${JSON.stringify(hit)}: as the post in one piece`);
    assert.ok(!split.inside && split.z > 1.5005, 'climbed past the split, no rim inside');
    if (!k) {
      const ledge = await corner(posts.ledge, hit);
      assert.ok(ledge.z < 1.5, 'the real ledge holds the rim');
    }
  }
  console.log(`concave corner, rim 3 deeper into the corner than past the post's split, ${hits.length} hits: footprints at most ${worst.toExponential(2)} m from the post in one piece`);
}

// 37. Pressed into a split wall as it rises into the ceiling beside the
// seam (29, now with 0.5 m/s into the wall): the same as the wall in one
// piece. Rim 1 ends the first tick inside the wall piece 20 to 90 um from
// the seam, past the wall face (an inner face there, under the ceiling) and
// into the ceiling (whose bottom is an inner face where the wall is). The
// seam face was the shallowest of the three inner faces and passed world.c's
// travel check on its 0.1 mm allowance (ON_FACE_WU) with no travel across
// it: the rim was pushed onto the seam, an extra wall contact whose friction
// took 18% off its speed into the ceiling. Contacts are compared by surface
// (a wall piece or the ceiling), impact and crash flag.
{
  const mapBoxes = async (id) => JSON.parse(await readFile(new URL(`tests/fixtures/maps/${id}.json`, root), 'utf8')).boxes
    .map((b, i) => ({ min: b.um.slice(0, 3).map((v) => v * 1e-6), max: b.um.slice(3).map((v) => v * 1e-6), id: i }));
  const room = await mapBoxes('room');
  const merged = [{ min: [0, 1, 2].map((a) => Math.min(room[0].min[a], room[1].min[a], room[2].min[a])), max: [0, 1, 2].map((a) => Math.max(room[0].max[a], room[1].max[a], room[2].max[a])), id: 0 }, ...room.slice(3)];
  // The pose of 29: on its tail, belly to the +x wall, rim 1 on the wall
  // face 0.5 mm under the ceiling, rimY from the seam.
  const L = REACH * Math.SQRT2;
  const c22 = Math.cos(Math.PI / 8);
  const s22 = Math.sin(Math.PI / 8);
  const up = [c22 * Math.SQRT1_2, -s22 * Math.SQRT1_2, -c22 * Math.SQRT1_2, s22 * Math.SQRT1_2];
  const wallX = room[0].min[0];
  const seamY = room[1].max[1];
  const ceilZ = room[12].min[2];
  const surface = (e) => (e.box >= 0 && e.box <= 2 ? 'wall' : e.box);
  let differ = 0;
  let hitMin = Infinity;
  // Beside the seam at 0.05 to 1.5 m/s into the wall, rising at 1 or 3 m/s,
  // still or drifting off the seam; then across it, and 2 mm off it (29's).
  const aims = [
    [0.00002, [0.5, 0, 3]], [0.00005, [0.5, 0, 3]], [0.00009, [0.5, 0, 3]], [-0.00003, [0.5, 0, 3]], [-0.00008, [0.5, 0, 3]],
    [0.00003, [0.05, 0, 3]], [0.00003, [1.5, 0, 3]], [0.00001, [0.5, 0, 1]], [0.00006, [0.5, 0.01, 3]],
    [0.00002, [0.5, -0.05, 3]], [-0.002, [0.5, 4, 3]],
  ];
  for (const [rimY, vel] of aims) {
    const pos = [wallX - REST, seamY + rimY, ceilZ - 5e-4 - L];
    const run = async (boxes) => {
      const c = await flight({ floorZ: 0, boxes });
      c.teleport({ pos, quat: up, vel });
      c.events();
      c.step(1);
      const r = c.footprint[1];
      const first = kinds(c.events(), 'contact');
      const ev = [...first];
      for (let k = 1; k < 20; k++) {
        c.step(1);
        ev.push(...kinds(c.events(), 'contact'));
      }
      return { r, ev: ev.map((e) => [surface(e), Number(e.impactMs.toFixed(6)), e.crashed]), first: first.map((e) => [surface(e), e.impactMs]), vel: c.state.vel, pos: c.state.pos };
    };
    const a = await run(room);
    const b = await run(merged);
    // Not vacuous: rim 1 met the ceiling on the first tick, on the wall face
    // (to 1 nm) beside the seam, and the wall reported the press.
    const ceiling = a.first.find((e) => e[0] === 12);
    assert.ok(ceiling && Math.abs(a.r[0] - wallX) <= 1e-9 && Math.abs(a.r[2] - ceilZ) <= 1e-6 && a.first.some((e) => e[0] === 'wall' && e[1] > 0.9 * vel[0]), `rim 1 at y ${rimY} pressed into the wall-ceiling edge: ${JSON.stringify(a.first)}`);
    hitMin = Math.min(hitMin, ceiling[1]);
    if (JSON.stringify(a.ev) !== JSON.stringify(b.ev) || a.vel.some((v, k) => Math.abs(v - b.vel[k]) > 1e-9) || a.pos.some((v, k) => Math.abs(v - b.pos[k]) > 1e-9)) {
      differ++;
      console.log(`  pressed up the split wall into the ceiling differs at ${JSON.stringify([rimY, vel])}: split ${JSON.stringify(a.ev)} vs one piece ${JSON.stringify(b.ev)}, rim 1 y after the first tick ${(a.r[1] - seamY).toExponential(2)} m from the seam`);
    }
  }
  console.log(`pressed into a split wall rising into the ceiling beside its seam, ${aims.length} aimed (rim 1 hit the ceiling at ${hitMin.toFixed(3)} m/s or more): ${differ} differ from the wall in one piece`);
  assert.equal(differ, 0);

  // The T-join of 26 (a table against a wall split at y = 0, the leading rim
  // on the table top at the seam, leaning into the wall, pressed for 3 s):
  // the same footprint path and contacts as against the wall in one piece
  // (a seam touch 361 ms in, from the allowance, took it 0.15 mm apart).
  // Pitched 0.52 rad into the wall: the leading rim (motor 1, +x -y) from the CG.
  const tq = [Math.cos(0.26), 0, Math.sin(0.26), 0];
  const lead = [REACH * Math.cos(0.52) - REST * Math.sin(0.52), -REACH, -REACH * Math.sin(0.52) - REST * Math.cos(0.52)];
  const tPos = [1.99 - lead[0], -lead[1], 0.5 - lead[2]];
  const table = { min: [1, -1, 0], max: [2, 1, 0.5], id: 1 };
  const join = async (wall) => {
    const c = await flight({ floorZ: 0, boxes: [table, ...wall] });
    c.teleport({ pos: tPos, quat: tq });
    c.events();
    c.motorOverride(-1, D(0.3));
    const path = [];
    const ev = [];
    let seam = 0;
    for (let k = 0; k < 3000; k++) {
      c.step(1);
      ev.push(...kinds(c.events(), 'contact').map((e) => [k, e.box === 1 ? 'table' : 'wall', Number(e.impactMs.toFixed(6))]));
      path.push(c.footprint);
      if (c.footprint.some((p) => p[0] > 2 - 1e-4 && Math.abs(p[1]) < 1e-3 && Math.abs(p[2] - 0.5) < 1e-4)) seam++;
    }
    return { path, ev, seam };
  };
  const tSplit = await join([{ min: [2, -1, 0], max: [2.2, 0, 2], id: 2 }, { min: [2, 0, 0], max: [2.2, 1, 2], id: 3 }]);
  const tOne = await join([{ min: [2, -1, 0], max: [2.2, 1, 2], id: 2 }]);
  const tApart = Math.max(...tSplit.path.map((fp, k) => Math.max(...fp.map((p, i) => maxAbs(p.map((u, a) => u - tOne.path[k][i][a]))))));
  console.log(`T-join against the split wall, pressed 3 s: ${tSplit.seam} ms with a rim in the join, contacts ${JSON.stringify(tSplit.ev)} (one piece ${JSON.stringify(tOne.ev)}), footprints ${tApart.toExponential(2)} m apart`);
  assert.ok(tSplit.seam >= 1000, 'pressed into the T-join');
  assert.ok(tApart < 1e-9 && JSON.stringify(tSplit.ev) === JSON.stringify(tOne.ev), 'the T-join as against the wall in one piece');
}

// The footprint hull checks of 38 and after: the hull of the five points,
// how deep a box's edges are inside it, and 27's pose against a wall.
const CANOPY = air65.values.hullAbove.value;
// The hull's faces (rims 0 1 3 2 round the base, the canopy at the apex),
// pointing out, and how deep a point is inside it (negative outside).
const hullDepthAt = (fp) => {
  const v = [fp[0], fp[1], fp[3], fp[2], fp[4]];
  const c = [0, 1, 2].map((a) => v.reduce((s, p) => s + p[a], 0) / 5);
  const sub = (a, b) => a.map((x, i) => x - b[i]);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const planes = [[0, 1, 2], [0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]].map(([i, j, k]) => {
    const [p, q, r] = [sub(v[j], v[i]), sub(v[k], v[i]), sub(c, v[i])];
    const n = [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
    const len = Math.hypot(...n) * (dot(n, r) > 0 ? -1 : 1);
    const u = n.map((x) => x / len);
    return { u, d: dot(u, v[i]) };
  });
  return { planes, at: (x) => Math.min(...planes.map(({ u, d }) => d - dot(u, x))) };
};
// The deepest any point of the box's twelve edges is inside the hull: each
// edge clipped to the hull, then sampled.
const edgeIn = (fp, box) => {
  const { planes, at } = hullDepthAt(fp);
  let worst = 0;
  for (let s = 0; s < 12; s++) {
    const k = Math.floor(s / 4);
    const [k1, k2] = [(k + 1) % 3, (k + 2) % 3];
    const a = [0, 0, 0];
    const e = [0, 0, 0];
    a[k] = box.min[k];
    e[k] = box.max[k];
    a[k1] = e[k1] = s & 1 ? box.max[k1] : box.min[k1];
    a[k2] = e[k2] = s & 2 ? box.max[k2] : box.min[k2];
    let [t0, t1] = [0, 1];
    for (const { u, d } of planes) {
      const [da, de] = [u[0] * a[0] + u[1] * a[1] + u[2] * a[2] - d, u[0] * e[0] + u[1] * e[1] + u[2] * e[2] - d];
      if (da > 0 && de > 0) t0 = 2;
      else if (da > 0) t0 = Math.max(t0, da / (da - de));
      else if (de > 0) t1 = Math.min(t1, da / (da - de));
    }
    for (let j = 0; t0 <= t1 && j <= 32; j++) {
      const t = t0 + ((t1 - t0) * j) / 32;
      worst = Math.max(worst, at(a.map((x, i) => x + t * (e[i] - x))));
    }
  }
  return worst;
};
// 27's pose: pitched tilt into +x after a yaw just past 45 deg, rim 1 on
// the wall face, on the quaternion the plant gets.
const pose = (tilt, yaw) => {
  const [cp, sp, cy, sy] = [Math.cos(tilt / 2), Math.sin(tilt / 2), Math.cos(yaw / 2), Math.sin(yaw / 2)];
  const quat = [cp * cy, sp * sy, sp * cy, cp * sy];
  const r = quat.map((v) => Math.round(v * 1e9) * 1e-9);
  const n = Math.sqrt(r.reduce((s, v) => s + v * v, 0));
  const [w, x, y, z] = r.map((v) => v / n);
  const rot = (v) => {
    const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
    return [v[0] + w * t[0] + (y * t[2] - z * t[1]), v[1] + w * t[1] + (z * t[0] - x * t[2]), v[2] + w * t[2] + (x * t[1] - y * t[0])];
  };
  return { quat, rim: rot([REACH, -REACH, -REST]), canopy: rot([0, 0, CANOPY]) };
};
const onFace = (tilt) => {
  const ahead = Math.floor(pose(tilt, Math.PI / 4).rim[0] * 1e6 + 1e-9) * 1e-6;
  let lo = Math.PI / 4;
  let hi = pose(tilt, lo).rim[0] <= ahead ? lo : lo + 0.05;
  while (hi > lo && hi - lo > 1e-15) {
    const m = (lo + hi) / 2;
    if (pose(tilt, m).rim[0] > ahead) lo = m;
    else hi = m;
  }
  return { ...pose(tilt, hi), cgX: 2 - ahead };
};

// 38. A box edge never passes through the footprint's hull, the convex hull
// of the five points (a square pyramid: the duct rims round the base, the
// canopy 28 mm above them at the apex). Pressed up under a shelf shallower
// than the quad against a wall, near level and yawed so that rim 1 leads on
// the wall face as in 27, the shelf's front edge comes down between rim 1 and
// the rest of the footprint, where no point is: the body swung over it and
// ended with points on the shelf. Each press starts 30 mm under the shelf
// (the hull clear of it) and checks every tick that no point of the shelf's
// edges is inside the hull (world.c sc_world_hull holds it off) and no
// footprint point is inside a box. Not vacuous: the shelf reported its first
// contact with every footprint point still 5 mm or more from it, so the hull
// met the edge. Then a quad set down level on a table with its CG 10 mm
// behind the edge and its front rims over it rests on its back rims and the
// edge, still and level, rather than tipping with the edge through its hull.
{
  let worst = 0;
  let inside = 0;
  let hullFirst = 0;
  let presses = 0;
  let lowest = Infinity;
  for (const depth of [0.03, 0.04, 0.045]) {
    const boxes = [{ min: [2 - depth, -1, 0.9], max: [2, 1, 0.94], id: 1 }, { min: [2, -1, 0], max: [2.08, 1, 2.4], id: 2 }];
    for (const [tilt, duty, vz] of [[1e-5, D(0.5), 0.5], [1e-5, D(0.62), 0.5], [1e-4, D(0.5), 0.5], [1e-4, D(0.62), 0.5], [1e-3, D(0.5), 0.5], [1e-3, D(0.62), 0.5], [0, 0.45, 0.2]]) {
      const { quat, rim, cgX } = onFace(tilt);
      const c = await flight({ floorZ: 0, boxes });
      c.teleport({ pos: [cgX, 0, 0.87 - rim[2]], quat, vel: [tilt ? 0 : 1e-6, 0, vz] });
      c.events();
      c.motorOverride(-1, duty);
      let met = null;
      for (let k = 0; k < 3000; k++) {
        c.step(1);
        const fp = c.footprint;
        worst = Math.max(worst, edgeIn(fp, boxes[0]));
        if (footInside(c, boxes, 1e-6)) inside++;
        // How far the nearest footprint point is from the shelf.
        if (met === null && kinds(c.events(), 'contact').some((e) => e.box === 1)) met = Math.min(...fp.map((p) => Math.hypot(...[0, 1, 2].map((a) => Math.max(0, boxes[0].min[a] - p[a], p[a] - boxes[0].max[a])))));
      }
      presses++;
      if (met !== null && met >= 0.005) hullFirst++;
      lowest = Math.min(lowest, met ?? 0);
    }
  }
  console.log(`presses up under 30, 40 and 45 mm shelves against a wall, ${presses}: shelf edges at most ${(worst * 1e6).toFixed(3)} um inside the footprint's hull, ${inside} ticks with a point inside a box; ${hullFirst} met the shelf with every point 5 mm or more from it (at least ${(lowest * 1e3).toFixed(1)} mm)`);
  assert.ok(worst < 1e-6, 'no shelf edge through the hull');
  assert.equal(inside, 0, 'no footprint point inside a box');
  assert.equal(hullFirst, presses, 'the hull met the shelf edge, not a point');

  // The table edge: level, yaw 0, CG 10 mm behind the edge (x 2), rims 1
  // and 3 25.8 mm past it, set down 0.5 mm above the top.
  const table = [{ min: [1, -1, 0], max: [2, 1, 0.5], id: 1 }];
  const c = await flight({ floorZ: 0, boxes: table });
  c.teleport({ pos: [1.99, 0, 0.5 + REST + 5e-4] });
  let tWorst = 0;
  let spin = 0;
  for (let k = 0; k < 2000; k++) {
    c.step(1);
    tWorst = Math.max(tWorst, edgeIn(c.footprint, table[0]));
    if (k >= 1000) spin = Math.max(spin, Math.hypot(...c.state.omega));
  }
  const q = c.state.quat;
  const upZ = 1 - 2 * (q[1] * q[1] + q[2] * q[2]);
  const fp = c.footprint;
  console.log(`set down level with the CG 10 mm behind a table edge: after 2 s up-z ${upZ.toFixed(6)}, back rims at z ${fp[0][2].toFixed(6)} ${fp[2][2].toFixed(6)}, front rims ${fp[1][2].toFixed(6)} ${fp[3][2].toFixed(6)} over the edge; edge at most ${(tWorst * 1e6).toFixed(3)} um inside the hull; |omega| at most ${spin.toExponential(2)} rad/s over the last second`);
  assert.ok(tWorst < 1e-6, 'the table edge never through the hull');
  assert.ok(upZ > 0.9999 && fp[1][0] > 2.02 && Math.abs(fp[0][2] - 0.5) < 2e-5, 'resting level on its back rims and the edge, the front rims over it');
  assert.ok(spin < 1e-3, 'and still');
}

// The boxes of a quadmath map fixture (ids: the box's index in the map).
const mapFixture = async (id) => JSON.parse(await readFile(new URL(`tests/fixtures/maps/${id}.json`, root), 'utf8')).boxes
  .map((b, i) => ({ min: b.um.slice(0, 3).map((v) => v * 1e-6), max: b.um.slice(3).map((v) => v * 1e-6), id: i }));

// 39. The parity model's box contact is quadmath's CG point as committed in
// 2a8ec95: the footprint's three rules in world.c resolvePoint (a box
// standing on the floor reaching down to it, an inner face crossed inside the
// solid ranking last, no on-face allowance for an inner face) are not
// applied to it. The gate cannot see this (P2 flies with no boxes, P5 checks
// the clearance query), so it is pinned here: seeded parity flights into the
// boxes of eight maps hash to 2a8ec95's states and events; a box whose bottom
// is 10.03 to 10.09 mm up (within ON_FACE_WU of the CG's padded floor) lets
// the sliding CG pass under it, as quadmath's does; and the CG pressed into
// the room's split wall as it rises into the ceiling beside the seam meets
// the wall first, as it did (with the footprint's rules it met the ceiling
// first, at 2.99 m/s).
{
  const parity = { ...air65, id: 'parity-box-contact', model: 'parity' };
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
  const all = createHash('sha256');
  let runs = 0;
  let contacts = 0;
  for (const id of ['room', 'garage', 'office', 'living', 'gym', 'warehouse', 'backyard', 'trainer']) {
    const boxes = await mapFixture(id);
    const h = createHash('sha256');
    const c = await flight({ floorZ: 0, boxes }, parity);
    for (let r = 0; r < 60; r++) {
      // Near a random face of a random box, flying into it.
      const b = boxes[Math.floor(rnd() * boxes.length)];
      const ax = Math.floor(rnd() * 3);
      const side = rnd() < 0.5 ? -1 : 1;
      const pos = [0, 1, 2].map((a) => b.min[a] + rnd() * (b.max[a] - b.min[a]));
      pos[ax] = (side > 0 ? b.max[ax] : b.min[ax]) + side * (0.0002 + rnd() * 0.02);
      if (pos[2] < 0.01) pos[2] = 0.01 + rnd() * 0.02;
      const vel = [0, 1, 2].map(() => (rnd() - 0.5) * 6);
      vel[ax] = -side * (0.2 + rnd() * 8);
      c.teleport({ pos, vel });
      c.events();
      for (let k = 0; k < 120; k++) {
        c.step(1);
        const ev = c.events();
        contacts += kinds(ev, 'contact').length;
        const s = c.state;
        h.update(JSON.stringify([s.pos, s.vel, s.omega, ev]));
      }
      runs++;
    }
    all.update(h.digest('hex'));
  }
  const digest = all.digest('hex').slice(0, 16);
  console.log(`parity model flown into the boxes of 8 maps, ${runs} flights, ${contacts} contact events: digest ${digest} (2a8ec95: 577, 1b06c2d6b3e71136)`);
  assert.equal(contacts, 577, 'the same contact events as 2a8ec95');
  assert.equal(digest, '1b06c2d6b3e71136', 'the same states and events as 2a8ec95');

  const under = [];
  for (const [lift, x0, vx, cgX] of [[0.01003, 1.9995, 3, 2.019383], [0.01005, 1.9995, 3, 2.019383], [0.01009, 1.9995, 3, 2.019383], [0.01005, 1.999, 0.5, 2.00232]]) {
    const c = await flight({ floorZ: 0, boxes: [{ min: [2, -1, lift], max: [2.3, 1, 0.5], id: 5 }] }, parity);
    c.teleport({ pos: [x0, 0, 0.01], vel: [vx, 0, 0] });
    c.events();
    const ev = [];
    for (let k = 0; k < 100; k++) {
      c.step(1);
      ev.push(...kinds(c.events(), 'contact'));
    }
    under.push(`${(lift * 1e3).toFixed(2)} mm up at ${vx} m/s: x ${c.state.pos[0].toFixed(6)}, ${ev.length} contacts`);
    assert.ok(ev.length === 0 && Math.abs(c.state.pos[0] - cgX) < 1e-6, `the CG passes under the box: ${under.at(-1)}`);
  }
  console.log(`parity CG sliding on its floor toward a box: ${under.join('; ')}`);

  const room = await mapFixture('room');
  const merged = [{ min: [0, 1, 2].map((a) => Math.min(...room.slice(0, 3).map((b) => b.min[a]))), max: [0, 1, 2].map((a) => Math.max(...room.slice(0, 3).map((b) => b.max[a]))), id: 0 }, ...room.slice(3)];
  const [wallX, seamY, ceilZ] = [room[0].min[0], room[1].max[1], room[12].min[2]];
  const press = async (boxes) => {
    const c = await flight({ floorZ: 0, boxes }, parity);
    c.teleport({ pos: [wallX - 2e-4, seamY + 2e-5, ceilZ - 1e-3], vel: [0.5, 0, 3] });
    c.events();
    const ev = [];
    for (let k = 0; k < 20; k++) {
      c.step(1);
      ev.push(...kinds(c.events(), 'contact').map((e) => [e.box <= 2 ? 'wall' : e.box, Number(e.impactMs.toFixed(4))]));
    }
    return { ev, vel: c.state.vel };
  };
  const split = await press(room);
  const whole = await press(merged);
  console.log(`parity CG pressed into the room's split wall, rising into the ceiling 20 um from the seam: ${JSON.stringify(split.ev)}, vel z ${split.vel[2].toFixed(6)}; the wall in one piece ${JSON.stringify(whole.ev)}, vel z ${whole.vel[2].toFixed(6)}`);
  assert.deepEqual(split.ev, [['wall', 0], ['wall', 0.4097], [12, 2.0092]], 'split wall: the wall first, as committed');
  assert.ok(Math.abs(split.vel[2] + 0.837070343) < 1e-8, 'split wall: the same velocity');
  assert.deepEqual(whole.ev, [['wall', 0.4997], [12, 2.4502]], 'one piece: the wall first, as committed');
  assert.ok(Math.abs(whole.vel[2] + 0.979411859) < 1e-8, 'one piece: the same velocity');
}

// 40. A solid in pieces meets the footprint's hull as the same solid in one
// piece (world.c buildSolids): a table split near, under or across the edge
// the quad lands on, in two, three or four pieces, and 38's shelf split along
// and across its front edge, give the same footprint path tick by tick and
// the same contacts as the box in one piece, the shelf's edge staying out of
// the hull; and every order of the pieces in the map's list gives the same
// path (the hull's contacts are taken in order in plant.c's sweeps). Per
// piece, a seam was a face: a sliver of the far piece across it pushed the
// quad up to 5 mm sideways in one tick with a phantom contact and a roll
// kick, the split shelf held its edge 2.2 um inside the hull, and swapping
// two pieces in the list moved the quad 44 um.
{
  const cut = (boxes, ax, at) => boxes.flatMap((b) => (b.min[ax] < at && at < b.max[ax]
    ? [{ ...b, max: b.max.map((v, a) => (a === ax ? at : v)) }, { ...b, min: b.min.map((v, a) => (a === ax ? at : v)) }]
    : [b]));
  const yawQ = (yaw) => [Math.cos(yaw / 2), 0, 0, Math.sin(yaw / 2)];
  const fly = async (boxes, { pos, vel, quat, duty }, ticks, edgeOf) => {
    const c = await flight({ floorZ: 0, boxes });
    c.teleport({ pos, vel, quat });
    c.events();
    if (duty) c.motorOverride(-1, duty);
    const path = [];
    const ev = [];
    let edge = 0;
    for (let k = 0; k < ticks; k++) {
      c.step(1);
      path.push(c.footprint);
      ev.push(...kinds(c.events(), 'contact').map((e) => [k, e.box, Number(e.impactMs.toFixed(6)), e.crashed]));
      if (edgeOf) edge = Math.max(edge, edgeIn(c.footprint, edgeOf));
    }
    return { path, ev, edge };
  };
  const apart = (a, b) => Math.max(...a.path.map((fp, k) => Math.max(...fp.map((p, i) => maxAbs(p.map((v, ax) => v - b.path[k][i][ax]))))));
  let runs = 0;
  let worst = 0;
  const differ = [];
  const same = (what, split, whole) => {
    const d = apart(split, whole);
    runs++;
    worst = Math.max(worst, d);
    if (!(d < 1e-9) || JSON.stringify(split.ev) !== JSON.stringify(whole.ev)) differ.push(`${what}: ${d.toExponential(2)} m apart, contacts ${JSON.stringify(split.ev.slice(0, 4))} vs ${JSON.stringify(whole.ev.slice(0, 4))}`);
  };

  // The table, the pieces all reporting its id.
  const table = [{ min: [1, -1, 0], max: [2, 1, 0.5], id: 1 }];
  const ySeams = [REACH - 3e-3, REACH - 1e-4, -(REACH - 1e-4), 0.0338, 0.01, 0];
  const splits = [
    ...ySeams.map((y) => [`y ${y.toFixed(4)}`, cut(table, 1, y)]),
    ['y -0.005 and 0.008', cut(cut(table, 1, -0.005), 1, 0.008)],
    ['x 1.995', cut(table, 0, 1.995)],
    ['x 1.97', cut(table, 0, 1.97)],
    ['z 0.3', cut(table, 2, 0.3)],
    ['quartered', cut(cut(table, 1, 0), 0, 1.97)],
  ];
  // Dropped level or yawed onto the edge, the CG 10 mm behind it.
  for (const [vz, yaw, up] of [[-1, 0, 2e-3], [-2, 0, 2e-3], [-1, 0.3, 2e-3], [-3, 0, 5e-4]]) {
    const start = { pos: [1.99, 0, 0.5 + REST + up], vel: [0, 0, vz], quat: yawQ(yaw) };
    const whole = await fly(table, start, 600);
    for (const [name, boxes] of splits.slice(0, ySeams.length)) same(`dropped at ${vz} m/s yaw ${yaw}, cut at ${name}`, await fly(boxes, start, 600), whole);
  }
  // Set down level on the edge (38's table) for 2 s.
  const setDown = { pos: [1.99, 0, 0.5 + REST + 5e-4] };
  const rest = await fly(table, setDown, 2000);
  for (const [name, boxes] of splits) same(`set down, cut at ${name}`, await fly(boxes, setDown, 2000), rest);
  // Set down 3 mm off a seam, the pieces in every order.
  const perms = (a) => (a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p])));
  const offSeam = { pos: [1.99, 0.003, 0.5 + REST + 5e-4] };
  const restOff = await fly(table, offSeam, 2000);
  for (const pieces of [cut(table, 1, 0), cut(cut(table, 1, -0.005), 1, 0.008)]) {
    for (const order of perms(pieces)) same(`set down 3 mm off the seam, ${order.length} pieces in the order ${order.map((b) => b.min[1]).join(' ')}`, await fly(order, offSeam, 2000), restOff);
  }

  // 38's shelf press, the shelf split along and across its front edge.
  const shelf = [{ min: [1.96, -1, 0.9], max: [2, 1, 0.94], id: 1 }];
  const wall = { min: [2, -1, 0], max: [2.08, 1, 2.4], id: 2 };
  let shelfEdge = 0;
  for (const [tilt, duty] of [[1e-3, D(0.62)], [1e-4, D(0.62)]]) {
    const { quat, rim, cgX } = onFace(tilt);
    const press = { pos: [cgX, 0, 0.87 - rim[2]], quat, vel: [0, 0, 0.5], duty };
    const whole = await fly([...shelf, wall], press, 3000, shelf[0]);
    for (const [name, pieces] of [['y 0', cut(shelf, 1, 0)], ['y 0.02', cut(shelf, 1, 0.02)], ['y -0.02', cut(shelf, 1, -0.02)], ['y 0.045', cut(shelf, 1, 0.045)], ['y -0.045', cut(shelf, 1, -0.045)], ['x 1.98', cut(shelf, 0, 1.98)], ['z 0.92', cut(shelf, 2, 0.92)]]) {
      const split = await fly([...pieces, wall], press, 3000, shelf[0]);
      shelfEdge = Math.max(shelfEdge, split.edge);
      same(`shelf press tilt ${tilt}, cut at ${name}`, split, whole);
    }
  }
  console.log(`a table and a shelf in pieces against the same in one piece, ${runs} flights (cuts along, across and under the edge, 2 to 4 pieces, every order of 2 and 3): ${differ.length} differ, footprints at most ${worst.toExponential(2)} m apart; the split shelf's edge at most ${(shelfEdge * 1e6).toFixed(3)} um inside the hull`);
  for (const d of differ.slice(0, 6)) console.log(`  ${d}`);
  assert.equal(differ.length, 0, 'a solid in pieces meets the hull as the solid in one piece');
  assert.ok(shelfEdge < 1e-6, 'the split shelf edge never through the hull');
}

// 41. A box standing on the floor reaches down through it for the hull too
// (world.c satOverlap), as it has no bottom face for a point: no way out of
// it takes the hull down. A level quad skimming 0.2 or 1 mm above the floor
// at 2 or 5 m/s, square or yawed 30 deg, into a 20 or 40 mm post standing on
// the floor that passes between its rims keeps every rim on or above the
// floor and the post out of the hull. The least-overlap axis was a sloped
// side face of the hull, about 0.79 vertical, so the push went down: rims up
// to 5.75 mm under the floor. And posed in the gym beside a 40 mm post that
// is 20 mm into the hull, no point inside it, with the motors at 0.265, the
// quad comes off the post onto the floor; it was pushed 25 mm under the
// floor, and held there every tick by the floor lifting it and the hull
// pushing it down again.
{
  let runs = 0;
  let low = 0;
  let deep = 0;
  for (const width of [0.02, 0.04]) {
    const post = { min: [1, -width / 2, 0], max: [1 + width, width / 2, 0.7], id: 1 };
    for (const gap of [0.0002, 0.001]) {
      for (const speed of [2, 5]) {
        for (const yawDeg of [0, 30]) {
          for (const dy of [0, 0.008]) {
            const yaw = (yawDeg * Math.PI) / 180;
            // 30 mm short of the post, the rims REACH (cos + sin) ahead of the CG.
            const ahead = REACH * (Math.cos(yaw) + Math.sin(yaw));
            const c = await flight({ floorZ: 0, boxes: [post] });
            c.teleport({ pos: [post.min[0] - ahead - 0.03, dy, REST + gap], quat: [Math.cos(yaw / 2), 0, 0, Math.sin(yaw / 2)], vel: [speed, 0, 0] });
            c.motorOverride(-1, HOVER_DUTY);
            for (let k = 0; k < 600; k++) {
              c.step(1);
              c.events();
              low = Math.min(low, footMin(c, 2));
              deep = Math.max(deep, edgeIn(c.footprint, post));
            }
            runs++;
          }
        }
      }
    }
  }
  console.log(`skimming the floor into a post standing on it, ${runs} skims: lowest rim ${(low * 1e3).toFixed(3)} mm, the post at most ${(deep * 1e3).toFixed(3)} mm inside the hull`);
  assert.ok(low > -5e-4, 'no rim pushed under the floor');
  assert.ok(deep < 1e-3, 'the post kept out of the hull');

  const gym = await mapFixture('gym');
  const c = await flight({ floorZ: 0, boxes: gym });
  c.teleport({ pos: [7.520772, -5.181785, 0.014805], quat: [0.9987369473220914, -0.003535410201526186, -0.019845015588958355, 0.046023757829308384], vel: [-0.470755, 1.486271, -0.62221] });
  c.motorOverride(-1, 0.2650545358657837);
  let gLow = 0;
  for (let k = 0; k < 1500; k++) {
    c.step(1);
    c.events();
    gLow = Math.min(gLow, footMin(c, 2));
  }
  console.log(`posed in the gym with a 40 mm post 20 mm into the hull, motors at 0.265 for 1.5 s: lowest rim ${(gLow * 1e3).toFixed(3)} mm, CG ends at z ${c.state.pos[2].toFixed(4)}`);
  assert.ok(gLow > -5e-4, 'no rim pushed under the floor');
  assert.ok(Math.abs(c.state.pos[2] - REST) < 5e-4, 'resting on the floor');
}

for (const o of open.filter((x) => investigation[x.key])) console.log(`open: ${o.what}; ${investigation[o.key].reason} (${investigation[o.key].by})`);
const failing = open.filter((x) => !investigation[x.key]);
assert.deepEqual(failing, [], `open checks failed: ${failing.map((x) => x.what).join('; ')}`);
console.log('plant-world: box tops, edges, seams, stacks, corners, box edges held off by the footprint hull, slabs at walls and map walls, crash cap, crash on a second rim, pose and spawn edge state at any attitude, ground effect on box tops, points lying on faces, portals frame-independent, rest plant, configure rollback, argument checks, twr, lerp, flat pack, hover current, the parity model box contact as committed, solids in pieces as in one piece, floor-standing boxes never pushing the hull down: PASS');
