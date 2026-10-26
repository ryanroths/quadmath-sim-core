// The fly harness page (fly.html): the Air65 preset on sim-core, a gamepad
// polled every 4 ms into the input ring, the view drawn every frame.
//
// Each animation frame: advance() by the frame's wall time, anchor the input
// clock, bring the radio link up or down (RadioLink), draw lerpState(). Every
// 4 ms: read the pad, map it to channels (or step the calibration wizard),
// stamp the sample in sim time, input() it. Betaflight arms from AUX1
// itself; nothing here arms, shapes sticks or applies rates.
//
// window.__fly carries the page's state for tests/browser/fly.test.mjs.
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import { SimCore } from '../../src/js/sim-core.js';
import {
  CAL_STEPS, GP_ID_KEY, RADIO_PRESETS, clearAxisMap, createCalibState, guessRadioPreset, loadAxisMap, radioScore,
  radioShortName, saveAxisMap, skipCalibAux, stepCalib,
} from './fly-radio.mjs';
import { InputClock, RadioLink, auxSources, channelsFrom } from './fly-input.mjs';
import { createRenderer } from './fly-render.mjs';

// The Air65 preset. The camera is quadmath's 65 mm whoop class
// (sim.html:4318, cam 15 degrees up) with its default vertical field of view
// (sim-feel.js VFOV_DEFAULT, 90 degrees); the airframe has no camera field.
const PRESET = {
  airframe: 'airframes/air65.json',
  config: 'configs/air65-ryfly-2026-10-23.txt',
  camDeg: 15,
  vfovDeg: 90,
};
const POLL_MS = 4;

// Betaflight's arming-disable flags (runtime_config.h:43-68), by bit.
const ARMING_FLAGS = [
  'NO_GYRO', 'FAILSAFE', 'RX_FAILSAFE', 'NOT_DISARMED', 'BOXFAILSAFE', 'RUNAWAY_TAKEOFF', 'CRASH_DETECTED', 'THROTTLE',
  'ANGLE', 'BOOT_GRACE_TIME', 'NOPREARM', 'LOAD', 'CALIBRATING', 'CLI', 'CMS_MENU', 'BST', 'MSP', 'PARALYZE', 'GPS',
  'RESC', 'DSHOT_TELEM', 'REBOOT_REQUIRED', 'DSHOT_BITBANG', 'ACC_CALIBRATION', 'MOTOR_PROTOCOL', 'ARM_SWITCH',
];
const flagNames = (flags) => ARMING_FLAGS.filter((_, bit) => flags & (1 << bit));

const fly = Object.assign(window.__fly, {
  started: true, ready: false, polls: 0, inputs: 0, dropped: 0, inputErrors: 0, lastStamp: null, resets: 0,
  render: null, pad: null, mapSource: null, calibrating: false, view: 'fpv',
});
const $ = (id) => document.getElementById(id);
const statusEl = $('status');
let store = null;
try {
  store = window.localStorage;
} catch {
  // no saved calibration this session
}

const text = async (path) => {
  const res = await fetch(new URL(`../../${path}`, import.meta.url));
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.text();
};

let core;
let link;
let renderer = null;
const clock = new InputClock();
let pad = null;   // { index, id, map, mapSource }
let calib = null;
let calibUi = null;
let note = '';
let fpv = true;

// A fresh instance: the link comes back as RadioLink allows (fly-input.mjs).
function reset(why) {
  core.reinit({ freshPack: true });
  clock.rebase();
  link.attach(core);
  fly.resets++;
  note = why;
}

// ---- The pad ----

function pads() {
  try {
    return Array.from((navigator.getGamepads && navigator.getGamepads()) || []).filter(Boolean);
  } catch {
    return [];
  }
}

function remembered() {
  try {
    return store ? store.getItem(GP_ID_KEY) : null;
  } catch {
    return null;
  }
}

function usePad(gp, all) {
  const saved = loadAxisMap(gp.id, store);
  const preset = guessRadioPreset(gp);
  pad = {
    index: gp.index,
    id: gp.id,
    map: saved || RADIO_PRESETS[preset].map,
    mapSource: saved ? 'calibrated' : `preset ${preset}`,
  };
  // Remembered when it is the only pad or nothing is remembered yet.
  if (all.length === 1 || !remembered()) {
    try {
      store?.setItem(GP_ID_KEY, gp.id);
    } catch {
      // not remembered
    }
  }
}

