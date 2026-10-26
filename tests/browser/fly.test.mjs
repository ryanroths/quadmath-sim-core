// Phase 2 fly harness in headless Chrome: fly.html loads the Air65 preset,
// draws with WebGL2, polls a TX16S every 4 ms (a stand-in for
// navigator.getGamepads with the TX16S's axes, as Chrome on Windows reports
// it), arms on AUX1, climbs on the throttle, disarms on AUX1 low; runs the
// calibration wizard, after which an arm switch left on needs a cycle; flies
// on through a short USB drop with a generic pad plugged in and no stand-in;
// hands over from a console pad to a TX16S plugged in with its switch on only
// after a cycle; and logs no console errors.
//
//   node tests/browser/fly.test.mjs
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { launch, serve } from './chrome.mjs';

const TX16S = 'RM TX16S Joystick (Vendor: 1209 Product: 4f54)';
const XBOX = 'Xbox 360 Controller (XInput STANDARD GAMEPAD)';
const GENERIC = 'Generic   USB  Joystick   (STANDARD GAMEPAD Vendor: 0079 Product: 0006)';
const REST = [0, 0, -1, 0, -1, -1, -1, -1];
// window.__pads: the pads present, each { id, index, mapping, axes }. The
// page starts with the TX16S, or with a console pad alone at
// ?console-pad-only.
const FAKE_PADS = `
  window.__pads = location.search === '?console-pad-only'
    ? [{ id: '${XBOX}', index: 0, mapping: 'standard', axes: [0, 0, 0, 0], buttons: [] }]
    : [{ id: '${TX16S}', index: 0, mapping: '', axes: ${JSON.stringify(REST)} }];
  navigator.getGamepads = () => window.__pads.map((p) => ({
    ...p, connected: true, timestamp: performance.now(), axes: p.axes.slice(), buttons: (p.buttons || []).map((b) => ({ ...b })),
  }));`;

const server = await serve(fileURLToPath(new URL('../../', import.meta.url)));
const chrome = await launch();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const page = () => chrome.evaluate('JSON.parse(JSON.stringify(window.__fly))');
const radio = (changes = {}) => REST.map((v, i) => (i in changes ? changes[i] : v));
const setAxes = (axes) => chrome.evaluate(`window.__pads.find((p) => p.id === '${TX16S}').axes = ${JSON.stringify(axes)}`);
const waitReady = async () => {
  const deadline = Date.now() + 60_000;
  while (!(await chrome.evaluate('!!(window.__fly && (window.__fly.ready || window.__fly.error))'))) {
    if (Date.now() > deadline) throw new Error('fly.html did not start in 60 s');
    await sleep(100);
  }
};
let fly;
const seen = {};
try {
  await chrome.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_PADS });
  await chrome.goto(`${server.url}tests/browser/fly.html`);
  await waitReady();
  await sleep(1500);
  seen.rest = await page();

  // Arm, climb, disarm.
  await setAxes(radio({ 4: 1 }));
  await sleep(500);
  seen.armed = await page();
  await setAxes(radio({ 4: 1, 2: -1 + 2 * 0.45 }));
  await sleep(2000);
  seen.climb = await page();
  await setAxes(radio({ 4: 1, 2: -1 + 2 * 0.43, 1: 0.3 }));   // stick forward
  await sleep(600);
  seen.forward = await page();
  await setAxes(REST);
  await sleep(500);
  seen.disarmed = await page();

  // The calibration wizard, the arm switch left on at the end.
  await chrome.evaluate(`document.getElementById('calibrate').click()`);
  for (const [axes, ms] of [
    [REST, 1400], [radio({ 0: 1 }), 900], [radio({ 1: 1 }), 900], [radio({ 3: 1 }), 900],
    [radio({ 2: 1 }), 400], [REST, 400], [radio({ 4: 1 }), 800], [radio({ 4: 1, 5: 1 }), 800],
  ]) {
    await setAxes(axes);
    await sleep(ms);
  }
  await setAxes(radio({ 4: 1 }));   // ANGLE off again; the arm switch stays on
  await sleep(1500);
  seen.afterCalib = await page();
  await setAxes(REST);
  await sleep(300);
  await setAxes(radio({ 4: 1 }));
  await sleep(500);
  seen.cycled = await page();

  // In the air with a generic USB pad plugged in too; the TX16S drops off
  // USB for 300 ms and comes back. No stand-in takes over: the link is down
  // meanwhile (Betaflight's stage 1 failsafe), and the TX16S flies on.
  await setAxes(radio({ 4: 1, 2: -1 + 2 * 0.45 }));
  await sleep(800);
  await chrome.evaluate(`window.__pads.push({ id: '${GENERIC}', index: 1, mapping: 'standard', axes: [0, 0, 0, 0, 0], buttons: [] });
    window.dispatchEvent(Object.assign(new Event('gamepadconnected'), { gamepad: window.__pads[1] }))`);
  await sleep(300);
  seen.twoPads = await page();
  await chrome.evaluate(`{ const tx = window.__pads.shift(); window.__tx = tx;
    window.dispatchEvent(Object.assign(new Event('gamepaddisconnected'), { gamepad: tx })) }`);
  await sleep(300);
  seen.txGone = await page();
  await chrome.evaluate(`window.__pads.unshift(window.__tx);
    window.dispatchEvent(Object.assign(new Event('gamepadconnected'), { gamepad: window.__tx }))`);
  await sleep(1000);
  seen.txBack = await page();
  await setAxes(REST);
  await sleep(500);
  seen.end1 = await page();

  // A fresh load with only a console pad; then the TX16S is plugged in with
  // its arm switch already on: it takes over, and needs a switch cycle.
  await chrome.goto(`${server.url}tests/browser/fly.html?console-pad-only`);
  await waitReady();
  await sleep(1500);
  seen.padOnly = await page();
  await chrome.evaluate(`window.__pads.push({ id: '${TX16S}', index: 1, mapping: '', axes: ${JSON.stringify(radio({ 4: 1 }))} });
    window.dispatchEvent(Object.assign(new Event('gamepadconnected'), { gamepad: window.__pads[1] }))`);
  await sleep(1500);
  seen.plugged = await page();
  await setAxes(REST);
  await sleep(300);
  await setAxes(radio({ 4: 1 }));
  await sleep(500);
  fly = await page();
} catch (err) {
  for (const m of chrome.console) console.log(`   [${m.source} ${m.level}] ${m.text}`);
  throw err;
} finally {
  await chrome.close();
  await server.close();
}

