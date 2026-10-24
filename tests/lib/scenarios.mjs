// Scripted sessions in sim time, shared by the Node tests and the browser
// harness so both hosts run the same input stream. No Node or DOM APIs here.
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import { sticksToChannels } from '../../src/js/sim-core.js';

export const CLASS_DIFFS = Object.freeze({
  '65mm': 'configs/65mm-air65-ryfly-1219s.diff',
  '75mm': 'configs/75mm-meteor75pro-ryfly-hamo-45mm.diff',
});

// The plant each class flies on. 65mm is the Air65 (M4). 75mm has no airframe
// file yet and stays on the rest plant.
export const CLASS_AIRFRAMES = Object.freeze({
  '65mm': 'airframes/air65.json',
});

// { diff, airframe } per class preset; readText(path) reads a repo file
// (readFile in Node, fetch in the browser harness).
export async function loadPresets(readText) {
  const out = {};
  for (const [name, path] of Object.entries(CLASS_DIFFS)) {
    const af = CLASS_AIRFRAMES[name];
    out[name] = { diff: await readText(path), airframe: af ? JSON.parse(await readText(af)) : undefined };
  }
  return out;
}

// Every class preset, acro and angle, RPM filter on and off, 3D off and on
// (the D2 coverage in the Phase 1 plan). On the Air65 plant the gyro and
// motor rpm are live, so the RPM filter path gets real input; on the rest
// plant (75mm) an rpm-on trace differs from its rpm-off twin only in
// Betaflight's RPM-filter-enabled flag.
export function matrix() {
  const out = [];
  for (const preset of Object.keys(CLASS_DIFFS)) {
    for (const angle of [false, true]) {
      for (const rpm of [false, true]) {
        for (const mode3d of [false, true]) {
          const name = `${preset} ${angle ? 'angle' : 'acro'} rpm-${rpm ? 'on' : 'off'}${mode3d ? ' 3d' : ''}`;
          out.push({ name, preset, angle, rpm, mode3d });
        }
      }
    }
  }
  return out;
}

// The class diff plus the scenario's switches, as CLI lines.
export function diffFor(scenario, presetText) {
  const extra = [`set dshot_bidir = ${scenario.rpm ? 'ON' : 'OFF'}`];
  if (scenario.mode3d) extra.push('feature 3D');
  return `${presetText}\n${extra.join('\n')}\n`;
}

// 0..1..0 over `period` steps. IEEE division is correctly rounded in every
// engine, and sticksToChannels rounds to integer channels.
function triangle(step, period) {
  const p = step % period;
  const half = period / 2;
  return p < half ? p / half : 2 - p / half;
}

// One sample every 4 ms (a 250 Hz poll) for durationMs from t0: still for
// 100 ms, ARM on AUX1, throttle steps, then roll, pitch and yaw sweeps and
// reversals, and a disarm 200 ms before the end. ANGLE on AUX2 when asked; in
// 3D the throttle alternates forward and reverse around the centre.
export function script(t0, durationMs, { angle = false, mode3d = false } = {}) {
  const out = [];
  for (let ms = 0; ms <= durationMs; ms += 4) {
    const k = ms / 4;
    const arm = ms >= 100 && ms < durationMs - 200 ? 2000 : 1000;
    const phase = Math.floor(ms / 250) % 2;
    const throttle = ms < 300 ? 0 : mode3d ? (phase ? 0.45 : -0.4) : (phase ? 0.55 : 0.4);
    const roll = ms < 800 ? 0 : 2 * triangle(k, 50) - 1;
    const pitch = ms < 1200 ? 0 : 0.8 * triangle(k, 80) - 0.4;
    const yaw = ms < 1600 ? 0 : (ms % 400 < 200 ? 0.6 : -0.6);
    out.push({
      tUs: t0 + ms * 1000,
      ch: sticksToChannels({ roll, pitch, yaw, throttle }, [arm, angle ? 2000 : 1000, 1000, 1000], { mode3d }),
    });
  }
  return out;
}

