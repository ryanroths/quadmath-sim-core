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
  assert.equal(plantBlock(f75).length, 55, 'every plant field present and finite');
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
  // The plan drag on both airframes (owner decision 2026-11-03).
  const PLAN_FLAG = 'effective plan drag, absorbs inflow, refit when the inflow model lands';
  assert.equal(V.cdAPlan.flag, PLAN_FLAG, 'Fractal75 cdAPlan (fitted): the owner flag');
  assert.equal((await json('airframes/air65.json')).values.cdAPlan.flag, PLAN_FLAG, 'Air65 cdAPlan (derived): the same flag');
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
  // The thrust exponent: the hover and the 20 ms onset at the plateau rpm
  // (owner decision 2026-11-03), as the plateau tool fits it.
  const n = V.thrustExponent.value;
  const fit = punch.derived.thrust_law;
  assert.equal(n, Number(fit.exponent_from_onset_20ms.toFixed(3)), `thrustExponent ${n} is the 20 ms onset's (${fit.exponent_from_onset_20ms})`);
  assert.ok(Math.abs(Math.log(fit.measured_onset_accZ_20ms_g) / Math.log(punch.measured.rpm / m.hover_rpm) - fit.exponent_from_onset_20ms) < 1e-4, 'n = ln(onset) / ln(rpm ratio)');
  assert.equal(fit.airframe_exponent, n);
  const omega = (m.hover_rpm * TWO_PI) / 60;
  const kt = (V.mass.value * V.gravity.value) / (4 * omega ** n);
  const wFull = V.loadFraction.value * ((V.kv.value * TWO_PI) / 60) * V.vRefCell.value * V.cells.value;
  assert.ok(close(V.tmax.value / wFull ** n, kt, 1e-9), 'tmax carries the hover\'s kt at n');
  assert.ok(close(kt, hover.derived.at_thrust_exponent.kt_prop_from_hover, 1e-4), 'and the hover tool\'s');
  assert.equal(V.rpmHover.value, m.hover_rpm);
  assert.ok(Math.abs(V.iHover.value + V.iQuiescent.value - m.amps_mean_a) < 1e-9, 'iHover + iQuiescent is the hover\'s current');
  // loadFraction: the plant's ratio at hover and at the plateau,
  // 1 / (1 + (1 - lf) / lf x (w / w_full)^(n - 1)) with thrust and drag
  // torque at n (src/plant/plant.c derive()), meets the log's at each; the
  // airframe takes their midpoint.
  const lfFor = (ratio, w) => {
    let lo = 0.01;
    let hi = 0.99;
    for (let k = 0; k < 100; k++) {
      const lf = (lo + hi) / 2;
      if (((1 - lf) / lf) * (w / (lf * ((V.kv.value * TWO_PI) / 60) * V.vRefCell.value)) ** (n - 1) > 1 / ratio - 1) lo = lf;
      else hi = lf;
    }
    return (lo + hi) / 2;
  };
  // The hover's is the hover tool's, from its unrounded bins (the reference
  // rounds duty to 0.001, worth 0.001 in lf); this bisection on the tool's
  // rounded ratio agrees with it to that.
  const lfHover = hover.derived.at_thrust_exponent.plant_load_fraction_for_hover_ratio;
  assert.ok(Math.abs(lfFor(hover.derived.static_load_fraction_hover, omega) - lfHover) < 0.001, 'the hover tool\'s lf at n');
  const lfPlateau = lfFor(punch.derived.load_fraction_full, (punch.measured.rpm * TWO_PI) / 60);
  assert.ok(Math.abs(lfHover - lfPlateau) < 0.001, `at n the hover and the plateau want one loadFraction (${lfHover}, ${lfPlateau.toFixed(4)})`);
  assert.ok(Math.abs(V.loadFraction.value - (lfHover + lfPlateau) / 2) < 1e-4, `loadFraction ${V.loadFraction.value} is their midpoint`);
  // cellIR: the mean of the four punches' sag from hover.
  const irs = inflow.punches.filter((p) => p.from_hover).map((p) => p.cell_ir_ohm);
  assert.equal(irs.length, 4);
  assert.ok(Math.abs(irs.reduce((a, b) => a + b) / irs.length - V.cellIR.value) < 5e-4, `cellIR ${V.cellIR.value} is the punches' mean (${irs.join(', ')})`);
  // The current law: through the idle bin before take-off (its source) and
  // the hover; the exponent minimises the rms in amps over the bands of at
  // least 8 bins and the plateau.
  const idle = { rpm: 6420, amps: 0.48 };
  const pts = [...punch.current_vs_rpm.filter((b) => b.bins >= 8), { rpm: punch.measured.rpm, amps: punch.measured.amps_a }];
  const ampLaw = (e) => {
    const iH = (m.amps_mean_a - idle.amps) / (1 - (idle.rpm / m.hover_rpm) ** e);
    return { iQ: m.amps_mean_a - iH, iH };
  };
  const rms = (e) => {
    const { iQ, iH } = ampLaw(e);
    return Math.sqrt(pts.reduce((s, b) => s + (iQ + iH * (b.rpm / m.hover_rpm) ** e - b.amps) ** 2, 0) / pts.length);
  };
  let best = 2;
  for (let e = 2; e <= 3.5; e += 0.001) if (rms(e) < rms(best)) best = e;
  assert.ok(Math.abs(best - V.currentExponent.value) < 0.005, `currentExponent ${V.currentExponent.value} (fit ${best.toFixed(3)})`);
  assert.ok(Math.abs(ampLaw(V.currentExponent.value).iQ - V.iQuiescent.value) < 0.002, 'iQuiescent from the same fit');
  console.log(`log values: n ${n}, kt ${kt.toExponential(4)}, loadFraction ${V.loadFraction.value} (hover ${lfHover.toFixed(4)}, plateau ${lfPlateau.toFixed(4)}), cellIR ${V.cellIR.value} (${irs.join(', ')}), current exponent ${best.toFixed(3)}`);
}

