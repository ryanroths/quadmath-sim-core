// The Fractal75 plant against its own log (owner, 2026-11-03: "gate rows
// banded against this log, not WebFPV"). Prints raw values for every row and
// fails (exit 1) on a miss the owner has not signed off or put under
// investigation in tests/x3-signoff.json (keyed "Fractal75 <row>"). Every band
// is one the Air65's gate already uses for the same row; none is new.
//
//   C1  the owner's diff applies (configs/fractal75-ryfly-2026-11-03.txt;
//       the log's header records nothing it does not reproduce,
//       configs/fractal75-ryfly-2026-11-03.from-header.txt)
//   F7  props out: yaw_motors_reversed reads back ON, and a yaw step from
//       hover in acro turns the way Betaflight asks with no runaway (a plant
//       spinning props in under a props-out mix yaws away from its setpoint)
//   P4  at rest on the floor, Betaflight's accelerometer reads +1 g +-1%
//   H1  hover stick: Betaflight's rcCommand throttle at steady hover, flown
//       on this config and on the pack the log had in its hover window (the
//       state of charge at which the plant's loaded voltage at the log's
//       hover current is the window's mean), within +-0.02 of the log's
//       (the Air65's hover-stick band)
//   P6  thrust law: kt from the hover predicts the punches' onset accZ at
//       their plateau rpm, within 10% (gate-plant P6's band)
//   P7  pack current model within 10% of the logged current on the log's
//       2 krpm bands of at least 8 bins, from the hover rpm up (gate-plant
//       P7's band and bins rule); the bands below hover reported. The law was
//       fitted to this log, so this is not an independent check
//   P8  the plant at the plateau duty on the pack the log had there
//       (reported, as gate-plant P8)
//   K1  each punch flown by the log's own duty: the plant's four motors run
//       the logged mean duty, 10 ms at a time, from rest at the log's pack
//       voltage before the run-up; its climb over the first second of the
//       run-up against the log's (the accelerometer integrated,
//       tests/reference/fractal75-punch-inflow.json), within +-15% (the
//       X3 punch 1 s band)
//   S1  step response: needs the owner's step log, which is missing; not run
//
//   node tests/gate-fractal75.mjs
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import { readFile } from 'node:fs/promises';
import { SimCore, sticksToChannels as ch } from '../src/js/sim-core.js';
import * as feel from './lib/feel.mjs';

const root = new URL('..', import.meta.url);
const json = async (p) => JSON.parse(await readFile(new URL(p, root), 'utf8'));
const module = await WebAssembly.compile(await readFile(new URL('dist/sim-core.wasm', root)));
const f75 = await json('airframes/fractal75.json');
const V = f75.values;
const CONFIG = ['configs/fractal75-ryfly-2026-11-03.txt', 'configs/fractal75-ryfly-2026-11-03.from-header.txt'];
const diff = (await Promise.all(CONFIG.map((p) => readFile(new URL(p, root), 'utf8')))).join('\n');
const hover = await json('tests/reference/fractal75-hover.json');
const punch = await json('tests/reference/fractal75-punch.json');
const inflow = await json('tests/reference/fractal75-punch-inflow.json');
const signoff = await json('tests/x3-signoff.json');

const rows = [];
function row(key, band, ov, rv, pass, extra = '') {
  const measured = ov != null && Number.isFinite(ov);
  const name = `Fractal75 ${key}`;
  const signed = measured && signoff.signedOff && signoff.signedOff[name];
  const probe = measured && signoff.underInvestigation && signoff.underInvestigation[name];
  const ok = measured && pass;
  const verdict = !measured ? 'NOT MEASURED' : ok ? 'pass'
    : probe ? `MISS, ${probe.reason} (${probe.by})`
    : signed ? `MISS, signed off by the owner (${signed.by}, ${signed.date})` : 'MISS';
  rows.push({ name, ok: ok || Boolean(signed || probe) });
  console.log(`   ${key.padEnd(34)} sim-core ${f(ov, 3).padStart(9)}  log ${f(rv, 3).padStart(9)}  band ${band.padEnd(10)} ${verdict}${extra ? `  ${extra}` : ''}`);
}
const f = (v, d = 4) => (v === null || v === undefined ? String(v) : Number(v).toFixed(d));
// Aux channel values with the given boxes on: ARM on AUX1, ANGLE on AUX2
// (the owner's aux lines).
const AUX_ARM = [1900, 1000, 1000, 1000];