// Seeded frame times in ms: base period with +-50% jitter (mulberry32).
export function jitteredFrames(hz, seed) {
  let a = seed >>> 0;
  const base = 1000 / hz;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const u = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    return base * (0.5 + u);
  };
}

// Feeds samples up to 260 ms ahead of the sim clock. Future stamps wait in
// the input ring for their RX frame, so how far ahead they arrive cannot
// change what Betaflight sees.
export function feeder(samples) {
  let next = 0;
  return (core) => {
    const horizon = core.simTimeUs + 260_000;
    while (next < samples.length && samples[next].tUs < horizon) {
      core.input(samples[next].ch, samples[next].tUs);
      next++;
    }
  };
}

// The frame clock a test keeps on its own side of advance(): the plan's
// accumulator (frame time in, whole ticks out, remainder kept), so every
// advance() call can be checked against the frame time it was given.
export function frameClock() {
  return { accUs: 0, frameMs: 0 };
}

// Drives a booted core until sim time endUs. Time moves by exact ticks, or by
// advance() with frame times from `frames`. In the frame path every call is
// checked: advance() must run exactly the ticks the frame time adds up to
// and keep the same remainder, so an advance() that ignored or miscounted
// frame time fails here instead of reaching the same sim time another way.
// The last frame is shortened, from the test's own clock, to land on endUs.
// Returns the number of step or advance calls.
export function drive(core, feed, endUs, { frames, clock = frameClock() } = {}) {
  const tickUs = core.tickUs;
  let calls = 0;
  while (core.simTimeUs < endUs) {
    feed(core);
    const ticksLeft = (endUs - core.simTimeUs) / tickUs;
    if (!frames) {
      core.step(Math.min(250, ticksLeft));
    } else {
      let dt = frames();
      if (clock.accUs + dt * 1000 >= ticksLeft * tickUs) dt = ((ticksLeft + 0.25) * tickUs - clock.accUs) / 1000;
      clock.accUs += dt * 1000;
      const due = Math.floor(clock.accUs / tickUs);
      clock.accUs -= due * tickUs;
      clock.frameMs += dt;
      const ran = core.advance(dt);
      if (ran !== due || due > 250) throw new Error(`advance(${dt} ms) ran ${ran} ticks; the frame time adds up to ${due}`);
      if (Math.abs(core.alpha * tickUs - clock.accUs) > 1e-6) {
        throw new Error(`advance() kept ${core.alpha * tickUs} us; the frame time leaves ${clock.accUs} us`);
      }
    }
    calls++;
  }
  return calls;
}

// Configure, boot to arm-ready, run the scenario script, and summarise.
// preset: { diff, airframe } from loadPresets.
export async function runScenario(SimCore, module, preset, scenario, { frames, durationMs = 3000 } = {}) {
  const core = await SimCore.load(module);
  const report = core.configure({ diff: diffFor(scenario, preset.diff), plant: preset.airframe });
  if (report.errors) throw new Error(`${scenario.name}: ${report.errors} config errors`);
  const t0 = core.simTimeUs;
  const feed = feeder(script(t0, durationMs, scenario));
  const clock = frameClock();
  // Stop once while still armed (300 ms before the end) to record the flight.
  let calls = drive(core, feed, t0 + (durationMs - 300) * 1000, { frames, clock });
  const f = core.fc;
  const flying = { armed: f.armed, mode: f.mode, setpoint: f.setpoint, motorDshot: core.state.motorDshot };
  calls += drive(core, feed, t0 + durationMs * 1000, { frames, clock });
  return {
    name: scenario.name,
    hash: core.traceHash(),
    simTimeUs: core.simTimeUs,
    calls,
    frameMs: clock.frameMs,
    flying,
    armedAtEnd: core.fc.armed,
  };
}