// ---- The plant flies the law: thrust kt |w|^n and drag torque kq |w|^n ----
{
  const wasm = await WebAssembly.compile(await readFile(new URL('dist/sim-core.wasm', root)));
  const { SimCore } = await import('../../src/js/sim-core.js');
  const core = await SimCore.load(wasm, { trace: false });
  core.configure({ diff: '', plant: f75, world: { floorZ: -100 } });
  const d = core.plantDerived;
  const n = V.thrustExponent.value;
  const wHover = (hover.measured.hover_rpm * TWO_PI) / 60;
  assert.ok(close(d.omegaHover, wHover, 1e-9), `the plant hovers at the log's rpm (${(d.omegaHover * 60) / TWO_PI})`);
  assert.ok(close(d.kqProp, V.kqRatio.value * (V.wheelbase.value / 2) * d.ktProp, 1e-12), 'kq is kqRatio on kt');
  core.teleport({ pos: [0, 0, 0] });
  core.motorOverride(-1, 0.8);
  core.step(600);
  const s = core.state;
  for (let i = 0; i < 4; i++) {
    const w = (s.rpm[i] * TWO_PI) / 60;
    assert.ok(close(s.thrustN[i], d.ktProp * w ** n, 1e-9), `motor ${i}: thrust ${s.thrustN[i]} is kt w^n`);
    // Steady: the motor's torque Kt (u V - w / Kv) / R meets the prop's kq w^n.
    const motor = (d.ktMotor * (0.8 * s.vbatLoaded - w / d.kvRad)) / d.rWinding;
    assert.ok(close(motor, d.kqProp * w ** n, 1e-3), `motor ${i}: drag torque is kq w^n (${motor} against ${d.kqProp * w ** n})`);
  }
  // The plant refuses an exponent outside 1..3 (src/plant/plant.c).
  for (const bad of [0.5, 3.5]) {
    const c = await SimCore.load(wasm, { trace: false });
    const air = JSON.parse(JSON.stringify(f75));
    air.values.thrustExponent.value = bad;
    assert.throws(() => c.configure({ diff: '', plant: air }), /plant block refused/, `thrustExponent ${bad} refused`);
  }
  console.log(`plant: hovers at ${((d.omegaHover * 60) / TWO_PI).toFixed(1)} rpm; at duty 0.8 thrust and drag torque follow w^${n}; exponents 0.5 and 3.5 refused`);
  // The Air65 stays rpm squared.
  assert.equal(JSON.parse(await readFile(new URL('airframes/air65.json', root), 'utf8')).values.thrustExponent.value, 2, 'the Air65 keeps n 2');
}

