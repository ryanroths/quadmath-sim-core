// The Fractal75 airframe (airframes/fractal75.json) against what it was
// built from: a source on every value, a flag on every estimated or missing
// one, the HV pack's curve, the values the owner's log gives
// (tests/reference/fractal75-*.json), and tools/punch-inflow.mjs on synthetic
// frames. With the decoder (QUADMATH_DIR) and the logs (SIM_CORE_LOGS), the
// tools re-run on the owner's logs must give the committed references.
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { plantBlock } from '../../src/js/sim-core.js';
import { climbBins, rampStart, fitThrust, speedBands } from '../../tools/punch-inflow.mjs';

const root = new URL('../../', import.meta.url);
const json = async (p) => JSON.parse(await readFile(new URL(p, root), 'utf8'));
const f75 = await json('airframes/fractal75.json');
const V = f75.values;
const hover = await json('tests/reference/fractal75-hover.json');
const punch = await json('tests/reference/fractal75-punch.json');
const inflow = await json('tests/reference/fractal75-punch-inflow.json');
const TWO_PI = 2 * Math.PI;
const close = (a, b, rel) => Math.abs(a / b - 1) <= rel;

// ---- Sources and flags ----
{
  assert.equal(plantBlock(f75).length, 54, 'every plant field present and finite');
  for (const [k, v] of Object.entries(V)) {
    assert.ok(typeof v.source === 'string' && v.source.trim().length > 0, `${k} has a source`);
    assert.ok(['high', 'medium', 'low'].includes(v.confidence), `${k} has a confidence`);
    assert.ok(!/PROVISIONAL/.test(v.source), `${k} is not provisional`);
    // Estimated or not measured on this quad: marked, and flagged.
    if (/estimat/i.test(v.source) || v.confidence === 'low') assert.equal(v.measured, false, `${k} is marked not measured`);
    if (v.measured === false) assert.ok(v.flag, `${k} is not measured and carries a flag`);
  }
  for (const k of ['hullBelow', 'hullAbove']) assert.equal(V[k].flag.startsWith('estimated, measure with pack before #15'), true, `${k}: the owner's flag`);
  for (const k of ['cgHeight', 'packBottom']) assert.equal(f75.measured[k].flag, 'estimated, measure with pack before #15', `measured.${k}: the owner's flag`);
  assert.equal(f75.measured.packBottom.value, null, 'the pack bottom is unknown');
  assert.equal(f75.measured.mahCharger.value, null, 'the charger mAh is missing');
  assert.ok(/missing/.test(f75.measured.mahCharger.flag));
  assert.ok(/missing/.test(f75.measured.stepLog.flag));
  for (const k of ['cellIR', 'iHover', 'iQuiescent']) assert.ok(/uncorrected/.test(V[k].flag), `${k}: logged current flagged`);
  assert.equal(V.hullBelow.value + V.hullAbove.value, f75.measured.canopyTop.value, 'the canopy top is hullBelow + hullAbove');
  assert.equal(V.ductHeight.value, f75.measured.ductHeight.value);
  assert.equal(V.mass.value, f75.measured.auw.value);
  console.log(`airframe: ${Object.keys(V).length} values, each with a source; flagged: ${Object.entries(V).filter(([, v]) => v.flag).map(([k]) => k).join(', ')}; measured: ${Object.entries(f75.measured).filter(([, v]) => v && v.flag).map(([k]) => k).join(', ')}`);
}

