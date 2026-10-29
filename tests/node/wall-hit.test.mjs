// Wall hits (owner, 2026-10-28): the Air65 flies into a wall at 2, 4 and
// 8 m/s, 15, 30, 60 and 90 degrees off the wall's plane (90 is head on), nose
// first and pitched into its direction of travel as steady flight at that
// speed holds it (thrust against the plant's frontal drag), the CG 1 m up.
// Two pilots:
//   - flown: Betaflight armed in acro on the owner's diff, sticks centred,
//     the steady-flight throttle held through the hit and REACT_MS past the
//     first wall contact, then the throttle to zero (the drop), and a disarm
//     DISARM_MS after the first floor contact;
//   - off: motors off from the start, the plant alone.
// Each case reports the velocity 50 ms after the first wall contact (away
// from the wall, along it, vertical), the body rates then (tilt: roll and
// pitch together; yaw), the speed along the wall at REACT_MS (flown: still
// pressed on by the thrust when the nose points into it), and the end state
// at rest on the floor: upright (up Z above 0.9), inverted (below -0.5), or
// wedged (anything else: on its side, or propped on the wall).
//
// Asserted: every case hits the wall and comes to rest; a 2 m/s head-on hit
// (off) comes back at the wall restitution; a glancing hit (15 or 30
// degrees) keeps three quarters of its speed along the wall, and with the
// motors off loses at least half of one contact's Coulomb take. With --target,
// the owner's target instead, its own entry in run-all: upright after every
// hit under 60 degrees and 6 m/s (flown: 15 and 30 degrees at 2 and 4 m/s).
//
//   node tests/node/wall-hit.test.mjs
//   node tests/node/wall-hit.test.mjs --target
//   node tests/node/wall-hit.test.mjs --set hullBelow=0.006   # a what-if: report only, nothing asserted
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SimCore } from '../../src/js/sim-core.js';

const root = new URL('../../', import.meta.url);
const wasm = await readFile(new URL('dist/sim-core.wasm', root));
const diff = await readFile(new URL('configs/air65-ryfly-2026-10-23.txt', root), 'utf8');
const air65 = JSON.parse(await readFile(new URL('airframes/air65.json', root), 'utf8'));
const whatIf = [];
for (let i = process.argv.indexOf('--set'); i > 0; i = process.argv.indexOf('--set', i + 1)) {
  const [name, value] = process.argv[i + 1].split('=');
  if (!air65.values[name]) throw new Error(`no airframe value '${name}'`);
  air65.values[name].value = Number(value);
  whatIf.push(`${name}=${value}`);
}
const val = (k) => air65.values[k].value;

// The wall: its face at x = WALL_X, facing -x, 20 m long, 3 m high.
const WALL_X = 1;
const WALL_ID = 7;
const world = { floorZ: 0, boxes: [{ min: [WALL_X, -10, 0], max: [WALL_X + 0.3, 10, 3], id: WALL_ID }] };
const HEIGHT = 1;               // m, the CG at the start
const GAP = 0.005;              // m, the leading duct's outside to the wall at the start
const REACT_MS = 250;           // flown: the throttle held this long past the first wall contact
const DISARM_MS = 300;          // flown: the disarm, this long past the first floor contact
const HOVER = 0.371;            // the bench hover stick (tests/reference/air65-hover.json)

const mul = (a, b) => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
];
const rotate = (q, v) => mul(mul(q, [0, ...v]), [q[0], -q[1], -q[2], -q[3]]).slice(1);
const upZ = (q) => 1 - 2 * (q[1] * q[1] + q[2] * q[2]);

// Steady level flight at speed v: thrust tilted so its horizontal part meets
// the frontal drag.
const pitchFor = (v) => Math.atan2(0.5 * val('airDensity') * val('cdAFront') * v * v, val('mass') * val('gravity'));

// How far the ducts reach along +x at attitude q: round each duct, at its
// bottom and top rims.
function leadingX(q) {
  const arm = val('wheelbase') / 2 * Math.SQRT1_2, R = val('ductOuterRadius');
  let best = -Infinity;
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    for (const z of [-val('hullBelow'), -val('hullBelow') + val('ductHeight')]) {
      for (let k = 0; k < 72; k++) {
        const a = (k / 72) * 2 * Math.PI;
        best = Math.max(best, rotate(q, [sx * arm + R * Math.cos(a), sy * arm + R * Math.sin(a), z])[0]);
      }
    }
  }
  return best;
}