// ---- cdAPlan is the least-squares fit to the four punches' altitude ----
// (tools/fit-plan-drag.mjs): 2 % either side, the summed squared altitude
// error is larger, and every trace has one bin each 10 ms.
{
  const { trackResiduals } = await import('../../tools/fit-plan-drag.mjs');
  const wasm = await WebAssembly.compile(await readFile(new URL('dist/sim-core.wasm', root)));
  const diff = (await Promise.all(['configs/fractal75-ryfly-2026-11-03.txt', 'configs/fractal75-ryfly-2026-11-03.from-header.txt']
    .map((f) => readFile(new URL(f, root), 'utf8')))).join('\n');
  const punches = inflow.punches.filter((x) => x.from_hover);
  assert.equal(punches.length, 4, 'all four punches');
  for (const x of punches) {
    const span = Math.round((x.end_s + 0.25 - x.trace.t0_s) / x.trace.dt_s);
    assert.ok(Math.abs(x.trace.duty.length - span) <= 1, `punch ${x.start_s} s: one bin each 10 ms (${x.trace.duty.length} of ${span}, ${x.filled_bins} filled)`);
  }
  const sse = async (cdA) => {
    const a = JSON.parse(JSON.stringify(f75));
    a.values.cdAPlan.value = cdA;
    return (await trackResiduals(wasm, { diff, airframe: a, punches })).reduce((t, r) => t + r.sse_m2, 0);
  };
  const at = await sse(V.cdAPlan.value);
  const below = await sse(V.cdAPlan.value * 0.98);
  const above = await sse(V.cdAPlan.value * 1.02);
  assert.ok(at < below && at < above, `cdAPlan ${V.cdAPlan.value} is the minimum (${at.toFixed(2)} against ${below.toFixed(2)} and ${above.toFixed(2)} m^2)`);
  console.log(`cdAPlan ${V.cdAPlan.value}: altitude sum of squares ${at.toFixed(2)} m^2, ${below.toFixed(2)} at -2 %, ${above.toFixed(2)} at +2 %`);
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
  // Dropped frames (the log drops corrupt ones, up to 32 ms under a punch):
  // the bins stay one every 10 ms, the empty ones filled and marked, and
  // the climb speed after the gap is still the quad's.
  const gappy = rows.filter((r) => !(r.t >= 2.2 && r.t < 2.232));
  const gb = climbBins(gappy, 1.0, 3.3, { acc1G, motorPoles: poles, gravity: g, accLpfHz: 1e9 });
  assert.equal(gb.length, bins.length, 'one bin every 10 ms across the gap');
  assert.deepEqual(gb.flatMap((b, k) => (b.filled ? [Math.round(b.t * 100)] : [])), [220, 221, 222], 'the three empty bins filled and marked');
  gb.forEach((b, k) => assert.ok(Math.abs(b.t - bins[k].t) < 1e-9, 'index is time'));
  const after = gb.find((b) => Math.abs(b.t - 2.49) < 1e-6);
  const seg = rows.filter((r) => r.t >= 2.49 - 1e-9 && r.t < 2.5 - 1e-9);
  assert.ok(Math.abs(after.v - seg.reduce((s, r) => s + r.vTrue, 0) / seg.length) < 0.02, `climb speed after the gap ${after.v}`);
  console.log('punch-inflow (synthetic, 32 ms of frames dropped): bins one every 10 ms, three filled, climb speed held');
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
    // tmax is keyed by the airframe's loadFraction of the day.
    const strip = (o) => { const c = plain(o); delete c.derived.tmax_N_at_load_fraction; delete c.derived.at_thrust_exponent.tmax_N_at_load_fraction; return c; };
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
