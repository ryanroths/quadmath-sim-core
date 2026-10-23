// M4 plant and world through the JS API: the contact, trigger, pose and pack
// behaviours the M4 review found wrong, each pinned by a check, and the
// argument checking of configure(), teleport(), motorOverride(), clearanceAt()
// and plantBlock().
//
//   node tests/node/plant-world.test.mjs
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SimCore, plantBlock, sticksToChannels as ch } from '../../src/js/sim-core.js';
import * as feel from '../lib/feel.mjs';

const root = new URL('../../', import.meta.url);
const module = await WebAssembly.compile(await readFile(new URL('dist/sim-core.wasm', root)));
const air65 = JSON.parse(await readFile(new URL('airframes/air65.json', root), 'utf8'));
const diff = await readFile(new URL('configs/65mm-air65-ryfly-1219s.diff', root), 'utf8');
const maxAbs = (v) => Math.max(...v.map(Math.abs));
const kinds = (events, kind) => events.filter((e) => e.kind === kind);

async function flight(world, plant = air65) {
  const core = await SimCore.load(module, { trace: false });
  core.configure({ diff, plant, world });
  return core;
}

// 1. Resting disarmed on a box top: no yaw spin-up (sim.html makes every tick
// there a duct hit with a yaw kick; the soft path and scrub now apply).
{
  const core = await flight({ floorZ: 0, boxes: [{ min: [1, -1, 0], max: [3, 1, 0.5] }] });
  core.teleport({ pos: [2, 0, 0.5] });
  core.events();
  core.step(10_000);
  const s = core.state;
  const ev = core.events();
  console.log(`box top, 10 s disarmed: omega ${s.omega.map((v) => v.toExponential(2)).join(' ')} rad/s, z ${s.pos[2].toFixed(4)} m, contact flags ${s.contactFlags}, acc ${core.fc.acc.map((v) => v.toFixed(3)).join(' ')} g, contact events ${kinds(ev, 'contact').length}`);
  assert.ok(maxAbs(s.omega) < 1e-3, 'no spin-up resting on a box top');
  assert.ok(Math.abs(s.pos[2] - 0.5) < 1e-3, 'stays on the box top');
  assert.equal(s.contactFlags, 2);
  assert.ok(Math.abs(core.fc.acc[2] - 1) < 0.01, 'Betaflight reads 1 g');
  assert.equal(kinds(ev, 'contact').length, 1, 'one contact event for the landing');
}

