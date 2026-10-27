// tools/hover-from-log.mjs on synthetic frames shaped like the owner's Air65
// hover log (tests/reference/air65-hover.json): idle, take-off, 56 s of
// steady hover, a throttle blip, more hover, landing. The decoder (quadmath's
// blackbox-log WASM) is not exercised here; this checks the window search and
// the numbers taken from the frames.
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { binRows, findWindow, analyse, analyseTurtle } from '../../tools/hover-from-log.mjs';

const root = new URL('../../', import.meta.url);
const air = JSON.parse(await readFile(new URL('airframes/air65.json', root), 'utf8')).values;
const ACC_1G = 2048;
const header = { motorOutput: [48, 2047], motor_poles: 12, currentSensor: [-600, 750] };

// 100 frames a second; a deterministic wobble instead of noise.
const rows = [];
for (let k = 0; k < 6610; k++) {
  const t = k / 100;
  const w = Math.sin(k * 0.7);
  const hover = (t >= 2 && t < 60) || (t >= 61 && t < 64);
  const u = Math.min(1, Math.max(0, (t - 2) / 58));
  let thr = 1371, motor = 720, erpm = 1942, accZ = ACC_1G + 20 * w, vbat = 4.11 - 0.25 * u, amps = 2.79 + 0.32 * u;
  if (t < 1) { thr = 1000; motor = 60; erpm = 150; accZ = ACC_1G; vbat = 4.24; amps = 0.62; }
  else if (!hover && t < 2) { thr = 1450; motor = 900; erpm = 2300; accZ = 1.3 * ACC_1G; }
  else if (!hover && t < 61) { thr = 1600; motor = 1100; erpm = 2600; accZ = 1.6 * ACC_1G + 300 * w; }
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
    // tools/sim-vs-log.mjs on the same synthetic log: the replayed roll, pitch
    // and yaw rcCommand come back from the sim's Betaflight exactly, the
    // setpoints match, the sim follows the logged mode switches (acro, ANGLE
    // from 6 s, acro from 9 s), the quad flies, and a hover gives no step
    // response.
    const { simVsLog } = await import('../../tools/sim-vs-log.mjs');
    const wasm = await WebAssembly.compile(await readFile(new URL('dist/sim-core.wasm', root)));
    const classDiff = await readFile(new URL('configs/65mm-air65-ryfly-1219s.diff', root), 'utf8');
    const airframe = JSON.parse(await readFile(new URL('airframes/air65.json', root), 'utf8'));
    const file = join(dir, 'replay.BBL');
    writeFileSync(file, synthHoverBbl({ rate: 1000, modes: [[0, 1], [6, 3], [9, 1]] }));
    const sv = await simVsLog(file, qm, { diff: classDiff, airframe, module: wasm, to: 12 });
    console.log(`sim-vs-log (synthetic): rcCommand readback ${sv.rc_readback_max_error.join(', ')}, setpoint rms ${sv.axes.map((x) => x.setpointErrRms).join(', ')}, modes ${sv.log_mode_mask} then ${JSON.stringify(sv.log_mode_changes)}, ${sv.mode_mismatch_ticks} ticks off, height ${sv.sim.height_m.join('..')} m, steps ${sv.axes.map((x) => (x.stepLog || x.stepSim ? 'some' : 'none')).join(', ')}`);
    assert.equal(sv.log_mode_mask, 1, 'ARM alone at the start: acro');
    assert.deepEqual(sv.log_mode_changes, [{ t: 6, mask: 3 }, { t: 9, mask: 1 }], 'the mode switches as logged');
    assert.equal(sv.mode_mismatch_ticks, 0, 'the sim flies the logged modes');
    assert.deepEqual(sv.rc_readback_max_error.slice(0, 3), [0, 0, 0], 'roll, pitch, yaw rcCommand replayed exactly');
    assert.ok(sv.axes.every((x) => x.setpointErrRms === 0), 'setpoints match');
    assert.ok(sv.sim.height_m[1] > 0.5, 'the replayed throttle flies the quad');
    assert.equal(sv.sim.contact_ticks, 0, 'the replay flies in open air');
    assert.ok(sv.axes.every((x) => x.stepLog === null && x.stepSim === null), 'a hover has no step to measure');
    // The sim's own runtime modes, independent of the tool's mask: ANGLE on
    // within an RX update of 6 s, off within one of 9 s.
    const simModes = (x) => x.sim_mode_changes.map((c) => `${c.flags}@${Math.abs(c.t - Math.round(c.t * 2) / 2) <= 0.03 ? Math.round(c.t * 2) / 2 : c.t}`).join(' ');
    assert.equal(simModes(sv), '1@6 0@9', 'the sim switched ANGLE on and off as logged');
    // ANGLE and HORIZON both on (mask 7): Betaflight runs ANGLE alone
    // (fc/core.c:970-990), and the check expects that. A three-position
    // switch (ANGLE high, HORIZON middle, both on AUX2): one channel value
    // per mask.
    writeFileSync(file, synthHoverBbl({ rate: 1000, modes: [[0, 1], [6, 7], [9, 1]] }));
    const both = await simVsLog(file, qm, { diff: classDiff, airframe, module: wasm, to: 12 });
    const threePos = `${classDiff}\naux 1 1 1 1700 2100 0 0\naux 2 2 1 1300 1675 0 0\n`;
    writeFileSync(file, synthHoverBbl({ rate: 1000, modes: [[0, 1], [6, 3], [9, 5], [10.5, 1]] }));
    const sw = await simVsLog(file, qm, { diff: threePos, airframe, module: wasm, to: 12 });
    console.log(`sim-vs-log (synthetic modes): ANGLE ${simModes(sv)}; both on ${simModes(both)}, ${both.mode_mismatch_ticks} ticks off; three-position switch ${simModes(sw)}, ${sw.mode_mismatch_ticks} ticks off`);
    assert.equal(both.mode_mismatch_ticks, 0, 'ANGLE and HORIZON both on: ANGLE');
    assert.equal(simModes(both), '1@6 0@9');
    assert.equal(sw.mode_mismatch_ticks, 0, 'a three-position switch flies the logged modes');
    assert.equal(simModes(sw), '1@6 2@9 0@10.5');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} else {
  console.log('decoder path not run: set QUADMATH_DIR to a quadmath clone (its vendor/blackbox-log.module.js decodes the synthetic log)');
}

