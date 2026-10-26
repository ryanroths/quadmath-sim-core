// Phase 2 fly harness, without a browser: the radio map and channels, the
// calibration wizard (ported from quadmath) on a scripted TX16S, the input
// clock, and the whole input path into sim-core on the Air65 preset (a
// scripted TX16S polled every 4 ms between 60 Hz frames): Betaflight sees a
// new sample on most 250 Hz RX frames, arms on AUX1 and climbs.
//
//   node tests/node/fly-radio.test.mjs
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SimCore } from '../../src/js/sim-core.js';
import { AETR_MAP, RADIO_PRESETS, createCalibState, guessRadioPreset, radioScore, skipCalibAux, stepCalib } from '../browser/fly-radio.mjs';
import { InputClock, RadioLink, auxSources, channelsFrom } from '../browser/fly-input.mjs';

const root = new URL('../../', import.meta.url);
const TX16S_ID = 'RM TX16S Joystick (Vendor: 1209 Product: 4f54)';
// A TX16S in USB joystick mode as Chrome on Windows reports it: 8 axes,
// AETR on 0-3, each the radio's channel output (stick forward, roll right
// and yaw right +1), CH5-CH8 on 4-7 resting at -1, no buttons.
const tx16s = (axes) => ({ id: TX16S_ID, index: 0, mapping: '', axes, buttons: [] });
const REST = [0, 0, -1, 0, -1, -1, -1, -1];

// ---- Preset map and channels ----
assert.equal(guessRadioPreset(tx16s(REST)), 'radiomaster');
// A generic USB pad is named a joystick too; it never ranks with a radio.
assert.equal(radioScore(tx16s(REST)), 2);
assert.equal(radioScore({ id: 'Generic   USB  Joystick   (STANDARD GAMEPAD Vendor: 0079 Product: 0006)', mapping: 'standard' }), 0);
assert.equal(radioScore({ id: 'USB Joystick', mapping: '' }), 1);
const preset = RADIO_PRESETS.radiomaster.map;
assert.deepEqual(channelsFrom(tx16s(REST), preset).slice(0, 8), [1500, 1500, 1500, 1000, 1000, 1000, 1000, 1000]);
// Roll right, pitch stick forward, yaw right, throttle full, CH5 up.
assert.deepEqual(channelsFrom(tx16s([1, 1, 1, 1, 1, -1, -1, -1]), preset).slice(0, 8), [2000, 2000, 2000, 2000, 2000, 1000, 1000, 1000]);
assert.deepEqual(channelsFrom(tx16s([-0.5, 0.25, -0.1, -0.5, 0, 1, -1, -1]), preset).slice(0, 8), [1250, 1625, 1250, 1450, 1500, 2000, 1000, 1000]);
assert.equal(channelsFrom(tx16s(REST), preset).length, 16);
console.log('preset map: TX16S AETR, CH5..CH8 on AUX1..AUX4');

// ---- Calibration on a scripted radio ----
// Each step held for its time in 4 ms polls; returns the finished map.
function calibrate(script) {
  const calib = createCalibState();
  let out = null;
  for (const { axes, secs, skip } of script) {
    if (skip) {
      out = skipCalibAux(calib);
      continue;
    }
    for (let t = 0; t < secs; t += 0.004) out = stepCalib(calib, tx16s(axes), 0.004);
  }
  assert.ok(out && out.done, `calibration finished (stuck at step ${calib.step})`);
  return calib.result;
}
const with_ = (base, changes) => base.map((v, i) => (i in changes ? changes[i] : v));
const map1 = calibrate([
  { axes: REST, secs: 1.2 },
  { axes: with_(REST, { 0: 1 }), secs: 0.8 },
  { axes: with_(REST, { 1: 1 }), secs: 0.8 },
  { axes: with_(REST, { 3: 1 }), secs: 0.8 },
  { axes: with_(REST, { 2: 1 }), secs: 0.3 },
  { axes: REST, secs: 0.3 },
  { axes: with_(REST, { 4: 1 }), secs: 0.6 },
  { axes: with_(REST, { 4: 1, 5: 1 }), secs: 0.6 },
]);
assert.deepEqual(map1, { r: { i: 0, sign: 1 }, p: { i: 1, sign: 1 }, y: { i: 3, sign: 1 }, t: { i: 2, max: 1, min: -1 }, arm: { i: 4 }, mode: { i: 5 } });
for (const axes of [REST, [0.3, -0.7, 0.2, -0.4, 1, -1, 1, -1]]) {
  assert.deepEqual(channelsFrom(tx16s(axes), map1), channelsFrom(tx16s(axes), AETR_MAP), 'the calibrated TX16S flies as the preset');
}
console.log('calibration, TX16S AETR: same map as the preset, arm on axis 4 (AUX1), mode on axis 5 (AUX2)');

