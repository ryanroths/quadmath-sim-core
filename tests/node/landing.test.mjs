// Landing at zero throttle, armed (owner, 2026-11-13): the acceptance target
// from the owner's Air65 log 143354 (log 0, 57.53 s). There the quad lands in
// acro with the throttle cut and air mode latched, takes one hop of about
// 1 cm (about 100 ms airborne: g t^2 / 8 = 12 mm), comes down again at
// 57.71 s and stays down until the disarm at 57.72 s.
//
// Each whoop, on its owner's diff, hovers at 0.3 m (CG) under an altitude hold
// for 2.5 s, until air mode latches, then the throttle is cut and the sticks
// are centred. In acro (the log's mode: only the ARM box on), two landings:
//   - drop: straight down from the hover (the log's landing);
//   - touch: 300 ms after the cut the quad is put just above the floor at 3
//     degrees of pitch, sinking at 0.05 m/s (the scout's case, the gentlest
//     landing a pilot makes).
// In angle mode (owner, 2026-11-16: the angle-mode target, the same as acro's):
//   - drop: the Air65's, as in acro;
//   - drift, each whoop: the pitch stick held at 0.25 forward (1625) over the
//     hover's last 0.6 s, so the quad drifts at the cut (0.18 m/s the Air65,
//     0.16 m/s the Fractal75: what a hovering pilot has), then at the cut the
//     throttle is cut and the sticks centred, and angle mode levels the quad
//     on the way down. The cut comes after 2.50 s of hover and every 30 ms to
//     2.80 s, 11 cuts a whoop: the altitude hold's small wander moves the
//     impact, and with it whether the first contact bounces (one hop of 4 to
//     9 mm, then at rest by 0.1 s) or holds the rims down. When it holds, the
//     one-tick impact spike reaches Betaflight's attitude estimate (the IMU's
//     100 Hz sample of a 200 Hz PT1 of the gyro, times 10 ms) at anywhere from
//     0 to about 7 times its area, the estimate is left 1.4 to 2.2 degrees off
//     the level quad, and angle mode levels toward that phantom tilt (10 to 14
//     deg/s of setpoint) with the floor holding the quad; air mode is latched,
//     so the I-term winds up, the motors split front against rear (up to about
//     990 against 50) and the quad rocks until the accelerometer corrects the
//     estimate. On version B (sim-core 0.7.0) the Air65 holds from the 2.62 s
//     cut on and the Fractal75 at 2.53, 2.62, 2.71 and 2.80 s, at rest 0.74 to
//     1.01 s after the first contact; one cut alone hits it or misses it.
// It stays armed 3 s from the cut. From the first floor contact:
//   hops: the lowest of the four duct rims leaving the floor by over 1 mm;
//   highest: that rim's highest point;
//   rest: the time from which, to the end of the 3 s, the rim stays within
//     0.5 mm of the floor and, over every 10 ms (a frame), the CG moves under
//     0.01 m/s and the attitude turns under 0.05 rad/s (the wall-hit test's
//     rest). Over a frame, not a tick: armed on the floor, the rigid contact
//     turns the attitude by under 0.01 degrees in one tick and back in the
//     next, which no frame shows; and state.omega there carries the motors'
//     torque the floor then takes back.
// The touch's pose is a teleport, which Betaflight's attitude estimate does
// not see: after the touch it reads -3 degrees with the quad level. Acro does
// not use the estimate.
//
// Asserted, every case (the 4 in acro, the angle drop and the 22 drifts): at
// most one hop, no higher than 15 mm (the log's 12 mm and a quarter); at rest
// within 0.5 s of the first contact (the log is back down at 0.18 s); still
// armed at the end, so the rest is not a disarm. The angle drop was reported
// only, as the log did not fly angle mode; the angle-mode target now covers
// it, and it is the drift's control: falling level, it rests by 0.1 s.
// The table gives each case's cut (the hover's length) and its horizontal
// speed there.
//
//   node tests/node/landing.test.mjs
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SimCore } from '../../src/js/sim-core.js';

