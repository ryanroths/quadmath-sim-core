// The fly harness's radio: which gamepad axis is which stick, and the stick
// calibration wizard. Ported from quadmath's sim (sim-touch.js:448-1066 at
// ryanroths/quadmath, the owner's code, ported by the owner's decision of
// 2026-10-24): the same presets, map shape, wizard steps and thresholds,
// rewritten here. Four things differ on purpose (the fourth, a bare
// "joystick" no longer scoring as a radio, at radioScore):
//   - quadmath's 0.02 stick deadzone is left out: Betaflight owns stick
//     shaping here (its own deadband settings), so the radio's channels pass
//     1:1.
//   - quadmath's own arming (stepArmSwitch, the throttle gate, Space to arm)
//     is left out: Betaflight arms from AUX1 itself.
//   - the wizard's arm and mode answers carry no sign. quadmath's own arming
//     read which way the switch moved; here the switch's channel goes to
//     Betaflight as the radio sends it, whose aux ranges are set for that.
// Pure functions of gamepad snapshots ({ id, axes, buttons }); the page and
// tests/node/fly-radio.test.mjs drive them.
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function sanitizeId(id) {
  return String(id == null ? '' : id).replace(/[^a-z0-9]+/gi, '_').slice(0, 64);
}

export function isRadio(gp) {
  const id = gp && gp.id != null ? String(gp.id) : '';
  return /opentx|edgetx|radiomaster|tx16|frsky|taranis|jumper|betafpv|flysky/i.test(id);
}

// Which of several pads to fly: a named radio first, a gamepad with the
// standard mapping (most likely a console controller) last. quadmath also
// gave a bare "joystick" a radio's score; that is left out, since generic USB
// pads are named "USB Joystick" too, and its pad picker, which let the pilot
// overrule the score, is not in the harness.
export function radioScore(gp) {
  if (!gp) return 0;
  if (/tx16|zorro|edgetx|opentx|1209|radiomaster|frsky|taranis|jumper|betafpv|flysky/i.test(gp.id || '')) return 2;
  if (gp.mapping === 'standard') return 0;
  return 1;
}

// EdgeTX/OpenTX joystick, AETR: 0 roll, 1 pitch, 2 throttle, 3 yaw.
export const AETR_MAP = Object.freeze({
  r: Object.freeze({ i: 0, sign: 1 }),
  p: Object.freeze({ i: 1, sign: -1 }),
  y: Object.freeze({ i: 3, sign: 1 }),
  t: Object.freeze({ i: 2, min: -1, max: 1 }),
});
// Spring gamepad, mode 2: left X yaw, left Y throttle, right X roll, right Y pitch.
export const PAD_MAP = Object.freeze({
  r: Object.freeze({ i: 2, sign: 1 }),
  p: Object.freeze({ i: 3, sign: -1 }),
  y: Object.freeze({ i: 0, sign: 1 }),
  t: Object.freeze({ i: 1, min: 0, max: -1, spring: true }),
});
const LITERADIO_TAER_MAP = Object.freeze({
  t: Object.freeze({ i: 0, min: -1, max: 1 }),
  r: Object.freeze({ i: 1, sign: 1 }),
  p: Object.freeze({ i: 2, sign: -1 }),
  y: Object.freeze({ i: 3, sign: 1 }),
});

export const RADIO_PRESETS = Object.freeze({
  radiomaster: { label: 'RadioMaster TX16S / Zorro / Boxer / Pocket (EdgeTX AETR)', map: AETR_MAP },
  frsky: { label: 'FrSky Taranis X9D / QX7 (OpenTX AETR)', map: AETR_MAP },
  jumper: { label: 'Jumper T-Lite / T20 (EdgeTX AETR)', map: AETR_MAP },
  literadio: { label: 'BetaFPV LiteRadio (AETR)', map: AETR_MAP },
  literadioTaer: { label: 'BetaFPV LiteRadio (TAER)', map: LITERADIO_TAER_MAP },
  flysky: { label: 'FlySky (AETR)', map: AETR_MAP },
  pad: { label: 'Xbox / PlayStation controller', map: PAD_MAP },
});

export function guessRadioPreset(gp) {
  const id = gp && gp.id != null ? String(gp.id) : '';
  if (/jumper/i.test(id)) return 'jumper';
  if (/frsky|taranis/i.test(id)) return 'frsky';
  if (/literadio/i.test(id)) return 'literadio';
  if (/flysky/i.test(id)) return 'flysky';
  if (/tx16|radiomaster|edgetx|opentx|zorro|boxer|pocket/i.test(id)) return 'radiomaster';
  if (isRadio(gp)) return 'radiomaster';
  return 'pad';
}

