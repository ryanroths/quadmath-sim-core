// Thrust against climb speed in a punch-out log: what each punch's specific
// force says about the thrust law once the quad is climbing, beside the
// hover's rpm-squared prediction. The plateau tool (tools/hover-from-log.mjs
// --plateau) compares the hover's kt with the punch's onset; this follows the
// whole punch, so a shortfall can be told apart: one that is there at any
// speed (a static law, thrust falling with rpm) from one that grows with the
// climb (inflow: the prop meets air already moving through it, and drag).
//
//   node tools/punch-inflow.mjs <log.BBL> --quadmath <quadmath clone>
//        --punch tests/reference/<quad>-punch.json --hover tests/reference/<quad>-hover.json
//        [--airframe airframes/<quad>.json] [--log 0] [--current-scale 1] [--out file.json]
//
// <log.BBL> is a path, or a name in SIM_CORE_LOGS (tools/logs.mjs). The
// punches are the plateau tool's (start_s, end_s); the hover's rotor speed
// and duty are the hover tool's (measured.hover_rpm, hover_motor_duty); mass,
// prop diameter, air density and gravity come from the airframe, mass from
// the hover file's auw_g when it has one.
//
// Per punch:
// - the run-up: the 10 ms bins before the plateau whose duty stays above the
//   hover duty + 0.1, back to the last one that does not; the 200 ms before
//   it must look like hover (duty within 0.1 of the hover duty, accZ within
//   0.3 g of 1 g), else the punch is listed and left out (its climb does not
//   start from rest);
// - the climb speed: from 200 ms before the run-up, at rest and level (an
//   assumption: a log has no attitude or speed), the gyro turns the attitude
//   and the accelerometer, less gravity, gives the velocity in the world; the
//   axial speed is its part along the thrust axis (body Z), the speed of the
//   air through the props;
// - 10 ms bins of duty, rpm, accZ (g) and axial speed, the climb over the
//   first second of the run-up, and the cell IR from the 200 ms of hover
//   before the run-up to the steady plateau (as the plateau tool's, which
//   needs its own 300..100 ms before the plateau to be hover).
// Pooled over the punches from hover, the bins with the rotors above hover
// rpm and duty above 0.3:
// - accZ / (w / w_hover)^2 in 1 m/s bands of axial speed: what is left of the
//   hover's rpm-squared thrust, less drag, as the climb builds;
// - least-squares fits of accZ (g) with p = (w / w_hover)^2:
//     rpm squared        accZ = p
//     static exponent    accZ = p^(n/2)              (a kt that falls with rpm)
//     inflow             accZ = p (1 - J / J0)       J = V / (n_rev D), the advance ratio
//     drag               accZ = p - rho cdA V|V| / (2 m g)
//     inflow and drag    both terms
//   with their rms; the inflow term alone at a few fixed plan drags (the
//   airframe's cdAPlan among them); and the exponent each bin below 1 m/s
//   gives by itself. A vertical punch alone hardly tells inflow from drag:
//   both take thrust away as the climb builds.
// accSmooth is Betaflight's accelerometer after its PT2 at acc_lpf_hz (25 Hz
// here, about 8 ms of lag; sensors/acceleration_init.c:377-381); p is taken
// from w^2 through the same PT2, so a fast spin-up lags alike in both.
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLog } from './hover-from-log.mjs';
import { logPath as findLog } from './logs.mjs';

const TWO_PI = 2 * Math.PI;
const DEG = Math.PI / 180;
const BIN = 0.01;
const RAMP_DUTY = 0.1;
const PRE_S = 0.2;
const AFTER_S = 0.25;
export const INFLOW_RULES = 'run-up: the 10 ms bins before the plateau with duty above hover + 0.1; from hover: the 200 ms before it within 0.1 of the hover duty and 0.3 g of 1 g; climb speed integrated from rest and level 200 ms before the run-up (gyro attitude, accelerometer less gravity), axial = along body Z; pooled bins: rotors above hover rpm, duty above 0.3, from the run-up to 250 ms after the plateau';

const round = (v, d) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const dutyOf = (motor) => (motor - 48) / 1999;

