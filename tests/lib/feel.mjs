// Feel metrics (X3) and rate tracking (F3/X2), measured the same way on
// sim-core and on the WebFPV reference. The procedures are the Phase 1
// research ones (webfpv-phase0/phase1-research/blackbox/feellib.mjs, our own
// code), adapted to a common sim interface:
//
//   sim.fly(stick, durMs, onStep) -> { diverged }
//     stick(tMs) -> { t, r, p, y }: WebFPV's stick convention (+roll right,
//       +pitch nose up, +yaw nose right, throttle 0..1), applied every 4 ms
//       (250 Hz) and rounded to whole microseconds of channel, so both sims
//       see the same rcData.
//     onStep(tMs, s) after every 1 ms tick, s = { z, vz, pos (m, up), quat
//       [w x y z], rate [roll, pitch, yaw] deg/s in the stick's sense,
//       setpoint [r p y] Betaflight deg/s, vbat }
//
// Divergence: any non-finite body rate, |rate| > 200 rad/s, or a sim-core
// fault ends the run (blackbox-ref.md:109; PROGRESS.md deliberate change 6).
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import { WebFpv } from './webfpv.mjs';

export const DEG = 180 / Math.PI;
export const SETTLE = 2000;
const FRAME_MS = 4;
const DIVERGED = 200;

const q500 = (v) => Math.round(500 * Math.max(-1, Math.min(1, v || 0)));
const q1000 = (v) => Math.round(1000 * Math.max(0, Math.min(1, v || 0)));

// WebFPV whoop65 reports position and velocity in scene metres: its plant
// scales them by len_scale = (0.110 + 0.0635) / (0.0325 + 0.0181)
// (WebFPV src/native/plant.c:523, :1903-1907). Rates are real.
export const WEBFPV_WHOOP_LEN_SCALE = (0.110 + 0.0635) / (0.0325 + 0.0181);

export function webfpvSim(module, diff, scenario, { lenScale = 1, name = 'WebFPV' } = {}) {
  const w = new WebFpv(module, diff);
  w.setScenario(scenario);
  return {
    name,
    fly(stick, durMs, onStep) {
      w.reset(4.2);
      for (let tMs = 0; tMs < durMs; tMs += 1) {
        if (tMs % FRAME_MS === 0) {
          const c = stick(tMs);
          w.input(tMs / 1000, q500(c.r) / 500, q500(c.p) / 500, q500(c.y) / 500, q1000(c.t) / 1000);
        }
        w.step(1);
        const st = w.state();
        const big = Math.max(Math.abs(st[11]), Math.abs(st[12]), Math.abs(st[13]));
        if (!Number.isFinite(big) || big > DIVERGED) return { diverged: { tMs: tMs + 1, rate: big } };
        const s = {
          z: st[3] / lenScale, vz: st[6] / lenScale, pos: [st[1] / lenScale, st[2] / lenScale, st[3] / lenScale],
          quat: [st[7], st[8], st[9], st[10]],
          rate: [st[11] * DEG, -st[12] * DEG, -st[13] * DEG],
          setpoint: [w.setpoint(0), w.setpoint(1), w.setpoint(2)],
          vbat: st[18],
        };
        if (onStep && onStep(tMs + 1, s) === 'stop') break;
      }
      return { diverged: null };
    },
  };
}

// sim-core with a plant: each run is a fresh flight instance, armed on a
// floor far below, then put level and still at the origin (as WebFPV's reset
// is) on a 4 ms RX-grid boundary, so frame timing matches WebFPV's.
export async function simCoreSim(SimCore, module, { diff, airframe, floorZ = -100, name = 'sim-core' }) {
  const core = await SimCore.load(module, { trace: false });
  const report = core.configure({ diff, plant: airframe, world: { floorZ } });
  const channels = (c, arm = 2000) => [1500 + q500(c.r), 1500 - q500(c.p), 1500 + q500(c.y), 1000 + q1000(c.t), arm];
  return {
    name,
    core,
    config: report,
    fly(stick, durMs, onStep) {
      core.reinit({ freshPack: true });
      core.input(channels({ t: 0 }));
      core.step(50);
      while (core.simTimeUs % (FRAME_MS * 1000) !== 0) core.step(1);
      if (!core.fc.armed) throw new Error('sim-core did not arm');
      core.teleport({ pos: [0, 0, 0] });
      const t0 = core.simTimeUs;
      for (let tMs = 0; tMs < durMs; tMs += 1) {
        if (tMs % FRAME_MS === 0) core.input(channels(stick(tMs)), t0 + tMs * 1000);
        core.flight.sc_step(1);
        if (core.fault) return { diverged: { tMs: tMs + 1, fault: core.fault } };
        const st = core.state;
        const big = Math.max(...st.omega.map(Math.abs));
        if (!Number.isFinite(big) || big > DIVERGED) return { diverged: { tMs: tMs + 1, rate: big } };
        const s = {
          z: st.pos[2], vz: st.vel[2], pos: st.pos, quat: st.quat,
          rate: [st.omega[0] * DEG, -st.omega[1] * DEG, -st.omega[2] * DEG],
          setpoint: core.fc.setpoint,
          vbat: st.vbatLoaded,
        };
        if (onStep && onStep(tMs + 1, s) === 'stop') break;
      }
      return { diverged: null };
    },
  };
}

