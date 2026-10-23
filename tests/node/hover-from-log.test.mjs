// tools/hover-from-log.mjs on synthetic frames shaped like the owner's Air65
// hover log (tests/reference/air65-hover.json): idle, take-off, 56 s of
// steady hover, a throttle blip, more hover, landing. The decoder (quadmath's
// blackbox-log WASM) is not exercised here; this checks the window search and
// the numbers taken from the frames.
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { binRows, findWindow, analyse } from '../../tools/hover-from-log.mjs';

const root = new URL('../../', import.meta.url);
const air = JSON.parse(await readFile(new URL('airframes/air65.json', root), 'utf8')).values;
const ACC_1G = 2048;
const header = { motorOutput: [48, 2047], motor_poles: 12, currentSensor: [-600, 750] };

// 100 frames a second; a deterministic wobble instead of noise.
const rows = [];
for (let k = 0; k < 6610; k++) {
  const t = k / 100;
  const w = Math.sin(k * 0.7);
  const hover = (t >= 3 && t < 59) || (t >= 60 && t < 64);
  const u = Math.min(1, Math.max(0, (t - 3) / 56));
  let thr = 1371, motor = 720, erpm = 1942, accZ = ACC_1G + 20 * w, vbat = 4.11 - 0.25 * u, amps = 2.79 + 0.32 * u;
  if (t < 1) { thr = 1000; motor = 60; erpm = 150; accZ = ACC_1G; vbat = 4.24; amps = 0.62; }
  else if (!hover && t < 3) { thr = 1450; motor = 900; erpm = 2300; accZ = 1.3 * ACC_1G; }
  else if (!hover && t < 60) { thr = 1600; motor = 1100; erpm = 2600; accZ = 1.6 * ACC_1G + 300 * w; }
  else if (!hover) { thr = 1200; motor = 400; erpm = 1300; accZ = 0.7 * ACC_1G + 400 * w; }
  rows.push({
    t, thr, vbat, amps,
    m: [motor + 2 * w, motor - 2 * w, motor + w, motor - w],
    erpm: [erpm + 3 * w, erpm - 3 * w, erpm, erpm],
    acc: [5 * w, -5 * w, accZ],
    gyro: [3 * w, -3 * w, 2 * w],
    setp: [0, 0, 0],
  });
}
const bins = binRows(rows);
const window = findWindow(bins, { acc1G: ACC_1G, motorIdle: 60 + 0.02 * 1999 });
console.log(`bins ${bins.length}, window ${JSON.stringify(window)}`);
assert.deepEqual(window, [3, 59], 'the longest steady run: after take-off, before the blip');

const { measured: m, derived: d } = analyse(bins, window, header, air, { auwG: 25.79, restAfter: 4.08, cells: 1 });
console.log(JSON.stringify({ m, d }));
assert.equal(m.hover_throttle_rc, 1371);
assert.equal(m.hover_stick, 0.371);
assert.equal(m.hover_motor_duty, Number(((720 - 48) / 1999).toFixed(3)));
assert.equal(m.hover_erpm_logged_mean, 1942);
// Logged eRPM is eRPM / 100; 12 poles is 6 pole pairs.
assert.equal(m.hover_rpm, Math.round((1942 * 100) / 6));
const omega = ((1942 * 100) / 6) * (2 * Math.PI) / 60;
assert.equal(m.hover_omega_rad_s, Math.round(omega));
assert.ok(Math.abs(d.kt_prop_from_hover_N_per_rad2 / ((0.02579 * air.gravity.value) / (4 * omega * omega)) - 1) < 1e-3, 'kt = m g / (4 w^2)');
const ratio = ((1942 * 100) / 6) / (air.kv.value * m.vbat_mean_v * ((720 - 48) / 1999));
assert.ok(Math.abs(d.static_load_fraction_hover - ratio) < 2e-3, 'hover ratio rpm / (KV V duty)');
// The plant loadFraction reproduces the measured ratio at hover
// (src/plant/plant.c derive(): u V = w / Kv + R kq w^2 / Kt).
const lf = d.plant_load_fraction_for_hover_ratio;
const kvRad = (air.kv.value * 2 * Math.PI) / 60;
const back = 1 / (1 + ((1 - lf) * omega) / (lf * lf * kvRad * air.vRefCell.value));
assert.ok(Math.abs(back - d.static_load_fraction_hover) < 1e-3, `plant lf ${lf} gives hover ratio ${back}`);
assert.ok(Math.abs(d.cell_ir_start_ohm - (4.24 - bins[3].vbat) / (bins[3].amps - 0.62)) < 1e-4, 'cell IR, idle bin against the first hover second');
assert.ok(Math.abs(d.cell_ir_end_ohm - (4.08 - bins[58].vbat) / bins[58].amps) < 1e-4, 'cell IR, rest after against the last hover second');

// Duty is the DShot value as the ESC reads it, not a fraction of the mixer's
// range: a static-idle log (motorOutput 158..2047) gives the same duty.
const staticIdle = analyse(bins, window, { ...header, motorOutput: [158, 2047] }, air, { auwG: 25.79 });
assert.equal(staticIdle.measured.hover_motor_duty, m.hover_motor_duty, 'duty from the DShot range');

// Through the real decoder (quadmath's vendored blackbox-log parser, which is
// not in this repository): a synthetic Betaflight log, plain, with static
// idle, and at high resolution, all give the same hover.
const qm = process.env.QUADMATH_DIR;
if (qm) {
  const { hoverFromLog } = await import('../../tools/hover-from-log.mjs');
  const { synthHoverBbl } = await import('../lib/synth-bbl.mjs');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'hover-from-log-'));
  try {
    for (const [name, opts] of [['plain', {}], ['static idle', { motorLow: 158, idle: 550 }], ['high resolution', { hiRes: true }]]) {
      const file = join(dir, `${name.replace(' ', '-')}.BBL`);
      writeFileSync(file, synthHoverBbl(opts));
      const out = await hoverFromLog(file, qm, air, { 'auw-g': 25.79, 'rest-after': 4.08 });
      console.log(`decoded (${name}): window ${JSON.stringify(out.window_s)}, stick ${out.measured.hover_stick}, duty ${out.measured.hover_motor_duty}, ${out.measured.hover_rpm} rpm, header motorOutput ${out.header.motorOutput}, vbatcellvoltage ${out.header.vbatcellvoltage}`);
      assert.deepEqual(out.window_s, [3, 59]);
      assert.equal(out.measured.hover_stick, 0.371);
      assert.equal(out.measured.hover_motor_duty, Number(((720 - 48) / 1999).toFixed(3)));
      assert.equal(out.measured.hover_rpm, Math.round((1942 * 100) / 6));
      assert.deepEqual(out.header.motorOutput, [opts.motorLow ?? 48, 2047], 'motorOutput from the raw header lines');
      assert.deepEqual(out.header.vbatcellvoltage, [330, 350, 430]);
      assert.deepEqual(out.header.currentSensor, [-600, 750]);
      assert.equal(out.header.thrust_linear, 20);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} else {
  console.log('decoder path not run: set QUADMATH_DIR to a quadmath clone (its vendor/blackbox-log.module.js decodes the synthetic log)');
}
console.log('hover-from-log: window, duty, rpm, kt, load fraction, cell IR from synthetic frames: PASS');
