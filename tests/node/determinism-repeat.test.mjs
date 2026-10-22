// D1 (first form): the same sim-time input stream, run on two fresh instances,
// gives the same state block, byte for byte, on every tick.
//
//   node tests/node/determinism-repeat.test.mjs
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { SimCore } from '../../src/js/sim-core.js';

const root = new URL('../../', import.meta.url);
const wasm = await readFile(new URL('dist/sim-core.wasm', root));
const diff = await readFile(new URL('configs/65mm-air65-ryfly-1219s.diff', root), 'utf8');
const module = await WebAssembly.compile(wasm);

// A scripted session in sim time (whole microseconds): arm, throttle steps,
// a roll sweep, yaw reversals. Generated in JS; only integer channels reach
// the core.
function script(t0, durationMs) {
  const out = [];
  for (let ms = 0; ms <= durationMs; ms += 4) {
    const arm = ms >= 100 ? 2000 : 1000;
    const throttle = ms < 300 ? 0 : (Math.floor(ms / 250) % 2 ? 0.55 : 0.4);
    const roll = ms < 800 ? 0 : ((ms / 4) % 50) / 25 - 1;
    const yaw = ms < 1600 ? 0 : (ms % 400 < 200 ? 0.6 : -0.6);
    out.push({ t: t0 + ms * 1000, sticks: { throttle, roll, yaw }, aux: [arm, 1000, 1000, 1000] });
  }
  return out;
}

async function run() {
  const core = await SimCore.load(module);
  core.configure(diff);
  core.boot();
  const ticksPerMs = core.loopHz / 1000;
  const durationMs = 3000;
  const samples = script(core.simTimeUs, durationMs);
  const hash = createHash('sha256');
  let next = 0;
  for (let tick = 0; tick < durationMs * ticksPerMs; tick++) {
    while (next < samples.length && samples[next].t <= core.simTimeUs) {
      core.input(samples[next].sticks, samples[next].aux, samples[next].t);
      next++;
    }
    core.step(1);
    hash.update(core.stateBytes());
  }
  return { hash: hash.digest('hex'), final: core.state() };
}

const a = await run();
const b = await run();
console.log(`run A ${a.hash.slice(0, 16)}  run B ${b.hash.slice(0, 16)}  armed ${a.final.armed}  motors ${a.final.motorDshot.join(' ')}`);
assert.equal(a.final.armed, true);
assert.equal(a.hash, b.hash, 'two fresh instances, same input stream, same state block every tick');
console.log('determinism-repeat: PASS');
