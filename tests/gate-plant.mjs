// M4 gate: the plant. Prints raw values for every check and fails (exit 1)
// if any check does not hold:
//
//   P1  single-motor step on the Air65 plant, held 1 s (the window of the
//       WebFPV check-8 run that diverged at 601 ms, PROGRESS.md Phase 0): no
//       divergence (non-finite state or the 200 rad/s guard), t63 reported
//   P2  port parity: C plant (parity model) vs quadmath's frozen quadphysics.js,
//       same motor commands, 2 s, within 1e-6 relative
//   P3  battery parity: C pack (parity model) vs quadmath's frozen sim-whoop.js
//       stepBattery, same load sequence, within 1e-6 relative
//   P4  at rest on the floor, Betaflight's accelerometer reads +1 g +-1%
//   P5  ground clearance: the C query equals quadmath's hook (sim.html
//       groundClearance) over a sampled grid on every exported map, on the
//       same micrometre boxes exactly, and within 1e-6 m of the hook on
//       quadmath's own (unquantised) boxes at the grid points
//   F6  axis signs for roll, pitch and yaw, in acro and angle
//   F9  3D: full reverse gives reverse thrust, the deadband holds Betaflight 3D idle; crash
//       flip reverses through spin-direction commands only when 3D is off;
//       turtle: upside down on the floor, crash flip at full roll, centred
//       at up-z > -0.5 (a pulse, as pilots fly it): upright and at rest at
//       500 ms, no divergence; held until upright is reported, not gated
//   X2  F3: achieved full-stick rate within +-1.0% of Betaflight's setpoint
//   X3  feel bands against WebFPV's whoop65, both on quadmath's class diff
//       and the same inputs (WebFPV cannot fly the Air65's full config);
//       hover stick against the owner's Air65 bench hover instead
//       (tests/reference/air65-hover.json, 2026-10-23): Betaflight's
//       rcCommand throttle at steady hover, as its blackbox logs it, flown
//       on the config that log flew, within +-0.02 of the measured 0.371;
//       a miss fails unless the owner signed it off in tests/x3-signoff.json
//       (PROGRESS.md: "a band is never widened")
//
//   node tests/gate-plant.mjs
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import { readFile } from 'node:fs/promises';
import { SimCore, sticksToChannels as ch } from '../src/js/sim-core.js';
import * as feel from './lib/feel.mjs';
import { loadWebfpvModule } from './lib/webfpv.mjs';
import { existsSync } from 'node:fs';
import { logPath } from '../tools/logs.mjs';
import { QuadPhysics, aeroCoeffs } from './reference/quadmath-de9b15d/quadphysics.js';
import { stepBattery, DEFAULT_WHOOP } from './reference/quadmath-de9b15d/sim-whoop.js';
import { batteryFromBuild, BUILD_PRESETS } from './reference/quadmath-de9b15d/sim-build.js';

const root = new URL('..', import.meta.url);
const module = await WebAssembly.compile(await readFile(new URL('dist/sim-core.wasm', root)));
const air65 = JSON.parse(await readFile(new URL('airframes/air65.json', root), 'utf8'));
// The Air65 flies the config its bench-hover log flew (owner decision
// 2026-10-23): the owner's diff all, then any setting the log's header
// records that the diff does not reproduce (tools/config-from-log.mjs; none
// for this log, the file says why). Lines sim-core does not apply (board
// identity, VTX, OSD, calibration, pid_process_denom) are refused with a
// reason and printed below as warnings.
const AIR65_CONFIG = ['configs/air65-ryfly-2026-10-23.txt', 'configs/air65-ryfly-2026-10-23.from-header.txt'];
const diff = (await Promise.all(AIR65_CONFIG.map((p) => readFile(new URL(p, root), 'utf8')))).join('\n');
// quadmath's class diff for the 65 mm Air65 (PIDs and rates only): what
// WebFPV's whoop65 flies for the X3 reference, which cannot fly the full dump
// (its hover trim falls to 0 on it), and the parity checks P2, P3 and P5.
const classDiff = await readFile(new URL('configs/65mm-air65-ryfly-1219s.diff', root), 'utf8');
// An aux channel (0 = AUX1) the config gives a Betaflight box id: ARM 0,
// ANGLE 1, FLIP OVER AFTER CRASH 35 (msp/msp_box.c).
const auxOf = (config, box) => {
  for (const line of config.split('\n')) {
    const m = line.trim().match(/^aux\s+\d+\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/);
    if (m && Number(m[1]) === box && Number(m[3]) < Number(m[4])) return Number(m[2]);
  }
  throw new Error(`the Air65 config has no aux range for box ${box}`);
};
const AUX = { arm: auxOf(diff, 0), angle: auxOf(diff, 1), crashFlip: auxOf(diff, 35) };
// Aux channel values with the given boxes on (1900) and the rest low.
const auxOn = (...boxes) => {
  const a = new Array(4).fill(1000);
  for (const b of boxes) a[AUX[b]] = 1900;
  return a;
};
const signoff = JSON.parse(await readFile(new URL('tests/x3-signoff.json', root), 'utf8'));
// The owner's bench hover on the Air65 with blackbox (2026-10-23): the X3
// hover-stick reference, in place of WebFPV.
const bench = JSON.parse(await readFile(new URL('tests/reference/air65-hover.json', root), 'utf8'));

const failures = [];
function check(ok, what) {
  if (!ok) failures.push(what);
  return ok ? 'ok' : 'FAIL';
}
const f = (v, d = 4) => (v === null || v === undefined ? String(v) : Number(v).toFixed(d));
const DEG = 180 / Math.PI;

// A flight instance armed on a floor far below, then put level and still at
// the origin, in the air.
async function airborne(extraDiff = '', { aux = auxOn('arm'), throttle = 0, mode3d = false } = {}) {
  const core = await SimCore.load(module, { trace: false });
  core.configure({ diff: `${diff}\n${extraDiff}`, plant: air65, world: { floorZ: -100 } });
  core.input(ch({ throttle }, aux, { mode3d }));
  core.step(50);
  core.teleport({ pos: [0, 0, 0] });
  core.step(1);
  return core;
}

