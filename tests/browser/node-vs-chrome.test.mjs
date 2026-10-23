// D2 Node vs Chrome: the scenario matrix (every class preset, acro and angle,
// RPM filter on and off, 3D off and on) gives the same trace hash in Node and
// in headless Chrome, and the harness page logs zero console errors.
// Chrome also runs two scenarios with a jittered 144 Hz advance() cadence,
// which must match the exact-tick Node hash (D3 in the browser). 65mm flies
// the Air65 plant, so the plant and the RPM filter path are compared too.
//
//   node tests/browser/node-vs-chrome.test.mjs
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { SimCore } from '../../src/js/sim-core.js';
import { loadPresets, matrix, runScenario } from '../lib/scenarios.mjs';
import { launch, serve } from './chrome.mjs';

const rootUrl = new URL('../../', import.meta.url);
const module = await WebAssembly.compile(await readFile(new URL('dist/sim-core.wasm', rootUrl)));
const presets = await loadPresets((path) => readFile(new URL(path, rootUrl), 'utf8'));

const node = {};
for (const sc of matrix()) node[sc.name] = (await runScenario(SimCore, module, presets[sc.preset], sc)).hash;

const SELF_CHECK = 'sim-core harness console self-check';
const server = await serve(fileURLToPath(rootUrl));
const chrome = await launch();
let harness;
try {
  await chrome.goto(`${server.url}tests/browser/harness.html`);
  const deadline = Date.now() + 180_000;
  while (!(await chrome.evaluate('!!(window.__harness && window.__harness.done)'))) {
    if (Date.now() > deadline) throw new Error('harness did not finish in 180 s');
    await new Promise((r) => setTimeout(r, 250));
  }
  harness = await chrome.evaluate('JSON.parse(JSON.stringify(window.__harness))');
  // Self-check of the console capture: this error must be seen, then it is
  // set aside; everything else counts.
  await chrome.evaluate(`console.error('${SELF_CHECK}')`);
  await new Promise((r) => setTimeout(r, 250));   // let late console events arrive
} catch (err) {
  // What the page said is usually the cause; show it with the failure.
  for (const m of chrome.console) console.log(`   [${m.source} ${m.level}] ${m.text}`);
  throw err;
} finally {
  await chrome.close();
  await server.close();
}

if (harness.error) {
  for (const m of chrome.console) console.log(`   [${m.source} ${m.level}] ${m.text}`);
  assert.fail(`harness error: ${harness.error}`);
}
console.log(`Node ${process.version} vs ${chrome.version} (${harness.ms.toFixed(0)} ms in the page)`);
for (const r of harness.results) {
  console.log(`${r.name.padEnd(26)} node ${node[r.name].slice(0, 16)}  chrome ${r.hash.slice(0, 16)}  ${node[r.name] === r.hash ? 'same' : 'DIFFERENT'}`);
}
for (const r of harness.cadence) {
  console.log(`${r.name.padEnd(26)} chrome advance() 144 Hz jitter, ${r.calls} frames: ${r.hash.slice(0, 16)}  ${node[r.name] === r.hash ? 'same as Node exact ticks' : 'DIFFERENT'}`);
}
const selfCheck = chrome.console.filter((m) => m.text === SELF_CHECK);
const page = chrome.console.filter((m) => m.text !== SELF_CHECK);
const errors = page.filter((m) => m.level === 'error');
const warnings = page.filter((m) => m.level === 'warning');
console.log(`console self-check: injected console.error ${selfCheck.length === 1 && selfCheck[0].level === 'error' ? 'captured' : 'NOT captured'}`);
console.log(`console from the harness: ${page.length} messages, ${errors.length} errors, ${warnings.length} warnings`);
for (const m of page) console.log(`   [${m.source} ${m.level}] ${m.text}`);
assert.equal(selfCheck.length, 1, 'the console capture works');
assert.equal(selfCheck[0].level, 'error');

assert.equal(harness.error, null, `harness error: ${harness.error}`);
assert.equal(harness.results.length, matrix().length, 'every scenario ran in Chrome');
for (const r of harness.results) assert.equal(r.hash, node[r.name], `${r.name}: Node and Chrome traces`);
assert.equal(harness.cadence.length, 2);
for (const r of harness.cadence) assert.equal(r.hash, node[r.name], `${r.name}: Chrome advance() cadence matches Node`);
assert.equal(errors.length, 0, 'zero console errors');
console.log(`node-vs-chrome: ${harness.results.length} scenarios identical, 0 console errors: PASS`);