// conj(a) * b, quaternions w x y z.
function qmulConj(a, b) {
  const [aw, ax, ay, az] = [a[0], -a[1], -a[2], -a[3]];
  const [bw, bx, by, bz] = b;
  return [
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
  ];
}

export function qangleDeg(a, b) {
  return 2 * Math.acos(Math.min(1, Math.abs(qmulConj(a, b)[0]))) * DEG;
}

const stickOf = (a, v) => (a === 0 ? { r: v } : a === 1 ? { p: v } : { y: v });
const rms = (v) => Math.sqrt(v.reduce((x, y) => x + y * y, 0) / v.length);

// Constant throttle that holds height: bisection on the mean vz over 2.5-3 s.
// The first trial flight that diverges is reported (X3 'divergence').
export function hoverTrim(sim) {
  let diverged = null;
  const evalVz = (thr) => {
    let sum = 0;
    let n = 0;
    const r = sim.fly(() => ({ t: thr }), 3000, (tMs, s) => {
      if (tMs > 2500) {
        sum += s.vz;
        n += 1;
      }
    });
    if (r.diverged && !diverged) diverged = { throttle: thr, ...r.diverged };
    return r.diverged ? NaN : sum / n;
  };
  let lo = 0;
  let hi = 1;
  let mid = 0.5;
  let vz = NaN;
  for (let i = 0; i < 30; i += 1) {
    mid = (lo + hi) / 2;
    vz = evalVz(mid);
    if (Math.abs(vz) < 0.002) break;
    if (vz > 0) hi = mid;
    else lo = mid;
  }
  return { throttle: mid, quantum: Math.round(mid * 1000) / 1000, vzResidual: vz, diverged };
}

// Full stick on one axis for 300 ms from hover, then centred for 300 ms.
export function step(sim, thr, a) {
  const HOLD = 300;
  const AFTER = 300;
  const resp = [];
  const sp = [];
  const off = [];
  const r = sim.fly((t) => ({ t: thr, ...stickOf(a, t >= SETTLE && t < SETTLE + HOLD ? 1 : 0) }), SETTLE + HOLD + AFTER, (tMs, s) => {
    if (tMs > SETTLE) {
      resp.push(s.rate[a]);
      sp.push(Math.abs(s.setpoint[a]));
      off.push([0, 1, 2].filter((b) => b !== a).map((b) => Math.abs(s.rate[b])));
    }
  });
  if (r.diverged) return { diverged: r.diverged };
  const hold = resp.slice(0, HOLD);
  const target = sp[HOLD - 1];
  const idx = (f) => hold.findIndex((x) => x >= f * target) + 1;
  const t10 = idx(0.1);
  const t50 = idx(0.5);
  const t90 = idx(0.9);
  const sp50 = sp.findIndex((x) => x >= 0.5 * target) + 1;
  let settle = null;
  for (let i = HOLD - 1; i >= 0; i -= 1) {
    if (Math.abs(hold[i] - target) > 0.05 * target) {
      settle = i + 2;
      break;
    }
  }
  if (settle === null) settle = 1;
  if (settle > HOLD) settle = null;
  const last = hold.slice(HOLD - 100);
  const rel = resp.slice(HOLD);
  return {
    target, t10, t50, t90, rise10_90: t10 && t90 ? t90 - t10 : null, trackLag50: t50 && sp50 ? t50 - sp50 : null,
    overshootPct: (Math.max(...hold) - target) / target * 100, settle5: settle,
    ssErrPct: (last.reduce((x, y) => x + y, 0) / last.length - target) / target * 100,
    bouncePct: -Math.min(...rel) / target * 100, offAxisPeak: Math.max(...off.slice(0, HOLD).flat()),
  };
}

