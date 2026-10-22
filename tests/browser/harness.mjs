// Runs in the browser: the D2 matrix through the same scenario code the Node
// tests use, plus two scenarios at a jittered 144 Hz advance() cadence (D3
// in the browser). Results go on window.__harness.
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import { SimCore } from '../../src/js/sim-core.js';
import { CLASS_DIFFS, jitteredFrames, matrix, runScenario } from '../lib/scenarios.mjs';

// harness.html creates window.__harness before this module loads.
const state = Object.assign(window.__harness, { started: true, userAgent: navigator.userAgent, ms: 0 });
const out = document.getElementById('log');
const lines = [];
const show = (line) => {
  lines.push(line);
  out.textContent = lines.join('\n');
};

try {
  const started = performance.now();
  const module = await WebAssembly.compileStreaming(fetch('../../dist/sim-core.wasm'));
  const presets = {};
  for (const [name, path] of Object.entries(CLASS_DIFFS)) {
    const res = await fetch(`../../${path}`);
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    presets[name] = await res.text();
  }
  for (const sc of matrix()) {
    const r = await runScenario(SimCore, module, presets[sc.preset], sc);
    state.results.push(r);
    show(`${sc.name.padEnd(26)} ${r.hash}`);
  }
  for (const sc of matrix().filter((s) => s.preset === '65mm' && s.rpm && !s.mode3d)) {
    const r = await runScenario(SimCore, module, presets[sc.preset], sc, { frames: jitteredFrames(144, 0x5eed0090) });
    state.cadence.push(r);
    show(`${sc.name.padEnd(26)} ${r.hash}  (advance, 144 Hz jitter, ${r.calls} frames)`);
  }
  state.ms = performance.now() - started;
  show(`done in ${state.ms.toFixed(0)} ms`);
} catch (err) {
  state.error = String((err && err.stack) || err);
  show(`ERROR ${state.error}`);
  throw err;
} finally {
  state.done = true;
}