const AUX1 = 4;

async function hit(speed, angleDeg, pilot) {
  const core = await SimCore.load(wasm, { trace: false });
  core.configure({ diff, plant: air65, world });
  // Roll, pitch, yaw, throttle, AUX1 (ARM), AUX2 (ANGLE: low, acro), AUX3, AUX4.
  const ch = [1500, 1500, 1500, 1000, 1000, 1000, 1000, 1000];
  const throttle = (stick) => Math.round(1000 + 1000 * Math.min(1, stick));
  const step = (ms, each) => {
    for (let k = 0; k < ms; k++) {
      if (core.simTimeUs % 4000 === 0) core.input(ch, core.simTimeUs);
      core.step(1);
      if (each && each() === false) return;
    }
  };
  step(200);
  if (pilot === 'flown') {
    ch[AUX1] = 2000;
    step(300);
    assert.equal(core.fc.armed, true, `armed (flags ${core.fc.armingDisableFlags})`);
  }
  const a = angleDeg * Math.PI / 180;
  const yaw = Math.PI / 2 - a;                  // nose along the velocity
  const pitch = pitchFor(speed);
  const q = mul([Math.cos(yaw / 2), 0, 0, Math.sin(yaw / 2)], [Math.cos(pitch / 2), 0, Math.sin(pitch / 2), 0]);
  const vIn = { n: speed * Math.sin(a), t: speed * Math.cos(a) };
  // Thrust mg / cos(pitch) in steady flight, as the stick squared.
  if (pilot === 'flown') ch[3] = throttle(HOVER * Math.sqrt(1 / Math.cos(pitch)));
  core.teleport({ pos: [WALL_X - GAP - leadingX(q), 0, HEIGHT], quat: q, vel: [vIn.n, vIn.t, 0] });
  core.events();
  let hitUs = null, floorUs = null, crashed = false, impact = null, after = null, slideAtReact = null;
  let rest = 0;
  step(8000, () => {
    for (const e of core.events()) {
      if (e.kind !== 'contact') continue;
      if (e.box === WALL_ID) {
        if (hitUs === null) {
          hitUs = core.simTimeUs;
          impact = e.impactMs;
        }
        crashed = crashed || e.crashed;
      } else if (e.box === -1 && floorUs === null && hitUs !== null) {
        floorUs = core.simTimeUs;
      }
    }
    const s = core.state;
    if (hitUs !== null) {
      const since = core.simTimeUs - hitUs;
      if (after === null && since >= 50_000) {
        after = { vn: -s.vel[0], vt: s.vel[1], vz: s.vel[2], tilt: Math.hypot(s.omega[0], s.omega[1]) * 180 / Math.PI,
          yaw: s.omega[2] * 180 / Math.PI };
      }
      if (slideAtReact === null && since >= REACT_MS * 1000) {
        slideAtReact = s.vel[1];
        if (pilot === 'flown') ch[3] = 1000;
      }
    }
    if (pilot === 'flown' && floorUs !== null && core.simTimeUs - floorUs >= DISARM_MS * 1000) ch[AUX1] = 1000;
    rest = Math.hypot(...s.vel) < 0.01 && Math.hypot(...s.omega) < 0.05 && !core.fc.armed ? rest + 1 : 0;
    return rest < 200;
  });
  const s = core.state;
  const up = upZ(s.quat);
  // The ducts' sides lead the footprint's rims into the wall: the gap from
  // either.
  const wallGap = WALL_X - Math.max(s.pos[0] + leadingX(s.quat), ...core.footprint.map((p) => p[0]));
  const state = up > 0.9 ? 'upright' : up < -0.5 ? 'inverted' : 'wedged';
  return { speed, angleDeg, pilot, pitchDeg: pitch * 180 / Math.PI, vIn, impact, crashed, after, slideAtReact, state, up,
    z: s.pos[2], onWall: wallGap < 0.002, rested: rest >= 200 };
}

const SPEEDS = [2, 4, 8];
const ANGLES = [15, 30, 60, 90];
const rows = [];
for (const pilot of ['flown', 'off']) {
  for (const speed of SPEEDS) {
    for (const angleDeg of ANGLES) rows.push(await hit(speed, angleDeg, pilot));
  }
}

