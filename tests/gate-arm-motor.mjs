// Phase 1 gate: Betaflight arms and a motor answers a stick, on a module that
// builds byte for byte from an untouched Betaflight tree. Prints raw state and
// fails (exit 1) if any check does not hold.
//
//   npm run gate                        # vendor check, two builds, Node harness
//   node tests/gate-arm-motor.mjs       # vendor check and Node harness only
//
// The builds need emsdk 3.1.61; on Windows they run in WSL, as scripts/build.sh does.
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { SimCore, sticksToChannels as ch } from '../src/js/sim-core.js';

const rootUrl = new URL('..', import.meta.url);
const root = fileURLToPath(rootUrl);
const withBuilds = process.argv.includes('--build');

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

// 1. Betaflight is read-only: no change in the submodule, pinned commit.
console.log('== vendor');
for (const args of [['diff', '--stat', 'vendor/betaflight'], ['-C', 'vendor/betaflight', 'status', '--porcelain'], ['submodule', 'status']]) {
  const r = run('git', args);
  console.log(`$ git ${args.join(' ')}\n${r.out}[exit=${r.code} bytes=${r.out.length}]`);
  if (args[0] !== 'submodule') assert.equal(r.out, '', `git ${args.join(' ')} must print nothing`);
}

// 2. Two consecutive clean builds give the same bytes, equal to the committed hash.
if (withBuilds) {
  console.log('\n== builds');
  const committed = run('git', ['show', 'HEAD:dist/sim-core.wasm.sha256']).out.split(/\s+/)[0];
  const buildCmd = process.platform === 'win32'
    ? ['wsl.exe', ['-e', 'bash', '-lc', `cd "$(wslpath -a '${root.replace(/\\/g, '/')}')" && bash scripts/build.sh && (source ~/emsdk/emsdk_env.sh >/dev/null 2>&1; emcc --version | head -1)`]]
    : ['bash', ['-c', 'bash scripts/build.sh && emcc --version | head -1']];
  const hashes = [];
  for (const n of [1, 2]) {
    const r = run(...buildCmd);
    const lines = r.out.split('\n').filter((l) => l.startsWith('build:') || l.startsWith('emcc'));
    const hash = createHash('sha256').update(await readFile(new URL('dist/sim-core.wasm', rootUrl))).digest('hex');
    console.log(`--- build ${n} (exit ${r.code})\n${lines.join('\n')}\nsha256 dist/sim-core.wasm = ${hash}`);
    assert.equal(r.code, 0, `build ${n} failed:\n${r.out.slice(-2000)}`);
    hashes.push(hash);
  }
  console.log(`committed dist/sim-core.wasm.sha256 = ${committed}`);
  assert.equal(hashes[0], hashes[1], 'two consecutive builds are byte-identical');
  assert.equal(hashes[0], committed, 'the build matches the committed hash');
}

// 3. Node harness on dist/sim-core.wasm.
const wasm = await readFile(new URL('dist/sim-core.wasm', rootUrl));
const diff = await readFile(new URL('configs/65mm-air65-ryfly-1219s.diff', rootUrl), 'utf8');
const module = await WebAssembly.compile(wasm);
console.log(`\n== harness on dist/sim-core.wasm sha256 ${createHash('sha256').update(wasm).digest('hex')}`);

// Betaflight 4.5.1 fc/runtime_config.c armingDisableFlagNames: bit i = name i.
const FLAG = ['NOGYRO', 'FAILSAFE', 'RXLOSS', 'NOT_DISARMED', 'BOXFAILSAFE', 'RUNAWAY', 'CRASH', 'THROTTLE', 'ANGLE',
  'BOOTGRACE', 'NOPREARM', 'LOAD', 'CALIB', 'CLI', 'CMS', 'BST', 'MSP', 'PARALYZE', 'GPS', 'RESCUE_SW', 'DSHOT_TELEM',
  'REBOOT_REQD', 'DSHOT_BBANG', 'NO_ACC_CAL', 'MOTOR_PROTO', 'ARMSWITCH'];
const flags = (v) => `0x${v.toString(16).padStart(8, '0')} [${FLAG.filter((_, i) => v & (1 << i)).join(' ') || 'none'}]`;
const fmt = (a) => a.map((v) => String(Math.round(v * 100) / 100).padStart(7)).join(' ');
const t = (us) => `${(us / 1e6).toFixed(3)}s`;

const core = await SimCore.load(module);
const report = core.configure(diff);
console.log(`== configure: applied ${report.applied}, rejected ${report.rejected}, errors ${report.errors}, comments ${report.comments}, rcmap ${report.rcmap}`);
for (const a of report.added) console.log(`   ${a.status}: ${a.text}`);
assert.equal(report.errors, 0);

// Boot timeline straight from the ABI (no SimCore helpers): sticks neutral,
// throttle 1000, ARM channel 1000.
console.log('\n== boot timeline (raw sc_fc_ptr block, ARM channel 1000, throttle 1000)');
{
  const e = new WebAssembly.Instance(module, {}).exports;
  e._initialize();
  new Uint8Array(e.memory.buffer, e.sc_eeprom_ptr(), e.sc_eeprom_size()).set(core.eeprom);
  console.log(`   sc_boot() -> ${e.sc_boot()}  sc_set_rx_rate(250) -> ${e.sc_set_rx_rate(250)}  loop ${e.sc_loop_hz()} Hz`);
  let done = 0;
  for (const m of [0, 10, 500, 1000, 2000, 3000, 3990, 4000, 4010, 4100]) {
    e.sc_step(m - done);
    done = m;
    // Betaflight readouts v1 (src/glue/abi.c): 0 armed, 1 armingDisableFlags,
    // 4 vbat, 7 cells, 43 rxSignal; the sim clock from sc_time().
    const f = new Float64Array(e.memory.buffer, e.sc_fc_ptr(), e.sc_fc_len());
    console.log(`   t=${t(e.sc_time())} armed=${f[0]} armingDisableFlags=${flags(f[1])} rxSignal=${f[43]} bfVbat=${f[4].toFixed(2)}V cells=${f[7]}`);
  }
}

