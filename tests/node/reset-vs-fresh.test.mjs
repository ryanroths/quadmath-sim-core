// D4 reset vs fresh load: flight A, then reinit(), then flight B, equals a
// fresh load with the same carry-over (EEPROM image, channel map, plant block
// and world, battery state of charge and filtered voltage) running flight B. Compared tick by
// tick over both blocks; 0 mismatching ticks, and the same trace hash.
//
// The pack starts part-drained (a value a fresh boot cannot produce), so the
// carry has to work for the two sides to match: a fresh pack boots with a
// different Betaflight vbat and a different trace, which the test also checks.
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

// Flight B tick by tick: a digest of both blocks after every tick, and the
// highest the quad got above where it booted.
function flyB(core, sc) {
  const t0 = core.simTimeUs;
  const z0 = core.state.pos[2];
  const feed = feeder(script(t0, DURATION_MS, sc));
  const ticks = [];
  ticks.climb = 0;
  const end = t0 + DURATION_MS * 1000;
  while (core.simTimeUs < end) {
    drive(core, feed, core.simTimeUs + core.tickUs);
    ticks.push(createHash('sha256').update(core.blockBytes()).digest('hex'));
    ticks.climb = Math.max(ticks.climb, core.state.pos[2] - z0);
  }
  return ticks;
}

const scenarios = matrix().filter((s) => !s.mode3d && s.rpm);
for (const sc of scenarios) {
  const preset = presets[sc.preset];
  const diff = diffFor(sc, preset.diff);

  // Flight A from a part-drained pack, then a reinit on the same SimCore.
  const used = await SimCore.load(module);
  used.configure({ diff, plant: preset.airframe });
  used.reinit({ battery: PACK });
  const a0 = used.simTimeUs;
  // Flight A runs on the frame path and ends partway through a tick, so the
  // reinit has host-side state (the frame accumulator) to drop as well.
  drive(used, feeder(script(a0, DURATION_MS, sc)), a0 + DURATION_MS * 1000, { frames: jitteredFrames(144, 0xd4) });
  used.advance(0.4);
  assert.ok(used.alpha > 0, 'flight A ends partway through a tick');
  const carried = used.battery;
  used.reinit();
  assert.equal(used.alpha, 0, 'reinit drops the frame accumulator');
  const usedBoot = { ...used.battery, bfVbat: used.fc.vbat };
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
  const freshBoot = { ...fresh.battery, bfVbat: fresh.fc.vbat };
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
  assert.deepEqual({ soc: usedBoot.soc, vbatFiltered: usedBoot.vbatFiltered }, carried, 'reinit carries the pack');
  assert.deepEqual({ soc: freshBoot.soc, vbatFiltered: freshBoot.vbatFiltered }, carried, 'the fresh load gets the same pack');
  assert.ok(Math.abs(usedBoot.bfVbat - carried.vbatFiltered) <= 0.011, `Betaflight reads the carried pack (${usedBoot.bfVbat} V)`);
  assert.equal(bUsed.length, bFresh.length);
  const mismatches = bUsed.filter((h, i) => h !== bFresh[i]).length;
  const fullDiffers = bFull.filter((h, i) => h !== bUsed[i]).length;
  console.log(`${sc.name.padEnd(18)} pack ${carried.soc} / ${carried.vbatFiltered} V (Betaflight ${usedBoot.bfVbat} V) | flight B ${bUsed.length} ticks, climbed ${bUsed.climb.toFixed(2)} m: reinit vs fresh mismatching ${mismatches}; vs a full pack (Betaflight ${fullBoot.bfVbat} V) ${fullDiffers} differ | trace ${used.traceHash().slice(0, 16)} vs ${fresh.traceHash().slice(0, 16)}`);
  assert.equal(mismatches, 0, `${sc.name}: reinit equals a fresh load, tick by tick`);
  assert.equal(used.traceHash(), fresh.traceHash(), `${sc.name}: same trace from boot`);
  assert.equal(fullDiffers, bUsed.length, 'a full pack gives a different flight B on every tick');
  assert.notEqual(full.traceHash(), used.traceHash());
}
console.log(`reset-vs-fresh: ${scenarios.length} scenarios, 0 mismatching ticks, carried pack visible to Betaflight: PASS`);