export function radioShortName(gp) {
  const id = gp && gp.id != null ? String(gp.id) : '';
  if (/tx16/i.test(id)) return 'TX16S';
  if (/zorro/i.test(id)) return 'Zorro';
  if (/jumper/i.test(id)) return 'Jumper';
  if (/frsky|taranis/i.test(id)) return 'FrSky';
  if (/literadio/i.test(id)) return 'LiteRadio';
  if (/flysky/i.test(id)) return 'FlySky';
  if (isRadio(gp)) return 'Radio';
  return 'Gamepad';
}

function axisAt(axes, i) {
  const v = axes && axes[i];
  return Number.isFinite(v) ? v : 0;
}

// Sticks from raw axes: roll, pitch, yaw -1..1 (positive: roll right, stick
// forward, yaw right) and throttle 0..1, low end at the calibrated rest.
export function applyAxisMap(axes, map) {
  const m = map || AETR_MAP;
  const r = clamp(axisAt(axes, m.r.i) * (m.r.sign || 1), -1, 1);
  const p = clamp(axisAt(axes, m.p.i) * (m.p.sign || 1), -1, 1);
  const y = clamp(axisAt(axes, m.y.i) * (m.y.sign || 1), -1, 1);
  const traw = axisAt(axes, m.t.i);
  let t;
  // Spring pads only. A ratcheted TX16S throttle is min/max -1..1, never the
  // spring map, or full up (+1) would read as throttle 0.
  if (m.t && m.t.spring) {
    t = clamp(-traw, 0, 1);
  } else {
    const min = m.t && Number.isFinite(m.t.min) ? m.t.min : -1;
    const max = m.t && Number.isFinite(m.t.max) ? m.t.max : 1;
    const span = max - min;
    t = Math.abs(span) < 0.1 ? 0 : clamp((traw - min) / span, 0, 1);
  }
  return { r, p, y, t };
}

export function isValidAxisMap(m) {
  if (!m || typeof m !== 'object') return false;
  const ch = (c) => !!(c && Number.isFinite(c.i) && c.i >= 0);
  return ch(m.r) && ch(m.p) && ch(m.y) && ch(m.t);
}

// Saved calibration, per device (keyed by the sanitised gamepad id), in the
// page's own localStorage. Storage failures (private mode, quota) are not
// errors: the harness flies on the preset.
const AXIS_MAP_PREFIX = 'simcoreFly.axisMap.';
export const GP_ID_KEY = 'simcoreFly.gamepadId';

export function loadAxisMap(id, store) {
  try {
    const raw = store && id ? store.getItem(AXIS_MAP_PREFIX + sanitizeId(id)) : null;
    const map = raw ? JSON.parse(raw) : null;
    return isValidAxisMap(map) ? map : null;
  } catch {
    return null;
  }
}

export function saveAxisMap(id, map, store) {
  try {
    if (store && id) store.setItem(AXIS_MAP_PREFIX + sanitizeId(id), JSON.stringify(map));
  } catch {
    // flies on the map in memory
  }
}

export function clearAxisMap(id, store) {
  try {
    if (store && id) store.removeItem(AXIS_MAP_PREFIX + sanitizeId(id));
  } catch {
    // nothing saved
  }
}

// ---- The calibration wizard (quadmath's CAL_STEPS and stepCalib) ----

export const CAL_STEPS = Object.freeze([
  { key: 'center', label: 'CENTER ALL STICKS, THROTTLE LOW', hint: 'hold 1 sec' },
  { key: 'r', label: 'ROLL: RIGHT STICK FULL RIGHT', hint: 'hold deflection' },
  { key: 'p', label: 'PITCH: RIGHT STICK FULL UP', hint: 'hold deflection' },
  { key: 'y', label: 'YAW: LEFT STICK FULL RIGHT', hint: 'hold deflection' },
  { key: 'thi', label: 'THROTTLE FULL UP', hint: 'hold' },
  { key: 'tlo', label: 'THROTTLE FULL DOWN', hint: 'hold' },
  { key: 'arm', label: 'ARM SWITCH: FLIP IT', hint: 'it becomes AUX1, or Skip aux' },
  { key: 'mode', label: 'MODE SWITCH: MOVE IT', hint: 'it becomes AUX2, or Skip aux' },
]);

export function createCalibState() {
  return { step: 0, timer: 0, center: null, result: {}, used: new Set(), thrCand: new Set(), lo: null, hi: null };
}

function listAxes(gp) {
  const raw = gp && gp.axes;
  if (!raw) return [];
  return Array.from(raw, (v) => (Number.isFinite(Number(v)) ? Number(v) : 0));
}

