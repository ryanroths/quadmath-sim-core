// The beeper: Betaflight's beeper state (io/beeper.c isBeeperOn()) is the FC
// readout fc.beeper, on the owner's Air65 diff and plant. There is no buzzer
// pin; the page plays it. One tick is 1 ms.
//   - quiet at rest once the boot beeps are over;
//   - arming: on within 20 ms of the arm, 300 ms on, 50 off, 50 on
//     (beep_armingBeep 30 5 5 5, in 10 ms);
//   - disarming: two 150 ms beeps (beep_disarmBeep 15 5 15 5);
//   - AUX3 high (the diff's BEEPER, with FLIP OVER AFTER CRASH): RX_SET short
//     beeps, and no DShot beacon, Betaflight's default (the policy refuses the
//     diff's 'beacon' lines): the motors stay at 0 and the arm is not delayed.
//
//   node tests/node/beeper.test.mjs
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SimCore, sticksToChannels as ch } from '../../src/js/sim-core.js';

const root = new URL('../../', import.meta.url);
const core = await SimCore.load(await readFile(new URL('dist/sim-core.wasm', root)), { trace: false });
const diff = await readFile(new URL('configs/air65-ryfly-2026-10-23.txt', root), 'utf8');
const air65 = JSON.parse(await readFile(new URL('airframes/air65.json', root), 'utf8'));
const report = core.configure({ diff, plant: air65, world: { floorZ: 0 } });
const beacon = report.lines.filter((l) => /^beacon\b/.test(l.text));
assert.equal(beacon.length, 2, 'the diff has its two beacon lines');
assert.ok(beacon.every((l) => l.status === 'rejected'), 'and the policy refuses them');

const LOW = [1000, 1000, 1000, 1000];
const ARM = [2000, 1000, 1000, 1000];
const AUX3 = [1000, 1000, 2000, 1000];
const ARM_AUX3 = [2000, 1000, 2000, 1000];
const ticksPerMs = core.loopHz / 1000;

// Hold the aux switches (throttle low) for ms, one sample a millisecond.
function hold(ms, aux) {
  core.input(ch({ throttle: 0 }, aux));
  const out = [];
  for (let i = 0; i < ms; i++) {
    core.step(ticksPerMs);
    const f = core.fc;
    out.push({ beeper: f.beeper, armed: f.armed, dshot: core.state.motorDshot.slice() });
  }
  return out;
}

// The beeper's on and off stretches, in ms, from the first change.
function stretches(samples) {
  const runs = [];
  for (const s of samples) {
    const last = runs[runs.length - 1];
    if (last && last.on === s.beeper) last.ms++;
    else runs.push({ on: s.beeper, ms: 1 });
  }
  return runs;
}
const near = (ms, want) => Math.abs(ms - want) <= 10;

hold(2000, LOW);
assert.equal(typeof core.fc.beeper, 'boolean', 'fc.beeper is a readout');
assert.ok(hold(500, LOW).every((s) => !s.beeper), 'quiet at rest once the boot beeps are over');

const arm = hold(600, ARM);
const armedAt = arm.findIndex((s) => s.armed);
const beepAt = arm.findIndex((s) => s.beeper);
assert.ok(armedAt >= 0, 'armed on AUX1');
assert.ok(beepAt >= armedAt && beepAt - armedAt <= 20, `the arming beep starts ${beepAt - armedAt} ms after the arm`);
const armRuns = stretches(arm.slice(beepAt));
console.log(`arming: armed at ${armedAt} ms, beeper ${armRuns.map((r) => `${r.on ? 'on' : 'off'} ${r.ms}`).join(', ')}`);
assert.ok(near(armRuns[0].ms, 300) && armRuns[0].on, 'arming beep: 300 ms on');
assert.ok(near(armRuns[1].ms, 50) && !armRuns[1].on, 'then 50 ms off');
assert.ok(near(armRuns[2].ms, 50) && armRuns[2].on, 'then 50 ms on');
assert.ok(!armRuns[3].on && armRuns.length === 4, 'then quiet');

const disarm = hold(600, LOW);
const disarmedAt = disarm.findIndex((s) => !s.armed);
assert.ok(disarmedAt >= 0 && disarmedAt <= 20 && disarm.slice(disarmedAt).every((s) => !s.armed), `disarmed on AUX1 at ${disarmedAt} ms`);
const disarmRuns = stretches(disarm).filter((r) => r.on);
console.log(`disarming: beeper on ${disarmRuns.map((r) => r.ms).join(', ')} ms`);
assert.equal(disarmRuns.length, 2, 'two disarming beeps');
assert.ok(disarmRuns.every((r) => near(r.ms, 150)), 'each 150 ms');

// Past Betaflight's 1.2 s beacon guard after the disarm, AUX3 high.
hold(1500, LOW);
const beeperBox = hold(2000, AUX3);
const rxSet = stretches(beeperBox).filter((r) => r.on);
console.log(`AUX3 (BEEPER): ${rxSet.length} beeps, ${rxSet.map((r) => r.ms).join(' ')} ms`);
assert.ok(rxSet.length >= 5 && rxSet.every((r) => near(r.ms, 100)), 'RX_SET short beeps, 100 ms each');
assert.ok(beeperBox.every((s) => s.dshot.every((v) => v === 0)), 'no DShot beacon: the motors stay at 0');
const flip = hold(100, ARM_AUX3);
const flipArmedAt = flip.findIndex((s) => s.armed);
assert.ok(flipArmedAt >= 0 && flipArmedAt <= 50, `arms into crash flip at once, ${flipArmedAt} ms (no beacon guard)`);
assert.equal(core.fc.crashFlip, true, 'in crash flip');
hold(100, LOW);

console.log('beeper: arming and disarming beeps, BEEPER on AUX3, no DShot beacon: PASS');
