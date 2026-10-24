// D4 reset vs fresh load: flight A, then reinit(), then flight B, equals a
// fresh load with the same carry-over (EEPROM image, channel map, plant block
// and world, battery state of charge and filtered voltage) running flight B. Compared tick by
// tick over both blocks; 0 mismatching ticks, and the same trace hash.
//
// The pack starts part-drained (a value a fresh boot cannot produce), so the
// carry has to work for the two sides to match: a fresh pack boots with a
// different Betaflight vbat and a different trace, which the test also checks.
// The Air65 plant draws its quiescent current while Betaflight boots, so the
// pack is compared at arm, not at load (owner decision 2026-10-23): both
// sides arm on the same pack, the carried one less the boot's quiescent
// drain, and Betaflight reads that pack.
// On the Air65 plant (65mm) flight A drains the pack, so the carried pack is
// whatever flight A left, and both flights leave the floor; the rest plant
// (75mm, no airframe file yet) leaves the pack as flight A started it.
//
// Every class preset, acro and angle.
//
//   node tests/node/reset-vs-fresh.test.mjs
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { SimCore } from '../../src/js/sim-core.js';
import { diffFor, drive, feeder, jitteredFrames, loadPresets, matrix, script } from '../lib/scenarios.mjs';

const root = new URL('../../', import.meta.url);
const module = await WebAssembly.compile(await readFile(new URL('dist/sim-core.wasm', root)));
const DURATION_MS = 2000;
const PACK = { soc: 0.6, vbatFiltered: 3.85 };
const presets = await loadPresets((path) => readFile(new URL(path, root), 'utf8'));

// Flight B tick by tick: a digest of both blocks after every tick, the
// highest the quad got above where it booted, and the pack and Betaflight's
// vbat on the tick it armed.
function flyB(core, sc) {
  const t0 = core.simTimeUs;
  const z0 = core.state.pos[2];
  const feed = feeder(script(t0, DURATION_MS, sc));
  const ticks = [];
  ticks.climb = 0;
  ticks.atArm = null;
  const end = t0 + DURATION_MS * 1000;
  while (core.simTimeUs < end) {
    drive(core, feed, core.simTimeUs + core.tickUs);
    ticks.push(createHash('sha256').update(core.blockBytes()).digest('hex'));
    ticks.climb = Math.max(ticks.climb, core.state.pos[2] - z0);
    if (!ticks.atArm && core.fc.armed) ticks.atArm = { soc: core.battery.soc, vbatFiltered: core.battery.vbatFiltered, mah: core.state.mah, bfVbat: core.fc.vbat, tUs: core.simTimeUs - t0 };
  }
  return ticks;
}