// EdgeTX USB joystick: the first four axes are the gimbals (in an order the
// radio's channel order sets); axes 4-7 are aux switches and pots that rest
// at -1 and must never be taken for the throttle.
const STICK_AXIS_COUNT = 4;

function isStickAxis(i, n) {
  return i >= 0 && i < Math.min(STICK_AXIS_COUNT, n);
}

// The throttle rests at an end (typically -1), not at 0: a stick axis away
// from centre at CENTER is a throttle candidate that roll, pitch and yaw
// never take.
function markThrottleCandidates(center) {
  const s = new Set();
  if (!center) return s;
  for (let i = 0; i < center.length; i++) {
    if (isStickAxis(i, center.length) && Math.abs(center[i]) >= 0.55) s.add(i);
  }
  return s;
}

function skipAuxAxes(ax) {
  const s = new Set();
  for (let i = STICK_AXIS_COUNT; i < ax.length; i++) s.add(i);
  return s;
}

function mergeSkip(a, b) {
  const s = new Set([...(a || []), ...(b || [])]);
  return s.size ? s : null;
}

function skipForStick(calib, ax) {
  const aux = skipAuxAxes(ax);
  const cand = calib.thrCand;
  if (!cand || !cand.size) return aux.size ? aux : null;
  let free = 0;
  for (let i = 0; i < ax.length; i++) {
    if (!calib.used.has(i) && !cand.has(i) && isStickAxis(i, ax.length)) free++;
  }
  return mergeSkip(aux, free > 0 ? cand : null);
}

// A stick pinned at an end, measured from the CENTER rest (not from this
// step's first sample: a stick already up when the step starts sweeps 0).
function heldStickLimit(ax, center, used) {
  let best = null;
  let bestAbs = 0;
  for (let i = 0; i < ax.length; i++) {
    if (used.has(i) || !isStickAxis(i, ax.length)) continue;
    if (Math.abs(ax[i]) < 0.95) continue;
    const rest = center && Number.isFinite(center[i]) ? center[i] : 0;
    const d = ax[i] - rest;
    if (Math.abs(d) < 0.5) continue;   // still at the CENTER rest (throttle low)
    if (Math.abs(d) > bestAbs) {
      bestAbs = Math.abs(d);
      best = { i, d, max: ax[i], min: rest, span: Math.abs(d) };
    }
  }
  return best;
}

function bestUnusedAxis(ax, center, used, minAbs, skip) {
  let best = -1;
  let bestD = 0;
  for (let i = 0; i < ax.length; i++) {
    if (used.has(i) || (skip && skip.has(i))) continue;
    const d = ax[i] - (center[i] || 0);
    if (Math.abs(d) > Math.abs(bestD)) {
      bestD = d;
      best = i;
    }
  }
  return best >= 0 && Math.abs(bestD) > minAbs ? { i: best, d: bestD } : null;
}

function trackSweep(calib, ax) {
  if (!calib.lo || calib.lo.length !== ax.length) {
    calib.lo = ax.slice();
    calib.hi = ax.slice();
    return;
  }
  for (let i = 0; i < ax.length; i++) {
    if (ax[i] < calib.lo[i]) calib.lo[i] = ax[i];
    if (ax[i] > calib.hi[i]) calib.hi[i] = ax[i];
  }
}

function bestSweep(calib, ax, used, minSpan, only) {
  let best = -1;
  let bestSpan = 0;
  for (let i = 0; i < ax.length; i++) {
    if (used.has(i) || !isStickAxis(i, ax.length)) continue;
    if (only && !only.has(i)) continue;
    const span = calib.hi[i] - calib.lo[i];
    if (span > bestSpan) {
      bestSpan = span;
      best = i;
    }
  }
  if (best < 0 || bestSpan <= minSpan) return null;
  const rest = calib.center[best];
  const hi = calib.hi[best];
  const lo = calib.lo[best];
  return { i: best, span: bestSpan, max: Math.abs(hi - rest) >= Math.abs(lo - rest) ? hi : lo, min: rest };
}

function clearSweep(calib) {
  calib.lo = null;
  calib.hi = null;
  calib.timer = 0;
}

function next(calib) {
  calib.step++;
  clearSweep(calib);
}

export function skipCalibAux(calib) {
  const st = CAL_STEPS[calib.step];
  if (st && (st.key === 'arm' || st.key === 'mode')) next(calib);
  return { state: calib, done: calib.step >= CAL_STEPS.length };
}