// The reference check (owner decision 2026-10-23): the tool's output on the
// owner's hover log, committed as tests/reference/air65-hover.tool.json,
// against the numbers the owner took from the same log by hand
// (tests/reference/air65-hover.json). The tool averages per-second bins and
// drops corrupt frames; the owner averaged frames, hence the small rpm and
// voltage tolerances.
const owner = JSON.parse(await readFile(new URL('tests/reference/air65-hover.json', root), 'utf8'));
const toolRef = JSON.parse(await readFile(new URL('tests/reference/air65-hover.tool.json', root), 'utf8'));
{
  const o = owner.measured;
  const t = toolRef.measured;
  console.log(`reference check: window ${JSON.stringify(toolRef.window_s)} (owner ${JSON.stringify(owner.window_s)}), stick ${t.hover_stick} (${o.hover_stick}), duty ${t.hover_motor_duty} (${o.hover_motor_duty}), eRPM ${t.hover_erpm_logged_mean} (${o.hover_erpm_logged_mean}), rpm ${t.hover_rpm} (${o.hover_rpm}), ${t.vbat_mean_v} V (${o.vbat_mean_v}), ${t.amps_mean_a} A (${o.amps_mean_a}), load fraction ${toolRef.derived.static_load_fraction_hover} (${owner.derived.static_load_fraction_hover})`);
  assert.deepEqual(toolRef.window_s, owner.window_s, 'the tool finds the owner\'s window');
  for (const k of ['hover_throttle_rc', 'hover_stick', 'hover_motor_duty', 'hover_erpm_logged_mean', 'amps_mean_a', 'power_mean_w']) assert.equal(t[k], o[k], k);
  assert.ok(Math.abs(t.hover_rpm / o.hover_rpm - 1) < 1e-3, 'rpm within 0.1 %');
  assert.ok(Math.abs(t.vbat_mean_v - o.vbat_mean_v) < 0.005, 'mean pack voltage within 5 mV');
  assert.deepEqual(t.first_10s, o.first_10s, 'first 10 s');
  assert.equal(toolRef.derived.static_load_fraction_hover, owner.derived.static_load_fraction_hover);
}

