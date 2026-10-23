// The Phase 1 test list in one command (npm test). Each test runs in its own
// Node process, in order; the run stops at the end and fails if any failed.
//
//   node tests/run-all.mjs            # everything, including two clean builds (B1, B2)
//   node tests/run-all.mjs --quick    # skip the builds (no emcc needed)
//
// The builds need emsdk 3.1.61 (WSL on Windows) and compare against the
// committed dist/sim-core.wasm.sha256, so run the full list on a committed tree.
// config-count, diff-passthrough, blackbox-webfpv and gate-plant read WebFPV's
// module and diffs from a WebFPV clone (tests/lib/webfpv.mjs). node-vs-chrome
// needs Chrome. gate-plant fails on an X3 band miss the owner has not signed
// off in tests/x3-signoff.json.
// A test that runs past its time limit is stopped and counts as failed.
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const quick = process.argv.includes('--quick');

const TESTS = [
  [quick ? 'B2 vendor untouched; F5 arm, motors (builds skipped)' : 'B1 B2 byte-exact build, vendor untouched; F5 arm, motors',
    'tests/gate-arm-motor.mjs', quick ? [] : ['--build']],
  ['B3 B4 B5 ABI surface, PG coverage, boot asserts', 'tests/node/abi-surface.test.mjs'],
  ['F5 arm and motor answer the sticks', 'tests/node/arm-and-motor.test.mjs'],
  ['C2 F5 config policy, map, link loss, bad input', 'tests/node/config-policy.test.mjs'],
  ['C1 C2 C3 config count and readback', 'tests/node/config-count.test.mjs'],
  ['C1 diff passthrough (rates ratio, RPM filter, P)', 'tests/node/diff-passthrough.test.mjs'],
  ['D1 determinism repeat', 'tests/node/determinism-repeat.test.mjs'],
  ['D3 frame independence 30/60/144/240 Hz', 'tests/node/frame-independence.test.mjs'],
  ['D4 reset vs fresh load', 'tests/node/reset-vs-fresh.test.mjs'],
  ['X1 black box vs WebFPV (F1 F2 F4)', 'tests/node/blackbox-webfpv.test.mjs'],
  ['M4 plant and world API: contact, triggers, pose, pack, argument checks', 'tests/node/plant-world.test.mjs'],
  ['M4 bench hover from a blackbox log (tools/hover-from-log.mjs, synthetic frames)', 'tests/node/hover-from-log.test.mjs'],
  ['M4 plant: P1-P5, F6, F9, X2/F3, X3 feel bands vs WebFPV', 'tests/gate-plant.mjs'],
  ['D2 Node vs headless Chrome, console clean', 'tests/browser/node-vs-chrome.test.mjs'],
];

// Two clean builds take about 2.5 minutes; everything else well under one.
const LIMIT_MS = { build: 15 * 60_000, other: 5 * 60_000 };

function run(file, args, limitMs) {
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(process.execPath, [file, ...args], { cwd: root, stdio: 'inherit' });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, limitMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 'timeout' : code, ms: performance.now() - started });
    });
  });
}

const results = [];
for (const [name, file, args = []] of TESTS) {
  console.log(`\n######## ${name}  (node ${file}${args.length ? ` ${args.join(' ')}` : ''})`);
  results.push({ name, file, ...(await run(file, args, args.includes('--build') ? LIMIT_MS.build : LIMIT_MS.other)) });
}

console.log('\n######## summary');
for (const r of results) {
  const verdict = r.code === 0 ? 'PASS' : r.code === 'timeout' ? 'FAIL (time limit)' : 'FAIL';
  console.log(`${verdict}  ${(r.ms / 1000).toFixed(1).padStart(6)} s  ${r.name}`);
}
const failed = results.filter((r) => r.code !== 0);
console.log(failed.length ? `${failed.length} of ${results.length} failed` : `all ${results.length} passed${quick ? ' (builds skipped: --quick)' : ''}`);
process.exitCode = failed.length ? 1 : 0;