// Roll chirp 1 -> 10 Hz over 4 s at half stick.
export function chirp(sim, thr) {
  const T = 4000;
  const F0 = 1;
  const F1 = 10;
  const stick = (t) => {
    if (t < SETTLE) return { t: thr };
    const u = (t - SETTLE) / 1000;
    if (u >= T / 1000) return { t: thr };
    return { t: thr, r: 0.5 * Math.sin(2 * Math.PI * (F0 * u + (F1 - F0) * u * u / (2 * T / 1000))) };
  };
  const ach = [];
  const sp = [];
  const r = sim.fly(stick, SETTLE + T, (tMs, s) => {
    if (tMs > SETTLE) {
      ach.push(s.rate[0]);
      sp.push(s.setpoint[0]);
    }
  });
  if (r.diverged) return { diverged: r.diverged };
  // Signed lag, -40..40 ms (negative: the response leads the setpoint, as
  // feedforward makes it), by Pearson correlation over each lag's overlap so
  // neither end of the window is favoured.
  const overlap = (L) => {
    const a = [];
    const b = [];
    for (let i = Math.max(0, L); i < Math.min(ach.length, sp.length + L); i += 1) {
      a.push(ach[i]);
      b.push(sp[i - L]);
    }
    return [a, b];
  };
  const pearson = (a, b) => {
    const ma = a.reduce((x, y) => x + y, 0) / a.length;
    const mb = b.reduce((x, y) => x + y, 0) / b.length;
    let sab = 0;
    let saa = 0;
    let sbb = 0;
    for (let i = 0; i < a.length; i += 1) {
      sab += (a[i] - ma) * (b[i] - mb);
      saa += (a[i] - ma) ** 2;
      sbb += (b[i] - mb) ** 2;
    }
    return sab / Math.sqrt(saa * sbb);
  };
  let best = 0;
  let bestC = -Infinity;
  for (let L = -40; L <= 40; L += 1) {
    const c = pearson(...overlap(L));
    if (c > bestC) {
      bestC = c;
      best = L;
    }
  }
  const [a, b] = overlap(best);
  const errLag = a.map((x, i) => x - b[i]);
  return { lagMs: best, rmsErrAfterLagPct: rms(errLag) / rms(b) * 100, gain: rms(ach) / rms(sp) };
}

// Full throttle for 1 s from hover: height gained.
export function punch(sim, thr) {
  let z0 = 0;
  let z1 = 0;
  const r = sim.fly((t) => ({ t: t < SETTLE ? thr : 1 }), SETTLE + 1000, (tMs, s) => {
    if (tMs === SETTLE) z0 = s.z;
    z1 = s.z;
  });
  if (r.diverged) return { diverged: r.diverged };
  return { climb1s: z1 - z0 };
}

// Full roll for 540 ms, then centred: coast after release and drift over the
// next 4.5 s (from release + 500 ms).
export function rollThenHold(sim, thr) {
  const ROLL = 540;
  const HOLD = 5000;
  let ang = 0;
  let angRel = 0;
  let qA = null;
  let qB = null;
  let coast = null;
  const r = sim.fly((t) => ({ t: thr, r: t >= SETTLE && t < SETTLE + ROLL ? 1 : 0 }), SETTLE + ROLL + HOLD, (tMs, s) => {
    if (tMs > SETTLE) ang += s.rate[0] / 1000;
    if (tMs === SETTLE + ROLL) angRel = ang;
    if (tMs > SETTLE + ROLL && coast === null && s.rate[0] <= 0) coast = ang - angRel;
    if (tMs === SETTLE + ROLL + 500) qA = s.quat.slice();
    if (tMs === SETTLE + ROLL + HOLD) qB = s.quat.slice();
  });
  if (r.diverged) return { diverged: r.diverged };
  return { coastAfterRelease: coast, drift5s: qangleDeg(qA, qB) };
}

// Hover hands-off for 8 s after the settle: attitude change.
export function handsOff(sim, thr) {
  let qA = null;
  let qB = null;
  const r = sim.fly(() => ({ t: thr }), 10000, (tMs, s) => {
    if (tMs === 2000) qA = s.quat.slice();
    if (tMs === 10000) qB = s.quat.slice();
  });
  if (r.diverged) return { diverged: r.diverged };
  return { att8s: qangleDeg(qA, qB) };
}

// T1 rate tracking (research p2_rates.mjs): throttle 0.35, full stick on one
// axis for 1.5 s, mean achieved rate over the last 0.3 s against the mean
// |setpoint|.
export function rateTracking(sim, a) {
  let ach = 0;
  let sp = 0;
  let n = 0;
  const r = sim.fly(() => ({ t: 0.35, ...stickOf(a, 1) }), 1500, (tMs, s) => {
    if (tMs > 1200) {
      ach += s.rate[a];
      sp += Math.abs(s.setpoint[a]);
      n += 1;
    }
  });
  if (r.diverged) return { diverged: r.diverged };
  const achieved = ach / n;
  const configured = sp / n;
  return { achieved, setpoint: configured, errPct: (achieved - configured) / configured * 100 };
}