// One wizard sample: gp a gamepad snapshot, dt seconds since the last one.
// Returns what to show, and done once every step has its answer; the map is
// then calib.result ({ r, p, y, t, arm?, mode? }), arm and mode an axis { i }
// or a button { button }.
export function stepCalib(calib, gp, dt) {
  const st = CAL_STEPS[calib.step];
  if (!st || !gp) return { state: calib, done: calib.step >= CAL_STEPS.length, skipAux: false, label: '', hint: '' };
  const ax = listAxes(gp);
  const ui = { state: calib, done: false, skipAux: st.key === 'arm' || st.key === 'mode', label: st.label, hint: st.hint };
  const finish = () => {
    ui.done = calib.step >= CAL_STEPS.length;
    return ui;
  };

  if (st.key === 'center') {
    calib.timer += dt;
    if (calib.timer > 1) {
      calib.center = ax.slice();
      calib.thrCand = markThrottleCandidates(calib.center);
      next(calib);
    }
    return finish();
  }
  if (st.key === 'thi') {
    // A stable pin at an end against the CENTER rest first; then a sweep of
    // a stick axis (the throttle candidates preferred); then any stick axis
    // well away from its rest. Full up must reach a rail.
    trackSweep(calib, ax);
    let hit = heldStickLimit(ax, calib.center, calib.used);
    if (!hit) {
      const prefer = calib.thrCand && calib.thrCand.size ? calib.thrCand : null;
      hit = bestSweep(calib, ax, calib.used, 1.2, prefer) || bestSweep(calib, ax, calib.used, 1.2, null);
      if (hit && Math.abs(ax[hit.i] - hit.max) > 0.25 && hit.span < 1.6) hit = null;
    }
    if (!hit) {
      const moved = bestUnusedAxis(ax, calib.center, calib.used, 0.6, skipAuxAxes(ax));
      if (moved) hit = { i: moved.i, span: Math.abs(moved.d), max: ax[moved.i], min: calib.center[moved.i] };
    }
    if (hit) {
      const peak = Number.isFinite(hit.max) ? hit.max : ax[hit.i];
      if (Math.abs(ax[hit.i]) < 0.95 && Math.abs(peak) < 0.95) hit = null;
    }
    if (hit) {
      calib.timer += dt;
      if (calib.timer > 0.1) {
        const rail = Math.abs(ax[hit.i]) >= Math.abs(hit.max) ? ax[hit.i] : hit.max;
        calib.result.t = { i: hit.i, max: rail, min: hit.min };
        calib.used.add(hit.i);
        next(calib);
      }
    } else calib.timer = 0;
    return finish();
  }
  if (st.key === 'tlo') {
    const t = calib.result.t;
    const ti = t && t.i;
    if (!Number.isFinite(ti)) {
      next(calib);
      return finish();
    }
    const rest = calib.center && Number.isFinite(calib.center[ti]) ? calib.center[ti] : (Number.isFinite(t.min) ? t.min : 0);
    const peak = Number.isFinite(t.max) ? t.max : ax[ti];
    const nearRest = Math.abs(ax[ti] - rest) <= 0.4;
    const awayFromMax = Math.abs(ax[ti] - peak) > 0.5;
    if (nearRest || awayFromMax) {
      calib.timer += dt;
      if (calib.timer > 0.1) {
        t.min = nearRest ? ax[ti] : rest;
        t.max = peak;
        next(calib);
      }
    } else calib.timer = 0;
    return finish();
  }
  if (st.key === 'arm' || st.key === 'mode') {
    const moved = bestUnusedAxis(ax, calib.center, calib.used, 0.5);
    if (moved) {
      calib.timer += dt;
      if (calib.timer > 0.45) {
        calib.result[st.key] = { i: moved.i };
        calib.used.add(moved.i);
        next(calib);
      }
    } else {
      const buttons = (gp && gp.buttons) || [];
      let btn = -1;
      for (let i = 0; i < buttons.length && btn < 0; i++) {
        if (buttons[i] && (buttons[i].pressed || buttons[i].value > 0.6)) btn = i;
      }
      if (btn >= 0) {
        calib.timer += dt;
        if (calib.timer > 0.35) {
          calib.result[st.key] = { button: btn };
          next(calib);
        }
      } else calib.timer = 0;
    }
    return finish();
  }
  // Roll, pitch, yaw: a held deflection on a self-centring gimbal, never on
  // the throttle candidate or an aux axis resting at -1.
  const moved = bestUnusedAxis(ax, calib.center, calib.used, 0.6, skipForStick(calib, ax));
  if (moved) {
    calib.timer += dt;
    if (calib.timer > 0.6) {
      calib.result[st.key] = { i: moved.i, sign: Math.sign(moved.d) || 1 };
      calib.used.add(moved.i);
      next(calib);
    }
  } else calib.timer = 0;
  return finish();
}