function euler(q) {
  const [w, x, y, z] = q;
  return {
    roll: Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)) * DEG,
    pitch: Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x)))) * DEG,
    yaw: Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) * DEG,
  };
}

// ---------------------------------------------------------------------------
console.log('== airframe airframes/air65.json');
{
  const core = await SimCore.load(module, { trace: false });
  core.configure({ diff, plant: air65 });
  for (const [k, v] of Object.entries(air65.values)) {
    console.log(`   ${k.padEnd(15)} ${JSON.stringify(v.value).padEnd(26)} ${v.unit.padEnd(14)} [${v.confidence}] ${v.source}`);
  }
  const d = core.plantDerived;
  console.log(`   derived: ${Object.entries(d).map(([k, v]) => `${k} ${Number(v.toPrecision(6))}`).join(', ')}`);
  console.log(`   full-throttle rpm ${f(d.omegaFull * 60 / (2 * Math.PI), 0)}, hover rpm ${f(d.omegaHover * 60 / (2 * Math.PI), 0)}, hover duty ${f(d.dutyHover)} at ${air65.values.vRefCell.value} V`);
}

// ---------------------------------------------------------------------------
console.log('\n== P4 at rest on the floor (Betaflight accelerometer, g)');
{
  const core = await SimCore.load(module, { trace: false });
  const r = core.configure({ diff, plant: air65 });
  core.step(500);
  const acc = core.fc.acc;
  const s = core.state;
  console.log(`   boot ${r.boot.ticks} ticks; z ${f(s.pos[2])} m; plant specific force ${s.specificForce.map((v) => f(v)).join(' ')} m/s^2`);
  console.log(`   Betaflight acc ${acc.map((v) => f(v, 5)).join(' ')} g; attitude ${core.fc.attitude.join(' ')} -> ${check(Math.abs(acc[2] - 1) <= 0.01 && Math.abs(acc[0]) <= 0.01 && Math.abs(acc[1]) <= 0.01, 'P4 +1 g at rest')}`);
}

// ---------------------------------------------------------------------------
console.log('\n== P1 single-motor step, Air65 plant, from rest in free air (bench override, duty 0 -> 1), held 1 s');
{
  const t63 = (rpm, final) => rpm.findIndex((v) => v >= 0.632 * final) + 1;
  for (let m = 0; m < 4; m++) {
    const core = await airborne('', { aux: auxOn() });
    core.motorOverride(m, 1);
    const rpm = [];
    let peak = 0;
    let finite = true;
    let faultAt = null;
    for (let k = 0; k < 1000; k++) {
      core.flight.sc_step(1);
      if (core.fault) {
        faultAt = k + 1;
        break;
      }
      const s = core.state;
      rpm.push(s.rpm[m]);
      peak = Math.max(peak, ...s.omega.map(Math.abs));
      finite &&= [...s.pos, ...s.vel, ...s.omega, ...s.quat, ...s.rpm].every(Number.isFinite);
    }
    const at150 = rpm[149];
    const ok = finite && faultAt === null;
    console.log(`   motor ${m}: t63 ${t63(rpm.slice(0, 150), at150)} ms, rpm at 150 ms ${f(at150, 0)}, peak body rate ${f(peak, 1)} rad/s, ${faultAt === null ? 'no fault in 1 s' : `fault ${core.fault} at ${faultAt} ms`}, finite ${finite} -> ${check(ok, `P1 motor ${m}`)}`);
  }
  // All four together (no body rotation), 2 s: no divergence. The rpm keeps
  // falling slowly after the step because full-throttle current drains the
  // pack; the voltage is printed beside it.
  const core = await airborne('', { aux: auxOn() });
  core.motorOverride(-1, 1);
  const rpm = [];
  const volts = [];
  let finite = true;
  for (let k = 0; k < 2000; k++) {
    core.step(1);
    const s = core.state;
    rpm.push(s.rpm[0]);
    volts.push(s.vbatLoaded);
    finite &&= [...s.pos, ...s.vel, ...s.omega, ...s.quat, ...s.rpm].every(Number.isFinite);
  }
  const final = rpm.at(-1);
  console.log(`   all four: t63 ${t63(rpm, final)} ms, rpm at 1.5 s ${f(rpm[1499], 0)} and 2 s ${f(final, 0)}, loaded pack ${f(volts[1499], 4)} -> ${f(volts[1999], 4)} V, finite ${finite}, fault ${core.fault} -> ${check(finite && core.fault === 0, 'P1 all four')}`);
}

// ---------------------------------------------------------------------------
// The owner's punch-out log (tests/reference/air65-punch.json, from
// tools/hover-from-log.mjs --plateau; owner decisions 2026-10-23).
const punch = JSON.parse(await readFile(new URL('tests/reference/air65-punch.json', root), 'utf8'));
const CURRENT_CORRECTION = 1.24;   // the Air65 bench's current-sensor correction (AJ:44-46), as iHover

console.log('\n== P6 thrust law: kt from the hover predicts the punch (thrust from rpm squared), within 10%');
{
  // The plant's kt, from the airframe (it carries the hover's m g / 4 w^2),
  // at the punch's steady plateau rpm: thrust / weight is the specific force
  // the accelerometer reads at the punch's onset, before the quad has speed.
  const core = await SimCore.load(module, { trace: false });
  core.configure({ diff, plant: air65 });
  const d = core.plantDerived;
  const w = punch.measured.omega_rad_s;
  const predicted = (4 * d.ktProp * w * w) / (air65.values.mass.value * air65.values.gravity.value);
  const measured = punch.measured.onset_accZ_g;
  console.log(`   kt ${d.ktProp.toExponential(4)} at ${punch.measured.rpm} rpm (${w} rad/s): thrust / weight ${f(predicted, 3)}; measured at onset ${f(measured, 2)} g (${punch.punches.map((p) => `${p.start_s} s: ${p.onset_accZ_g}`).join(', ')}) -> ${check(Math.abs(predicted / measured - 1) <= 0.1, 'P6 thrust law')}`);
}

