// Landing at zero throttle, armed (owner, 2026-11-13): the acceptance target
// from the owner's Air65 log 143354 (log 0, 57.53 s). There the quad lands in
// acro with the throttle cut and air mode latched, takes one hop of about
// 1 cm (about 100 ms airborne: g t^2 / 8 = 12 mm), comes down again at
// 57.71 s and stays down until the disarm at 57.72 s.
//
// Each whoop, on its owner's diff, in acro (the log's mode: only the ARM box
// on), hovers at 0.3 m (CG) under an altitude hold until air mode latches,
// then the throttle is cut and the sticks are centred. Two landings:
//   - drop: straight down from the hover (the log's landing);
//   - touch: 300 ms after the cut the quad is put just above the floor at 3
//     degrees of pitch, sinking at 0.05 m/s (the scout's case, the gentlest
//     landing a pilot makes).
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
// Asserted, every case: at most one hop, no higher than 15 mm (the log's
// 12 mm and a quarter); at rest within 0.5 s of the first contact (the log is
// back down at 0.18 s); still armed at the end, so the rest is not a disarm.
// Reported only: the Air65's drop in angle mode, which the log did not fly.
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

async function land(quad, kind, mode) {
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
  for (let i = 0; i < 2500; i++) {
    const s = core.state, e = HOVER_Z - s.pos[2];
    ie += e * 0.001;
    ch[3] = Math.round(1000 + 1000 * Math.max(0, Math.min(1, 0.37 + 0.6 * e - 0.25 * s.vel[2] + 0.3 * ie)));
    tick();
  }
  assert.equal(core.fc.airmode, true, `${quad}: air mode latched in the hover`);
  ch[3] = 1000;
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
  return { quad, kind, mode, hops, highest, rest, armed: core.fc.armed, motor: core.state.motorOut };
}

const CASES = [
  ['Air65', 'drop', 'acro'], ['Air65', 'touch', 'acro'],
  ['Fractal75', 'drop', 'acro'], ['Fractal75', 'touch', 'acro'],
  ['Air65', 'drop', 'angle', { report: true }],
];
const rows = [];
for (const [quad, kind, mode, opt = {}] of CASES) rows.push({ ...(await land(quad, kind, mode)), report: !!opt.report });

const f = (v, d) => (v === null ? 'never' : v.toFixed(d));
console.log('quad       landing  mode   hops  highest mm  rest s  armed  motors at the end');
for (const r of rows) {
  console.log(`${r.quad.padEnd(10)} ${r.kind.padEnd(8)} ${r.mode.padEnd(6)} ${String(r.hops).padStart(4)}  ${f(r.highest * 1000, 1).padStart(10)}  ${f(r.rest, 3).padStart(6)}  ${String(r.armed).padEnd(5)}  ${r.motor.map((m) => m.toFixed(2)).join(' ')}${r.report ? '   (reported only)' : ''}`);
}
for (const r of rows.filter((x) => !x.report)) {
  const name = `${r.quad} ${r.kind} (${r.mode})`;
  assert.ok(r.hops <= MAX_HOPS, `${name}: ${r.hops} hops, the log takes one`);
  assert.ok(r.highest <= MAX_HOP_M, `${name}: a hop of ${f(r.highest * 1000, 1)} mm, the log's is about 12`);
  assert.ok(r.rest !== null && r.rest <= REST_BY_S, `${name}: at rest ${r.rest === null ? 'never' : `at ${f(r.rest, 3)} s`}, by ${REST_BY_S} s after the first contact`);
  assert.equal(r.armed, true, `${name}: still armed at the end`);
}
console.log(`landing: every case at most ${MAX_HOPS} hop of up to ${MAX_HOP_M * 1000} mm, at rest by ${REST_BY_S} s, armed`);
