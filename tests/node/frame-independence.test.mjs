// D3 frame independence: one sim-time sample stream driven by advance() at
// 30, 60, 144 and 240 Hz frames, each also with seeded +-50% jitter, and by
// exact ticks, gives one trace hash. Physics never sees frame time.
//
// The driver (tests/lib/scenarios.mjs drive) checks every advance() call
// against the frame time it was given, so a cadence cannot reach the same
// sim time by an advance() that ignores frame time. This test also checks
// the number of frames each cadence took.
//
//   node tests/node/frame-independence.test.mjs
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SimCore } from '../../src/js/sim-core.js';
import { CLASS_DIFFS, jitteredFrames, matrix, runScenario } from '../lib/scenarios.mjs';

const root = new URL('../../', import.meta.url);
const module = await WebAssembly.compile(await readFile(new URL('dist/sim-core.wasm', root)));
const DURATION_MS = 3000;

const cadences = [
  { name: 'exact ticks', frames: undefined },
  ...[30, 60, 144, 240].flatMap((hz) => [
    { name: `${hz} Hz`, hz, frames: () => 1000 / hz },
    { name: `${hz} Hz jitter`, hz, jitter: true, frames: jitteredFrames(hz, 0x5eed0000 + hz) },
  ]),
];

// Two scenarios with the most going on in the controller: angle mode (the
// attitude task and level PID), and 3D (reverse throttle range). Both arm,
// sweep every stick and disarm.
const picks = matrix().filter((s) => s.preset === '65mm' && ((s.angle && s.rpm && !s.mode3d) || (!s.angle && s.mode3d && !s.rpm)));
assert.equal(picks.length, 2);

for (const sc of picks) {
  const preset = await readFile(new URL(CLASS_DIFFS[sc.preset], root), 'utf8');
  const hashes = new Set();
  for (const c of cadences) {
    const r = await runScenario(SimCore, module, preset, sc, { frames: c.frames, durationMs: DURATION_MS });
    console.log(`${sc.name}  ${c.name.padEnd(14)} ${String(r.calls).padStart(5)} calls  frame time ${r.frameMs.toFixed(3)} ms  t=${(r.simTimeUs / 1e6).toFixed(3)} s  ${r.hash.slice(0, 16)}  armed while flying ${r.flying.armed}`);
    assert.equal(r.flying.armed, true);
    if (c.hz) {
      // About duration x rate frames (one extra where the run stops to record
      // the flight); jitter averages the same rate.
      const expected = (DURATION_MS * c.hz) / 1000;
      assert.ok(Math.abs(r.calls - expected) <= (c.jitter ? 0.1 * expected : 2), `${c.name}: ${r.calls} frames, expected about ${expected}`);
      assert.ok(Math.abs(r.frameMs - DURATION_MS) < 1, `${c.name}: the frames add up to the run (${r.frameMs} ms)`);
    }
    hashes.add(r.hash);
  }
  assert.equal(hashes.size, 1, `${sc.name}: one hash across ${cadences.length} cadences`);
}
console.log(`frame-independence: ${picks.length} scenarios x ${cadences.length} cadences, 1 hash each: PASS`);