const scenarios = matrix().filter((s) => !s.mode3d && s.rpm);
// The actuator stage holds state (the motor delay line and the electrical
// lag; owner decision 2026-10-24): with it on, flight A stops 500 ms early,
// armed with the rotors spinning, so the reinit has a full delay line and a
// lag in motion to drop, as a fresh load starts without them.
const withActuator = (af) => ({ ...af, values: { ...af.values, motorDelay: { ...af.values.motorDelay, value: 0.003 }, electricalTau: { ...af.values.electricalTau, value: 0.001 } } });
const cases = [
  ...scenarios.map((sc) => ({ sc, airframe: presets[sc.preset].airframe, name: sc.name, actuator: false })),
  ...scenarios.filter((sc) => presets[sc.preset].airframe).map((sc) => ({ sc, airframe: withActuator(presets[sc.preset].airframe), name: `${sc.name} actuator`, actuator: true })),
];
for (const { sc, airframe, name, actuator } of cases) {
  const preset = { ...presets[sc.preset], airframe };
  const diff = diffFor(sc, preset.diff);

  // Flight A from a part-drained pack, then a reinit on the same SimCore.
  const used = await SimCore.load(module);
  used.configure({ diff, plant: preset.airframe });
  used.reinit({ battery: PACK });
  const a0 = used.simTimeUs;
  // Flight A runs on the frame path and ends partway through a tick, so the
  // reinit has host-side state (the frame accumulator) to drop as well.
  drive(used, feeder(script(a0, DURATION_MS, sc)), a0 + (actuator ? DURATION_MS - 500 : DURATION_MS) * 1000, { frames: jitteredFrames(144, 0xd4) });
  used.advance(0.4);
  assert.ok(used.alpha > 0, 'flight A ends partway through a tick');
  if (actuator) assert.ok(used.fc.armed && Math.min(...used.state.rpm) > 1000, 'flight A ends armed with the rotors spinning');
  const carried = used.battery;
  used.reinit();
  assert.equal(used.alpha, 0, 'reinit drops the frame accumulator');
  const bUsed = flyB(used, sc);

  // A fresh SimCore given the same carry-over.
  const carryConfig = (core) => {
    core.eeprom = used.eeprom.slice();
    core.rcmap = used.rcmap;
    core.plant = used.plant && used.plant.slice();
    core.airframe = used.airframe;
    core.world = used.world;
  };
  const fresh = await SimCore.load(module);
  carryConfig(fresh);
  fresh.reinit({ battery: carried });
  const bFresh = flyB(fresh, sc);

  // The same fresh load with a full pack: the carry must matter.
  const full = await SimCore.load(module);
  carryConfig(full);
  full.reinit({ freshPack: true });
  const fullBoot = { ...full.battery, bfVbat: full.fc.vbat };
  const bFull = flyB(full, sc);

  if (preset.airframe) {
    assert.ok(carried.soc < PACK.soc && carried.vbatFiltered !== PACK.vbatFiltered, `flight A drained the pack (${carried.soc})`);
    assert.ok(bUsed.climb > 0.5, `flight B leaves the floor (${bUsed.climb} m)`);
  }
  else assert.deepEqual(carried, PACK, 'the rest plant leaves the pack as flight A started it');
  // At arm: both sides arm on the same pack, the carried one less what the
  // quiescent current drew between load and arm, and Betaflight reads it.
  const uArm = bUsed.atArm;
  assert.ok(uArm && bFresh.atArm && bFull.atArm, 'every side arms in flight B');
  assert.deepEqual(bFresh.atArm, uArm, 'the fresh load arms on the same pack as the reinit');
  if (preset.airframe) {
    const v = preset.airframe.values;
    // Exactly: the carried state of charge less what the pack gave since the
    // reinit (every rotor is at duty 0 before arm, so that is the quiescent
    // current's charge).
    assert.ok(uArm.mah > 0, 'the quiescent current drew while Betaflight booted');
    assert.ok(Math.abs(carried.soc - uArm.mah / v.capacityMah.value - uArm.soc) <= 1e-12, `the reinit arms on the carried pack less the quiescent drain (${uArm.soc}, ${uArm.mah} mAh drawn)`);
  } else {
    assert.deepEqual({ soc: uArm.soc, vbatFiltered: uArm.vbatFiltered }, carried, 'the rest plant arms on the carried pack');
  }
  assert.notEqual(bFull.atArm.soc, uArm.soc, 'a full pack arms on a different pack');
  // A derived bound, not a tuned one (owner, 2026-10-24): Betaflight's
  // reading of a pack voltage is quantised to its 10 mV steps and its ADC
  // counts. The ADC count is rounded (src/glue/hal_sensors.c adcGetChannel),
  // the display filter's output is truncated to a whole count, and the count
  // is converted to centivolts rounded to the nearest
  // (sensors/voltage.c:163-185). So it reads within half a count above to a
  // count and a half below, plus half a centivolt either way.
  const vb = used.get(['vbat_scale', 'vbat_divider', 'vbat_multiplier']);
  const countV = (Number(vb.vbat_scale) * 3300) / 10 / (0xfff * Number(vb.vbat_divider) * Number(vb.vbat_multiplier)) / 100;
  const off = uArm.bfVbat - uArm.vbatFiltered;
  assert.ok(off >= -(1.5 * countV + 0.005) && off <= 0.5 * countV + 0.005, `Betaflight reads the pack at arm (${uArm.bfVbat} V, pack ${uArm.vbatFiltered} V, one count ${countV.toFixed(5)} V)`);
  assert.equal(bUsed.length, bFresh.length);
  const mismatches = bUsed.filter((h, i) => h !== bFresh[i]).length;
  const fullDiffers = bFull.filter((h, i) => h !== bUsed[i]).length;
  console.log(`${name.padEnd(27)} pack ${carried.soc} / ${carried.vbatFiltered} V, at arm ${uArm.soc} / ${uArm.vbatFiltered} V (Betaflight ${uArm.bfVbat} V) | flight B ${bUsed.length} ticks, climbed ${bUsed.climb.toFixed(2)} m: reinit vs fresh mismatching ${mismatches}; vs a full pack (Betaflight ${fullBoot.bfVbat} V) ${fullDiffers} differ | trace ${used.traceHash().slice(0, 16)} vs ${fresh.traceHash().slice(0, 16)}`);
  assert.equal(mismatches, 0, `${name}: reinit equals a fresh load, tick by tick`);
  assert.equal(used.traceHash(), fresh.traceHash(), `${name}: same trace from boot`);
  assert.equal(fullDiffers, bUsed.length, 'a full pack gives a different flight B on every tick');
  assert.notEqual(full.traceHash(), used.traceHash());
}
console.log(`reset-vs-fresh: ${cases.length} cases (${cases.filter((c) => c.actuator).length} with the actuator stage on), 0 mismatching ticks, carried pack visible to Betaflight: PASS`);