// The likeliest radio (radioScore); among equals, the pad in use, then the
// remembered one. After the pad in use is lost, only it is taken back, until
// Clear or a reload: a stand-in would send its own AUX1, and a quad in the air
// would disarm. Meanwhile the link stays down and Betaflight's failsafe has
// the quad. A switch to a different pad drops the link, so Betaflight sees the
// new pad's switches as a link coming back (RadioLink). No switch while the
// wizard runs.
let lost = null;   // the id of the pad that went away
function pickPad() {
  if (calib && pad) return;
  const all = pads();
  const list = lost ? all.filter((p) => p.id === lost) : all;
  if (!list.length) return;
  const best = Math.max(...list.map(radioScore));
  const top = list.filter((p) => radioScore(p) === best);
  const gp = top.find((p) => pad && p.id === pad.id) || top.find((p) => p.id === remembered()) || top[0];
  lost = null;
  if (pad && pad.id === gp.id && pad.index === gp.index) return;
  if (pad && pad.id !== gp.id) link.drop();
  usePad(gp, all);
}

function currentPad() {
  if (!pad) return null;
  const list = pads();
  // Chrome can return an empty list for a pad still plugged in; the ring
  // holds the last sample until it comes back or disconnects. An index that
  // moved is followed by id.
  return list.find((p) => p.index === pad.index && p.id === pad.id) || list.find((p) => p.id === pad.id) || null;
}

window.addEventListener('gamepadconnected', () => {
  if (core) pickPad();
});
window.addEventListener('gamepaddisconnected', (ev) => {
  if (!core || !pad || ev.gamepad.id !== pad.id) return;
  // The radio is gone: Betaflight's link drops and its failsafe takes over.
  lost = pad.id;
  pad = null;
  link.drop();
  note = 'radio disconnected: waiting for it (Clear to use another pad)';
  pickPad();
});

// ---- Polling, every 4 ms ----

let lastPollMs = null;
function poll() {
  const now = performance.now();
  const dt = lastPollMs === null ? 0 : (now - lastPollMs) / 1000;
  lastPollMs = now;
  fly.polls++;
  if (!pad) pickPad();
  const gp = currentPad();
  if (calib) {
    // The link is down while the wizard runs; nothing goes to Betaflight.
    calibUi = stepCalib(calib, gp, dt);
    if (gp) calibUi.axes = Array.from(gp.axes, (v) => v.toFixed(2));
    if (calibUi.done) finishCalib();
    return;
  }
  if (!gp) return;   // no new sample: the ring holds the last one
  const t = clock.stamp(core, now);
  if (t === null) {
    fly.dropped++;
    return;
  }
  try {
    core.input(channelsFrom(gp, pad.map), t);
    link.sample(t);
    fly.inputs++;
    fly.lastStamp = t;
  } catch (err) {
    fly.inputErrors++;
    note = String(err.message || err);
  }
}

// ---- Calibration ----

function startCalib() {
  if (!pad) {
    note = 'no radio to calibrate';
    return;
  }
  calib = createCalibState();
  calibUi = null;
  link.drop();
}

function finishCalib() {
  pad.map = calib.result;
  pad.mapSource = 'calibrated';
  saveAxisMap(pad.id, pad.map, store);
  calib = null;
  note = 'calibrated';
}

