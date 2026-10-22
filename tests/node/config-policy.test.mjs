// Config path: every diff line is accounted for, Betaflight's silent
// alterations are caught, any channel map flies, and a link loss does not
// stall the input stream.
//
//   node tests/node/config-policy.test.mjs
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SimCore, sticksToChannels as ch } from '../../src/js/sim-core.js';

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
  core.input(ch({ throttle: 0 }, [1000, 1000, 1500, 1000]));
  ms(core, 100);
  assert.equal(core.fc.armed, false, 'AUX3 mid does not arm');
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
  core.input(ch({ throttle: 0 }, [2000]));
  ms(core, 50);
  assert.equal(core.fc.armed, true, 'arms with TAER1234');
  core.input(ch({ throttle: 0.5 }, [2000]));
  ms(core, 100);
  const s = core.state;
  assert.ok(s.motorDshot.every((v) => v > 900), 'throttle reaches the motors through the inverse map');
  console.log(`map TAER1234: armed, motors ${s.motorDshot.join(' ')}`);
}

// 4. Link loss for 6 s at a 4 ms poll: input keeps flowing, Betaflight's
//    failsafe engages, and the link comes back.
{
  const core = await SimCore.load(module);
  core.configure(classDiff);
  core.input(ch({ throttle: 0 }, [2000]));
  ms(core, 50);
  core.link(false);
  for (let i = 0; i < 1500; i++) {
    core.input(ch({ throttle: 0.3 }, [2000]));
    ms(core, 4);
  }
  const lost = core.fc;
  assert.notEqual(lost.failsafePhase, 0, 'failsafe engaged during the outage');
  assert.equal(lost.rxSignal, false);
  core.link(true);
  core.input(ch({ throttle: 0 }, [2000]));
  ms(core, 200);
  assert.equal(core.fc.rxSignal, true, 'signal back after the link returns');
  console.log(`link loss 6 s: failsafe phase ${lost.failsafePhase}, armed ${lost.armed}; recovered rx ${core.fc.rxSignal}`);
}

// 5. Bad input is refused at the boundary.
{
  const core = await SimCore.load(module);
  core.configure(classDiff);
  assert.throws(() => core.input(ch({ throttle: 0 }), core.simTimeUs + 0.5), /whole microseconds/);
  assert.throws(() => core.input(ch({ throttle: 0 }, [1500.5])), /integer/);
  assert.throws(() => core.input([1500, 1500, 1500, 999]), /integer in 1000..2000/);
  assert.throws(() => ch({ throttle: NaN }), /finite/);
  core.input(ch({ throttle: 0 }), core.simTimeUs + 4000);
  assert.throws(() => core.input(ch({ throttle: 0 }), core.simTimeUs), /earlier than the last sample/);
}

// 6. The neutral boot frame follows Betaflight's own throttle check, so 3D
//    configs and a moved mid_rc reach arm-ready and arm.
for (const extra of ['feature 3D', 'feature 3D\nset 3d_switched_mode = ON', 'feature 3D\nset mid_rc = 1560', 'set mid_rc = 1560']) {
  const core = await SimCore.load(module);
  const r = core.configure(`${classDiff}\n${extra}`);
  assert.equal(r.errors + r.rejected, 0, extra);
  const neutral = core.fc.rcData;
  const switched = extra.includes('switched');
  const mid = extra.includes('1560') ? 1560 : 1500;
  const throttle = extra.includes('3D') && !switched ? mid : 1000;
  core.input([mid, mid, mid, throttle, 2000]);
  ms(core, 50);
  console.log(`${extra.replace(/\n/g, '; ')}: arm-ready at ${(r.boot.simTimeUs / 1e6).toFixed(3)} s, neutral frame ${neutral.slice(0, 4).join(' ')}, armed ${core.fc.armed}`);
  assert.deepEqual(neutral.slice(0, 4), [mid, mid, mid, throttle], 'neutral sticks on mid_rc, throttle where Betaflight reads it as low');
  assert.equal(core.fc.armed, true);
}