// The state of charge at which the plant's pack, loaded with amps, reads volts
// (src/plant/plant.c ocvCell, linear between the airframe's seven points).
const SOC = [0, 0.05, 0.15, 0.40, 0.70, 0.90, 1];
function socFor(volts, amps) {
  const ocv = volts / V.cells.value + amps * V.cellIR.value;
  const t = V.ocv.value;
  if (ocv >= t[6]) return 1;
  for (let i = 0; i < 6; i++) {
    if (ocv >= t[i] && ocv <= t[i + 1]) return SOC[i] + ((ocv - t[i]) / (t[i + 1] - t[i])) * (SOC[i + 1] - SOC[i]);
  }
  return 0;
}

// A flight instance on this config, on the given pack, armed (throttle low)
// in the air far above the floor, level and still at the origin.
async function airborne({ battery = null, extraDiff = '' } = {}) {
  const core = await SimCore.load(module, { trace: false });
  core.configure({ diff: `${diff}\n${extraDiff}`, plant: f75, world: { floorZ: -100 } });
  if (battery) core.reinit({ battery });
  core.input(ch({ throttle: 0 }, AUX_ARM));
  core.step(50);
  if (!core.fc.armed) throw new Error('the Fractal75 config did not arm on AUX1');
  core.teleport({ pos: [0, 0, 0] });
  core.step(1);
  return core;
}

// ---------------------------------------------------------------------------
console.log('== airframe airframes/fractal75.json');
{
  const core = await SimCore.load(module, { trace: false });
  const r = core.configure({ diff, plant: f75 });
  for (const [k, v] of Object.entries(V)) {
    console.log(`   ${k.padEnd(16)} ${JSON.stringify(v.value).padEnd(26)} ${v.unit.padEnd(12)} [${v.confidence}]${v.flag ? ` FLAG: ${v.flag}` : ''}`);
  }
  for (const [k, v] of Object.entries(f75.measured)) if (v && v.flag) console.log(`   measured.${k}: FLAG: ${v.flag}`);
  const d = core.plantDerived;
  console.log(`   derived: ${Object.entries(d).map(([k, v]) => `${k} ${Number(v.toPrecision(6))}`).join(', ')}`);
  console.log(`   full-throttle rpm ${f(d.omegaFull * 60 / (2 * Math.PI), 0)}, hover rpm ${f(d.omegaHover * 60 / (2 * Math.PI), 0)} (log ${hover.measured.hover_rpm}), hover duty ${f(d.dutyHover)} at ${V.vRefCell.value} V`);
  const warned = r.lines.filter((l) => l.status === 'rejected' || l.status === 'error');
  console.log(`\n== C1 config ${CONFIG.join(' + ')}: ${r.applied} lines applied, ${warned.length} not (warnings, per the config rule)`);
  for (const l of warned) console.log(`   warning: line ${l.n} ${l.status}: ${l.text.trim()} (${l.msg})`);
  const missing = ['motor_poles', 'yaw_motors_reversed', 'thr_mid', 'thr_expo', 'dshot_idle_value', 'vbat_warning_cell_voltage'].filter((k) => !r.lines.some((l) => l.status === 'applied' && l.text.includes(k)));
  console.log(`   the throttle path, poles and props-out lines applied: ${missing.length ? `MISSING ${missing.join(', ')}` : 'yes'}`);
  rows.push({ name: 'Fractal75 C1 config', ok: missing.length === 0 });
}

// ---------------------------------------------------------------------------
console.log('\n== F7 props out (yaw_motors_reversed ON): readback, and acro yaw right from hover, 150 ms');
{
  const core = await SimCore.load(module, { trace: false });
  core.configure({ diff, plant: f75 });
  const reversed = core.get('yaw_motors_reversed');
  console.log(`   Betaflight get yaw_motors_reversed: ${reversed}`);
  rows.push({ name: 'Fractal75 F7 readback', ok: reversed === 'ON' });
  // The OFF run is reported: the plant follows Betaflight either way, props in
  // under OFF.
  for (const [label, extra] of [['as configured (ON)', ''], ['set OFF (reported)', 'set yaw_motors_reversed = OFF']]) {
    const c = await airborne({ extraDiff: extra });
    c.input(ch({ throttle: 0.3 }, AUX_ARM));
    c.step(400);
    c.input(ch({ throttle: 0.3, yaw: 0.3 }, AUX_ARM));
    let worst = 0;
    for (let k = 0; k < 150; k++) {
      c.step(1);
      worst = Math.max(worst, Math.abs(c.fc.gyroFiltered[2]));
    }
    const sp = c.fc.setpoint[2];
    const g = c.fc.gyroFiltered[2];
    const tracks = sp < 0 && g < 0 && Math.abs(g) <= 1.5 * Math.abs(sp) && c.fault === 0;
    console.log(`   ${label}: setpoint ${f(sp, 0)} deg/s, gyro ${f(g, 0)} deg/s (peak |gyro| ${f(worst, 0)}) -> ${tracks ? 'tracks' : 'RUNAWAY OR WRONG WAY'}`);
    if (!extra) rows.push({ name: 'Fractal75 F7 yaw tracks', ok: tracks });
  }
}

