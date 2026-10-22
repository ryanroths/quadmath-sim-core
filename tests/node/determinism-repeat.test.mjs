// D1 repeat: the same sim-time sample stream, run twice on fresh instances,
// gives the same trace hash (SHA-256 over the state block and Betaflight's
// readouts at the end of every tick since boot). Every scenario of the D2
// matrix, so each one is known to repeat before Node and Chrome are compared.
// On the M3 rest plant an rpm-on scenario differs from its rpm-off twin only
// in Betaflight's RPM-filter-enabled flag (gyro and eRPM are zero), which is
// what keeps those traces distinct; the filter path gets input with M4.
//
//   node tests/node/determinism-repeat.test.mjs
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SimCore } from '../../src/js/sim-core.js';
import { CLASS_DIFFS, matrix, runScenario } from '../lib/scenarios.mjs';

const root = new URL('../../', import.meta.url);
const module = await WebAssembly.compile(await readFile(new URL('dist/sim-core.wasm', root)));
const presets = {};
for (const [name, path] of Object.entries(CLASS_DIFFS)) presets[name] = await readFile(new URL(path, root), 'utf8');

const seen = new Set();
for (const sc of matrix()) {
  const a = await runScenario(SimCore, module, presets[sc.preset], sc);
  const b = await runScenario(SimCore, module, presets[sc.preset], sc);
  console.log(`${sc.name.padEnd(26)} ${a.hash.slice(0, 16)} ${b.hash.slice(0, 16)}  flying: armed ${a.flying.armed} angle ${a.flying.mode.angle} 3d ${a.flying.mode.mode3d} motors ${a.flying.motorDshot.join(' ')}`);
  assert.equal(a.hash, b.hash, `${sc.name}: two fresh runs, same trace`);
  assert.equal(a.flying.armed, true, `${sc.name}: armed during the script`);
  assert.equal(a.flying.mode.angle, sc.angle, `${sc.name}: ANGLE as scripted`);
  assert.equal(a.flying.mode.mode3d, sc.mode3d, `${sc.name}: 3D as configured`);
  assert.ok(a.flying.motorDshot.every((v) => v > 0), `${sc.name}: motors running while armed`);
  assert.equal(a.armedAtEnd, false, `${sc.name}: disarmed at the end`);
  seen.add(a.hash);
}
assert.equal(seen.size, matrix().length, 'every scenario has its own trace');
console.log(`determinism-repeat: ${seen.size} scenarios, each identical twice: PASS`);