// 7. Raw ABI: the CLI's echo of a typed '###ERROR' is not Betaflight's error;
//    a battery carry after the first tick is refused; an untraced instance
//    has no trace digest.
{
  const e = new WebAssembly.Instance(module, {}).exports;
  e._initialize();
  assert.equal(e.sc_boot(), 0);
  e.sc_cli_enter();
  const line = new TextEncoder().encode('set craft_name = X###ERROR');
  new Uint8Array(e.memory.buffer, e.sc_scratch_ptr(), line.length).set(line);
  assert.equal(e.sc_cli_line(e.sc_scratch_ptr(), line.length), 0, 'echoed ###ERROR is not an error');
  const bad = new TextEncoder().encode('set no_such_key = 1');
  new Uint8Array(e.memory.buffer, e.sc_scratch_ptr(), bad.length).set(bad);
  assert.equal(e.sc_cli_line(e.sc_scratch_ptr(), bad.length), 1, "Betaflight's own ###ERROR is");

  const f = new WebAssembly.Instance(module, {}).exports;
  f._initialize();
  assert.equal(f.sc_boot(), 0);
  assert.equal(f.sc_trace_digest(), 0, 'no digest without sc_trace_start');
  new Float64Array(f.memory.buffer, f.sc_scratch_ptr(), 2).set([0.5, 3.7]);
  assert.equal(f.sc_battery_carry(f.sc_scratch_ptr()), 0, 'carry before the first tick');
  f.sc_step(1);
  assert.equal(f.sc_battery_carry(f.sc_scratch_ptr()), -2, 'carry after a tick is refused');

  const untraced = await SimCore.load(module, { trace: false });
  untraced.configure('');
  assert.throws(() => untraced.traceHash(), /trace is off/);
}

// 8. get(): a profile that does not exist throws instead of reading another
//    one; names match in any case, as Betaflight's get does.
{
  const core = await SimCore.load(module);
  core.configure('profile 1\nset p_roll = 61');
  assert.equal(core.get('p_roll', { profile: 1 }), '61');
  assert.equal(core.get('P_ROLL', { profile: 1 }), '61');
  assert.throws(() => core.get('p_roll', { profile: 7 }), /no profile 7/);
  assert.throws(() => core.get('roll_srate', { rateprofile: 'x' }), /no rateprofile x/);
  console.log('get(): profile 7 and rateprofile x refused; P_ROLL reads p_roll');
}

// 9. Boot with configs whose arm-ready needs more than the defaults:
//    - rx_min_usec above 1000: the neutral frame stays a valid pulse.
//    - a switch range that holds arming with aux low (PREARM, ARM on aux low,
//      FAILSAFE on aux low): boot ends with only that switch's flags left
//      (reinit's switchFlags), and the quad arms once the pilot moves it.
{
  const core = await SimCore.load(module);
  const r = core.configure(`${classDiff}
set rx_min_usec = 1010`);
  const neutral = core.fc.rcData;
  assert.equal(r.lines.at(-1).status, 'applied');
  assert.equal(neutral[3], 1010, 'neutral throttle at rx_min_usec');
  assert.ok(neutral.slice(4).every((v) => v >= 1010), 'neutral aux inside the valid pulse window');
  core.input([1500, 1500, 1500, 1020, 2000]);
  ms(core, 50);
  console.log(`rx_min_usec 1010: arm-ready, neutral throttle ${neutral[3]}, aux ${neutral.slice(4).join(' ')}, armed ${core.fc.armed}`);
  assert.equal(core.fc.armed, true);
}
const SWITCHES = [
  // [name, extra lines, switch flags left at boot, steps: [AUX1, AUX2, ms]...]
  ['PREARM on AUX2', 'aux 0 0 0 1700 2100 0 0\naux 1 36 1 1700 2100 0 0', 1 << 10, [[1000, 2000, 50], [2000, 2000, 50]]],
  ['ARM range on aux low', 'aux 0 0 0 900 1300 0 0', (1 << 25) | (1 << 3), [[2000, 1000, 100], [1000, 1000, 50]]],
  ['FAILSAFE range on aux low', 'aux 0 0 0 1700 2100 0 0\naux 1 27 1 900 1300 0 0', (1 << 4) | (1 << 2), [[1000, 2000, 1500], [2000, 2000, 50]]],
];
for (const [name, extra, flags, steps] of SWITCHES) {
  const core = await SimCore.load(module);
  const r = core.configure(`${classDiff}
${extra}`);
  assert.equal(r.boot.switchFlags, flags, `${name}: switch flags left at boot`);
  assert.equal(core.fc.armingDisableFlags, flags, `${name}: nothing else left`);
  steps.forEach(([aux1, aux2, wait], i) => {
    core.input([1500, 1500, 1500, 1000, aux1, aux2]);
    ms(core, wait);
    if (i < steps.length - 1) assert.equal(core.fc.armed, false, `${name}: not armed before the last step`);
  });
  console.log(`${name}: boot switch flags 0x${r.boot.switchFlags.toString(16)}, armed after the pilot moves the switches: ${core.fc.armed}`);
  assert.equal(core.fc.armed, true);
}