// ---------------------------------------------------------------------------
console.log('\n== P4 at rest on the floor (Betaflight accelerometer, g)');
{
  const core = await SimCore.load(module, { trace: false });
  core.configure({ diff, plant: f75 });
  core.step(500);
  const acc = core.fc.acc;
  const ok = Math.abs(acc[2] - 1) <= 0.01 && Math.abs(acc[0]) <= 0.01 && Math.abs(acc[1]) <= 0.01;
  console.log(`   z ${f(core.state.pos[2])} m; Betaflight acc ${acc.map((v) => f(v, 5)).join(' ')} g -> ${ok ? 'ok' : 'FAIL'}`);
  rows.push({ name: 'Fractal75 P4 +1 g at rest', ok });
}

// ---------------------------------------------------------------------------
console.log(`\n== log rows: ${hover.source} (${hover.flown})`);
console.log('   H1 hover stick on the log\'s pack, P6 thrust law, P7 current, P8 plateau, K1 punches flown by the log\'s duty');
{
  const m = hover.measured;
  const soc = socFor(m.vbat_mean_v, m.amps_mean_a);
  const sim = await feel.simCoreSim(SimCore, module, { diff, airframe: f75, battery: { soc, vbatFiltered: m.vbat_mean_v } });
  const h = feel.hoverTrim(sim);
  const rc = h.diverged ? null : (sim.core.fc.rcCommand[3] - 1000) / 1000;
  const st = sim.core.state;
  row('H1 hover stick (rcCommand)', '+-0.02', rc, m.hover_stick, rc !== null && Math.abs(rc - m.hover_stick) <= 0.02,
    `channel ${f(h.quantum, 3)}, vz residual ${f(h.vzResidual, 3)} m/s; pack SoC ${f(soc, 3)} (the logged ${f(1 - (m.amps_mean_a * 34) / 3.6 / V.capacityMah.value, 3)} at mid-window), ${f(st.vbatLoaded, 3)} V, ${f(st.amps, 2)} A, ${f(st.rpm.reduce((a, b) => a + b) / 4, 0)} rpm (log ${m.vbat_mean_v} V, ${m.amps_mean_a} A, ${m.hover_rpm} rpm)`);
}
{
  const core = await SimCore.load(module, { trace: false });
  core.configure({ diff, plant: f75 });
  const d = core.plantDerived;
  const w = punch.measured.omega_rad_s;
  const predicted = (4 * d.ktProp * w * w) / (V.mass.value * V.gravity.value);
  const measured = punch.measured.onset_accZ_g;
  row('P6 thrust law, onset (g)', '10%', predicted, measured, Math.abs(predicted / measured - 1) <= 0.1,
    `kt ${d.ktProp.toExponential(4)} at the plateau's ${punch.measured.rpm} rpm; onsets ${punch.punches.map((p) => `${p.start_s} s ${p.onset_accZ_g}`).join(', ')}`);
  const low = inflow.fits.below_1_m_s;
  console.log(`   (P6 reported beside it: below 1 m/s of climb, at ${low.w_over_w_hover.join('-')} x hover rpm, accZ is ${low.accZ_over_p} of rpm squared (${low.bins} bins of 10 ms); by climb speed: ${inflow.speed_bands.filter((b) => b.v_m_s[0] % 3 === 0).map((b) => `${b.v_m_s[0]}-${b.v_m_s[1]} m/s ${b.accZ_over_p}`).join(', ')})`);
}
{
  const { iHover, rpmHover, currentExponent, iQuiescent } = V;
  const ampsAt = (rpm) => iQuiescent.value + iHover.value * (rpm / rpmHover.value) ** currentExponent.value;
  const bands = punch.current_vs_rpm.filter((b) => b.bins >= 8);
  const gated = bands.filter((b) => b.rpm >= rpmHover.value);
  for (const b of bands) {
    console.log(`   P7 ${b.rpm} rpm (${b.bins} bins): model ${f(ampsAt(b.rpm), 2)} A, log ${f(b.amps, 2)} A, ${f((ampsAt(b.rpm) / b.amps - 1) * 100, 1)} %${b.rpm < rpmHover.value ? ' (below hover: reported)' : ''}`);
  }
  const worst = gated.reduce((x, b) => (Math.abs(ampsAt(b.rpm) / b.amps - 1) > Math.abs(ampsAt(x.rpm) / x.amps - 1) ? b : x));
  row('P7 current, worst band (A)', '10%', ampsAt(worst.rpm), worst.amps, gated.length >= 3 && gated.every((b) => Math.abs(ampsAt(b.rpm) / b.amps - 1) <= 0.1),
    `${gated.length} bands from the hover rpm up; worst at ${worst.rpm} rpm; logged current, uncorrected`);
}
{
  const pm = punch.measured;
  const soc = socFor(pm.vbat_v, pm.amps_a);
  const core = await airborne({ battery: { soc, vbatFiltered: pm.vbat_v } });
  core.motorOverride(-1, pm.duty);
  core.step(400);
  const s = core.state;
  const rpm = s.rpm.reduce((a, b) => a + b) / 4;
  console.log(`   P8 (reported) plateau duty ${pm.duty} for 400 ms, pack SoC ${f(soc, 3)}: plant ${f(rpm, 0)} rpm, ${f(s.vbatLoaded, 3)} V, ${f(s.amps, 2)} A, rpm / (KV x V x duty) ${f(rpm / (V.kv.value * s.vbatLoaded * pm.duty), 4)}; log ${pm.rpm} rpm, ${pm.vbat_v} V, ${pm.amps_a} A, ${punch.derived.load_fraction_full}; loadFraction ${V.loadFraction.value}`);
}