// The arm and mode switches go to Betaflight as the radio sends them,
// whichever way they were moved in the wizard: CH6 left up (ANGLE) at CENTER
// and moved down at MODE, and the arm switch left on and flipped off at ARM.
const UP = with_(REST, { 4: 1, 5: 1 });
const map1b = calibrate([
  { axes: UP, secs: 1.2 },
  { axes: with_(UP, { 0: 1 }), secs: 0.8 },
  { axes: with_(UP, { 1: 1 }), secs: 0.8 },
  { axes: with_(UP, { 3: 1 }), secs: 0.8 },
  { axes: with_(UP, { 2: 1 }), secs: 0.3 },
  { axes: UP, secs: 0.3 },
  { axes: with_(UP, { 4: -1 }), secs: 0.6 },
  { axes: REST, secs: 0.6 },
]);
assert.deepEqual([map1b.arm, map1b.mode], [{ i: 4 }, { i: 5 }]);
assert.deepEqual(channelsFrom(tx16s(UP), map1b).slice(4, 6), [2000, 2000], 'switches up: AUX1 and AUX2 high, as the radio sends them');
assert.deepEqual(channelsFrom(tx16s(REST), map1b).slice(4, 6), [1000, 1000]);
console.log('calibration with the switches starting up: AUX1 and AUX2 as the radio sends them');

// A radio in TAER order whose arm switch is on CH7 (axis 6): the wizard finds
// the sticks by movement; the arm switch swaps into AUX1 and CH6 keeps AUX2.
const TAER_REST = [-1, 0, 0, 0, -1, -1, -1, -1];
const map2 = calibrate([
  { axes: TAER_REST, secs: 1.2 },
  { axes: with_(TAER_REST, { 1: 1 }), secs: 0.8 },
  { axes: with_(TAER_REST, { 2: 1 }), secs: 0.8 },
  { axes: with_(TAER_REST, { 3: 1 }), secs: 0.8 },
  { axes: with_(TAER_REST, { 0: 1 }), secs: 0.3 },
  { axes: TAER_REST, secs: 0.3 },
  { axes: with_(TAER_REST, { 6: 1 }), secs: 0.6 },
  { skip: true },
]);
assert.deepEqual(map2, { r: { i: 1, sign: 1 }, p: { i: 2, sign: 1 }, y: { i: 3, sign: 1 }, t: { i: 0, max: 1, min: -1 }, arm: { i: 6 } });
assert.deepEqual(auxSources(map2, 8), [{ i: 6 }, { i: 5 }, { i: 4 }, { i: 7 }]);
assert.deepEqual(channelsFrom(tx16s(with_(TAER_REST, { 0: 1, 6: 1 })), map2).slice(0, 8), [1500, 1500, 1500, 2000, 2000, 1000, 1000, 1000]);
console.log('calibration, TAER radio, arm on axis 6: throttle on axis 0, arm switch swapped into AUX1, mode skipped');