// ---- The HV pack and props out ----
{
  const ocv = V.ocv.value;
  assert.equal(ocv.length, 7);
  assert.equal(ocv[6], 4.35, 'full is 4.35 V a cell (owner: HV)');
  assert.equal(V.vRefCell.value, 4.35, 'the plant\'s reference is the HV full');
  assert.equal(ocv[0], hover.header.vbatcellvoltage[0] / 100, 'SoC 0 is Betaflight\'s min cell from the header');
  for (let i = 1; i < 7; i++) assert.ok(ocv[i] > ocv[i - 1], 'the curve rises');
  // The LiPo table stretched above its SoC-0 point (the ocv source).
  const lipo = [3.30, 3.50, 3.60, 3.75, 3.87, 4.05, 4.20];
  lipo.forEach((v, i) => assert.ok(Math.abs(ocv[i] - (3.30 + ((v - 3.30) * 1.05) / 0.9)) < 5e-4, `ocv[${i}] as its source says`));
  const diff = await readFile(new URL('configs/fractal75-ryfly-2026-11-03.txt', root), 'utf8');
  assert.match(diff, /^set yaw_motors_reversed = ON$/m, 'the owner\'s diff flies props out');
  assert.equal(V.propsOut.value, true);
  console.log(`HV curve ${ocv.join(', ')} V; yaw_motors_reversed ON in the diff`);
}

// ---- The values the log gives ----
{
  const m = hover.measured;
  assert.deepEqual(hover.window_s, [10, 58], 'the owner\'s hover window');
  assert.equal(m.auw_g, 35.98);
  const omega = (m.hover_rpm * TWO_PI) / 60;
  const kt = (V.mass.value * V.gravity.value) / (4 * omega * omega);
  const wFull = V.loadFraction.value * ((V.kv.value * TWO_PI) / 60) * V.vRefCell.value * V.cells.value;
  assert.ok(close(V.tmax.value / (wFull * wFull), kt, 1e-9), 'tmax carries the hover\'s kt');
  assert.ok(close(kt, hover.derived.kt_prop_from_hover_N_per_rad2, 1e-4), 'and the hover tool\'s');
  assert.equal(V.rpmHover.value, m.hover_rpm);
  assert.ok(Math.abs(V.iHover.value + V.iQuiescent.value - m.amps_mean_a) < 1e-9, 'iHover + iQuiescent is the hover\'s current');
  // loadFraction between the hover's and the plateau's (the plant's ratio
  // 1 / (1 + (1 - lf) w / (lf^2 Kv Vref)), src/plant/plant.c derive()).
  const lfFor = (ratio, w) => {
    const c = ((1 / ratio - 1) * ((V.kv.value * TWO_PI) / 60) * V.vRefCell.value) / w;
    return (-1 + Math.sqrt(1 + 4 * c)) / (2 * c);
  };
  const lfHover = lfFor(hover.derived.static_load_fraction_hover, omega);
  const lfPlateau = lfFor(punch.derived.load_fraction_full, punch.measured.omega_rad_s);
  assert.ok(lfHover < V.loadFraction.value && V.loadFraction.value < lfPlateau, `loadFraction ${V.loadFraction.value} between ${lfHover} and ${lfPlateau}`);
  // cellIR: the mean of the four punches' sag from hover.
  const irs = inflow.punches.filter((p) => p.from_hover).map((p) => p.cell_ir_ohm);
  assert.equal(irs.length, 4);
  assert.ok(Math.abs(irs.reduce((a, b) => a + b) / irs.length - V.cellIR.value) < 5e-4, `cellIR ${V.cellIR.value} is the punches' mean (${irs.join(', ')})`);
  // The current law: through the idle bin before take-off (its source) and
  // the hover; the exponent minimises the rms in amps over the bands of at
  // least 8 bins and the plateau.
  const idle = { rpm: 6420, amps: 0.48 };
  const pts = [...punch.current_vs_rpm.filter((b) => b.bins >= 8), { rpm: punch.measured.rpm, amps: punch.measured.amps_a }];
  const law = (n) => {
    const iH = (m.amps_mean_a - idle.amps) / (1 - (idle.rpm / m.hover_rpm) ** n);
    return { iQ: m.amps_mean_a - iH, iH };
  };
  const rms = (n) => {
    const { iQ, iH } = law(n);
    return Math.sqrt(pts.reduce((s, b) => s + (iQ + iH * (b.rpm / m.hover_rpm) ** n - b.amps) ** 2, 0) / pts.length);
  };
  let best = 2;
  for (let n = 2; n <= 3.5; n += 0.001) if (rms(n) < rms(best)) best = n;
  assert.ok(Math.abs(best - V.currentExponent.value) < 0.005, `currentExponent ${V.currentExponent.value} (fit ${best.toFixed(3)})`);
  assert.ok(Math.abs(law(V.currentExponent.value).iQ - V.iQuiescent.value) < 0.002, 'iQuiescent from the same fit');
  console.log(`log values: kt ${kt.toExponential(4)}, loadFraction ${V.loadFraction.value} in [${lfHover.toFixed(4)}, ${lfPlateau.toFixed(4)}], cellIR ${V.cellIR.value} (${irs.join(', ')}), exponent ${best.toFixed(3)}`);
}