// Betaflight's PT2 gain (common/filter.c pt2FilterGain): two PT1 stages,
// each cut off 1.554 x higher so the pair is -3 dB at hz.
const pt2Gain = (hz, dt) => {
  const rc = 1 / (TWO_PI * hz * 1.553774);
  return dt / (rc + dt);
};

// rows: hover-from-log readLog rows (t s, m, erpm, acc, gyro, vbat, amps).
// The rows from t0 to t1 in 10 ms bins, with the climb integrated from t0
// (at rest and level then). w2f is the mean rotor speed squared ((rad/s)^2)
// through the accelerometer's PT2 at accLpfHz, run from 1 s before t0, so it
// lags as accZ does.
export function climbBins(rows, t0, t1, { acc1G, motorPoles, gravity = 9.81, currentScale = 1, accLpfHz = 25 }) {
  let q = [1, 0, 0, 0];
  let v = [0, 0, 0];
  const bins = [];
  let bin = null;
  const w2Of = (r) => ((((r.erpm.reduce((x, y) => x + y, 0) / r.erpm.length) * 100) / (motorPoles / 2)) * TWO_PI / 60) ** 2;
  let i = rows.findIndex((r) => r.t >= t0 - 1);
  if (i < 0) return bins;
  let f1 = w2Of(rows[i]);
  let f2 = f1;
  for (; i + 1 < rows.length && rows[i].t < t0; i++) {
    const k = pt2Gain(accLpfHz, rows[i + 1].t - rows[i].t);
    f1 += k * (w2Of(rows[i]) - f1);
    f2 += k * (f1 - f2);
  }
  for (; i < rows.length && rows[i].t < t1; i++) {
    const r = rows[i];
    const dt = i + 1 < rows.length ? rows[i + 1].t - r.t : 0;
    const kf = pt2Gain(accLpfHz, dt || 5e-4);
    f1 += kf * (w2Of(r) - f1);
    f2 += kf * (f1 - f2);
    // Betaflight's gyro is the body rate in the module frame (X forward, Y
    // left, Z up; src/plant/plant.c), deg/s.
    const w = r.gyro.map((x) => x * DEG);
    const [a, b, c, d] = q;
    q = [a - 0.5 * dt * (b * w[0] + c * w[1] + d * w[2]), b + 0.5 * dt * (a * w[0] + c * w[2] - d * w[1]),
      c + 0.5 * dt * (a * w[1] - b * w[2] + d * w[0]), d + 0.5 * dt * (a * w[2] + b * w[1] - c * w[0])];
    const n = Math.hypot(...q);
    q = q.map((x) => x / n);
    const [qw, qx, qy, qz] = q;
    const xb = [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy + qw * qz), 2 * (qx * qz - qw * qy)];
    const yb = [2 * (qx * qy - qw * qz), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz + qw * qx)];
    const zb = [2 * (qx * qz + qw * qy), 2 * (qy * qz - qw * qx), 1 - 2 * (qx * qx + qy * qy)];
    const f = r.acc.map((x) => (x / acc1G) * gravity);
    const aw = [0, 1, 2].map((k) => xb[k] * f[0] + yb[k] * f[1] + zb[k] * f[2] - (k === 2 ? gravity : 0));
    const k = Math.floor((r.t - t0) / BIN + 1e-9);
    if (!bin || bin.k !== k) {
      bin = { k, n: 0, duty: 0, rpm: 0, w2f: 0, accZ: 0, v: 0, vz: 0, tilt: 0, vbat: 0, amps: 0 };
      bins.push(bin);
    }
    bin.n++;
    bin.w2f += f2;
    bin.duty += dutyOf(r.m.reduce((x, y) => x + y, 0) / r.m.length);
    bin.rpm += ((r.erpm.reduce((x, y) => x + y, 0) / r.erpm.length) * 100) / (motorPoles / 2);
    bin.accZ += r.acc[2] / acc1G;
    bin.v += v[0] * zb[0] + v[1] * zb[1] + v[2] * zb[2];
    bin.vz += v[2];
    bin.tilt += Math.acos(Math.max(-1, Math.min(1, zb[2]))) / DEG;
    bin.vbat += r.vbat;
    bin.amps += r.amps * currentScale;
    v = v.map((x, j) => x + aw[j] * dt);
  }
  return bins.map((b) => ({
    t: t0 + b.k * BIN, duty: b.duty / b.n, rpm: b.rpm / b.n, w2f: b.w2f / b.n, accZ: b.accZ / b.n,
    v: b.v / b.n, vz: b.vz / b.n, tilt: b.tilt / b.n, vbat: b.vbat / b.n, amps: b.amps / b.n,
  }));
}