// A gamepad arm button: AUX1 high while it is held.
const padMap = { ...RADIO_PRESETS.pad.map, arm: { button: 3 } };
const pad = (pressed) => ({ id: 'Xbox controller', index: 0, mapping: 'standard', axes: [0, 0, 0, 0], buttons: [0, 1, 2, 3].map((i) => ({ pressed: pressed && i === 3, value: pressed && i === 3 ? 1 : 0 })) });
assert.equal(channelsFrom(pad(true), padMap)[4], 2000);
assert.equal(channelsFrom(pad(false), padMap)[4], 1000);
// Arm skipped, mode on a button: the button is AUX2, never AUX1 (ARM).
const modeOnly = { ...RADIO_PRESETS.pad.map, mode: { button: 3 } };
assert.deepEqual(channelsFrom(pad(true), modeOnly).slice(4, 6), [1000, 2000]);

// ---- The input clock ----
{
  const sim = { simTimeUs: 5_100_000, alpha: 0.25, tickUs: 1000 };
  const clock = new InputClock({ horizonUs: 100_000 });
  assert.equal(clock.stamp(sim, 0), 5_100_000, 'before the first frame: the next tick');
  clock.anchor(sim, 1000);   // wall 1000 ms is sim 5,100,250 us
  assert.equal(clock.stamp(sim, 1004), 5_104_250);
  assert.equal(clock.stamp(sim, 1003), 5_104_250, 'never backwards');
  assert.equal(clock.stamp(sim, 1150), null, 'past the horizon: dropped');
  clock.rebase();
  assert.equal(clock.stamp({ ...sim, simTimeUs: 5_100_000 }, 2000), 5_100_000, 'a reinit starts over');
}
console.log('input clock: wall time to sim time from the frame anchor, monotonic, capped');

// ---- The whole path on the Air65 preset ----
const module = await WebAssembly.compile(await readFile(new URL('dist/sim-core.wasm', root)));
const airframe = JSON.parse(await readFile(new URL('airframes/air65.json', root), 'utf8'));
const config = await readFile(new URL('configs/air65-ryfly-2026-10-23.txt', root), 'utf8');

// fly.mjs's loop in wall time, 0.25 ms steps: a poll every 4 ms (with
// jitter) and a frame every 16.7 ms (with jitter), each frame running its
// ticks one at a time so every tick's rcData can be read. radio(ms) gives
// the TX16S's axes at wall ms, or null while it is unplugged (a disconnect
// drops the link at once, as fly.mjs's handler does); resetAt are the wall
// times R is pressed.
async function fly(radio, ms, { stampAhead = true, resetAt = [] } = {}) {
  const core = await SimCore.load(module, { trace: false });
  core.configure({ diff: config, plant: airframe, world: { floorZ: 0 } });
  const clock = new InputClock();
  const link = new RadioLink(core);
  const resets = resetAt.slice();
  let present = false;
  let acc = 0;
  let nextPoll = 0;
  let nextFrame = 0;
  let lastFrame = 0;
  let seed = 7;
  const jitter = (span) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return (seed / 2147483648 - 0.5) * span;
  };
  const rc = [];
  const log = [];
  for (let w = 0; w <= ms; w += 0.25) {
    const axes = radio(w);
    if (present && !axes) link.drop();
    present = !!axes;
    if (resets.length && w >= resets[0]) {
      resets.shift();
      core.reinit({ freshPack: true });
      clock.rebase();
      link.attach(core);
      acc = 0;
    }
    if (w >= nextPoll) {
      nextPoll += 4 + jitter(1.5);
      const t = stampAhead ? clock.stamp(core, w) : core.simTimeUs;
      if (axes && t !== null) {
        core.input(channelsFrom(tx16s(axes), AETR_MAP), t);
        link.sample(t);
      }
    }
    if (w >= nextFrame) {
      acc += w - lastFrame;
      lastFrame = w;
      nextFrame += 1000 / 60 + jitter(4);
      while (acc >= 1) {
        core.step(1);
        acc -= 1;
        rc.push(core.fc.rcData[0]);
      }
      clock.anchor({ simTimeUs: core.simTimeUs, alpha: acc, tickUs: core.tickUs }, w);
      link.update(present);
      const fc = core.fc;
      const st = core.state;
      log.push({
        w, armed: fc.armed, flags: fc.armingDisableFlags, link: link.up, rc1: fc.rcData[1], sp1: fc.setpoint[1],
        x: st.pos[0], z: st.pos[2], wy: st.omega[1],
      });
    }
  }
  const at = (t) => log.find((f) => f.w >= t);
  return { rc, log, at };
}
const hex = (f) => `0x${f.flags.toString(16)}`;