const root = new URL('../../', import.meta.url);
const wasm = await readFile(new URL('dist/sim-core.wasm', root));
const QUADS = {
  Air65: { airframe: 'airframes/air65.json', diff: 'configs/air65-ryfly-2026-10-23.txt' },
  Fractal75: { airframe: 'airframes/fractal75.json', diff: 'configs/fractal75-ryfly-2026-11-03.txt' },
};

const AUX1 = 4, AUX2 = 5;       // ARM; ANGLE (low: acro)
const HOVER_Z = 0.3;            // m, the CG
const ARMED_MS = 3000;          // from the cut
const HOP_M = 0.001;            // a rim over 1 mm off the floor is a hop
const MAX_HOPS = 1;
const MAX_HOP_M = 0.015;
const REST_BY_S = 0.5;
const REST_LOW_M = 0.0005, REST_V = 0.01, REST_TURN = 0.05;
const FRAME_TICKS = 10;         // 10 ms at the 1 kHz tick
const HOVER_MS = 2500;          // the altitude-held hover before the cut
const DRIFT_MS = 600;           // drift: the pitch stick over the hover's last 0.6 s
const DRIFT_PITCH = 1625;       // drift: pitch stick 0.25 forward (1500 + 0.25 x 500)
const DRIFT_CUTS_MS = Array.from({ length: 11 }, (_, k) => HOVER_MS + 30 * k); // 2.50 s to 2.80 s

async function land(quad, kind, mode, hoverMs = HOVER_MS) {
  const q = QUADS[quad];
  const plant = JSON.parse(await readFile(new URL(q.airframe, root), 'utf8'));
  const diff = await readFile(new URL(q.diff, root), 'utf8');
  const core = await SimCore.load(wasm, { trace: false });
  core.configure({ diff, plant, world: { floorZ: 0, boxes: [] } });
  const ch = [1500, 1500, 1500, 1000, 1000, 1000, 1000, 1000];
  const tick = () => {
    if (core.simTimeUs % 4000 === 0) core.input(ch, core.simTimeUs);
    core.step(1);
  };
  for (let i = 0; i < 300; i++) tick();
  ch[AUX1] = 2000;
  ch[AUX2] = mode === 'angle' ? 2000 : 1000;
  for (let i = 0; i < 300; i++) tick();
  assert.equal(core.fc.armed, true, `${quad}: armed (flags ${core.fc.armingDisableFlags})`);
  // Altitude hold at HOVER_Z, the throttle stick from height and climb rate.
  let ie = 0;
  for (let i = 0; i < hoverMs; i++) {
    if (kind === 'drift' && i === hoverMs - DRIFT_MS) ch[1] = DRIFT_PITCH;
    const s = core.state, e = HOVER_Z - s.pos[2];
    ie += e * 0.001;
    ch[3] = Math.round(1000 + 1000 * Math.max(0, Math.min(1, 0.37 + 0.6 * e - 0.25 * s.vel[2] + 0.3 * ie)));
    tick();
  }
  assert.equal(core.fc.airmode, true, `${quad}: air mode latched in the hover`);
  const drift = Math.hypot(core.state.vel[0], core.state.vel[1]);
  ch[3] = 1000;
  ch[1] = 1500;
  const hb = plant.values.hullBelow.value;
  let t = 0;
  if (kind === 'touch') {
    for (; t < 300; t++) tick();
    const tilt = 3 * Math.PI / 180;
    const reach = (plant.values.wheelbase.value / 2 + plant.values.ductOuterRadius.value) * Math.SQRT1_2;
    const p = core.state.pos;
    core.teleport({ pos: [p[0], p[1], hb * Math.cos(tilt) + reach * Math.sin(tilt) + 0.0005],
      quat: [Math.cos(tilt / 2), 0, Math.sin(tilt / 2), 0], vel: [0, 0, -0.05] });
  }
  const rows = [];
  const frameS = FRAME_TICKS * core.tickUs / 1e6;
  for (; t < ARMED_MS; t++) {
    tick();
    const s = core.state;
    const low = Math.min(...core.footprint.slice(0, 4).map((r) => r[2]));
    const row = { t: t / 1000, low, floor: (s.contactFlags & 1) !== 0, pos: s.pos, quat: s.quat, v: 0, turn: 0 };
    const back = rows[rows.length - FRAME_TICKS];
    if (back) {
      const dot = Math.min(1, Math.abs(s.quat.reduce((a, v, k) => a + v * back.quat[k], 0)));
      row.v = Math.hypot(...s.pos.map((x, k) => x - back.pos[k])) / frameS;
      row.turn = 2 * Math.acos(dot) / frameS;
    }
    rows.push(row);
  }
  const first = rows.findIndex((r) => r.floor);
  assert.ok(first >= 0, `${quad} ${kind}: reached the floor`);
  const after = rows.slice(first);
  let hops = 0, off = false, highest = 0;
  for (const r of after) {
    highest = Math.max(highest, r.low);
    if (!off && r.low > HOP_M) hops++;
    off = r.low > HOP_M;
  }
  let lastMoving = -1;
  after.forEach((r, i) => {
    if (r.low > REST_LOW_M || r.v > REST_V || r.turn > REST_TURN) lastMoving = i;
  });
  const rest = lastMoving === after.length - 1 ? null : (lastMoving + 1) * core.tickUs / 1e6;
  return { quad, kind, mode, cut: hoverMs / 1000, drift, hops, highest, rest, armed: core.fc.armed, motor: core.state.motorOut };
}