// 10. A config that can never reach arm-ready (no valid low throttle:
//     rx_min_usec above min_check) fails configure() and edit() with the line
//     report attached, and leaves the previous config, channel map included,
//     flying.
{
  const core = await SimCore.load(module);
  core.configure(classDiff);
  const before = core.get('rx_min_usec');
  let err;
  try {
    core.edit(['map TAER1234', 'set rx_min_usec = 1100']);
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'edit() fails');
  assert.equal(err.code, 'boot-timeout');
  assert.deepEqual(err.report.lines.map((l) => l.status), ['applied', 'applied'], 'the report says the lines went in');
  assert.equal(core.get('rx_min_usec'), before, 'the previous config stays');
  assert.equal(core.rcmap, 'AETR1234', 'and its channel map');
  core.input([1500, 1500, 1500, 1000, 2000]);
  ms(core, 50);
  assert.equal(core.fc.armed, true, 'and still flies');
  console.log(`edit(map TAER1234, rx_min_usec 1100): ${err.message}; report attached; rx_min_usec still ${core.get('rx_min_usec')}, map ${core.rcmap}, armed ${core.fc.armed}`);
  assert.throws(() => core.configure('map TAER1234\nset rx_min_usec = 1100'), (e) => e.code === 'boot-timeout' && e.report.applied === 2);
  assert.equal(core.get('rx_min_usec'), before);
  assert.equal(core.rcmap, 'AETR1234');
  // Centred sticks outside the valid pulse window: RX_FAILSAFE for good. A
  // failsafe switch on aux low must not pass that off as a switch flag.
  for (const extra of ['set rx_max_usec = 1400', 'set rx_max_usec = 1400\naux 1 27 1 900 1300 0 0']) {
    assert.throws(() => core.configure(`${classDiff}\naux 0 0 0 1700 2100 0 0\n${extra}`),
      (e) => e.code === 'boot-timeout' && (e.flags & (1 << 2)) !== 0, extra);
  }
  assert.equal(core.get('rx_max_usec'), '2115');
  console.log('rx_max_usec 1400 (sticks never valid): boot-timeout with and without a failsafe switch on aux low');
}

// 11. A trailing comment is cut as Betaflight cuts it: '?', non-ASCII and
//     length in the comment do not matter; a control character there does.
{
  const core = await SimCore.load(module);
  const r = core.configure(['set p_roll = 61 # was 45, too low?', 'set i_roll = 70 # café', `set d_roll = 30 # ${'x'.repeat(260)}`,
    'set p_pitch = 50 # a\x7fb', 'set p_pitch = 52 # a\rset p_yaw = 99', '# header\rset p_yaw = 98'].join('\n'));
  assert.deepEqual(r.lines.map((l) => l.status), ['applied', 'applied', 'applied', 'rejected', 'rejected', 'rejected']);
  assert.deepEqual([core.get('p_roll'), core.get('i_roll'), core.get('d_roll'), core.get('p_yaw')], ['61', '70', '30', '45']);
  console.log(`comments: ${r.lines.map((l) => l.status).join(' ')}; p_roll ${core.get('p_roll')}`);
}

console.log('config-policy: PASS');
