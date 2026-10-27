// The Air65 pack run to empty on the owner's diff (owner, 2026-10-26: "OCV(SoC)
// must hit the Betaflight min cell voltage (3.30 per header) at 340 mAh drawn
// and fall steeply after ... Test: scripted 2 min flight, pack reaches LAND
// NOW before 340 mAh and can't hover by 380").
//
// - The pack's OCV at SoC 0 (340 mAh drawn) is Betaflight's
//   vbat_min_cell_voltage, read back from the configured Betaflight (330, its
//   header default: sensors/battery.h VBAT_CELL_VOLTAGE_DEFAULT_MIN).
// - A carry accepts SoC down to the floor (-0.15) and refuses below it.
// - A scripted 2 min flight, flown as a pilot might, in angle mode:
//   1. race: full-throttle climbs, stick forward, to 25 m and zero-throttle
//      drops to 8 m, until 315 mAh are drawn (the owner's bat_capacity of
//      300 has passed: time to ease off);
//   2. cruise: hold 6 m until the OSD shows LAND NOW;
//   3. race again, the warning ignored, until 378 mAh or 2 min.
//   LAND NOW is what the quadmath OSD shows: Betaflight's vbat at or below
//   the min cell voltage. In the cruise (half a second in, past the drop's
//   recovery) it must show before 340 mAh are drawn. A punch's sag shows it
//   far earlier; that is reported, not tested.
// - Then full throttle, level, held on to 380 mAh: the last 250 ms before
//   380 mAh give less thrust than the weight. It cannot hover by 380 mAh.
// - Run on past 391 mAh, the pack stays bounded: SoC exactly at the floor,
//   the OCV at its last point, and a respawn (reinit, pack carried) still
//   boots.
//
//   node tests/node/pack-empty.test.mjs
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SimCore } from '../../src/js/sim-core.js';

const root = new URL('../../', import.meta.url);
const wasm = await readFile(new URL('dist/sim-core.wasm', root));
const diff = await readFile(new URL('configs/air65-ryfly-2026-10-23.txt', root), 'utf8');
const air65 = JSON.parse(await readFile(new URL('airframes/air65.json', root), 'utf8'));
const v = air65.values;
const cap = v.capacityMah.value;
const weightN = v.mass.value * v.gravity.value;
const SOC_FLOOR = -0.15;

const core = await SimCore.load(wasm, { trace: false });
core.configure({ diff, plant: air65, world: { floorZ: 0 } });

// ---- OCV at capacity is Betaflight's min cell voltage; SoC is bounded ----
const minCellV = Number(core.get(['vbat_min_cell_voltage']).vbat_min_cell_voltage) / 100;
assert.equal(minCellV, 3.3, 'the owner\'s diff leaves vbat_min_cell_voltage at the header default');
assert.equal(v.ocv.value[0], minCellV, 'OCV at SoC 0 (capacity drawn) is the min cell voltage');
// The open-circuit voltage per cell, from the loaded voltage and the current.
const ocvNow = () => (core.state.vbatLoaded + core.state.amps * v.cellIR.value * v.cells.value) / v.cells.value;
let prevV = Infinity;
for (const soc of [0, -0.05, -0.1, SOC_FLOOR]) {
  core.reinit({ battery: { soc, vbatFiltered: 0 } });
  assert.ok(ocvNow() < prevV, `the OCV falls past the capacity (SoC ${soc}: ${ocvNow().toFixed(3)} V)`);
  prevV = ocvNow();
}
assert.throws(() => core.reinit({ battery: { soc: SOC_FLOOR - 0.01, vbatFiltered: 0 } }), /battery carry/, 'a carry below the floor is refused');
console.log(`OCV per cell: ${minCellV} V at ${cap} mAh, ${v.ocvOverDischarge.value.join(', ')} V at ${[0.05, 0.1, 0.15].map((x) => Math.round(cap * (1 + x))).join(', ')} mAh`);

// A physical airframe whose over-discharge OCV rises is refused.
const rising = { ...air65, values: { ...v, ocvOverDischarge: { value: [2.8, 3.0, 0.5] } } };
assert.throws(() => core.configure({ diff, plant: rising, world: { floorZ: 0 } }), /plant block refused/);

