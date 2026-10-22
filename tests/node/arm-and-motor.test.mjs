// Stop point for Phase 1: in Node, Betaflight arms and a motor answers a stick.
//
//   node tests/node/arm-and-motor.test.mjs
//
// Uses the committed dist/sim-core.wasm and the 65 mm class diff.
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SimCore, sticksToChannels as ch } from '../../src/js/sim-core.js';

const root = new URL('../../', import.meta.url);
const wasm = await readFile(new URL('dist/sim-core.wasm', root));
const diff = await readFile(new URL('configs/65mm-air65-ryfly-1219s.diff', root), 'utf8');

const core = await SimCore.load(wasm, { rxHz: 250 });

// 1. Configure through Betaflight's CLI on a config instance.
const report = core.configure(diff);
console.log(`configure: ${report.applied} applied, ${report.rejected} rejected, ${report.errors} errors, ${report.comments} comments; rcmap ${report.rcmap}`);
for (const l of report.lines.filter((x) => x.status !== 'applied' && x.status !== 'comment')) console.log(`  line ${l.n} ${l.status}: ${l.text} -- ${l.msg}`);
for (const a of report.added) console.log(`  ${a.status}: ${a.text} (${a.msg})`);
assert.equal(report.errors, 0, 'every class diff line is accepted by Betaflight');
assert.equal(report.applied, 19, 'all 19 set lines applied');

// 2. configure() booted the flight instance until Betaflight reported no
//    arming-disable flag.
const boot = report.boot;
let f = core.fc;
console.log(`boot: arm-ready after ${(boot.simTimeUs / 1e6).toFixed(3)} s (${boot.ticks} ticks); vbat ${f.vbat.toFixed(2)} V, ${f.cells} cell(s), rx signal ${f.rxSignal}`);
assert.equal(f.armingDisableFlags, 0);
assert.equal(f.armed, false);
let s;
if (core.flightLog.trim()) console.log(`boot log: ${core.flightLog.trim()}`);

const run = (ms) => core.step(Math.round(ms * core.loopHz / 1000));

// 3. Throttle low, AUX1 high: arm.
core.input(ch({ throttle: 0 }, [2000, 1000, 1000, 1000]));
run(50);
s = core.state;
f = core.fc;
console.log(`arm: armed ${f.armed} at t=${(s.tUs / 1e6).toFixed(3)} s; motors (DShot) ${s.motorDshot.map((v) => v.toFixed(0)).join(' ')}`);
assert.equal(f.armed, true, 'Betaflight armed from the ARM aux');
const idle = s.motorDshot.slice();
assert.ok(idle.every((v) => v >= 48), 'armed motors sit at digital idle');

// 4. Raise the throttle stick: every motor rises.
core.input(ch({ throttle: 0.5 }, [2000, 1000, 1000, 1000]));
run(100);
s = core.state;
f = core.fc;
console.log(`throttle 50%: rcCommand T ${f.rcCommand[3].toFixed(0)}; motors ${s.motorDshot.map((v) => v.toFixed(0)).join(' ')}`);
assert.ok(s.motorDshot.every((v, i) => v > idle[i] + 200), 'throttle stick moves every motor');
const mid = s.motorDshot.slice();

// 5. Full right roll at the same throttle: Betaflight's PID drives a roll split
//    (QUADX: motors 3 and 4 are on the left, 1 and 2 on the right). The rest
//    plant does not rotate, so this is the first response, not a flight.
core.input(ch({ throttle: 0.5, roll: 1 }, [2000, 1000, 1000, 1000]));
run(20);
s = core.state;
f = core.fc;
const left = s.motorDshot[2] + s.motorDshot[3];
const right = s.motorDshot[0] + s.motorDshot[1];
console.log(`roll right: setpoint roll ${f.setpoint[0].toFixed(0)} deg/s; motors ${s.motorDshot.map((v) => v.toFixed(0)).join(' ')} (left ${left.toFixed(0)} vs right ${right.toFixed(0)})`);
assert.ok(f.setpoint[0] > 400, 'roll stick reaches a high roll setpoint');
assert.ok(left > right, 'right roll pushes the left motors up');

// 6. Disarm.
core.input(ch({ throttle: 0 }, [1000, 1000, 1000, 1000]));
run(50);
s = core.state;
f = core.fc;
console.log(`disarm: armed ${f.armed}; motors ${s.motorDshot.map((v) => v.toFixed(0)).join(' ')}`);
assert.equal(f.armed, false);
console.log('arm-and-motor: PASS');