// Arming: flags before and after the ARM channel goes high.
console.log('\n== arming (AUX1 = ARM, 1700..2100)');
let s = core.fc;
console.log(`   before: t=${t(core.simTimeUs)} armed=${s.armed} armingDisableFlags=${flags(s.armingDisableFlags)} rcData[T]=${s.rcData[3]} AUX1=${s.rcData[4]}`);
assert.equal(s.armed, false);
assert.equal(s.armingDisableFlags, 0);
core.input(ch({ throttle: 0 }, [2000, 1000, 1000, 1000]));
core.step(8);
s = core.fc;
console.log(`   ARM 2000 +8 ms: t=${t(core.simTimeUs)} armed=${s.armed} armingDisableFlags=${flags(s.armingDisableFlags)} AUX1=${s.rcData[4]}`);
core.step(42);
s = core.fc;
console.log(`   ARM 2000 +50 ms: t=${t(core.simTimeUs)} armed=${s.armed} armingDisableFlags=${flags(s.armingDisableFlags)} AUX1=${s.rcData[4]}`);
assert.equal(s.armed, true);

// Motors at throttle channel 1000 and 1500 (armed, sticks centred).
console.log('\n== motors vs throttle (armed; motor = Betaflight motor[], dshot = value sent to the ESC)');
const atThrottle = {};
for (const thr of [0, 0.5]) {
  core.input(ch({ throttle: thr }, [2000, 1000, 1000, 1000]));
  core.step(200);
  s = core.fc;
  atThrottle[s.rcData[3]] = s.motor.slice();
  console.log(`   throttle ch ${s.rcData[3]}: rcCommand[T]=${s.rcCommand[3].toFixed(1)} motor[0..3]=${fmt(s.motor)} dshot[0..3]=${fmt(core.state.motorDshot)}`);
}
assert.ok(atThrottle[1000].every((v) => v >= 48 && v < 300), 'armed at throttle 1000: digital idle');
assert.ok(atThrottle[1500].every((v, i) => v > atThrottle[1000][i] + 500), 'throttle 1500 lifts every motor');

// Roll deflection vs motor split at throttle 1500. Fresh instance per
// deflection: the rest plant never rotates, so integral wind-up from one
// deflection would carry into the next. Motors: 0 RR, 1 FR, 2 RL, 3 FL.
console.log('\n== roll deflection vs motor split (throttle 1500; fresh boot each; split = (m2+m3) - (m0+m1))');
const splitAt10 = {};
for (const roll of [0, 0.1, 0.25, 0.5, -0.25, 1]) {
  const c = await SimCore.load(module);
  c.eeprom = core.eeprom;
  c.rcmap = core.rcmap;
  c.reinit({ freshPack: true });
  c.input(ch({ throttle: 0 }, [2000]));
  c.step(50);
  c.input(ch({ throttle: 0.5 }, [2000]));
  c.step(200);
  c.input(ch({ throttle: 0.5, roll }, [2000]));
  let done = 0;
  for (const after of [2, 10, 30]) {
    c.step(after - done);
    done = after;
    const q = c.fc;
    const split = q.motor[2] + q.motor[3] - q.motor[0] - q.motor[1];
    if (after === 10) splitAt10[roll] = split;
    console.log(`   roll ${String(roll).padStart(5)} ch ${String(q.rcData[0]).padStart(4)} +${String(after).padStart(2)}ms setpoint=${q.setpoint[0].toFixed(1).padStart(7)} motor[0..3]=${fmt(q.motor)} split=${split.toFixed(1)}`);
  }
}
assert.equal(splitAt10[0], 0, 'no roll, no split');
assert.ok(splitAt10[0.1] > 0 && splitAt10[0.25] > splitAt10[0.1] && splitAt10[0.5] > splitAt10[0.25] && splitAt10[1] > splitAt10[0.5],
  'right roll lifts the left motors, more with more deflection');
assert.equal(splitAt10[-0.25], -splitAt10[0.25], 'left roll mirrors right roll');

// Negative: Betaflight refuses to arm with the throttle up.
console.log('\n== negative: ARM high with throttle 1500 before arming');
{
  const c = await SimCore.load(module);
  c.eeprom = core.eeprom;
  c.rcmap = core.rcmap;
  c.reinit({ freshPack: true });
  c.input(ch({ throttle: 0.5 }, [1000]));
  c.step(50);
  let q = c.fc;
  console.log(`   throttle 1500, ARM 1000: armed=${q.armed} armingDisableFlags=${flags(q.armingDisableFlags)}`);
  c.input(ch({ throttle: 0.5 }, [2000]));
  c.step(50);
  q = c.fc;
  console.log(`   throttle 1500, ARM 2000: armed=${q.armed} armingDisableFlags=${flags(q.armingDisableFlags)} motor[0..3]=${fmt(q.motor)}`);
  assert.equal(q.armed, false);
}

console.log('\ngate-arm-motor: PASS');