// ---- tools/punch-inflow.mjs on synthetic frames ----
// 1 kHz: hover 1.5 s, the duty and rotor speed run up over 0.4 s to twice the
// hover's, held 1.2 s, cut. Thrust kt w^2 (1 - J / J0), drag on the climb,
// a point mass climbing level; the accelerometer reads (T - D) / m.
{
  const m = 0.036;
  const g = 9.81;
  const D = 0.04;
  const rho = 1.225;
  const J0 = 1.2;
  const cdA = 0.004;
  const wH = 2500;
  const kt = (m * g) / (4 * wH * wH);
  const acc1G = 2048;
  const poles = 12;
  const rows = [];
  let v = 0;
  const dt = 0.001;
  for (let k = 0; k < 3500; k++) {
    const t = k * dt;
    const u = t < 1.5 ? 0 : t < 1.9 ? (t - 1.5) / 0.4 : t < 3.1 ? 1 : 0;
    const w = wH * (1 + u);
    const duty = 0.33 + 0.62 * u;
    const J = (TWO_PI * Math.max(v, 0)) / (w * D);
    const thrust = 4 * kt * w * w * (1 - J / J0);
    const drag = 0.5 * rho * cdA * v * Math.abs(v);
    const f = (thrust - drag) / m;
    const erpm = ((w * 60) / TWO_PI) * (poles / 2) / 100;
    rows.push({
      t, thr: 1300, vbat: 4, amps: 3, m: [0, 1, 2, 3].map(() => 48 + duty * 1999), erpm: [erpm, erpm, erpm, erpm],
      acc: [0, 0, (f / g) * acc1G], gyro: [0, 0, 0], setp: [0, 0, 0], vTrue: v,
    });
    v += (f - g) * dt;
  }
  const bins = climbBins(rows, 1.0, 3.3, { acc1G, motorPoles: poles, gravity: g, accLpfHz: 1e9 });
  const ramp = rampStart(bins, 1.9, 0.33);
  assert.ok(Math.abs(ramp - 1.57) < 0.02, `the run-up found at ${ramp} s (duty past hover + 0.1 at 1.565 s)`);
  // The climb speed against the synthetic quad's own, over a 10 ms bin.
  for (const tb of [1.8, 2.49, 3.2]) {
    const at = bins.find((b) => Math.abs(b.t - tb) < 1e-6);
    const seg = rows.filter((r) => r.t >= tb - 1e-9 && r.t < tb + 0.01 - 1e-9);
    const vTrue = seg.reduce((s, r) => s + r.vTrue, 0) / seg.length;
    assert.ok(Math.abs(at.v - vTrue) < 0.02, `climb speed at ${tb} s ${at.v} against ${vTrue}`);
  }
  const driven = bins.filter((b) => b.t >= ramp && b.duty > 0.3 && Math.sqrt(b.w2f) > wH);
  const fit = fitThrust(driven, wH, { massKg: m, propDiameter: D, airDensity: rho, gravity: g }, [cdA, 0]);
  assert.ok(close(fit.inflow_and_drag.J0, J0, 0.05), `J0 ${fit.inflow_and_drag.J0} (built ${J0})`);
  assert.ok(close(fit.inflow_and_drag.cdA_m2, cdA, 0.05), `cdA ${fit.inflow_and_drag.cdA_m2} (built ${cdA})`);
  assert.ok(close(fit.inflow_at_cdA[0].J0, J0, 0.02), `J0 at the built drag ${fit.inflow_at_cdA[0].J0}`);
  assert.ok(fit.inflow_and_drag.rms_g < 0.01 && fit.rpm_squared.rms_g > 0.3, 'the built law fits; rpm squared alone does not');
  assert.ok(Math.abs(fit.below_1_m_s.accZ_over_p - 1) < 0.04, `near rest the law is rpm squared (${fit.below_1_m_s.accZ_over_p})`);
  const bands = speedBands(driven, wH);
  assert.ok(bands.length >= 3 && bands.every((b, i) => i === 0 || b.accZ_over_p < bands[i - 1].accZ_over_p), 'what is left of rpm squared falls with the climb');
  console.log(`punch-inflow (synthetic): run-up at ${ramp} s, J0 ${fit.inflow_and_drag.J0} and cdA ${fit.inflow_and_drag.cdA_m2} back (built ${J0}, ${cdA}); bands ${bands.map((b) => `${b.v_m_s[0]}: ${b.accZ_over_p}`).join(', ')}`);
}