// A roll sweep, 2 s from -1 to 1: count the RX frames whose roll differs
// from the frame before (500 frames at 250 Hz).
const sweep = (w) => with_(REST, { 0: Math.max(-1, Math.min(1, -1 + (w - 500) / 1000)) });
const changes = (rc) => {
  const frames = rc.filter((_, k) => k % 4 === 0);
  let n = 0;
  for (let k = 1; k < frames.length; k++) if (frames[k] !== frames[k - 1]) n++;
  return n;
};
const ahead = changes((await fly(sweep, 2600)).rc);
const naive = changes((await fly(sweep, 2600, { stampAhead: false })).rc);
console.log(`roll sweep over 500 RX frames: ${ahead} new samples stamped ahead in sim time, ${naive} stamped at the sim clock (once per frame)`);
assert.ok(ahead >= 440, `most RX frames carry a new sample (${ahead} of 500)`);
assert.ok(naive <= 140, `the once-per-frame stamp is what the clock avoids (${naive})`);

// Arm and climb: AUX1 up at 1 s, throttle 0.45 from 1.2 s to 3.2 s, AUX1
// down at 3.4 s. The link comes up once Betaflight has seen it gone, and
// Betaflight then clears RX_FAILSAFE after its recovery delay
// (failsafe_recovery_delay, 500 ms): armable well before 1 s.
const climb = (w) => with_(REST, { 4: w >= 1000 && w < 3400 ? 1 : -1, 2: w >= 1200 && w < 3200 ? -1 + 2 * 0.45 : -1 });
{
  const { log, at } = await fly(climb, 3700);
  const linkAt = log.find((f) => f.link).w;
  const clearAt = log.find((f) => f.w > linkAt && f.flags === 0).w;
  assert.ok(linkAt < 400, `the link is up soon after the radio is seen (${linkAt.toFixed(0)} ms)`);
  assert.ok(clearAt < 950, `no arming-disable flags before the switch goes up (${clearAt.toFixed(0)} ms)`);
  assert.equal(at(950).armed, false, 'disarmed with AUX1 low');
  assert.equal(at(1150).armed, true, `armed on AUX1 (flags ${hex(at(1150))})`);
  assert.ok(at(3200).z > 0.5, `climbing at throttle 0.45 (z ${at(3200).z.toFixed(2)} m)`);
  assert.equal(at(3600).armed, false, 'disarmed when AUX1 goes low');
  console.log(`Air65: link up at ${linkAt.toFixed(0)} ms, flags clear at ${clearAt.toFixed(0)} ms, armed on AUX1 at 1 s, z ${at(3200).z.toFixed(2)} m after 2 s at throttle 0.45, disarmed at 3.4 s`);
}

