// The plan drag (cdAPlan, body Z) that makes the plant climb as a punch-out
// log does: the plant flown through every punch on the log's own duty, and
// its altitude, every 10 ms, least-squared against the log's (owner decision
// 2026-11-03: "least-squares on all four punches' altitude tracks").
//
//   node tools/fit-plan-drag.mjs --airframe airframes/fractal75.json
//        --config configs/<diff>[,configs/<more>] --inflow tests/reference/<quad>-punch-inflow.json
//
// The punches are tools/punch-inflow.mjs's (its reference's punches with a
// trace: 10 ms bins of the logged mean duty and the climb speed, from rest
// 200 ms before the run-up to 250 ms after the plateau). The log's altitude
// is that climb speed summed; it has no altitude of its own, so the track is
// the accelerometer's (punch-inflow's assumptions: at rest and level at the
// start). Each punch is flown as tests/gate-fractal75.mjs K1 flies it:
// - the pack set to the state of charge at which the plant's loaded voltage
//   at the log's current before the run-up is the log's voltage;
// - armed in the air, held at the origin on the trace's first duty for
//   500 ms so the rotors settle, then released;
// - all four motors on the logged mean duty, 10 ms at a time.
// The fit is a golden-section search for the cdAPlan with the least sum of
// squared altitude errors over every sample of every punch; every other
// airframe value is as the airframe has it. A drag fitted this way takes in
// whatever else the plant lacks in a climb (the inflow, tools/punch-inflow.mjs),
// so it is an effective value.
//
// Prints the fit and each punch's residuals at the airframe's cdAPlan and at
// the fit; writes nothing.
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SimCore, sticksToChannels } from '../src/js/sim-core.js';

const SOC = [0, 0.05, 0.15, 0.40, 0.70, 0.90, 1];
const HOLD_TICKS = 500;
// ARM on AUX1, the owner's aux line on both quads.
export const AUX_ARM = [1900, 1000, 1000, 1000];

// The state of charge at which the plant's pack, loaded with amps, reads volts
// (src/plant/plant.c ocvCell, linear between the airframe's seven points).
export function socFor(values, volts, amps) {
  const ocv = volts / values.cells.value + amps * values.cellIR.value;
  const t = values.ocv.value;
  if (ocv >= t[6]) return 1;
  for (let i = 0; i < 6; i++) {
    if (ocv >= t[i] && ocv <= t[i + 1]) return SOC[i] + ((ocv - t[i]) / (t[i + 1] - t[i])) * (SOC[i + 1] - SOC[i]);
  }
  return 0;
}

// One punch flown on its logged duty. punch: a punch-inflow punch (before,
// trace). Returns the pack's state of charge and, per trace bin, the plant's
// climb speed, altitude above the release point and mean accelerometer Z (g)
// at the bin's end.
export async function flyPunch(module, { diff, airframe, punch, aux = AUX_ARM }) {
  const tr = punch.trace;
  const soc = socFor(airframe.values, punch.before.vbat, punch.before.amps);
  const core = await SimCore.load(module, { trace: false });
  core.configure({ diff, plant: airframe, world: { floorZ: -100 } });
  core.reinit({ battery: { soc, vbatFiltered: punch.before.vbat } });
  core.input(sticksToChannels({ throttle: 0 }, aux));
  core.step(50);
  if (!core.fc.armed) throw new Error('the config did not arm on the aux given');
  core.teleport({ pos: [0, 0, 0] });
  core.step(1);
  core.motorOverride(-1, tr.duty[0]);
  for (let k = 0; k < HOLD_TICKS; k++) {
    core.teleport({ pos: [0, 0, 0] });
    core.step(1);
  }
  const z0 = core.state.pos[2];
  const ticks = Math.round(tr.dt_s * 1000);
  const vz = [];
  const z = [];
  const az = [];
  for (const duty of tr.duty) {
    core.motorOverride(-1, duty);
    let a = 0;
    for (let k = 0; k < ticks; k++) {
      core.step(1);
      a += core.fc.acc[2];
    }
    const s = core.state;
    vz.push(s.vel[2]);
    z.push(s.pos[2] - z0);
    az.push(a / ticks);
  }
  return { soc, vz, z, az };
}

// The log's altitude at each trace bin's end: its climb speed summed.
export function logAltitude(punch) {
  const tr = punch.trace;
  let h = 0;
  return tr.v_m_s.map((v) => (h += v * tr.dt_s));
}