// The owner's freestyle log, replayed by tools/sim-vs-log.mjs on the Air65
// config (tests/reference/air65-freestyle.sim-vs-log.json).
const freestyleRef = JSON.parse(await readFile(new URL('tests/reference/air65-freestyle.sim-vs-log.json', root), 'utf8'));

console.log('\n== P7 pack current model against the freestyle log, 38-60 krpm bands of at least 8 bins, within 10% (logged current x 1.24)');
{
  // I = iHover x (rpm / rpmHover)^currentExponent (src/plant/plant.c
  // stepPhysical), at each band's mean rpm, against the freestyle log's
  // steady flight. The punch log's own mid-rpm bins are the rotors spinning
  // up or down within 100 ms, where accelerating the rotors draws current the
  // model does not describe; they are printed below for the record.
  const { iHover, rpmHover, currentExponent } = air65.values;
  const bands = freestyleRef.log_current_vs_rpm.filter((b) => b.rpm >= 38000 && b.rpm < 60000 && b.bins >= 8);
  let worst = 0;
  for (const b of bands) {
    const model = iHover.value * (b.rpm / rpmHover.value) ** currentExponent.value;
    const logged = b.amps * CURRENT_CORRECTION;
    worst = Math.max(worst, Math.abs(model / logged - 1));
    console.log(`   ${b.rpm} rpm (${b.bins} bins): model ${f(model, 2)} A, log ${f(logged, 2)} A (${f(b.amps, 2)} logged), ${f((model / logged - 1) * 100, 1)} %`);
  }
  console.log(`   ${bands.length} bands, worst ${f(worst * 100, 1)} % -> ${check(bands.length >= 3 && worst <= 0.1, 'P7 current model')}`);
  const transient = punch.current_vs_rpm.filter((b) => b.rpm >= 38000 && b.rpm < 60000)
    .map((b) => `${b.rpm} rpm ${f((iHover.value * (b.rpm / rpmHover.value) ** currentExponent.value / (b.amps * CURRENT_CORRECTION) - 1) * 100, 1)} % (${b.bins} bins)`);
  console.log(`   punch log, the same bands (spin-up and spin-down, reported): ${transient.join(', ')}`);
}

console.log('\n== P8 the plant at the punch (reported, not gated): all four motors at the plateau duty from a full pack, 400 ms');
{
  const core = await airborne('', { aux: auxOn() });
  core.motorOverride(-1, punch.measured.duty);
  core.step(400);
  const s = core.state;
  const rpm = s.rpm.reduce((a, b) => a + b) / 4;
  const ratio = rpm / (air65.values.kv.value * s.vbatLoaded * punch.measured.duty);
  console.log(`   plant: ${f(rpm, 0)} rpm, ${f(s.vbatLoaded, 3)} V, ${f(s.amps, 2)} A, rpm / (KV x V x duty) ${f(ratio, 4)}; log: ${punch.measured.rpm} rpm, ${punch.measured.vbat_v} V, ${f(punch.measured.amps_a * CURRENT_CORRECTION, 2)} A (x 1.24), ${punch.derived.load_fraction_full}; loadFraction ${air65.values.loadFraction.value}`);
}

// ---------------------------------------------------------------------------
// The quadmath Air65 build as quadmath's sim runs it (physicsFromBuild,
// floatiness 0.32, build drag), for the parity models.
function parityModel(quadCfg, { battery }) {
  const a = aeroCoeffs(quadCfg);
  const v = (value) => ({ value });
  const pack = batteryFromBuild(BUILD_PRESETS.air65);
  return {
    id: 'air65-parity', model: 'parity',
    values: {
      mass: v(quadCfg.mass), wheelbase: v(quadCfg.wheelbase), boxHeightRatio: v(0.35), propDiameter: v(quadCfg.propDiameter),
      kv: v(0), vRefCell: v(0), loadFraction: v(0), tmax: v(quadCfg.maxThrustPerMotor), kqRatio: v(quadCfg.kQ),
      tau: v(quadCfg.motorTau * quadCfg.spoolTauMul), tauDownMult: v(quadCfg.spoolDownMul), reverseScale: v(quadCfg.reverseThrustScale),
      cdAFront: v(a.cdAxy), cdAPlan: v(a.cdAz), skinB: v(a.skinB), aeroB: v(a.aeroB), aeroC: v(a.aeroC),
      discK: v(1.35), discEnd: v(0.22), groundK: v(0), gravity: v(9.81), airDensity: v(1.225),
      cells: v(pack.cells), capacityMah: v(pack.mah), cellIR: v(0), iHover: v(0),
      ocv: v([3.30, 3.50, 3.60, 3.75, 3.87, 4.05, 4.20]),
      sagDrop: v(pack.sagDrop), hoverSeconds: v(battery ? pack.hoverS : 0), sagScale: v(1),
      bounceScale: v(1), crashScale: v(1), spinScale: v(1),
      ductOuterRadius: v(0), hullBelow: v(0), hullAbove: v(0), rpmHover: v(0), currentExponent: v(0),
    },
  };
}

function quadmathAir65() {
  const qp = new QuadPhysics({
    name: 'air65', mass: 0.0254, wheelbase: 0.065, propDiameter: 0.031,
    maxThrustPerMotor: air65.values.tmax.value, motorTau: 0.013, kQ: 0.72, idleThrottle: 0.055,
  });
  qp.setPhysicsHz(1000);
  qp.setFloatiness(0.32);
  qp.cfg.userDragMul = 0.561 / 0.55;
  return qp;
}

// Motor commands 0..1 from integer arithmetic: a triangle per motor with its
// own period and phase, so the body rolls, pitches, yaws and climbs.
function commands(k) {
  const tri = (period, phase) => {
    const p = (k + phase) % period;
    return p < period / 2 ? (2 * p) / period : 2 - (2 * p) / period;
  };
  return [0.30 + 0.30 * tri(700, 0), 0.30 + 0.30 * tri(500, 120), 0.30 + 0.30 * tri(900, 260), 0.30 + 0.30 * tri(600, 400)];
}