const f = (v, d = 2) => (v === null || v === undefined ? '-' : v.toFixed(d));
if (whatIf.length) console.log(`what-if: ${whatIf.join(', ')} (nothing asserted)`);
console.log(`airframe: wallFriction ${val('wallFriction')}, wallRestitution ${val('wallRestitution')}, ductHeight ${val('ductHeight')} m, hullBelow ${val('hullBelow')} m`);
console.log('pilot  m/s  deg  pitch  into   crash  vn_in  vt_in  | 50 ms: vn_out  vt_out  vz_out  tilt_dps  yaw_dps | vt@250ms | end');
for (const r of rows) {
  const a = r.after || {};
  console.log(`${r.pilot.padEnd(5)}  ${String(r.speed).padStart(3)}  ${String(r.angleDeg).padStart(3)}  ${f(r.pitchDeg, 1).padStart(5)}  ${f(r.impact).padStart(5)}  ${String(r.crashed).padEnd(5)}  ${f(r.vIn.n).padStart(5)}  ${f(r.vIn.t).padStart(5)}  |        ${f(a.vn).padStart(6)}  ${f(a.vt).padStart(6)}  ${f(a.vz).padStart(6)}  ${f(a.tilt, 0).padStart(8)}  ${f(a.yaw, 0).padStart(7)} | ${f(r.slideAtReact).padStart(8)} | ${r.state}${r.onWall ? ', on the wall' : ''} (up Z ${f(r.up, 3)})${r.rested ? '' : ', not at rest'}`);
}

const misses = rows.filter((r) => r.pilot === 'flown' && r.angleDeg < 60 && r.speed < 6 && r.state !== 'upright')
  .map((r) => `${r.speed} m/s ${r.angleDeg} deg: ${r.state} (up Z ${f(r.up, 3)}), tilt ${f(r.after && r.after.tilt, 0)} deg/s 50 ms after the hit`);
console.log(`the owner's target (flown, under 60 degrees and 6 m/s): ${misses.length ? `missed, ${misses.join('; ')}` : 'every hit upright'}`);
if (whatIf.length) {
  // A what-if asserts nothing.
} else if (process.argv.includes('--target')) {
  assert.deepEqual(misses, [], `the owner's target, upright after every hit under 60 degrees and 6 m/s (flown):\n  ${misses.join('\n  ')}`);
  console.log('wall hits, the owner\'s target: ok');
} else {
  for (const r of rows) {
    assert.ok(r.after && r.rested, `${r.pilot} ${r.speed} m/s ${r.angleDeg} deg: hit the wall and came to rest`);
    // A glance, not a stop: three quarters of the speed along the wall kept.
    if (r.angleDeg <= 30) {
      assert.ok(r.after.vt >= 0.75 * r.vIn.t, `${r.pilot} ${r.speed} m/s ${r.angleDeg} deg glances: ${f(r.after.vt)} m/s along the wall after, from ${f(r.vIn.t)}`);
    }
    // And the wall's friction acts: with the motors off, a glance loses at
    // least half of what one Coulomb contact takes, wallFriction (1 +
    // wallRestitution) times the speed into the wall (with wallFriction 0 it
    // loses only drag).
    if (r.pilot === 'off' && r.angleDeg <= 30) {
      const take = val('wallFriction') * (1 + val('wallRestitution')) * r.vIn.n;
      assert.ok(r.vIn.t - r.after.vt >= 0.5 * take, `${r.speed} m/s ${r.angleDeg} deg (off): ${f(r.vIn.t - r.after.vt, 3)} m/s taken along the wall, the wall's friction ${f(take, 3)} at one contact`);
    }
  }
  const headOn = rows.find((r) => r.pilot === 'off' && r.speed === 2 && r.angleDeg === 90);
  const ratio = headOn.after.vn / headOn.vIn.n;
  assert.ok(Math.abs(ratio - val('wallRestitution')) < 0.05, `2 m/s head on comes back at ${f(ratio, 3)} of the speed in (wallRestitution ${val('wallRestitution')})`);
  console.log(`2 m/s head on (off): back at ${f(ratio, 3)} of the speed in`);
  console.log('wall hits: ok');
}