// With the decoder and the owner's logs (SIM_CORE_LOGS, tools/logs.mjs): the
// tool on the real log gives the committed output exactly, and sim-vs-log
// replays it (sticks back exact, modes as logged, no step in a hover).
if (qm) {
  const { logPath } = await import('../../tools/logs.mjs');
  const { existsSync } = await import('node:fs');
  const real = logPath(toolRef.source);
  if (existsSync(real)) {
    const { hoverFromLog } = await import('../../tools/hover-from-log.mjs');
    const again = await hoverFromLog(real, qm, air, { 'auw-g': 25.79, 'rest-after': 4.08, pack: 'weBLEEDfpv 340 mAh 1S BT2.0' });
    // tmax_N_at_load_fraction is keyed by the airframe's loadFraction of the
    // day; everything else comes from the log and must match exactly.
    const strip = (o) => { const c = JSON.parse(JSON.stringify(o)); delete c.derived.tmax_N_at_load_fraction; return c; };
    assert.deepEqual(strip(again), strip(toolRef), 'the tool on the real log gives the committed reference');
    const { simVsLog } = await import('../../tools/sim-vs-log.mjs');
    const wasm = await WebAssembly.compile(await readFile(new URL('dist/sim-core.wasm', root)));
    const config = (await Promise.all(['configs/air65-ryfly-2026-10-23.txt', 'configs/air65-ryfly-2026-10-23.from-header.txt'].map((p) => readFile(new URL(p, root), 'utf8')))).join('\n');
    const airframe = JSON.parse(await readFile(new URL('airframes/air65.json', root), 'utf8'));
    const sv = await simVsLog(real, qm, { diff: config, airframe, module: wasm });
    console.log(`real hover log: tool output equals the reference; sim-vs-log rcCommand readback ${sv.rc_readback_max_error.join(', ')}, modes log ${sv.log_mode_mask} (${sv.log_mode_changes.length} changes) sim ${sv.sim.flightModeFlags}, ${sv.mode_mismatch_ticks} ticks off, gyro rms sim ${sv.axes.map((x) => x.gyroRmsSim).join('/')} vs log ${sv.axes.map((x) => x.gyroRmsLog).join('/')} deg/s`);
    assert.deepEqual(sv.rc_readback_max_error.slice(0, 3), [0, 0, 0], 'roll, pitch, yaw replayed exactly');
    assert.ok(sv.rc_readback_max_error[3] <= 2, 'throttle within its smoothing');
    assert.equal(sv.mode_mismatch_ticks, 0, 'the sim flies the logged modes');
    assert.equal(sv.sim.contact_ticks, 0, 'the replay flies in open air');
    assert.ok(sv.axes.every((x) => x.stepLog === null && x.stepSim === null), 'a hover has no step to measure');
  } else {
    console.log(`real hover log not run: ${real} not found (SIM_CORE_LOGS)`);
  }
}
console.log('hover-from-log: window, duty, rpm, kt, load fraction, cell IR from synthetic frames: PASS');

// ---- --turtle: crash flips found from the gyro (analyseTurtle) ----
{
  // 1 kHz frames: still, a 190 deg roll flip (a turtle lands a little past
  // 180) at a half-sine rate, still, a pitch flip whose rate the gyro clips at 2000 deg/s,
  // and a 40 deg wobble that is no flip.
  const t = [];
  const add = (seconds, rate) => {
    const t0 = t.length ? t[t.length - 1].t + 0.001 : 0;
    for (let k = 0; k < seconds * 1000; k++) {
      const s = k / (seconds * 1000);
      t.push({ t: t0 + k / 1000, gyro: rate(s) });
    }
  };
  const still = () => [0, 0, 0];
  const halfSine = (peak) => (s) => peak * Math.sin(Math.PI * s);
  add(0.5, still);
  const rollPeak = (190 * Math.PI) / (2 * 0.4);              // 190 deg over 0.4 s of half-sine
  add(0.4, (s) => [halfSine(rollPeak)(s), 0, 0]);
  add(0.5, still);
  add(0.25, (s) => [0, -Math.min(2000, halfSine(2500)(s)), 0]);
  add(0.5, still);
  add(0.2, (s) => [halfSine(300)(s), 0, 0]);                 // about 38 deg: no flip
  add(0.5, still);
  const out = analyseTurtle(t);
  assert.equal(out.flips.length, 2, JSON.stringify(out.flips));
  const [roll, pitch] = out.flips;
  assert.equal(roll.axis, 'roll');
  assert.ok(Math.abs(roll.rotation_deg - 190) < 1, `roll ${roll.rotation_deg} deg`);
  assert.equal(roll.clipped, false);
  assert.ok(Math.abs(roll.peak_rate_dps - rollPeak) < 1, `roll peak ${roll.peak_rate_dps}`);
  // 180 of 190 deg: (1 - cos(pi s)) / 2 = 18 / 19 at s = 0.856, 342 ms into
  // the half-sine; the run starts where the rate passes 20 deg/s, 3.4 ms in.
  assert.ok(Math.abs(roll.time_to_180_ms - 338.6) <= 2, `roll 180 deg at ${roll.time_to_180_ms} ms`);
  assert.equal(pitch.axis, 'pitch');
  assert.ok(pitch.rotation_deg < -300, `pitch ${pitch.rotation_deg} deg`);
  assert.equal(pitch.clipped, true, 'a peak at the gyro range is clipped');
  assert.ok(out.measured.clipped && out.measured.flips === 2);
  // A window keeps only what is in it.
  assert.equal(analyseTurtle(t, [1.3, 2.0]).flips.length, 1);
  assert.equal(analyseTurtle(t, [2.2, 3.0]).measured, null, 'the wobble alone is no flip');
  console.log(`hover-from-log --turtle: roll flip of 190 deg, 180 deg at ${roll.time_to_180_ms} ms, clipped pitch flip ${pitch.rotation_deg} deg, a 40 deg wobble ignored: PASS`);
}