async function parityCore(model) {
  const core = await SimCore.load(module, { trace: false });
  core.configure({ diff: classDiff, plant: model, world: { floorZ: -100 } });
  core.teleport({ pos: [0, 0, 10] });
  return core;
}

console.log('\n== P2 port parity: C plant (parity model) vs quadmath quadphysics.js (frozen de9b15d), 2 s, same motor commands');
{
  const qp = quadmathAir65();
  qp.reset({ x: 0, y: 0, z: 10 });
  const proto = Object.getPrototypeOf(qp.motors[0]);
  let cmd = [0, 0, 0, 0];
  qp.motors.forEach((mo, i) => { mo.step = function step(dt) { this.command = cmd[i]; proto.step.call(this, dt); }; });
  const core = await parityCore(parityModel(qp.cfg, { battery: false }));
  const worst = { pos: 0, vel: 0, quat: 0, omega: 0, motorOut: 0 };
  const rel = (a, b) => {
    const d = Math.hypot(...a.map((x, i) => x - b[i]));
    return d / Math.max(Math.hypot(...b), 1e-9);
  };
  let last = null;
  for (let k = 0; k < 2000; k++) {
    cmd = commands(k);
    cmd.forEach((c, i) => core.motorOverride(i, c));
    core.step(1);
    qp.substep();
    const s = core.state;
    const j = {
      pos: [qp.position.x, qp.position.y, qp.position.z], vel: [qp.velocity.x, qp.velocity.y, qp.velocity.z],
      quat: [qp.quaternion.w, qp.quaternion.x, qp.quaternion.y, qp.quaternion.z], omega: [qp.omega.x, qp.omega.y, qp.omega.z],
      motorOut: qp.motorOutputs,
    };
    for (const key of Object.keys(worst)) worst[key] = Math.max(worst[key], rel(s[key], j[key]));
    last = { s, j };
  }
  console.log(`   end: C pos ${last.s.pos.map((v) => f(v, 6)).join(' ')}  JS ${last.j.pos.map((v) => f(v, 6)).join(' ')}`);
  console.log(`   end: C omega ${last.s.omega.map((v) => f(v, 6)).join(' ')}  JS ${last.j.omega.map((v) => f(v, 6)).join(' ')}`);
  for (const [key, e] of Object.entries(worst)) console.log(`   ${key.padEnd(9)} max relative difference ${e.toExponential(3)} -> ${check(e <= 1e-6, `P2 ${key}`)}`);
}

console.log('\n== P3 battery parity: C pack (parity model) vs quadmath sim-whoop.js stepBattery (frozen de9b15d), same load sequence, 30 s');
{
  const qp = quadmathAir65();
  const core = await parityCore(parityModel(qp.cfg, { battery: true }));
  const pack = batteryFromBuild(BUILD_PRESETS.air65);
  const tmax = air65.values.tmax.value;
  let prev = { charge: core.battery.soc, voltage: core.battery.vbatFiltered };
  let worstV = 0;
  let worstC = 0;
  let loadPrev = core.state.thrustN.reduce((a, t) => a + Math.abs(t), 0) / (4 * tmax);
  for (let k = 0; k < 30000; k++) {
    commands(k).forEach((c, i) => core.motorOverride(i, c));
    core.step(1);
    const s = core.state;
    prev = stepBattery(prev, 0.001, loadPrev, pack, DEFAULT_WHOOP);
    worstV = Math.max(worstV, Math.abs(s.vbatLoaded - prev.voltage) / prev.voltage);
    worstC = Math.max(worstC, Math.abs(s.soc - prev.charge) / Math.max(prev.charge, 1e-9));
    loadPrev = Math.min(1, s.thrustN.reduce((a, t) => a + Math.abs(t), 0) / (4 * tmax));
    if (k === 29999) console.log(`   at 30 s: C charge ${f(s.soc, 6)} V ${f(s.vbatLoaded, 6)}; JS charge ${f(prev.charge, 6)} V ${f(prev.voltage, 6)}`);
  }
  console.log(`   voltage max relative difference ${worstV.toExponential(3)} -> ${check(worstV <= 1e-6, 'P3 voltage')}`);
  console.log(`   charge  max relative difference ${worstC.toExponential(3)} -> ${check(worstC <= 1e-6, 'P3 charge')}`);
}