// ---- The tools on the owner's logs ----
const qm = process.env.QUADMATH_DIR;
if (qm) {
  const { logPath } = await import('../../tools/logs.mjs');
  const { existsSync } = await import('node:fs');
  const f75Log = logPath(hover.source);
  const a65Log = logPath('BTFL_BLACKBOX_LOG_AIR65_RYFLY_20261023_143354_BETAFPVG473.BBL');
  const plain = (o) => JSON.parse(JSON.stringify(o));
  if (existsSync(f75Log)) {
    const { hoverFromLog, plateauFromLog } = await import('../../tools/hover-from-log.mjs');
    const { punchInflow } = await import('../../tools/punch-inflow.mjs');
    const again = await hoverFromLog(f75Log, qm, V, { window: '10,58', 'auw-g': '35.98', 'rest-before': '4.41', cells: '1', pack: 'weBLEEDfpv 450 mAh 1S HV' });
    const strip = (o) => { const c = plain(o); delete c.derived.tmax_N_at_load_fraction; return c; };
    assert.deepEqual(strip(again), strip(hover), 'the hover tool on the log gives the committed reference');
    assert.deepEqual(plain(await plateauFromLog(f75Log, qm, V, hover, {})), punch, 'the plateau tool on the log gives the committed reference');
    assert.deepEqual(plain(await punchInflow(f75Log, qm, { punch, hover, airframe: f75 })), inflow, 'punch-inflow on the log gives the committed reference');
    console.log(`the Fractal75 log (${hover.source}): hover, plateau and punch-inflow equal their references`);
  } else {
    console.log(`the Fractal75 log not run: ${f75Log} not found (SIM_CORE_LOGS)`);
  }
  if (existsSync(a65Log)) {
    const { punchInflow } = await import('../../tools/punch-inflow.mjs');
    const ref = await json('tests/reference/air65-punch-inflow.json');
    const out = await punchInflow(a65Log, qm, { punch: await json('tests/reference/air65-punch.json'), hover: await json('tests/reference/air65-hover.tool.json'), airframe: await json('airframes/air65.json') });
    assert.deepEqual(plain(out), ref, 'punch-inflow on the Air65 punch log gives the committed reference');
    console.log('the Air65 punch log: punch-inflow equals its reference');
  } else {
    console.log(`the Air65 punch log not run: ${a65Log} not found (SIM_CORE_LOGS)`);
  }
} else {
  console.log('the owner\'s logs not run: set QUADMATH_DIR to a quadmath clone (its vendor/blackbox-log.module.js decodes them)');
}
console.log('fractal75: airframe sources and flags, HV curve, props out, log values, punch-inflow: PASS');