// The start of the run-up into a plateau beginning at start (s): bins are
// 10 ms climbBins-style bins (t, duty) covering the time before it.
export function rampStart(bins, start, hoverDuty) {
  let k = bins.findIndex((b) => b.t >= start - 1e-9);
  if (k < 0) k = bins.length;
  while (k > 0 && bins[k - 1].duty > hoverDuty + RAMP_DUTY) k--;
  return k < bins.length ? bins[k].t : start;
}

// Least squares of y = sum c_j x_j (no constant): coefficients and rms.
export function lsq(ys, xs) {
  const m = xs.length;
  const M = Array.from({ length: m }, () => new Array(m).fill(0));
  const r = new Array(m).fill(0);
  ys.forEach((y, i) => {
    for (let a = 0; a < m; a++) {
      r[a] += xs[a][i] * y;
      for (let c = 0; c < m; c++) M[a][c] += xs[a][i] * xs[c][i];
    }
  });
  for (let a = 0; a < m; a++) {
    for (let c = a + 1; c < m; c++) {
      const f = M[c][a] / M[a][a];
      for (let d = a; d < m; d++) M[c][d] -= f * M[a][d];
      r[c] -= f * r[a];
    }
  }
  const sol = new Array(m).fill(0);
  for (let a = m - 1; a >= 0; a--) {
    let s = r[a];
    for (let c = a + 1; c < m; c++) s -= M[a][c] * sol[c];
    sol[a] = s / M[a][a];
  }
  const res = ys.map((y, i) => y - xs.reduce((s, x, j) => s + x[i] * sol[j], 0));
  return { coef: sol, rms: Math.sqrt(mean(res.map((e) => e * e))) };
}

// p = (w / w_hover)^2 of a bin, from its filtered w^2 (climbBins w2f).
const pOf = (b, omegaH) => b.w2f / (omegaH * omegaH);

// The pooled analysis. bins: climbBins bins with the rotors driven; omegaH
// rad/s; air: { massKg, propDiameter, airDensity, gravity }; cdAs: plan drags
// (m^2) at which the inflow term is fitted alone, as a plant would hold its
// drag fixed and take J0 from the log.
export function fitThrust(bins, omegaH, air, cdAs = []) {
  const p = bins.map((b) => pOf(b, omegaH));
  const acc = bins.map((b) => b.accZ);
  const y = acc.map((a, i) => a - p[i]);
  const xInflow = bins.map((b, i) => -Math.sqrt(p[i]) * b.v);
  const xDrag = bins.map((b) => -b.v * Math.abs(b.v));
  const { massKg: m, propDiameter: D, airDensity: rho, gravity: g } = air;
  // J0 <= 0 means the drag takes more than the whole shortfall: the fit wants
  // thrust to grow with the climb; reported as null.
  const j0 = (beta) => (beta > 0 ? TWO_PI / (beta * omegaH * D) : null);
  const cdA = (gamma) => (2 * gamma * m * g) / rho;
  const gammaOf = (c) => (c * rho) / (2 * m * g);
  const rpm2 = Math.sqrt(mean(y.map((e) => e * e)));
  let exp = null;
  for (let n100 = 100; n100 <= 220; n100++) {
    const n = n100 / 100;
    const rms = Math.sqrt(mean(acc.map((a, i) => (a - p[i] ** (n / 2)) ** 2)));
    if (!exp || rms < exp.rms) exp = { n, rms };
  }
  const inflow = lsq(y, [xInflow]);
  const drag = lsq(y, [xDrag]);
  const both = lsq(y, [xInflow, xDrag]);
  const low = bins.map((b, i) => ({ b, p: p[i] })).filter(({ b, p: pi }) => b.v < 1 && Math.sqrt(pi) > 1.15);
  return {
    bins: bins.length,
    rpm_squared: { rms_g: round(rpm2, 3) },
    static_exponent: { n: exp.n, rms_g: round(exp.rms, 3) },
    inflow: { J0: round(j0(inflow.coef[0]), 3), rms_g: round(inflow.rms, 3) },
    drag: { cdA_m2: round(cdA(drag.coef[0]), 5), rms_g: round(drag.rms, 3) },
    inflow_and_drag: { J0: round(j0(both.coef[0]), 3), cdA_m2: round(cdA(both.coef[1]), 5), rms_g: round(both.rms, 3) },
    inflow_at_cdA: cdAs.map((c) => {
      const f = lsq(y.map((e, i) => e - gammaOf(c) * xDrag[i]), [xInflow]);
      return { cdA_m2: c, J0: round(j0(f.coef[0]), 3), beta: round(f.coef[0], 4), rms_g: round(f.rms, 3) };
    }),
    below_1_m_s: low.length ? {
      bins: low.length,
      w_over_w_hover: [round(Math.min(...low.map((x) => Math.sqrt(x.p))), 2), round(Math.max(...low.map((x) => Math.sqrt(x.p))), 2)],
      accZ_over_p: round(mean(low.map((x) => x.b.accZ / x.p)), 3),
      exponent: round(mean(low.map((x) => 2 + Math.log(x.b.accZ / x.p) / Math.log(Math.sqrt(x.p)))), 3),
    } : null,
  };
}