const CASES = [
  ['Air65', 'drop', 'acro'], ['Air65', 'touch', 'acro'],
  ['Fractal75', 'drop', 'acro'], ['Fractal75', 'touch', 'acro'],
  ['Air65', 'drop', 'angle'],
  ...['Air65', 'Fractal75'].flatMap((quad) => DRIFT_CUTS_MS.map((cut) => [quad, 'drift', 'angle', cut])),
];
const rows = [];
for (const [quad, kind, mode, cut] of CASES) rows.push(await land(quad, kind, mode, cut));

const f = (v, d) => (v === null ? 'never' : v.toFixed(d));
console.log('quad       landing  mode   cut s  drift m/s  hops  highest mm  rest s  armed  motors at the end');
for (const r of rows) {
  console.log(`${r.quad.padEnd(10)} ${r.kind.padEnd(8)} ${r.mode.padEnd(6)} ${f(r.cut, 2).padStart(5)}  ${f(r.drift, 2).padStart(9)}  ${String(r.hops).padStart(4)}  ${f(r.highest * 1000, 1).padStart(10)}  ${f(r.rest, 3).padStart(6)}  ${String(r.armed).padEnd(5)}  ${r.motor.map((m) => m.toFixed(2)).join(' ')}`);
}
for (const r of rows) {
  const name = `${r.quad} ${r.kind} (${r.mode}${r.kind === 'drift' ? `, cut at ${f(r.cut, 2)} s` : ''})`;
  assert.ok(r.hops <= MAX_HOPS, `${name}: ${r.hops} hops, the log takes one`);
  assert.ok(r.highest <= MAX_HOP_M, `${name}: a hop of ${f(r.highest * 1000, 1)} mm, the log's is about 12`);
  assert.ok(r.rest !== null && r.rest <= REST_BY_S, `${name}: at rest ${r.rest === null ? 'never' : `at ${f(r.rest, 3)} s`}, by ${REST_BY_S} s after the first contact`);
  assert.equal(r.armed, true, `${name}: still armed at the end`);
}
console.log(`landing: every case at most ${MAX_HOPS} hop of up to ${MAX_HOP_M * 1000} mm, at rest by ${REST_BY_S} s, armed`);
