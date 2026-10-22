// Config path: every diff line is accounted for, Betaflight's silent
// alterations are caught, any channel map flies, and a link loss does not
// stall the input stream.
//
//   node tests/node/config-policy.test.mjs
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SimCore } from '../../src/js/sim-core.js';

const root = new URL('../../', import.meta.url);
const module = await WebAssembly.compile(await readFile(new URL('dist/sim-core.wasm', root)));
const classDiff = await readFile(new URL('configs/65mm-air65-ryfly-1219s.diff', root), 'utf8');

function accounted(report, inputText) {
  const n = String(inputText).split('\n').length;
  assert.equal(report.applied + report.rejected + report.errors + report.comments, n, 'every input line has a verdict');
}

const ms = (core, t) => core.step(Math.round(t * core.loopHz / 1000));

// 1. Unknown aux box id: rejected and its slot cleared, defaults still added,
//    and the stale-ARM trap does not arm.
{
  const core = await SimCore.load(module);
  const text = 'aux 2 3 2 1300 2100 0 0';
  const r = core.configure(text);
  accounted(r, text);
  assert.equal(r.lines[0].status, 'rejected', r.lines[0].msg);
  assert.ok(r.added.some((a) => a.text.startsWith('aux') && a.text.includes(' 0 0 1700 2100')), 'default ARM added');
  core.boot();
  core.input({ throttle: 0 }, [1000, 1000, 1500, 1000]);
  ms(core, 100);
  assert.equal(core.state().armed, false, 'AUX3 mid does not arm');
  console.log(`aux unknown id: ${r.lines[0].msg}`);
}

// 2. Features: peripherals rejected up front, AIRMODE applied and verified.
{
  const core = await SimCore.load(module);
  const text = 'feature TELEMETRY\nfeature OSD\nfeature LED_STRIP\nfeature ESC_SENSOR\nfeature AIRMODE\nfeature -ANTI_GRAVITY';
  const r = core.configure(text);
  accounted(r, text);
  assert.deepEqual(r.lines.map((l) => l.status), ['rejected', 'rejected', 'rejected', 'rejected', 'applied', 'applied']);
  console.log(`features: ${r.lines.map((l) => `${l.text}=${l.status}`).join(', ')}`);
}

// 3. A non-AETR map (TAER1234): boots, arms, and throttle drives the motors.
{
  const core = await SimCore.load(module);
  const text = `${classDiff}\nmap TAER1234`;
  const r = core.configure(text);
  accounted(r, text);
  assert.equal(r.rcmap, 'TAER1234');
  core.boot();
  core.input({ throttle: 0 }, [2000]);
  ms(core, 50);
  assert.equal(core.state().armed, true, 'arms with TAER1234');
  core.input({ throttle: 0.5 }, [2000]);
  ms(core, 100);
  const s = core.state();
  assert.ok(s.motorDshot.every((v) => v > 900), 'throttle reaches the motors through the inverse map');
  console.log(`map TAER1234: armed, motors ${s.motorDshot.join(' ')}`);
}

// 4. Link loss for 6 s at a 4 ms poll: input keeps flowing, Betaflight's
//    failsafe engages, and the link comes back.
{
  const core = await SimCore.load(module);
  core.configure(classDiff);
  core.boot();
  core.input({ throttle: 0 }, [2000]);
  ms(core, 50);
  core.link(false);
  for (let i = 0; i < 1500; i++) {
    core.input({ throttle: 0.3 }, [2000]);
    ms(core, 4);
  }
  const lost = core.state();
  assert.notEqual(lost.failsafePhase, 0, 'failsafe engaged during the outage');
  assert.equal(lost.rxSignal, false);
  core.link(true);
  core.input({ throttle: 0 }, [2000]);
  ms(core, 200);
  assert.equal(core.state().rxSignal, true, 'signal back after the link returns');
  console.log(`link loss 6 s: failsafe phase ${lost.failsafePhase}, armed ${lost.armed}; recovered rx ${core.state().rxSignal}`);
}

// 5. Bad input is refused at the boundary.
{
  const core = await SimCore.load(module);
  core.configure(classDiff);
  core.boot();
  assert.throws(() => core.input({ throttle: 0 }, [], core.simTimeUs + 0.5), /whole microseconds/);
  assert.throws(() => core.input({ throttle: 0 }, [1500.5]), /integer/);
  assert.throws(() => core.input({ throttle: NaN }), /finite/);
}

console.log('config-policy: PASS');