// ---------------------------------------------------------------------------
// K1: the plant through each punch on the log's own duty.
for (const p of inflow.punches.filter((x) => x.from_hover)) {
  const tr = p.trace;
  const soc = socFor(p.before.vbat, p.before.amps);
  const core = await airborne({ battery: { soc, vbatFiltered: p.before.vbat } });
  // Held at the origin on the first duty for 500 ms, so the rotors settle
  // where the log's were before the run-up; then free.
  core.motorOverride(-1, tr.duty[0]);
  for (let k = 0; k < 500; k++) {
    core.teleport({ pos: [0, 0, 0] });
    core.step(1);
  }
  const ticks = Math.round(tr.dt_s * 1000);
  const vz = [];
  const az = [];
  for (const duty of tr.duty) {
    core.motorOverride(-1, duty);
    let a = 0;
    for (let k = 0; k < ticks; k++) {
      core.step(1);
      a += core.fc.acc[2];
    }
    vz.push(core.state.vel[2]);
    az.push(a / ticks);
  }
  const from = Math.round((p.ramp_start_s - tr.t0_s) / tr.dt_s);
  const climb = vz.slice(from, from + Math.round(1 / tr.dt_s)).reduce((s, v) => s + v * tr.dt_s, 0);
  const peak = (xs) => Math.max(...xs.slice(0, Math.round((p.end_s - tr.t0_s) / tr.dt_s)));
  row(`K1 punch ${p.start_s} s climb in 1 s (m)`, '+-15%', climb, p.climb_1s_m, Math.abs(climb / p.climb_1s_m - 1) <= 0.15,
    `pack SoC ${f(soc, 3)}; climb speed max ${f(Math.max(...vz), 2)} m/s (log ${p.v_max_m_s}); peak accZ ${f(peak(az), 2)} g (log ${f(peak(tr.accZ_g), 2)})`);
}

console.log('\n== S1 step response (rise, lag, overshoot against a log)');
console.log(`   not run: ${f75.measured.stepLog.source}`);

const failures = rows.filter((r) => !r.ok).map((r) => r.name);
console.log(`\n${failures.length ? `gate-fractal75: FAIL (${failures.length}): ${failures.join('; ')}` : 'gate-fractal75: PASS'}`);
process.exitCode = failures.length ? 1 : 0;