// 2. A fast shallow crash into the floor: a crash event, never the divergence
// fault (the contact spin kick is capped below the 200 rad/s guard).
for (const vel of [[18, 0, -8], [30, 10, -15], [0, 25, -20]]) {
  const core = await flight(undefined);
  core.teleport({ pos: [0, 0, 0.03], vel });
  let peak = 0;
  for (let k = 0; k < 200; k++) {
    core.step(1);
    peak = Math.max(peak, maxAbs(core.state.omega));
  }
  const crashes = kinds(core.events(), 'contact').filter((e) => e.crashed);
  console.log(`crash at ${vel.join(' ')} m/s: peak body rate ${peak.toFixed(1)} rad/s, crash events ${crashes.length}, fault ${core.fault}`);
  assert.equal(core.fault, 0);
  assert.ok(peak <= 150, 'contact leaves body rates at or below the cap');
  assert.ok(crashes.length >= 1, 'reported as a crash');
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

// 9. A flat pack (0 V) carries across a reinit.
{
  const core = await flight(undefined);
  assert.doesNotThrow(() => core.reinit({ battery: { soc: 0.02, vbatFiltered: 0 } }));
  assert.equal(core.battery.soc, 0.02);
}

// 10. At hover on a full pack the current stand-in draws the bench current:
// its reference duty is the hover duty with the pack sagging at that current.
{
  const sim = await feel.simCoreSim(SimCore, module, { diff, airframe: air65 });
  const h = feel.hoverTrim(sim);
  sim.fly(() => ({ t: h.throttle }), 3000);
  const s = sim.core.state;
  const d = sim.core.plantDerived;
  const iRef = air65.values.iRef.value;
  console.log(`hover stick ${h.quantum}: ${s.amps.toFixed(3)} A at ${s.vbatLoaded.toFixed(3)} V (bench ${iRef} A); reference duty ${d.dutyCurrentRef.toFixed(4)}, no-sag hover duty ${d.dutyHover.toFixed(4)}`);
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

// 13. Landing close to a box-top edge is a landing on the top, not a side hit
// that sinks through the box.
for (const [x, vz, crash] of [[1.0005, -1, false], [1.002, -3, true], [2.9995, -1, false]]) {
  const core = await flight({ floorZ: 0, boxes: [{ min: [1, -1, 0], max: [3, 1, 0.75], id: 4 }] });
  core.teleport({ pos: [x, 0, 0.8], vel: [0, 0, vz] });
  core.events();
  core.step(1000);
  const s = core.state;
  const c = kinds(core.events(), 'contact');
  console.log(`landing at x ${x} m, ${vz} m/s: z ${s.pos[2].toFixed(4)} after 1 s, first contact ${c[0].impactMs.toFixed(3)} m/s crashed ${c[0].crashed}`);
  assert.ok(s.pos[2] >= 0.749, 'stays on the top face');
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
  for (const [field, value] of [['iRef', 42], ['cellIR', 0.6], ['cellIR', 0.9]]) {
    const bad = structuredClone(air65);
    bad.values[field].value = value;
    assert.throws(() => core.configure({ diff, plant: bad }), /plant block refused/, `${field} ${value}: the pack cannot hold hover at the bench current`);
    assert.equal(core.plant, null);
  }
  console.log('uncloneable plant and three unreachable current references: refused, previous config kept');
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
  const flush = await flight({ floorZ: 0, boxes: [{ min: [1, -1, 0], max: [2, 1, 0.5], id: 10 }, { min: [2, -1, 0], max: [3, 1, 0.5], id: 11 }] });
  flush.teleport({ pos: [1.97, 0, 0.5005], vel: [5, 0, -0.5] });
  flush.events();
  flush.step(300);
  const fs1 = flush.state;
  const fev = kinds(flush.events(), 'contact');
  const one = await flight({ floorZ: 0, boxes: [{ min: [1, -1, 0], max: [3, 1, 0.5], id: 10 }] });
  one.teleport({ pos: [1.97, 0, 0.5005], vel: [5, 0, -0.5] });
  one.step(300);
  console.log(`flush tops: x ${fs1.pos[0].toFixed(6)} z ${fs1.pos[2].toFixed(4)} after 300 ms (one box: x ${one.state.pos[0].toFixed(6)}), contacts ${JSON.stringify(fev.map((e) => [e.box, Number(e.impactMs.toFixed(3)), e.crashed]))}`);
  assert.ok(Math.abs(fs1.pos[0] - one.state.pos[0]) < 1e-6, 'slides across the seam as across one box');
  assert.ok(fs1.pos[2] >= 0.499);
  assert.ok(fev.every((e) => !e.crashed && e.impactMs < 1), 'no hit at the seam');
  // At 6 m/s, every landing offset short of the seam: never a crash on box 11.
  for (let x0 = 1.9; x0 < 1.996; x0 += 0.005) {
    const c = await flight({ floorZ: 0, boxes: [{ min: [1, -1, 0], max: [2, 1, 0.5], id: 10 }, { min: [2, -1, 0], max: [3, 1, 0.5], id: 11 }] });
    c.teleport({ pos: [x0, 0, 0.5005], vel: [6, 0, -0.5] });
    c.events();
    c.step(200);
    assert.ok(kinds(c.events(), 'contact').every((e) => !e.crashed), `no crash at the seam from x ${x0}`);
  }

  const table = await flight({ floorZ: 0, boxes: [{ min: [1, -1, 0], max: [2, 1, 0.5], id: 1 }, { min: [2, -1, 0], max: [2.2, 1, 2], id: 2 }] });
  table.teleport({ pos: [1.985, 0, 0.5005], vel: [2, 0, -0.3] });
  table.events();
  table.step(1000);
  const ts = table.state;
  const tev = table.events();
  console.log(`table against a wall: x ${ts.pos[0].toFixed(4)} z ${ts.pos[2].toFixed(4)} after 1 s, ${kinds(tev, 'contact').length} contact events`);
  assert.ok(ts.pos[2] >= 0.499, 'stays on the table');
  assert.ok(kinds(tev, 'contact').length < 10, 'no event flood');

  const backyard = JSON.parse(await readFile(new URL('tests/fixtures/maps/backyard.json', root), 'utf8'));
  const yard = await flight({ floorZ: 0, boxes: backyard.boxes.map((b) => ({ min: b.um.slice(0, 3).map((v) => v * 1e-6), max: b.um.slice(3).map((v) => v * 1e-6) })) });
  yard.teleport({ pos: [-2.3623, 5.5, 0.0635], vel: [5, 0, -0.3] });
  yard.events();
  yard.step(1000);
  const ys = yard.state;
  const yev = yard.events();
  console.log(`backyard deck seam: x ${ys.pos[0].toFixed(4)} z ${ys.pos[2].toFixed(4)} after 1 s, ${kinds(yev, 'contact').length} contact events, dropped ${kinds(yev, 'dropped').length}`);
  assert.ok(ys.pos[2] > 0.05, 'does not sink through the deck');
  assert.ok(kinds(yev, 'contact').length < 10);
}

// 19. A fast skim along the floor into a box standing on it bounces off the
// side; a pose low inside such a box comes out, not under the floor.
{
  const skim = await flight({ floorZ: 0, boxes: [{ min: [2, -1, 0], max: [3, 1, 0.5], id: 5 }] });
  skim.teleport({ pos: [1.98653, 0, 0.01061], vel: [12, 0, -0.5] });
  skim.events();
  for (let k = 0; k < 20 && !kinds(skim.events(), 'contact').some((e) => e.box === 5); k++) skim.step(1);
  const sk = skim.state;
  console.log(`floor skim into a box: x ${sk.pos[0].toFixed(5)} after the hit, vx ${sk.vel[0].toFixed(3)}`);
  assert.ok(sk.pos[0] <= 2, 'pushed back out of the side');
  assert.ok(sk.vel[0] < 0, 'bounced');

  const low = await flight({ floorZ: 0, boxes: [{ min: [2, -0.5, 0], max: [3, 0.5, 0.4] }] });
  low.teleport({ pos: [2.5, 0, 0.05] });
  low.step(1);
  const ls = low.state;
  const inside = ls.pos[0] > 2 && ls.pos[0] < 3 && Math.abs(ls.pos[1]) < 0.5 && ls.pos[2] < 0.4 - 1e-9;
  console.log(`pose low inside a grounded box: out at ${ls.pos.map((v) => v.toFixed(3)).join(' ')}`);
  assert.ok(!inside, 'not left inside the box');
  assert.ok(ls.pos[2] >= 0.01 - 1e-9, 'not under the floor');
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
  const depthInside = (pos, boxes) => Math.max(0, ...boxes.map((b) => {
    const d = [0, 1, 2].map((a) => Math.min(pos[a] - b.min[a], b.max[a] - pos[a]));
    return Math.min(...d);
  }));
  const slide = async (boxes) => {
    const core = await flight({ floorZ: 0, boxes });
    core.teleport({ pos: [1.999, 0, 0.56], vel: [0.5, 0, -0.3], quat: [Math.cos(0.4), 0, Math.sin(0.4), 0] });
    core.motorOverride(-1, 0.35);
    core.step(2500);
    return core.state.pos;
  };
  const stacked = await slide([{ min: [2, -1, 0], max: [2.2, 1, 0.5] }, { min: [2, -1, 0.5], max: [2.2, 1, 1] }]);
  const whole = await slide([{ min: [2, -1, 0], max: [2.2, 1, 1] }]);
  console.log(`slide down a wall: stacked blocks x ${stacked[0].toFixed(4)} z ${stacked[2].toFixed(4)}; one-piece x ${whole[0].toFixed(4)} z ${whole[2].toFixed(4)}`);
  assert.ok(stacked[0] <= 2.001, 'stays on the face of the stacked wall');

  const garage = JSON.parse(await readFile(new URL('tests/fixtures/maps/garage.json', root), 'utf8'));
  const gboxes = garage.boxes.map((b) => ({ min: b.um.slice(0, 3).map((v) => v * 1e-6), max: b.um.slice(3).map((v) => v * 1e-6) }));
  const g = await flight({ floorZ: 0, boxes: gboxes });
  g.teleport({ pos: [3.43485, 0.17222, 0.51497], vel: [-1.667, -2.063, -5.546], quat: [0.97603, -0.07663, -0.2037, 0] });
  g.step(1000);
  const gd = depthInside(g.state.pos, gboxes);
  console.log(`garage crate stack: at ${g.state.pos.map((v) => v.toFixed(4)).join(' ')} after 1 s, ${(gd * 1000).toFixed(3)} mm inside a box`);
  assert.ok(gd < 1e-3, 'not left inside the crates');
}

// 22. A box standing exactly on the floor plane is solid at floor level.
{
  const core = await flight({ floorZ: -0.01, boxes: [{ min: [2, -1, 0], max: [2.3, 1, 0.5], id: 5 }] });
  core.teleport({ pos: [1.995, 0, 0], quat: [Math.cos(0.25), 0, Math.sin(0.25), 0], vel: [0.5, 0, 0] });
  core.events();
  core.motorOverride(-1, 0.33);
  core.step(3000);
  const s = core.state;
  const c = kinds(core.events(), 'contact').filter((e) => e.box === 5);
  console.log(`box on the floor plane: x ${s.pos[0].toFixed(4)} after 3 s, ${c.length} contacts with it`);
  assert.ok(s.pos[0] <= 2.001 || s.pos[2] >= 0.499, 'kept out of the box');
  assert.ok(c.length >= 1, 'and the hit is reported');
}

// 23. Setting the floor again while resting on a box is not a new contact.
{
  const core = await flight({ floorZ: 0, boxes: [{ min: [1, -1, 0], max: [3, 1, 0.5], id: 9 }] });
  core.teleport({ pos: [2, 0, 0.5] });
  core.step(500);
  core.events();
  for (let k = 0; k < 3; k++) {
    core.flight.sc_world_floor(0);
    core.step(100);
  }
  assert.deepEqual(kinds(core.events(), 'contact'), [], 'no contact from a floor call');
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
    core.teleport({ pos: [1.99, 0, 0.5], quat: [Math.cos(0.26), 0, Math.sin(0.26), 0] });
    core.motorOverride(-1, 0.3);
    core.step(3000);
    const s = core.state;
    console.log(`pressed into the wall from the table (box order ${order ? 'wall first' : 'table first'}): x ${s.pos[0].toFixed(4)} z ${s.pos[2].toFixed(4)} after 3 s`);
    assert.ok(s.pos[2] >= 0.499 && s.pos[0] <= 2.001, 'stays on the table, at the wall');
  }

  const living = JSON.parse(await readFile(new URL('tests/fixtures/maps/living.json', root), 'utf8')).boxes
    .map((b) => ({ min: b.um.slice(0, 3).map((v) => v * 1e-6), max: b.um.slice(3).map((v) => v * 1e-6) }));
  const tv = await flight({ floorZ: 0, boxes: living });
  tv.teleport({ pos: [3.17, 0.2, 0.405714], quat: [Math.cos(0.26), 0, Math.sin(0.26), 0] });
  tv.motorOverride(-1, 0.3);
  tv.step(6000);
  const t = tv.state;
  console.log(`slid along the TV stand into the TV: x ${t.pos[0].toFixed(4)} z ${t.pos[2].toFixed(4)} after 6 s`);
  assert.ok(t.pos[0] <= 3.1867 || t.pos[2] > 0.5, 'stopped at the TV, not under it');

  const clip = await flight({ floorZ: 0, boxes: [{ min: [2, -1, 0], max: [3, 1, 0.5], id: 3 }] });
  clip.teleport({ pos: [1.999, 0, 0.4965], vel: [3, 0, 3] });
  clip.events();
  clip.step(1);
  const cs = clip.state;
  const ce = kinds(clip.events(), 'contact');
  console.log(`top edge clipped climbing at 3 m/s: vz ${cs.vel[2].toFixed(3)}, contact ${JSON.stringify(ce.map((e) => [Number(e.impactMs.toFixed(3)), e.crashed]))}`);
  // The point crosses x = 2 at z 0.4975, below the edge, at 3 m/s: a side
  // hit (a crash by quadmath's threshold), never an upward kick off the top.
  assert.ok(cs.vel[2] <= 3.001, 'no extra climb from the clip');
}

// 26. Corners and edges where boxes overlap or meet: a room corner, a wall
// under a ceiling slab or a deck, a crate stack's inner line, a T-join of a
// table against a split wall, a pose inside two overlapping boxes, and the
// office fixture's 1 um rounding gap above the door. Never pushed through a
// wall, never left inside, never up onto a slab from below.
{
  const mapBoxes = async (id) => JSON.parse(await readFile(new URL(`tests/fixtures/maps/${id}.json`, root), 'utf8')).boxes
    .map((b) => ({ min: b.um.slice(0, 3).map((v) => v * 1e-6), max: b.um.slice(3).map((v) => v * 1e-6) }));
  const inside = (p, boxes) => boxes.some((b) => [0, 1, 2].every((a) => p[a] > b.min[a] + 1e-3 && p[a] < b.max[a] - 1e-3));
  const tilt = (az, ang) => [Math.cos(ang / 2), Math.sin(ang / 2) * -Math.sin(az), Math.sin(ang / 2) * Math.cos(az), 0];

  const garage = await mapBoxes('garage');
  const gc = await flight({ floorZ: 0, boxes: garage });
  gc.teleport({ pos: [5.9, 2.9, 1.0], quat: [Math.cos(0.15), -0.707 * Math.sin(0.15), 0.707 * Math.sin(0.15), 0] });
  gc.motorOverride(-1, 0.3);
  gc.step(3000);
  const gp = gc.state.pos;
  console.log(`garage corner, pressed in 3 s: at ${gp.map((v) => v.toFixed(4)).join(' ')}`);
  assert.ok(gp[0] < 5.943 && gp[1] < 2.943 && !inside(gp, garage), 'held in the corner, inside the room');

  const room = await mapBoxes('room');
  const corner = [room[4], room[10]];
  let out = 0;
  for (const duty of [0.28, 0.34]) {
    for (let az = 0; az < 360; az += 30) {
      const c = await flight({ floorZ: 0, boxes: corner });
      c.teleport({ pos: [-2.35, -1.78, 0.4], quat: tilt(az * Math.PI / 180, 0.3), vel: [-0.35, -0.35, 0] });
      c.motorOverride(-1, duty);
      c.step(1500);
      const p = c.state.pos;
      if (p[0] < -2.39843 + 1e-4 && p[1] < -1.828857 - 1e-4) out++;
      if (inside(p, corner)) out++;
    }
  }
  console.log(`room corner (boxes 4 and 10), 24 presses: ${out} ended behind or inside a wall`);
  assert.equal(out, 0);

  for (const [name, boxes, from] of [
    ['ceiling slab on a wall', [{ min: [2, -1, 0], max: [2.1, 1, 3] }, { min: [-1, -1, 2.965714], max: [2.05, 1, 3.034286] }], [1.95, 0, 2.915714]],
    ['deck against a wall', [{ min: [1, -1, 0.9], max: [2, 1, 0.94] }, { min: [2, -1, 0], max: [2.08, 1, 2.4] }], [1.95, 0, 0.85]],
  ]) {
    const c = await flight({ floorZ: 0, boxes });
    c.teleport({ pos: from, quat: [Math.cos(0.1), 0, Math.sin(0.1), 0] });
    c.motorOverride(-1, 0.45);
    c.step(3000);
    let maxX = -Infinity;
    for (let k = 0; k < 4000; k++) {
      c.motorOverride(-1, 0.45 - 0.12 * (k / 4000));
      c.step(1);
      maxX = Math.max(maxX, c.state.pos[0]);
    }
    const p = c.state.pos;
    const slabBottom = boxes[name.startsWith('ceiling') ? 1 : 0].min[2];
    console.log(`${name}: pressed up into the edge then eased off: max x ${maxX.toFixed(4)}, end ${p.map((v) => v.toFixed(4)).join(' ')}`);
    assert.ok(maxX <= 2.0001, 'never through the wall');
    assert.ok(p[2] <= slabBottom + 1e-4, 'never up onto the slab');
  }

  const cl = await flight({ floorZ: 0, boxes: garage });
  cl.teleport({ pos: [3.60055, 0.28684, 0.23521], vel: [2.552, -5.415, 0.503], quat: [0.99427, 0.0982, -0.04214, 0] });
  cl.motorOverride(-1, 0.4);
  cl.step(2000);
  assert.ok(!inside(cl.state.pos, garage), 'not held inside the crate stack');

  const tj = await flight({ floorZ: 0, boxes: [{ min: [1, -1, 0], max: [2, 1, 0.5], id: 1 }, { min: [2, -1, 0], max: [2.2, 0, 2], id: 2 }, { min: [2, 0, 0], max: [2.2, 1, 2], id: 3 }] });
  tj.teleport({ pos: [1.99, 0, 0.5], quat: [Math.cos(0.26), 0, Math.sin(0.26), 0] });
  tj.events();
  tj.motorOverride(-1, 0.3);
  tj.step(3000);
  const tp = tj.state.pos;
  const tc = kinds(tj.events(), 'contact').length;
  console.log(`T-join (table against a split wall), pressed 3 s: x ${tp[0].toFixed(4)} z ${tp[2].toFixed(4)}, ${tc} contacts`);
  assert.ok(tp[2] >= 0.499 && tp[0] <= 2.0001 && tc < 10);

  const yard = await mapBoxes('backyard');
  const py = await flight({ floorZ: 0, boxes: yard });
  py.teleport({ pos: [-7.475, -0.7649, 1.549] });
  py.step(300);
  assert.ok(!inside(py.state.pos, yard), 'a pose inside two overlapping boxes comes out');

  const office = await mapBoxes('office');
  let through = 0;
  for (const dy of [1e-6, -1e-6, 3e-4, 1e-3, -1e-3, 2e-3, -2e-3]) {
    for (const v of [2, 5, 8]) {
      const c = await flight({ floorZ: 0, boxes: office });
      c.teleport({ pos: [-6.5, -3.371428 + dy, 2.2], vel: [-v, 0, 0], quat: [Math.cos(0.075), 0, -Math.sin(0.075), 0] });
      c.motorOverride(-1, 0.34);
      c.step(2000);
      if (c.state.pos[0] < -6.75) through++;
    }
  }
  console.log(`office door lintel, 21 hits along the 1 um gap: ${through} through the wall`);
  assert.equal(through, 0);
}

// 27. Nanometres from a wall: a quad sliding along a wall face, a few nm
// inside it where a deck or table meets the wall, still meets the deck's
// bottom or the table's top. Near-level tilts into the wall, and a level
// press, all hold.
{
  const deck = [{ min: [1, -1, 0.9], max: [2, 1, 0.94] }, { min: [2, -1, 0], max: [2.08, 1, 2.4] }];
  const table = [{ min: [1, -1, 0], max: [2, 1, 0.5] }, { min: [2, -1, 0], max: [2.2, 1, 2] }];
  let bad = 0;
  for (const tiltRad of [1e-5, 1e-4, 1e-3]) {
    const q = [Math.cos(tiltRad / 2), 0, Math.sin(tiltRad / 2), 0];
    for (const duty of [0.5, 0.62]) {
      const c = await flight({ floorZ: 0, boxes: deck });
      c.teleport({ pos: [2.0, 0, 0.85], quat: q });
      c.motorOverride(-1, duty);
      c.step(3000);
      if (c.state.pos[2] > 0.9 + 1e-4 || c.state.pos[0] > 2.0001) bad++;
    }
    for (const duty of [0, 0.15, 0.25]) {
      const c = await flight({ floorZ: 0, boxes: table });
      c.teleport({ pos: [2.0, 0, 0.8], quat: q });
      if (duty) c.motorOverride(-1, duty);
      c.step(2000);
      if (c.state.pos[2] < 0.499 || c.state.pos[0] > 2.0001) bad++;
    }
  }
  const level = await flight({ floorZ: 0, boxes: deck });
  level.teleport({ pos: [2.0, 0, 0.88], vel: [1e-6, 0, 0.2] });
  level.motorOverride(-1, 0.45);
  level.step(1000);
  if (level.state.pos[2] > 0.9 + 1e-4) bad++;
  const drop = await flight({ floorZ: 0, boxes: table });
  drop.teleport({ pos: [2.0, 0, 0.55], vel: [1e-6, 0, -2] });
  drop.step(1000);
  if (drop.state.pos[2] < 0.499) bad++;
  console.log(`deck and table against a wall, 17 near-level presses and drops along the wall face: ${bad} went through`);
  assert.equal(bad, 0);
}

// 28. A split wall answers a hit as the same wall in one piece does: aimed
// hits on and near the seam, head-on and oblique, give the same events,
// crash flags and velocities; halves that overlap by 1 um hold too.
{
  const one = [{ min: [2, -1, 0], max: [2.2, 1, 2], id: 1 }];
  const split = [{ min: [2, -1, 0], max: [2.2, 0, 2], id: 1 }, { min: [2, 0, 0], max: [2.2, 1, 2], id: 1 }];
  const hit = async (boxes, pos, vel) => {
    const c = await flight({ floorZ: 0, boxes });
    c.teleport({ pos, vel });
    c.events();
    c.step(30);
    return { ev: kinds(c.events(), 'contact').map((e) => [Number(e.impactMs.toFixed(6)), e.crashed]), vel: c.state.vel, pos: c.state.pos };
  };
  let differ = 0;
  for (const [pos, vel] of [
    [[1.99, 0, 1], [3, 0, 0]], [[1.99, 0.00005, 1], [3, 0, 0]], [[1.99, -0.00005, 1], [3, 0, 0]],
    [[1.9995, -0.0002, 1], [3, 0.3, 0]], [[1.999, -0.0045, 1], [5, 5, 0]], [[1.999, -0.005, 1], [2, 6, 0]],
    [[1.999, 0.004, 1], [4, -3, 0]],
  ]) {
    const a = await hit(one, pos, vel);
    const b = await hit(split, pos, vel);
    const same = JSON.stringify(a.ev) === JSON.stringify(b.ev) && a.vel.every((v, k) => Math.abs(v - b.vel[k]) < 1e-9)
      && a.pos.every((v, k) => Math.abs(v - b.pos[k]) < 1e-9);
    if (!same) {
      differ++;
      console.log(`  split wall differs at ${JSON.stringify([pos, vel])}: one ${JSON.stringify(a.ev)} vs split ${JSON.stringify(b.ev)}`);
    }
  }
  console.log(`split wall vs one piece, 7 aimed hits on and near the seam: ${differ} differ`);
  assert.equal(differ, 0);

  const overlap = await flight({ floorZ: 0, boxes: [{ min: [2, -1, 0], max: [2.2, 0.000001, 2], id: 1 }, { min: [2, 0, 0], max: [2.2, 1, 2], id: 2 }] });
  overlap.teleport({ pos: [1.99, 0.00001, 1], vel: [5, 0, 0] });
  overlap.events();
  overlap.motorOverride(-1, 0.32);
  overlap.step(2000);
  const crash = kinds(overlap.events(), 'contact').some((e) => e.crashed);
  console.log(`halves overlapping by 1 um, 5 m/s at the seam: x ${overlap.state.pos[0].toFixed(5)} after 2 s, crash reported ${crash}`);
  assert.ok(overlap.state.pos[0] <= 2.00001 && crash);
}

// 29. Where a split wall meets a ceiling, a hit on the ceiling beside the
// seam is the same as with the wall in one piece; a hit on a column behind a
// catwalk is on the column; a concave corner with a split post holds no
// invisible ledge; and poses deep in the solid, on a seam plane, come out.
{
  const mapBoxes = async (id) => JSON.parse(await readFile(new URL(`tests/fixtures/maps/${id}.json`, root), 'utf8')).boxes
    .map((b, i) => ({ min: b.um.slice(0, 3).map((v) => v * 1e-6), max: b.um.slice(3).map((v) => v * 1e-6), id: i }));
  const inside = (p, boxes) => boxes.some((b) => [0, 1, 2].every((a) => p[a] > b.min[a] + 1e-3 && p[a] < b.max[a] - 1e-3));
  const room = await mapBoxes('room');
  const merged = [{ min: [0, 1, 2].map((a) => Math.min(room[0].min[a], room[1].min[a], room[2].min[a])), max: [0, 1, 2].map((a) => Math.max(room[0].max[a], room[1].max[a], room[2].max[a])), id: 0 }, ...room.slice(3)];
  let differ = 0;
  for (const [pos, vel] of [[[2.398429, 0.00002, 2.4035], [0, 0, 3]], [[2.398429, 0.00009, 2.4035], [0, 0, 3]], [[2.398429, -0.002, 2.4035], [0, 4, 3]]]) {
    const run = async (boxes) => {
      const c = await flight({ floorZ: 0, boxes });
      c.teleport({ pos, vel });
      c.events();
      c.step(20);
      return { ev: kinds(c.events(), 'contact').map((e) => [Number(e.impactMs.toFixed(6)), e.crashed]), vel: c.state.vel };
    };
    const a = await run(room);
    const b = await run(merged);
    if (JSON.stringify(a.ev) !== JSON.stringify(b.ev) || a.vel.some((v, k) => Math.abs(v - b.vel[k]) > 1e-9)) {
      differ++;
      console.log(`  ceiling beside the seam differs at ${JSON.stringify([pos, vel])}: split ${JSON.stringify(a.ev)} vs one piece ${JSON.stringify(b.ev)}`);
    }
  }
  console.log(`ceiling hits beside a split wall's seam, 3 aimed: ${differ} differ from the wall in one piece`);
  assert.equal(differ, 0);

  const warehouse = await mapBoxes('warehouse');
  const wh = await flight({ floorZ: 0, boxes: warehouse });
  wh.teleport({ pos: [4.458, -6.8956, 1.21146], vel: [0.003, 11, 0.0024] });
  wh.events();
  wh.step(2);
  const whe = kinds(wh.events(), 'contact');
  console.log(`warehouse column behind the catwalk at 11 m/s: ${JSON.stringify(whe.map((e) => [e.box, Number(e.impactMs.toFixed(3)), e.crashed]))}`);
  assert.ok(whe.some((e) => e.box === 40 && e.crashed && e.impactMs > 10.9), 'the crash is on the column, at the hit speed');

  const walls = [{ min: [-1, 1, 0], max: [2, 1.1, 3] }, { min: [2, -1, 0], max: [2.1, 1, 3] }];
  const post = async (pieces) => {
    const c = await flight({ floorZ: 0, boxes: [...walls, ...pieces] });
    const h = 0.15 / 2;
    c.teleport({ pos: [1.9995, 0.9995, 1.46], vel: [0.2, 0.2, 0.3], quat: [Math.cos(h), -Math.sin(h) * Math.SQRT1_2, Math.sin(h) * Math.SQRT1_2, 0] });
    c.motorOverride(-1, 0.55);
    c.step(1500);
    return c.state.pos[2];
  };
  const zSplit = await post([{ min: [2, 1, 0], max: [2.1, 1.1, 1.5] }, { min: [2, 1, 1.5], max: [2.1, 1.1, 3] }]);
  const zOne = await post([{ min: [2, 1, 0], max: [2.1, 1.1, 3] }]);
  console.log(`concave corner, climbing past a post split at 1.5 m: z ${zSplit.toFixed(4)} (post in one piece ${zOne.toFixed(4)})`);
  // A ledge holds z at 1.5000; the climb past the split may differ by the
  // touches along the post's seam.
  assert.ok(zSplit > 1.5005 && Math.abs(zSplit - zOne) < 5e-3, 'no ledge at the split');

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
    if (deep(c.state.pos, boxes)) {
      stuck++;
      console.log(`  pose at ${pos.join(' ')} still inside at ${c.state.pos.map((v) => v.toFixed(4)).join(' ')}`);
    }
  }
  console.log(`poses deep in the solid, on or near seam planes, 9: ${stuck} still deep inside after 300 ms`);
  assert.equal(stuck, 0);
}

console.log('plant-world: box tops, edges, seams, stacks, corners, slabs at walls and map walls, crash cap, pose and spawn edge state, portals frame-independent, rest plant, configure rollback, argument checks, twr, lerp, flat pack, hover current: PASS');