// Pitch, every hop: the TX16S's stick forward (+0.3 on axis 1) is a pitch
// channel above 1500 in Betaflight's rcData, a positive pitch setpoint, a
// nose-down body pitch rate (plant.c: + nose down) and the quad moving +x in
// the world. Arm at 1 s, climb, hold near hover, stick forward from 2.6 s.
{
  const forward = (w) => with_(REST, {
    4: w >= 1000 ? 1 : -1,
    2: w < 1200 ? -1 : -1 + 2 * (w < 2000 ? 0.45 : w < 2600 ? 0.405 : 0.43),
    1: w >= 2600 ? 0.3 : 0,
  });
  const { at } = await fly(forward, 3400);
  const before = at(2600);
  const f = at(2680);
  assert.equal(before.armed, true);
  assert.ok(f.rc1 > 1500, `stick forward: rcData[1] ${f.rc1} > 1500`);
  assert.ok(f.sp1 > 0, `pitch setpoint ${f.sp1.toFixed(1)} deg/s > 0`);
  assert.ok(f.wy > 0, `body pitch rate ${f.wy.toFixed(3)} rad/s > 0, nose down`);
  assert.ok(at(3300).x > before.x + 0.1, `moves +x in the world (${before.x.toFixed(2)} to ${at(3300).x.toFixed(2)} m)`);
  console.log(`stick forward: rcData[1] ${f.rc1}, setpoint[1] ${f.sp1.toFixed(1)} deg/s, pitch rate +${f.wy.toFixed(3)} rad/s (nose down), x ${before.x.toFixed(2)} to ${at(3300).x.toFixed(2)} m`);
}

// The arm switch already on: when the radio first appears (the page opened
// with it on), after R, and after a radio that was unplugged comes back.
// Betaflight's own guard (NOT_DISARMED) holds it disarmed until the switch
// is cycled, as on the real quad.
{
  const onAtLoad = (w) => with_(REST, { 4: w < 1500 || w >= 1800 ? 1 : -1 });
  const { at } = await fly(onAtLoad, 2400);
  assert.equal(at(1400).armed, false, `switch on at load: not armed (flags ${hex(at(1400))})`);
  assert.ok(at(1400).flags & (1 << 25), 'ARM_SWITCH: the switch must be cycled');
  assert.equal(at(2300).armed, true, `armed after the cycle (flags ${hex(at(2300))})`);
  console.log(`switch on at load: held (flags ${hex(at(1400))}) until cycled, then armed`);
}
{
  const onThrough = (w) => with_(REST, { 4: w >= 1000 && (w < 2500 || w >= 2800) ? 1 : -1 });
  const { at } = await fly(onThrough, 3400, { resetAt: [1500] });
  assert.equal(at(1400).armed, true);
  assert.equal(at(2400).armed, false, `R with the switch on: not armed (flags ${hex(at(2400))})`);
  assert.equal(at(3300).armed, true, `armed after the cycle (flags ${hex(at(3300))})`);
  console.log(`R with the switch on: held (flags ${hex(at(2400))}) until cycled, then armed`);
}
{
  // Disarmed, the radio unplugged for 0.5 s and back with the switch on.
  const unplugged = (w) => (w >= 1200 && w < 1700 ? null : with_(REST, { 4: w >= 1700 && (w < 2500 || w >= 2700) ? 1 : -1 }));
  const { at } = await fly(unplugged, 3400);
  assert.equal(at(1650).link, false, 'unplugged: the link is down');
  assert.equal(at(2400).armed, false, `back with the switch on: held (flags ${hex(at(2400))})`);
  assert.equal(at(3300).armed, true, `armed after the cycle (flags ${hex(at(3300))})`);
  console.log(`radio unplugged for 0.5 s, back with the switch on: link down meanwhile, held (flags ${hex(at(2400))}) until cycled`);
}

// A USB blip in flight, 60 ms: the quad keeps flying (Betaflight's stage 1
// failsafe holds), and no stale low frame disarms it.
{
  const blip = (w) => (w >= 2000 && w < 2060 ? null : with_(REST, { 4: w >= 1000 ? 1 : -1, 2: w >= 1200 ? -1 + 2 * 0.45 : -1 }));
  const { at } = await fly(blip, 3500);
  assert.equal(at(1900).armed, true);
  assert.equal(at(3400).armed, true, `still armed after the blip (flags ${hex(at(3400))})`);
  assert.ok(at(3400).z > at(1900).z, `still climbing (z ${at(1900).z.toFixed(2)} to ${at(3400).z.toFixed(2)} m)`);
  console.log(`60 ms USB blip in flight: still armed, z ${at(1900).z.toFixed(2)} to ${at(3400).z.toFixed(2)} m`);
}
console.log('fly-radio: PASS');