// accZ / p in 1 m/s bands of axial speed.
export function speedBands(bins, omegaH) {
  const bands = [];
  for (let lo = 0; lo < 30; lo++) {
    const set = bins.filter((b) => b.v >= lo && b.v < lo + 1);
    if (set.length < 3) continue;
    const p = set.map((b) => pOf(b, omegaH));
    bands.push({
      v_m_s: [lo, lo + 1], bins: set.length, v: round(mean(set.map((b) => b.v)), 2),
      w_over_w_hover: round(mean(set.map((b) => (b.rpm * TWO_PI) / 60 / omegaH)), 3),
      accZ_g: round(mean(set.map((b) => b.accZ)), 3), p: round(mean(p), 3), accZ_over_p: round(mean(set.map((b, i) => b.accZ / p[i])), 3),
    });
  }
  return bands;
}

export async function punchInflow(logPath, quadmathDir, { punch, hover, airframe }, opts = {}) {
  const li = Number(opts.log ?? punch.log_index ?? 0);
  const log = await readLog(logPath, quadmathDir, li);
  const scale = opts['current-scale'] == null ? 1 : Number(opts['current-scale']);
  const air = airframe.values;
  const fit = {
    massKg: hover.measured.auw_g ? hover.measured.auw_g / 1000 : air.mass.value,
    propDiameter: air.propDiameter.value, airDensity: air.airDensity.value, gravity: air.gravity.value,
  };
  const omegaH = (hover.measured.hover_rpm * TWO_PI) / 60;
  const hoverDuty = hover.measured.hover_motor_duty;
  const cells = hover.measured.cells ?? air.cells.value;
  // acc_lpf_hz is logged x 100 (tools/config-from-log.mjs).
  const accLpfHz = Number(log.rawHeader.acc_lpf_hz) / 100 || 25;
  const binOpts = { acc1G: log.acc1G, motorPoles: log.header.motor_poles, gravity: fit.gravity, currentScale: scale, accLpfHz };
  const pooled = [];
  const punches = punch.punches.map((pp) => {
    const lead = climbBins(log.rows, pp.start_s - 2, pp.start_s + BIN, binOpts);
    const ramp = rampStart(lead, pp.start_s, hoverDuty);
    const pre = lead.filter((b) => b.t >= ramp - PRE_S - 1e-9 && b.t < ramp - 1e-9);
    const preDuty = pre.length ? mean(pre.map((b) => b.duty)) : null;
    const preAcc = pre.length ? mean(pre.map((b) => b.accZ)) : null;
    const fromHover = pre.length > 0 && Math.abs(preDuty - hoverDuty) <= RAMP_DUTY && Math.abs(preAcc - 1) <= 0.3;
    const out = {
      start_s: pp.start_s, end_s: pp.end_s, ramp_start_s: round(ramp, 2), run_up_s: round(pp.start_s - ramp, 2),
      before: pre.length ? { duty: round(preDuty, 3), accZ_g: round(preAcc, 3), vbat: round(mean(pre.map((b) => b.vbat)), 3), amps: round(mean(pre.map((b) => b.amps)), 2) } : null,
      from_hover: fromHover,
    };
    if (!fromHover) return out;
    const t0 = ramp - PRE_S;
    const bins = climbBins(log.rows, t0, pp.end_s + AFTER_S, binOpts);
    const steady = bins.filter((b) => b.t >= pp.start_s + 0.1 - 1e-9 && b.t < pp.end_s - 1e-9);
    const at = (t) => bins.reduce((best, b) => (Math.abs(b.t - t) < Math.abs(best.t - t) ? b : best));
    // The peak specific force over 50 ms (five bins, centred), as the plateau
    // tool's 50 ms onset bins read it.
    const smooth = bins.map((b, k) => {
      const set = bins.slice(Math.max(0, k - 2), k + 3);
      return { ...b, accZ: mean(set.map((x) => x.accZ)), w2f: mean(set.map((x) => x.w2f)), rpm: mean(set.map((x) => x.rpm)), v: mean(set.map((x) => x.v)) };
    });
    const peak = smooth.filter((b) => b.t < pp.end_s).reduce((x, b) => (b.accZ > x.accZ ? b : x));
    const climb1s = bins.filter((b) => b.t >= ramp - 1e-9 && b.t < ramp + 1 - 1e-9).reduce((s, b) => s + b.v * BIN, 0);
    if (steady.length) {
      const sv = mean(steady.map((b) => b.vbat));
      const sa = mean(steady.map((b) => b.amps));
      out.steady = { duty: round(mean(steady.map((b) => b.duty)), 3), rpm: Math.round(mean(steady.map((b) => b.rpm))), vbat: round(sv, 3), amps: round(sa, 2) };
      out.cell_ir_ohm = round((out.before.vbat - sv) / ((sa - out.before.amps) * cells), 4);
    }
    out.at_plateau_start = { v_m_s: round(at(pp.start_s).v, 2), rpm: Math.round(at(pp.start_s).rpm) };
    out.peak_accZ = { g: round(peak.accZ, 3), t_s: round(peak.t, 2), rpm: Math.round(peak.rpm), v_m_s: round(peak.v, 2), p: round(pOf(peak, omegaH), 3) };
    out.v_at_end_m_s = round(at(pp.end_s).v, 2);
    out.v_max_m_s = round(Math.max(...bins.map((b) => b.v)), 2);
    out.climb_1s_m = round(climb1s, 3);
    out.tilt_max_deg = round(Math.max(...bins.filter((b) => b.t < pp.end_s).map((b) => b.tilt)), 1);
    // The trace a plant can be flown through (tests/gate-fractal75.mjs):
    // 10 ms bins from t0 (rest, 200 ms before the run-up).
    out.trace = {
      t0_s: round(t0, 3), dt_s: BIN,
      duty: bins.map((b) => round(b.duty, 4)), rpm: bins.map((b) => Math.round(b.rpm)),
      accZ_g: bins.map((b) => round(b.accZ, 3)), v_m_s: bins.map((b) => round(b.v, 3)),
      vbat: bins.map((b) => round(b.vbat, 3)),
    };
    for (const b of bins) if (b.t >= ramp - 1e-9 && b.duty > 0.3 && (b.rpm * TWO_PI) / 60 > omegaH) pooled.push(b);
    return out;
  });
  // The pack's charge at each run-up, from the logged current: mAh drawn
  // since the first frame (x the current scale).
  let mah = 0;
  const rows = log.rows;
  const runUps = punches.map((p) => p.ramp_start_s).filter((x) => x != null);
  const drawn = {};
  for (let i = 1, k = 0; i < rows.length && k < runUps.length; i++) {
    mah += (rows[i - 1].amps * scale * (rows[i].t - rows[i - 1].t)) / 3.6;
    while (k < runUps.length && rows[i].t >= runUps[k] - PRE_S) drawn[runUps[k++]] = round(mah, 1);
  }
  for (const p of punches) p.mah_drawn_before = drawn[p.ramp_start_s] ?? null;
  const dur = log.rows[log.rows.length - 1].t;
  return {
    source: basename(logPath),
    log_index: li,
    mode: 'thrust against climb speed',
    rule: INFLOW_RULES,
    flown: [log.info.datetime, log.info.craft, log.info.board, log.info.firmware].filter(Boolean).join(', '),
    log: { frames: log.rows.length, duration_s: round(dur, 1), rate_hz: Math.round(log.rows.length / dur), corrupt_frames_dropped: log.dropped, acc_lpf_hz: Number(log.rawHeader.acc_lpf_hz) / 100 },
    current_scale: scale,
    hover: { omega_rad_s: round(omegaH, 1), duty: hoverDuty, mass_kg: fit.massKg },
    prop_diameter_m: fit.propDiameter,
    punches,
    speed_bands: speedBands(pooled, omegaH),
    fits: fitThrust(pooled, omegaH, fit, [0, 0.002, 0.004, 0.006, 0.008, air.cdAPlan.value]),
  };
}

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) out._.push(a);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[a.slice(2)] = argv[++i];
    else out[a.slice(2)] = true;
  }
  return out;
}