// ---------------------------------------------------------------------------
console.log('\n== P5 ground clearance: C query vs quadmath sim.html groundClearance (H:3206-3215) on every exported map');
{
  const WS = 3.5;
  const FLOOR_Y = 0.01 * WS;
  // quadmath's hook, over world-unit boxes, at a module-frame point.
  const hook = (pos, boxes) => {
    const gx = -pos[1] * WS;
    const gy = pos[2] * WS;
    const gz = -pos[0] * WS;
    let top = FLOOR_Y;
    for (const bb of boxes) {
      if (gx >= bb.min.x && gx <= bb.max.x && gz >= bb.min.z && gz <= bb.max.z && bb.max.y <= gy && bb.max.y > top) top = bb.max.y;
    }
    return (gy - top) / WS;
  };
  const fromUm = (um) => ({
    min: { x: -(um[4] * 1e-6) * WS, y: (um[2] * 1e-6) * WS, z: -(um[3] * 1e-6) * WS },
    max: { x: -(um[1] * 1e-6) * WS, y: (um[5] * 1e-6) * WS, z: -(um[0] * 1e-6) * WS },
  });
  const maps = ['living', 'garage', 'warehouse', 'backyard', 'office', 'gym', 'trainer', 'room', 'city-explore'];
  for (const id of maps) {
    const fix = JSON.parse(await readFile(new URL(`tests/fixtures/maps/${id}.json`, root), 'utf8'));
    const world = { floorZ: 0, boxes: fix.boxes.map((b) => ({ min: b.um.slice(0, 3).map((v) => v * 1e-6), max: b.um.slice(3).map((v) => v * 1e-6) })) };
    const core = await SimCore.load(module, { trace: false });
    core.configure({ diff: classDiff, world });
    const quantised = fix.boxes.map((b) => fromUm(b.um));
    const original = fix.boxes.map((b) => ({ min: { x: b.world[0], y: b.world[1], z: b.world[2] }, max: { x: b.world[3], y: b.world[4], z: b.world[5] } }));
    // Points: a grid over the map, plus each box's top corners and centre just
    // above and below its top face (the inclusive edges the hook tests).
    const lo = [0, 1, 2].map((a) => Math.min(...fix.boxes.map((b) => b.um[a])) - 500000);
    const hi = [0, 1, 2].map((a) => Math.max(...fix.boxes.map((b) => b.um[a + 3])) + 500000);
    const points = [];
    for (let i = 0; i <= 24; i++) {
      for (let j = 0; j <= 24; j++) {
        for (const zf of [0.02, 0.25, 0.5, 0.75, 1.0]) {
          points.push([lo[0] + Math.round(((hi[0] - lo[0]) * i) / 24), lo[1] + Math.round(((hi[1] - lo[1]) * j) / 24), Math.round(hi[2] * zf)]);
        }
      }
    }
    const gridCount = points.length;
    for (const b of fix.boxes) {
      for (const dz of [-20000, 0, 20000]) {
        for (const [x, y] of [[b.um[0], b.um[1]], [b.um[3], b.um[4]], [b.um[0], b.um[4]], [b.um[3], b.um[1]], [Math.round((b.um[0] + b.um[3]) / 2), Math.round((b.um[1] + b.um[4]) / 2)]]) {
          points.push([x, y, b.um[5] + dz]);
        }
      }
    }
    let exact = 0;
    let worstGrid = 0;
    let edgeMoved = 0;
    let differ = null;
    points.forEach((p, i) => {
      const pos = p.map((v) => v * 1e-6);
      const c = core.clearanceAt(pos);
      const jq = hook(pos, quantised);
      if (Object.is(c, jq)) exact++;
      else if (!differ) differ = { p, c, jq };
      // Against quadmath's unquantised boxes: on the grid the only difference
      // is the micrometre rounding of a box top. The edge points sit exactly
      // on rounded box edges, where the rounding can move a point in or out of
      // a box; those are counted, not measured.
      const d = Math.abs(c - hook(pos, original));
      if (i < gridCount) worstGrid = Math.max(worstGrid, d);
      else if (d > 1e-5) edgeMoved++;
    });
    console.log(`   ${id.padEnd(13)} ${String(fix.boxes.length).padStart(4)} boxes, ${String(points.length).padStart(5)} points: equal to the hook on the same (micrometre) boxes ${exact}/${points.length}; against quadmath's unquantised boxes: grid max |difference| ${worstGrid.toExponential(2)} m, ${edgeMoved}/${points.length - gridCount} edge points moved in or out by the rounding -> ${check(exact === points.length, `P5 ${id}`)} ${check(worstGrid <= 1e-6, `P5 ${id} vs quadmath's boxes`)}${differ ? ` first difference ${JSON.stringify(differ)}` : ''}`);
  }
  console.log('   not covered: the city base buildings and track gates, built inline in sim.html (they need a browser page to export)');
}

// ---------------------------------------------------------------------------
console.log('\n== F6 axis signs (acro 150 ms, angle 1 s; module frame X forward, Y left, Z up)');
for (const [name, sticks, angle, expect] of [
  ['acro roll right', { roll: 0.3 }, false, (g, e, v, sp) => g[0] > 0 && e.roll > 0 && v[1] < 0],
  ['acro pitch forward', { pitch: 0.3 }, false, (g, e, v) => g[1] > 0 && e.pitch > 0 && v[0] > 0],
  ['acro yaw right', { yaw: 0.3 }, false, (g, e, v, sp) => sp[2] < 0 && g[2] < 0 && e.yaw < 0],
  ['angle roll right', { roll: 0.5 }, true, (g, e, v, sp, att) => e.roll > 3 && att[0] > 3 && Math.abs(att[0] - e.roll) < 3 && v[1] < 0],
  ['angle pitch forward', { pitch: 0.5 }, true, (g, e, v, sp, att) => e.pitch > 3 && att[1] > 3 && Math.abs(att[1] - e.pitch) < 3 && v[0] > 0],
]) {
  const aux = angle ? auxOn('arm', 'angle') : auxOn('arm');
  const core = await airborne('', { aux });
  core.input(ch({ throttle: 0.4 }, aux));
  core.step(500);
  core.input(ch({ throttle: 0.4, ...sticks }, aux));
  core.step(angle ? 1000 : 150);
  const s = core.state;
  const fcs = core.fc;
  const e = euler(s.quat);
  const ok = expect(fcs.gyroFiltered, e, s.vel, fcs.setpoint, fcs.attitude);
  console.log(`   ${name.padEnd(20)} gyro ${fcs.gyroFiltered.map((v) => f(v, 0)).join(' ')} deg/s, setpoint ${fcs.setpoint.map((v) => f(v, 0)).join(' ')}, body roll ${f(e.roll, 1)} pitch ${f(e.pitch, 1)} yaw ${f(e.yaw, 1)} deg, Betaflight attitude ${fcs.attitude.map((v) => f(v, 1)).join(' ')}, velocity ${s.vel.map((v) => f(v, 2)).join(' ')} -> ${check(ok && core.fault === 0, `F6 ${name}`)}`);
}

// ---------------------------------------------------------------------------
console.log('\n== F9 3D and crash flip');
{
  // 3D: arm at mid throttle, then full reverse, then back into the deadband.
  const core = await airborne('feature 3D', { mode3d: true });
  console.log(`   3D armed ${core.fc.armed} (mode3d ${core.fc.mode3d})`);
  core.input(ch({ throttle: -1 }, auxOn('arm'), { mode3d: true }));
  core.step(300);
  let s = core.state;
  const reverse = s.thrustN.every((t) => t < 0);
  console.log(`   full reverse stick: DShot ${s.motorDshot.join(' ')}, thrust ${s.thrustN.map((t) => f(t)).join(' ')} N, rpm ${s.rpm.map((v) => f(v, 0)).join(' ')} -> ${check(reverse, 'F9 reverse thrust')}`);
  // In the deadband Betaflight 4.5.1 does not stop the motors: it mixes
  // throttle 0 into the range of the side last flown (flight/mixer.c:174-197
  // INVERTED_TO_DEADBAND, and the NORMAL range after forward), whose bottom is
  // the 3D idle from dshot_idle_value (drivers/dshot.c:63-66). So the thrust
  // there is idle thrust, not zero. PROGRESS.md M4 argues the plan's
  // "deadband gives zero" wording.
  const tmax = air65.values.tmax.value;
  core.input(ch({ throttle: 0 }, auxOn('arm'), { mode3d: true }));
  core.step(500);
  s = core.state;
  const revIdle = s.motorDshot.every((v) => v > 48 && v < 1048) && s.thrustN.every((t) => t < 0 && -t < 0.01 * tmax);
  const revIdleN = s.thrustN[0];
  console.log(`   deadband after reverse: DShot ${s.motorDshot.join(' ')}, thrust ${s.thrustN.map((t) => f(t, 6)).join(' ')} N (${f(-revIdleN / tmax * 100, 3)} % of full, reverse 3D idle) -> ${check(revIdle, 'F9 deadband reverse idle')}`);
  core.input(ch({ throttle: 1 }, auxOn('arm'), { mode3d: true }));
  core.step(300);
  core.input(ch({ throttle: 0 }, auxOn('arm'), { mode3d: true }));
  core.step(500);
  s = core.state;
  const fwdIdle = s.motorDshot.every((v) => v >= 1048) && s.thrustN.every((t) => t > 0 && t < 0.01 * tmax);
  const ratio = -revIdleN / s.thrustN[0];
  console.log(`   deadband after forward: DShot ${s.motorDshot.join(' ')}, thrust ${s.thrustN.map((t) => f(t, 6)).join(' ')} N (${f(s.thrustN[0] / tmax * 100, 3)} % of full, forward 3D idle); reverse/forward idle thrust ${f(ratio, 4)} (reverseScale ${air65.values.reverseScale.value}) -> ${check(fwdIdle, 'F9 deadband forward idle')}`);

  // Crash flip: FLIP OVER AFTER CRASH on AUX4 before arming, then full roll.
  // 50 ms in the air shows the commands and the thrust direction. Held much
  // longer the body spins up without limit (M4 drag has no rotational term)
  // and the 200 rad/s divergence guard stops the run.
  for (const mode3d of [false, true]) {
    const c = await SimCore.load(module, { trace: false });
    c.configure({ diff: `${diff}\n${mode3d ? 'feature 3D' : ''}`, plant: air65, world: { floorZ: -100 } });
    c.input(ch({ throttle: 0 }, auxOn('crashFlip'), { mode3d }));
    c.step(50);
    c.teleport({ pos: [0, 0, 0] });
    c.input(ch({ throttle: 0, roll: 1 }, auxOn('arm', 'crashFlip'), { mode3d }));
    c.step(50);
    const q = c.state;
    const flags = c.fc;
    const reversedByCommand = q.motorDir.some((d) => d < 0);
    const ok = mode3d ? !reversedByCommand : reversedByCommand;
    console.log(`   crash flip, 3D ${mode3d ? 'on' : 'off'}: armed ${flags.armed}, crashFlip ${flags.crashFlip}, spin-direction state ${q.motorDir.join(' ')}, DShot ${q.motorDshot.join(' ')}, thrust ${q.thrustN.map((t) => f(t)).join(' ')} -> ${check(ok && flags.armed && flags.crashFlip, `F9 crash flip 3D ${mode3d ? 'on' : 'off'}`)}`);
  }

  // Turtle as flown: upside down on the floor, crash flip on, armed, full roll,
  // then the stick centred. Betaflight's crash flip is open loop, so only the
  // plant can stop the roll. The gate releases at up-z > -0.5, a pulse as
  // pilots fly it: held until upright, a real whoop rolls on over (owner
  // decision 2026-10-23; PROGRESS.md logs it as a reshape). Pass: armed in
  // crash flip, upright (up-z > 0.9) and at rest (|omega| < 2 rad/s) at
  // 500 ms, no fault. Held until up-z > 0.9 is reported, not gated.
  {
    const upZ = (q) => 1 - 2 * (q[1] * q[1] + q[2] * q[2]);
    const turtle = async (releaseAt) => {
      const c = await SimCore.load(module, { trace: false });
      c.configure({ diff, plant: air65 });
      c.teleport({ pos: [0, 0, 0.01], quat: [0, 1, 0, 0] });
      c.input(ch({ throttle: 0 }, auxOn('crashFlip')));
      c.step(300);
      c.input(ch({ throttle: 0 }, auxOn('arm', 'crashFlip')));
      c.step(50);
      const armed = c.fc.armed && c.fc.crashFlip;
      const up0 = upZ(c.state.quat);
      c.input(ch({ throttle: 0, roll: 1 }, auxOn('arm', 'crashFlip')));
      let peak = 0;
      let faultAt = null;
      let releasedAt = null;
      let releaseRate = null;
      for (let k = 0; k < 500; k++) {
        c.flight.sc_step(1);
        if (c.fault) {
          faultAt = k + 1;
          break;
        }
        const st = c.state;
        peak = Math.max(peak, ...st.omega.map(Math.abs));
        if (releasedAt === null && upZ(st.quat) > releaseAt) {
          releasedAt = k + 1;
          releaseRate = Math.hypot(...st.omega);
          c.input(ch({ throttle: 0 }, auxOn('arm', 'crashFlip')));
        }
      }
      const end = c.state;
      const up = upZ(end.quat);
      const spin = Math.hypot(...end.omega);
      const ok = armed && up0 < -0.9 && faultAt === null && releasedAt !== null && up > 0.9 && spin < 2;
      const text = `start up-z ${f(up0, 2)}, armed in crash flip ${armed}; full roll, centred at up-z > ${releaseAt} (${releasedAt} ms, turning ${f(releaseRate, 1)} rad/s), peak body rate ${f(peak, 1)} rad/s, ${faultAt === null ? `at 500 ms up-z ${f(up, 2)}, |omega| ${f(spin, 2)} rad/s` : `fault ${c.fault} at ${faultAt} ms`}`;
      return { ok, text };
    };
    const pulse = await turtle(-0.5);
    console.log(`   turtle from the floor, pulsed: ${pulse.text} -> ${check(pulse.ok, 'F9 turtle from the floor')}`);
    const held = await turtle(0.9);
    console.log(`   turtle from the floor, held until upright (reported, not gated): ${held.text} -> ${held.ok ? 'upright' : 'not upright at 500 ms'}`);
  }
}

// ---------------------------------------------------------------------------
// sim-core on the Air65 config (X2, and the X3 hover stick against the
// bench); sim-core on the class diff beside WebFPV on it (X3 feel rows, the
// same diff and inputs on both until they are re-banded against the owner's
// freestyle log).
const ours = await feel.simCoreSim(SimCore, module, { diff, airframe: air65 });
const oursClass = await feel.simCoreSim(SimCore, module, { diff: classDiff, airframe: air65, name: 'sim-core, class diff' });
const ref = feel.webfpvSim(await loadWebfpvModule(), classDiff, { airframe: 1, gravity: 1, air: 1, kv: 1 }, { lenScale: feel.WEBFPV_WHOOP_LEN_SCALE, name: 'WebFPV whoop65' });
{
  const warned = ours.config.lines.filter((l) => l.status === 'rejected' || l.status === 'error');
  console.log(`\n== Air65 config ${AIR65_CONFIG.join(' + ')}: ${ours.config.applied} lines applied, ${warned.length} not (warnings, per the config rule)`);
  for (const l of warned) console.log(`   warning: line ${l.n} ${l.status}: ${l.text.trim()} (${l.msg})`);
}

// The freestyle replay, where the decoder and the log are at hand.
let freestyle = null;
{
  const qm = process.env.QUADMATH_DIR;
  const file = logPath(freestyleRef.source);
  if (qm && existsSync(file)) {
    const { simVsLog } = await import('../tools/sim-vs-log.mjs');
    freestyle = await simVsLog(file, qm, { diff, airframe: air65, module, log: freestyleRef.log_index });
    console.log(`\n== X3 replay of ${freestyleRef.source} log ${freestyleRef.log_index} on the Air65 config: ${freestyle.log.frames} frames into ${freestyle.sim.ticks} ticks; rcCommand read back within ${freestyle.rc_readback_max_error.join(', ')}`);
    for (const x of freestyle.axes) {
      const m = (s) => (s ? `rise ${s.riseMs} ms, lag ${s.lag50Ms} ms, overshoot ${s.overshootPct} %, settle ${s.settleMs} ms (${s.windows} windows)` : 'none');
      console.log(`   ${x.name.padEnd(5)} log: ${m(x.stepLog)}; sim: ${m(x.stepSim)}`);
    }
  } else {
    console.log(`\n== X3 replay of ${freestyleRef.source}: not run here (${qm ? `${file} not found` : 'QUADMATH_DIR not set'})`);
  }
}

console.log('\n== X2 / F3 rate tracking: throttle 0.35, full stick 1.5 s, mean of the last 0.3 s (+-1.0%)');
for (const [a, name] of ['roll', 'pitch', 'yaw'].entries()) {
  const o = feel.rateTracking(ours, a);
  const r = feel.rateTracking(ref, a);   // WebFPV on the class diff, for reference only
  console.log(`   ${name.padEnd(5)} sim-core ${f(o.achieved, 2)} deg/s vs setpoint ${f(o.setpoint, 2)} (${f(o.errPct, 3)} %); WebFPV ${f(r.achieved, 2)} (${f(r.errPct, 3)} %) -> ${check(!o.diverged && Math.abs(o.errPct) <= 1.0, `X2 ${name}`)}`);
}

console.log('\n== X3 feel bands: sim-core Air65 vs WebFPV whoop65, both on the class diff (65mm-air65-ryfly-1219s), same channel inputs, gravity/air/kv 1.0; hover stick: sim-core on the Air65 config vs the bench');
{
  // Betaflight's throttle rcCommand on the last tick of a hover trim (its
  // last trial flight is at the trimmed stick), 0..1 as the blackbox field
  // rcCommand[3] (blackbox/blackbox.c:1149) reads: min_check and the
  // throttle curve applied, before the mixer. sim-core only.
  const rcHover = (sim) => {
    const hover = feel.hoverTrim(sim);
    return { ...hover, rc: sim.core ? (sim.core.fc.rcCommand[3] - 1000) / 1000 : null };
  };
  const run = (sim) => {
    const hover = rcHover(sim);
    const thr = hover.throttle;
    return {
      hover, roll: feel.step(sim, thr, 0), pitch: feel.step(sim, thr, 1), yaw: feel.step(sim, thr, 2),
      chirp: feel.chirp(sim, thr), punch: feel.punch(sim, thr), hold: feel.rollThenHold(sim, thr), hands: feel.handsOff(sim, thr),
    };
  };
  const b = rcHover(ours);
  const o = run(oursClass);
  const r = run(ref);
  const rows = [];
  const rel = (pct, minAbs = 0) => (ov, rv) => Math.abs(ov - rv) <= Math.max(Math.abs(rv) * pct, minAbs);
  const abs = (lim) => (ov, rv) => Math.abs(ov - rv) <= lim;
  const ratio = (k) => (ov, rv) => ov !== null && rv !== null && ov <= rv * k;
  const bound = (lim) => (ov) => ov !== null && ov <= lim;
  const add = (key, band, ov, rv, test) => rows.push({ key, band, ov, rv, pass: ov !== null && ov !== undefined && test(ov, rv) });
  // Hover stick against the Air65's own bench hover (owner decision
  // 2026-10-23): rcCommand throttle, the bench throttle path, +-0.02.
  add('hover stick (Air65 bench)', '+-0.02', !b.diverged ? b.rc : null, bench.measured.hover_stick, abs(0.02));
  rows.at(-1).refName = 'Air65';
  // The plan restricts rise, overshoot and stop bounce to roll and pitch;
  // lag at 50% and settle have no axis restriction (PROGRESS.md band table).
  // Rise, lag and overshoot against the Air65's own freestyle log (owner
  // decision 2026-10-23), the bands unchanged: the closed-loop step response
  // of setpoint to gyro, by quadmath's blackbox-metrics.js stepResponse
  // (Wiener deconvolution) on both, the log and sim-core replaying its sticks
  // on the Air65 config. Needs QUADMATH_DIR and the log in SIM_CORE_LOGS;
  // without them the rows are not run here.
  const logRows = (sv) => {
    for (const [i, ax] of ['roll', 'pitch', 'yaw'].entries()) {
      const x = sv ? sv.axes[i] : null;
      const sim = x && x.stepSim;
      const log = x && x.stepLog;
      const tag = (k) => `${ax} ${k} (log)`;
      const put = (key, band, ov, rv, test) => {
        if (!sv) rows.push({ key, band, ov: null, rv: null, pass: false, notRun: true, refName: 'log' });
        else { add(key, band, ov, rv, test); rows.at(-1).refName = 'log'; }
      };
      put(tag('rise to 90% ms'), ax === 'yaw' ? '+-30%' : '+-20% (>= +-4 ms)', sim && sim.riseMs, log && log.riseMs, ax === 'yaw' ? rel(0.3) : rel(0.2, 4));
      put(tag('lag at 50% ms'), '+-3 ms', sim && sim.lag50Ms, log && log.lag50Ms, abs(3));
      if (ax !== 'yaw') put(tag('overshoot %'), '+-2 points', sim && sim.overshootPct, log && log.overshootPct, abs(2));
    }
  };
  logRows(freestyle);
  for (const ax of ['roll', 'pitch']) {
    add(`${ax} stop bounce (%)`, '+-2 points', o[ax].bouncePct, r[ax].bouncePct, abs(2));
  }
  for (const ax of ['roll', 'pitch', 'yaw']) {
    add(`${ax} settle 5% (ms)`, '<= 1.5x', o[ax].settle5, r[ax].settle5, ratio(1.5));
  }
  add('chirp lag (ms)', '+-3 ms', o.chirp.lagMs, r.chirp.lagMs, abs(3));
  add('yaw steady error (%)', '+-3 points', o.yaw.ssErrPct, r.yaw.ssErrPct, abs(3));
  add('chirp error after lag (%)', '+-3 points', o.chirp.rmsErrAfterLagPct, r.chirp.rmsErrAfterLagPct, abs(3));
  add('chirp gain', '+-0.03', o.chirp.gain, r.chirp.gain, abs(0.03));
  add('punch 1 s (m)', '+-15%', o.punch.climb1s, r.punch.climb1s, rel(0.15));
  add('coast after roll (deg)', '+-20%', o.hold.coastAfterRelease, r.hold.coastAfterRelease, rel(0.2));
  add('drift after roll (deg, 4.5 s)', '<= 0.5', o.hold.drift5s, r.hold.drift5s, bound(0.5));
  add('hands-off 8 s (deg)', '<= 0.05', o.hands.att8s, r.hands.att8s, bound(0.05));
  add('off-axis peak (deg/s)', '<= 10', Math.max(o.roll.offAxisPeak, o.pitch.offAxisPeak, o.yaw.offAxisPeak),
    Math.max(r.roll.offAxisPeak, r.pitch.offAxisPeak, r.yaw.offAxisPeak), bound(10));
  const diverged = Object.values(o).some((m) => m && m.diverged);
  add('divergence', 'none', diverged ? 1 : 0, 0, (ov) => ov === 0);
  for (const row of rows) {
    const signed = signoff.signedOff && signoff.signedOff[row.key];
    const verdict = row.notRun ? 'not run here: needs QUADMATH_DIR and the freestyle log in SIM_CORE_LOGS'
      : row.pass ? 'pass' : signed ? `MISS, signed off by the owner (${signed.by}, ${signed.date}${signed.reason ? `: ${signed.reason}` : ''})` : 'MISS';
    console.log(`   ${row.key.padEnd(30)} sim-core ${f(row.ov, 3).padStart(9)}  ${(row.refName || 'WebFPV').padEnd(6)} ${f(row.rv, 3).padStart(9)}  band ${row.band.padEnd(18)} ${verdict}`);
    if (!row.pass && !signed && !row.notRun) failures.push(`X3 ${row.key}`);
  }
  console.log(`   hover stick, Air65 bench row: on the Air65 config; channel ${f(b.quantum, 3)}, rcCommand ${f(b.rc, 3)}, vz residual ${f(b.vzResidual, 3)} m/s; measured rcCommand ${f(bench.measured.hover_stick, 3)} (${bench.source})`);
  console.log(`   not banded: yaw overshoot sim-core ${f(o.yaw.overshootPct, 2)} % vs WebFPV ${f(r.yaw.overshootPct, 2)} %; yaw bounce ${f(o.yaw.bouncePct, 2)} % vs ${f(r.yaw.bouncePct, 2)} %; hover residual vz ${f(o.hover.vzResidual, 3)} vs ${f(r.hover.vzResidual, 3)} m/s; hover stick on the class diff alone: sim-core channel ${f(o.hover.quantum, 3)} (rcCommand ${f(o.hover.rc, 3)}), WebFPV whoop65 channel ${f(r.hover.quantum, 3)} (the band's reference until 2026-10-23)`);
}

console.log(`\n${failures.length ? `gate-plant: FAIL (${failures.length}): ${failures.join('; ')}` : 'gate-plant: PASS'}`);
process.exitCode = failures.length ? 1 : 0;