// ---- The scripted 2 min flight ----
core.configure({ diff, plant: air65, world: { floorZ: 0 } });
// Roll, pitch, yaw, throttle, AUX1 ARM, AUX2 ANGLE (on), AUX3, AUX4.
const ch = [1500, 1500, 1500, 1000, 1000, 2000, 1000, 1000];
const us = (x) => Math.round(1500 + 500 * Math.max(-1, Math.min(1, x)));
const thrust = () => core.state.thrustN.reduce((a, b) => a + Math.abs(b), 0);
function run(ms, ctl, each) {
  for (let k = 0; k < ms; k++) {
    if (k % 4 === 0) {
      if (ctl) ctl();
      core.input(ch, core.simTimeUs);
    }
    core.step(1);
    if (each) each();
  }
}
run(1500);
ch[4] = 2000;
run(300);
assert.equal(core.fc.armed, true, `armed (flags ${core.fc.armingDisableFlags})`);
const t0 = core.simTimeUs;
const secs = () => (core.simTimeUs - t0) / 1e6;
let phase = 'climb';
let racing = true;
let phaseAt = 0;
let landNow = null;
let firstDip = null;
let atEmpty = null;
const to = (p) => { phase = p; phaseAt = secs(); };
const ctl = () => {
  const s = core.state;
  if (racing && landNow === null && s.mah >= 315) { racing = false; to('cruise'); }
  if (!racing && landNow !== null) { racing = true; to('climb'); }
  if (phase === 'climb' && s.pos[2] > 25) to('drop');
  else if (phase === 'drop' && s.pos[2] < 8) to('climb');
  let thr = 0;
  let pitch = 0;
  if (phase === 'climb') { thr = 1; pitch = 1; }
  else if (phase === 'cruise') thr = Math.max(0, Math.min(1, 0.45 + 0.15 * (6 - s.pos[2]) - 0.25 * s.vel[2]));
  ch[1] = us(pitch);
  ch[3] = Math.round(1000 + 1000 * thr);
};
const done = () => secs() >= 120 || core.state.mah >= 378;
while (!done()) {
  run(4, ctl, () => {
    const s = core.state;
    if (firstDip === null && core.fc.vbat <= minCellV) firstDip = { t: secs(), mah: s.mah, phase };
    if (atEmpty === null && s.soc <= 0) atEmpty = { mah: s.mah, ocv: ocvNow() };
    if (landNow === null && phase === 'cruise' && secs() - phaseAt >= 0.5 && core.fc.vbat <= minCellV) {
      landNow = { t: secs(), mah: s.mah, vbat: core.fc.vbat, amps: s.amps };
    }
  });
}
const flown = { t: secs(), mah: core.state.mah };
assert.ok(atEmpty, 'the flight reaches SoC 0');
console.log(`SoC 0 at ${atEmpty.mah.toFixed(2)} mAh drawn: OCV ${atEmpty.ocv.toFixed(4)} V per cell`);
assert.ok(Math.abs(atEmpty.mah - cap) < 0.01, 'SoC 0 is the capacity drawn');
assert.ok(Math.abs(atEmpty.ocv - minCellV) < 0.001, 'the OCV there is the min cell voltage');
console.log(`first OSD dip to ${minCellV} V: ${firstDip ? `${firstDip.t.toFixed(1)} s, ${firstDip.mah.toFixed(0)} mAh (${firstDip.phase})` : 'never'}`);
assert.ok(landNow, 'LAND NOW in the cruise');
console.log(`LAND NOW in the cruise: ${landNow.t.toFixed(1)} s, ${landNow.mah.toFixed(1)} mAh, OSD ${landNow.vbat.toFixed(2)} V at ${landNow.amps.toFixed(1)} A`);
assert.ok(landNow.mah < cap, `LAND NOW in the cruise before ${cap} mAh (${landNow.mah.toFixed(1)})`);
assert.ok(flown.mah >= cap, `the 2 min flight empties the pack (${flown.mah.toFixed(0)} mAh in ${flown.t.toFixed(0)} s)`);

// Full throttle, level, from the flight's end until 380 mAh are drawn: the
// thrust over the last 250 ms before 380 mAh is less than the weight.
const fromMah = core.state.mah;
ch[1] = 1500;
ch[3] = 2000;
const window = [];
let stallMah = null;
let twr = null;
for (let ms = 0; ms < 60_000 && twr === null; ms++) {
  run(1, null, () => {
    window.push(thrust());
    if (window.length > 250) window.shift();
    const mean = window.reduce((a, b) => a + b, 0) / window.length;
    if (window.length === 250) {
      if (mean < weightN) { if (stallMah === null) stallMah = core.state.mah; } else stallMah = null;
    }
    if (core.state.mah >= 380) twr = mean / weightN;
  });
}
assert.ok(twr !== null, 'reaches 380 mAh');
console.log(`full throttle, level, from ${fromMah.toFixed(0)} mAh: thrust below the weight from ${stallMah === null ? 'never' : stallMah.toFixed(1) + ' mAh'}; at 380 mAh thrust/weight ${twr.toFixed(3)}, z ${core.state.pos[2].toFixed(2)} m, OSD ${core.fc.vbat.toFixed(2)} V`);
assert.ok(twr < 1, 'cannot hover at 380 mAh');

// ---- Bounded: run on past the floor, then respawn with the pack carried ----
// Past -0.15 (391 mAh) the SoC stops at the floor though current still flows
// (the electronics' quiescent draw), and the OCV holds its last point.
const floorMah = cap * (1 - SOC_FLOOR);
let floorAt = null;
for (let k = 0; k < 120 && floorAt === null; k++) {
  run(1000);
  if (core.state.mah > floorMah + 2) floorAt = core.state.mah;
}
assert.ok(floorAt !== null, `drew past ${floorMah.toFixed(0)} mAh (${core.state.mah.toFixed(1)})`);
const s = core.state;
assert.equal(s.soc, SOC_FLOOR, `SoC at the floor with ${s.mah.toFixed(1)} mAh drawn`);
assert.ok(Math.abs(ocvNow() - v.ocvOverDischarge.value[2]) < 1e-9, `the OCV at its last point (${ocvNow()} V)`);
assert.ok(Number.isFinite(s.vbatLoaded) && s.vbatLoaded >= 0, `pack voltage finite (${s.vbatLoaded})`);
console.log(`run on to ${s.mah.toFixed(0)} mAh: SoC ${s.soc.toFixed(3)} (the floor), OCV ${ocvNow().toFixed(2)} V, pack ${s.vbatLoaded.toFixed(2)} V`);
const soc = core.battery.soc;
assert.doesNotThrow(() => core.reinit());
// The boot after a respawn draws its quiescent current (D4's relation).
assert.ok(Math.abs(core.battery.soc - Math.max(SOC_FLOOR, soc - core.state.mah / cap)) < 1e-9, `a respawn carries the over-discharged pack (${soc} -> ${core.battery.soc})`);
console.log('pack empty: ok');