const flags = (f) => `0x${f.flags.toString(16)}`;
for (const m of chrome.console) console.log(`   [${m.source} ${m.level}] ${m.text}`);
assert.equal(fly.error, null, `page error: ${fly.error}`);
console.log(`${chrome.version}: render ${fly.render}, ${fly.frames} frames, ${fly.polls} polls (${fly.pollHz} a second at the end), ${fly.inputs} inputs, ${fly.dropped} dropped, ${fly.inputErrors} input errors, ${fly.resets} resets`);
console.log(`TX16S (${seen.rest.mapSource}): rest armed ${seen.rest.armed} (flags ${flags(seen.rest)}); AUX1 up: armed ${seen.armed.armed}; 2 s at throttle 0.45: z ${seen.climb.pos[2].toFixed(2)} m; AUX1 down: armed ${seen.disarmed.armed}`);
console.log(`stick forward 0.6 s: x ${seen.climb.pos[0].toFixed(2)} to ${seen.forward.pos[0].toFixed(2)} m; scenery ${fly.scenery.length} world boxes`);
console.log(`calibrated (${seen.afterCalib.mapSource}), arm switch left on: armed ${seen.afterCalib.armed} (flags ${flags(seen.afterCalib)}); after a cycle: armed ${seen.cycled.armed}`);
console.log(`generic pad added in the air: flying ${seen.twoPads.pad}; TX16S unplugged 300 ms: pad ${seen.txGone.pad}, link ${seen.txGone.link}, armed ${seen.txGone.armed}; back: ${seen.txBack.pad}, link ${seen.txBack.link}, armed ${seen.txBack.armed}, z ${seen.txBack.pos[2].toFixed(2)} m`);
console.log(`console pad only: flying ${seen.padOnly.pad}; TX16S plugged with the switch on: ${seen.plugged.pad}, armed ${seen.plugged.armed} (flags ${flags(seen.plugged)}); after a cycle: armed ${fly.armed}`);
assert.equal(fly.render, 'webgl2', 'the view draws with WebGL2');
assert.equal(seen.rest.mapSource, 'preset radiomaster', 'the TX16S is recognised');
assert.equal(seen.rest.flags, 0, 'armable after the link comes up');
assert.equal(seen.rest.armed, false);
assert.equal(seen.armed.armed, true, 'arms on AUX1');
assert.ok(seen.climb.pos[2] > 0.5, 'climbs on the throttle');
assert.ok(seen.forward.pos[0] > seen.climb.pos[0] + 0.1, 'stick forward moves the quad +X');
// Eight 1 m cubes within 10 m of the start, and the gate's three bars at 5 m.
const cubes = fly.scenery.filter((b) => b.max[2] === 1);
assert.equal(cubes.length, 8);
for (const b of cubes) {
  assert.deepEqual(b.max.map((v, k) => +(v - b.min[k]).toFixed(9)), [1, 1, 1]);
  for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) assert.ok(Math.hypot(x, y) <= 10);
}
assert.equal(fly.scenery.filter((b) => b.min[0] === 4.95).length, 3, 'the gate');
assert.equal(seen.disarmed.armed, false, 'disarms on AUX1 low');
assert.equal(seen.afterCalib.mapSource, 'calibrated', 'the wizard finished');
assert.equal(seen.afterCalib.armed, false, 'an arm switch left on through calibration does not arm');
assert.equal(seen.cycled.armed, true, 'arms after the switch is cycled');
assert.equal(seen.twoPads.pad, TX16S, 'the TX16S keeps over a generic pad');
assert.equal(seen.txGone.pad, null, 'no stand-in while the TX16S is away');
assert.equal(seen.txGone.link, false, 'the link drops with the TX16S');
assert.equal(seen.txGone.armed, true, 'Betaflight holds through a short drop');
assert.equal(seen.txBack.pad, TX16S);
assert.equal(seen.txBack.link, true);
assert.equal(seen.txBack.armed, true, 'the TX16S flies on');
assert.equal(seen.end1.armed, false);
assert.equal(seen.padOnly.pad, XBOX, 'a console pad alone is flown');
assert.equal(seen.plugged.pad, TX16S, 'the TX16S takes over when plugged in');
assert.equal(seen.plugged.armed, false, 'plugged in with the switch on: not armed');
assert.equal(fly.armed, true, 'arms after the switch is cycled');
assert.equal(fly.inputErrors, 0);
assert.equal(fly.resets, 0);
assert.ok(fly.frames > 60, 'frames ran');
// 4 ms polls: a timer throttled to frame rate (60 a second) would show here.
assert.ok(fly.pollHz > 120, `the 4 ms poll ran (${fly.pollHz} a second)`);
assert.equal(chrome.console.filter((m) => m.level === 'error').length, 0, 'zero console errors');
console.log('fly: arms, climbs, disarms, calibrates and keeps the TX16S in Chrome, 0 console errors: PASS');