// The climb over the run-up's first second (tests/gate-fractal75.mjs K1).
export function climbFirstSecond(punch, vz) {
  const tr = punch.trace;
  const from = Math.round((punch.ramp_start_s - tr.t0_s) / tr.dt_s);
  return vz.slice(from, from + Math.round(1 / tr.dt_s)).reduce((s, v) => s + v * tr.dt_s, 0);
}

// Each punch's altitude residuals with the airframe as given.
export async function trackResiduals(module, { diff, airframe, punches }) {
  const out = [];
  for (const p of punches) {
    const fl = await flyPunch(module, { diff, airframe, punch: p });
    const log = logAltitude(p);
    const err = fl.z.map((h, k) => h - log[k]);
    out.push({
      start_s: p.start_s,
      samples: err.length,
      sse_m2: err.reduce((s, e) => s + e * e, 0),
      rms_m: Math.sqrt(err.reduce((s, e) => s + e * e, 0) / err.length),
      end_m: { sim: fl.z.at(-1), log: log.at(-1), error: err.at(-1) },
      climb_1s_m: { sim: climbFirstSecond(p, fl.vz), log: p.climb_1s_m },
      v_max_m_s: { sim: Math.max(...fl.vz), log: p.v_max_m_s },
    });
  }
  return out;
}

const withPlan = (airframe, cdA) => {
  const a = JSON.parse(JSON.stringify(airframe));
  a.values.cdAPlan.value = cdA;
  return a;
};

// The cdAPlan with the least summed squared altitude error over every
// sample of every punch: golden-section search on [lo, hi].
export async function fitPlanDrag(module, { diff, airframe, punches }, { lo = 0.001, hi = 0.03, tol = 1e-6 } = {}) {
  const sse = async (cdA) => (await trackResiduals(module, { diff, airframe: withPlan(airframe, cdA), punches })).reduce((s, r) => s + r.sse_m2, 0);
  const g = (Math.sqrt(5) - 1) / 2;
  let a = lo;
  let b = hi;
  let c = b - g * (b - a);
  let d = a + g * (b - a);
  let fc = await sse(c);
  let fd = await sse(d);
  let evaluations = 2;
  while (b - a > tol) {
    if (fc < fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - g * (b - a);
      fc = await sse(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + g * (b - a);
      fd = await sse(d);
    }
    evaluations++;
  }
  const cdA = (a + b) / 2;
  return { cdA_m2: cdA, sse_m2: await sse(cdA), evaluations, bracket: [lo, hi] };
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[++i];
  return out;
}

async function main() {
  const a = args(process.argv.slice(2));
  if (!a.airframe || !a.config || !a.inflow) {
    console.error('usage: node tools/fit-plan-drag.mjs --airframe <airframe json> --config <diff>[,<diff>] --inflow <punch-inflow json>');
    process.exit(2);
  }
  const root = fileURLToPath(new URL('..', import.meta.url));
  const read = (p) => readFileSync(resolve(root, p), 'utf8');
  const module = await WebAssembly.compile(readFileSync(resolve(root, 'dist/sim-core.wasm')));
  const airframe = JSON.parse(read(a.airframe));
  const diff = a.config.split(',').map(read).join('\n');
  const punches = JSON.parse(read(a.inflow)).punches.filter((p) => p.from_hover);
  const show = (label, rs) => {
    console.log(label);
    for (const r of rs) {
      console.log(`  punch ${r.start_s} s: altitude rms ${r.rms_m.toFixed(3)} m over ${r.samples} samples; at the end ${r.end_m.sim.toFixed(2)} m against ${r.end_m.log.toFixed(2)} (${r.end_m.error >= 0 ? '+' : ''}${r.end_m.error.toFixed(2)}); climb in 1 s ${r.climb_1s_m.sim.toFixed(3)} against ${r.climb_1s_m.log} (${((r.climb_1s_m.sim / r.climb_1s_m.log - 1) * 100).toFixed(1)} %); top speed ${r.v_max_m_s.sim.toFixed(2)} against ${r.v_max_m_s.log} m/s`);
    }
    console.log(`  sum of squares ${rs.reduce((s, r) => s + r.sse_m2, 0).toFixed(3)} m^2`);
  };
  show(`at the airframe's cdAPlan ${airframe.values.cdAPlan.value} m^2:`, await trackResiduals(module, { diff, airframe, punches }));
  const fit = await fitPlanDrag(module, { diff, airframe, punches });
  show(`at the fit, cdAPlan ${fit.cdA_m2.toPrecision(4)} m^2 (${fit.evaluations} evaluations on [${fit.bracket.join(', ')}]):`, await trackResiduals(module, { diff, airframe: withPlan(airframe, fit.cdA_m2), punches }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