$('calibrate').onclick = () => {
  if (core) startCalib();
};
$('skipAux').onclick = () => {
  if (calib && skipCalibAux(calib).done) finishCalib();
};
$('cancel').onclick = () => {
  calib = null;
  note = 'calibration cancelled';
};
// Back to the preset, and forget which pad was remembered or lost. When that
// moves an aux channel to another source, the link drops first, as for a
// change of pad.
$('clear').onclick = () => {
  if (!core || calib) return;
  try {
    store?.removeItem(GP_ID_KEY);
  } catch {
    // nothing remembered
  }
  lost = null;
  note = 'calibration cleared';
  if (!pad) return;
  clearAxisMap(pad.id, store);
  const preset = guessRadioPreset({ id: pad.id });
  const gp = currentPad();
  const n = gp ? gp.axes.length : 8;
  const before = JSON.stringify(auxSources(pad.map, n));
  pad.map = RADIO_PRESETS[preset].map;
  pad.mapSource = `preset ${preset}`;
  if (JSON.stringify(auxSources(pad.map, n)) !== before) link.drop();
};
window.addEventListener('keydown', (ev) => {
  if (!core || ev.repeat || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if (ev.key === 'r' || ev.key === 'R') reset('reset');
  else if (ev.key === 'v' || ev.key === 'V') {
    fpv = !fpv;
    fly.view = fpv ? 'fpv' : 'los';
  }
});

// ---- Frames ----

let lastFrameMs = null;
let lastStatusMs = 0;
function frame(ts) {
  const dt = lastFrameMs === null ? 0 : ts - lastFrameMs;
  lastFrameMs = ts;
  fly.frames = (fly.frames || 0) + 1;
  try {
    core.advance(dt);
  } catch (err) {
    // A fault (the plant diverged) stops the instance: start over.
    reset(`${err.message}: reset`);
  }
  clock.anchor(core, ts);
  link.update(!!pad && !calib);
  core.events();   // drained; the harness has no use for them yet
  const s = core.lerpState();
  if (renderer) renderer.draw(s, { fpv, camDeg: PRESET.camDeg, vfovDeg: PRESET.vfovDeg });
  if (ts - lastStatusMs > 100) {
    lastStatusMs = ts;
    showStatus(s);
  }
  requestAnimationFrame(frame);
}

let rate = { ms: 0, polls: 0 };
function showStatus(s) {
  const fc = core.fc;
  const now = performance.now();
  if (now - rate.ms >= 1000) {
    // Polls a second over the last second or so: 250 when the 4 ms timer keeps time.
    if (rate.ms) fly.pollHz = Math.round(((fly.polls - rate.polls) * 1000) / (now - rate.ms));
    rate = { ms: now, polls: fly.polls };
  }
  Object.assign(fly, {
    armed: fc.armed, flags: fc.armingDisableFlags, rxSignal: fc.rxSignal, simTimeUs: core.simTimeUs, pos: s.pos,
    pad: pad && pad.id, mapSource: pad && pad.mapSource, calibrating: !!calib, link: link.up,
  });
  $('skipAux').hidden = !(calib && calibUi && calibUi.skipAux);
  $('cancel').hidden = !calib;
  statusEl.classList.toggle('calib', !!calib);
  if (calib) {
    const step = CAL_STEPS[calib.step];
    statusEl.textContent = `CALIBRATE ${calib.step + 1}/${CAL_STEPS.length}: ${step ? `${step.label} (${step.hint})` : ''}`
      + `   ${calibUi && calibUi.axes ? calibUi.axes.map((v, i) => `ax${i} ${v}`).join(' ') : 'move a stick'}`;
    return;
  }
  const radio = pad ? `${radioShortName({ id: pad.id })}, ${pad.mapSource}` : 'no radio: plug in the TX16S (USB Joystick) and move a stick';
  const arm = fc.armed ? 'ARMED' : `disarmed${fc.armingDisableFlags ? `: ${flagNames(fc.armingDisableFlags).join(' ')}` : ''}`;
  statusEl.textContent = `${radio} | ${arm}${link.up ? '' : ' | link down'}${note ? ` | ${note}` : ''}`;
}

// ---- Start ----

try {
  const [airframe, config] = await Promise.all([text(PRESET.airframe).then(JSON.parse), text(PRESET.config)]);
  core = await SimCore.load(new URL('../../dist/sim-core.wasm', import.meta.url), { trace: false });
  // The dump carries lines the sim has no target for (OSD, VTX, board
  // identity); configure() reports them and goes on.
  const report = core.configure({ diff: config, plant: airframe, world: { floorZ: 0 } });
  console.info(`fly: ${PRESET.config}: ${report.applied} applied, ${report.rejected} refused, ${report.errors} not in the sim target`);
  link = new RadioLink(core);
  // The box: the plant's footprint (its rims, plant.c) and its hull heights.
  const v = airframe.values;
  const reach = (v.wheelbase.value / 2 + v.ductOuterRadius.value) * Math.SQRT1_2;
  try {
    renderer = createRenderer($('view'), { box: { halfX: reach, halfY: reach, bottom: -v.hullBelow.value, top: v.hullAbove.value } });
    fly.render = 'webgl2';
  } catch (err) {
    fly.render = `none: ${err.message}`;
    note = String(err.message);
  }
  pickPad();
  setInterval(poll, POLL_MS);
  requestAnimationFrame(frame);
  fly.ready = true;
} catch (err) {
  fly.error = String((err && err.stack) || err);
  statusEl.textContent = `ERROR ${err.message || err}`;
  throw err;
}