async function main() {
  const a = args(process.argv.slice(2));
  const logFile = a._[0] && findLog(a._[0]);
  const qm = a.quadmath ?? process.env.QUADMATH_DIR;
  if (!logFile || !qm || !a.punch || !a.hover) {
    console.error('usage: node tools/punch-inflow.mjs <log.BBL> --quadmath <quadmath clone> --punch <plateau json> --hover <hover json> [--airframe <airframe json>] [--out file.json]');
    process.exit(2);
  }
  const root = fileURLToPath(new URL('..', import.meta.url));
  const json = (p) => JSON.parse(readFileSync(resolve(root, p), 'utf8'));
  const out = await punchInflow(logFile, qm, { punch: json(a.punch), hover: json(a.hover), airframe: json(a.airframe ?? 'airframes/air65.json') }, a);
  const text = `${JSON.stringify(out, (k, v) => (Array.isArray(v) && typeof v[0] === 'number' && v.length > 8 ? JSON.stringify(v) : v), 2)
    .replace(/"(\[[-+0-9.,eElnu]*\])"/g, '$1')}\n`;
  if (a.out) writeFileSync(a.out, text);
  else process.stdout.write(text);
  for (const p of out.punches) {
    if (!p.from_hover) console.error(`punch ${p.start_s} s: not from hover (before: duty ${p.before?.duty}, accZ ${p.before?.accZ_g} g); left out`);
    else console.error(`punch ${p.start_s} s: run-up from ${p.ramp_start_s} s (${p.run_up_s} s), ${p.at_plateau_start.v_m_s} m/s at the plateau; peak ${p.peak_accZ.g} g at ${p.peak_accZ.v_m_s} m/s (p ${p.peak_accZ.p}); ${p.v_max_m_s} m/s max; climb in 1 s ${p.climb_1s_m} m; cell IR ${p.cell_ir_ohm}`);
  }
  for (const b of out.speed_bands) console.error(`  ${b.v_m_s[0]}-${b.v_m_s[1]} m/s: ${b.bins} bins, w/w_h ${b.w_over_w_hover}, accZ ${b.accZ_g} g, p ${b.p}, accZ/p ${b.accZ_over_p}`);
  const f = out.fits;
  console.error(`fits (${f.bins} bins): rpm^2 rms ${f.rpm_squared.rms_g} g; exponent n ${f.static_exponent.n} rms ${f.static_exponent.rms_g}; inflow J0 ${f.inflow.J0} rms ${f.inflow.rms_g}; drag cdA ${f.drag.cdA_m2} rms ${f.drag.rms_g}; both J0 ${f.inflow_and_drag.J0} cdA ${f.inflow_and_drag.cdA_m2} rms ${f.inflow_and_drag.rms_g}; below 1 m/s ${JSON.stringify(f.below_1_m_s)}`);
  console.error(`inflow at a fixed drag: ${f.inflow_at_cdA.map((x) => `cdA ${x.cdA_m2}: J0 ${x.J0} rms ${x.rms_g}`).join('; ')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
