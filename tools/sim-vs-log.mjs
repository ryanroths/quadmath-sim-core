// Fly a real blackbox log's sticks in sim-core and compare the gyro: the
// logged rcCommand[0..3] replayed at the log's own rate into Betaflight in
// the sim, with the same diff, from rest on the floor; the sim's filtered gyro
// against the logged gyroADC. Prints per-axis error and the closed-loop step
// response of both (rise, overshoot, settle), computed by quadmath's
// blackbox-metrics.js stepResponse (Wiener deconvolution of setpoint to
// gyro), imported by path like the decoder.
//
//   node tools/sim-vs-log.mjs <log.BBL> --quadmath <quadmath clone>
//        [--diff configs/<file>] [--airframe airframes/air65.json] [--log 0]
//        [--from 0] [--to <s>] [--aux 5=2000,6=1000] [--out file.json]
//
// <log.BBL> is a path, or a name in SIM_CORE_LOGS (tools/logs.mjs).
// --quadmath, or QUADMATH_DIR: a quadmath clone; its vendor/blackbox-log
// .module.js decodes the log and its blackbox-metrics.js computes the step
// response. Neither is copied into this repository.
//
// The replay. Betaflight logs rcCommand, not the channels, so each channel
// value is found by asking Betaflight itself: every channel value 1000..2000
// is fed to a probe instance of the same build and diff, and its
// rcCommand read back (min_check, deadband and the throttle curve applied);
// a logged rcCommand is replayed as the channel that gives it (the one
// nearest centre where several do). The replayed flight reads its own
// rcCommand back every tick, and the largest difference to the log is
// printed, so a bad inversion shows. Arming and modes: the ARM range and the
// ANGLE and HORIZON ranges from the diff's aux lines, chosen by the log's
// flight mode flags; --aux overrides channel values (5 = AUX1).
//
// Step response: quadmath's stepResponse needs stick input (setpoint swings
// over 80 deg/s in 2 s windows); a hover has none, so it reports nothing to
// measure on both sides, which still proves the pipeline end to end.
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SimCore } from '../src/js/sim-core.js';
import { readLog, binRows50, currentBands } from './hover-from-log.mjs';
import { logPath as findLog } from './logs.mjs';

const AXES = ['roll', 'pitch', 'yaw'];
// Betaflight 4.5 flight mode flags (fc/runtime_config.h) and box ids
// (msp/msp_box.c): the modes the replay can set from aux lines.
const MODE_FLAG = { ANGLE: 1 << 0, HORIZON: 1 << 1 };
const BOX_ID = { ARM: 0, ANGLE: 1, HORIZON: 2 };

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

// The diff's aux lines: aux <slot> <box id> <aux channel> <start> <end> ...
function auxRanges(diff) {
  const ranges = [];
  for (const line of diff.split('\n')) {
    const m = line.trim().match(/^aux\s+\d+\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/);
    if (m && Number(m[3]) < Number(m[4])) ranges.push({ box: Number(m[1]), channel: 4 + Number(m[2]), start: Number(m[3]), end: Number(m[4]) });
  }
  return ranges;
}

const inRange = (r) => Math.max(1000, Math.min(2000, Math.round((r.start + r.end) / 2)));
const outOf = (r) => (r.start > 1000 ? 1000 : 2000);

// Channel values 1000..2000 per axis to the rcCommand Betaflight makes of
// them, on a probe instance; returned as rcCommand -> channel.
async function inversion(module, diff, airframe) {
  const probe = await SimCore.load(module, { trace: false });
  probe.configure({ diff, plant: airframe, world: { floorZ: -100 } });
  const maps = [new Map(), new Map(), new Map(), new Map()];
  for (let axis = 0; axis < 4; axis++) {
    for (let c = 1000; c <= 2000; c++) {
      const ch = [1500, 1500, 1500, 1000];
      ch[axis] = c;
      probe.input(ch);
      // Until it settles: the RX update, and for throttle Betaflight's own
      // smoothing (fc/rc.c:455-469 smooths throttle rcCommand only).
      let rc = NaN;
      for (let k = 0; k < 400; k++) {
        probe.step(1);
        const v = Math.round(probe.fc.rcCommand[axis]);
        if (v === rc && k > 8) break;
        rc = v;
      }
      const centre = axis === 3 ? 1000 : 1500;
      const prev = maps[axis].get(rc);
      if (prev === undefined || Math.abs(c - centre) < Math.abs(prev - centre)) maps[axis].set(rc, c);
    }
  }
  return maps.map((m) => {
    const keys = [...m.keys()].sort((a, b) => a - b);
    return (rc) => {
      const r = Math.round(rc);
      if (m.has(r)) return m.get(r);
      let best = keys[0];
      for (const k of keys) if (Math.abs(k - r) < Math.abs(best - r)) best = k;
      return m.get(best);
    };
  });
}

// Time for a step response to first reach half its target (1.0), ms, linear
// between samples: the lag at 50 % of the X3 rows, on the deconvolved step.
function lag50(r) {
  if (r.step[0] >= 0.5) return 0;   // already there at t = 0 (an instant kick)
  for (let i = 1; i < r.step.length; i++) {
    if (r.step[i] >= 0.5) {
      const f = (0.5 - r.step[i - 1]) / (r.step[i] - r.step[i - 1]);
      return +(r.t[i - 1] + f * (r.t[i] - r.t[i - 1])).toFixed(1);
    }
  }
  return null;
}

const rmsOf = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / Math.max(1, a.length));

export async function simVsLog(file, quadmathDir, { diff, airframe, module, log: li = 0, from = 0, to = Infinity, aux = {} }, print = () => {}) {
  const log = await readLog(file, quadmathDir, li);
  const metrics = await import(pathToFileURL(join(quadmathDir, 'blackbox-metrics.js')).href);
  const rows = log.rows.filter((r) => r.t >= from && r.t <= to);
  if (rows.length < 64) throw new Error(`only ${rows.length} frames between ${from} and ${to} s`);
  const t0 = rows[0].t;
  const dur = rows[rows.length - 1].t - t0;
  const logFs = (rows.length - 1) / dur;

  // Modes: the log's flags at the first frame of the stretch.
  // The flags in effect at the stretch's start: the last slow frame at or
  // before it, else the first one logged (slow frames come every few hundred
  // ms, so a log's first frames have none before them).
  const before = log.slow.filter((s) => s.t <= t0);
  const flagsAt = (before.length ? before.at(-1) : log.slow[0])?.flightModeFlags ?? null;
  const core = await SimCore.load(module, { trace: false });
  const report = core.configure({ diff, plant: airframe, world: { floorZ: 0 } });
  for (const l of report.lines.filter((x) => x.status === 'rejected' || x.status === 'error')) {
    print(`warning: config line ${l.n} ${l.status}: ${l.text} (${l.msg})`);
  }
  // The aux ranges Betaflight runs with: the diff's, and any sim-core added.
  const applied = [...report.lines.filter((x) => x.status === 'applied').map((x) => x.text), ...report.added.map((x) => x.text)];
  const ranges = auxRanges(applied.join('\n'));
  const auxValues = new Array(12).fill(1000);
  const armRange = ranges.find((r) => r.box === BOX_ID.ARM);
  if (!armRange) throw new Error('the diff has no aux range for ARM');
  for (const r of ranges) {
    if (r.box === BOX_ID.ARM) auxValues[r.channel - 4] = inRange(r);
    else if (r.box === BOX_ID.ANGLE || r.box === BOX_ID.HORIZON) {
      const on = flagsAt !== null && (flagsAt & (r.box === BOX_ID.ANGLE ? MODE_FLAG.ANGLE : MODE_FLAG.HORIZON)) !== 0;
      auxValues[r.channel - 4] = on ? inRange(r) : outOf(r);
    }
  }
  for (const [k, v] of Object.entries(aux)) auxValues[Number(k) - 5] = Number(v);

  const invert = await inversion(module, diff, airframe);
  // Armed at rest on the floor, throttle low, as the log begins.
  core.input([1500, 1500, 1500, 1000, ...auxValues]);
  core.step(100);
  if (!core.fc.armed) throw new Error(`the sim did not arm (arming disable flags 0x${core.fc.armingDisableFlags.toString(16)})`);
  const simFlags = core.fc.flightModeFlags;
  print(`modes: log flight mode flags ${flagsAt}, sim ${simFlags}${flagsAt !== null && (flagsAt & 3) !== (simFlags & 3) ? '  (ANGLE/HORIZON differ: pass --aux)' : ''}`);

  // Replay: each log frame's channels at its own time; the sim records every tick.
  const start = core.simTimeUs;
  const tick = core.tickUs;
  const sim = { t: [], gyro: [[], [], []], setpoint: [[], [], []], throttle: [], rc: [[], [], [], []], zMin: Infinity, zMax: -Infinity };
  let next = 0;
  let rcErr = 0;
  const endUs = start + Math.floor(dur * 1e6);
  while (core.simTimeUs < endUs) {
    while (next < rows.length && start + Math.round((rows[next].t - t0) * 1e6) <= core.simTimeUs) {
      const r = rows[next];
      const ch = [invert[0](r.rc[0]), invert[1](r.rc[1]), invert[2](r.rc[2]), invert[3](r.rc[3])];
      core.input([...ch, ...auxValues], start + Math.round((r.t - t0) * 1e6));
      next++;
    }
    core.flight.sc_step(1);
    if (core.fault) throw new Error(`sim fault ${core.fault} at ${((core.simTimeUs - start) / 1e6).toFixed(3)} s`);
    const fc = core.fc;
    const ts = (core.simTimeUs - start) / 1e6;
    sim.t.push(ts);
    for (let a = 0; a < 3; a++) {
      sim.gyro[a].push(fc.gyroFiltered[a]);
      // The setpoint the PID ran on, after angle mode: what the blackbox's
      // setpoint field logs (blackbox/blackbox.c:1153).
      sim.setpoint[a].push(fc.pidSetpoint[a]);
    }
    for (let a = 0; a < 4; a++) sim.rc[a].push(fc.rcCommand[a]);
    sim.throttle.push((fc.rcCommand[3] - 1000) / 1000);
    const z = core.state.pos[2];
    sim.zMin = Math.min(sim.zMin, z);
    sim.zMax = Math.max(sim.zMax, z);
  }
  // The log at the sim's tick times (the latest frame at or before each tick).
  const at = [];
  let j = 0;
  for (const ts of sim.t) {
    while (j + 1 < rows.length && rows[j + 1].t - t0 <= ts) j++;
    at.push(rows[j]);
  }
  // Readback: Betaflight takes a frame's channels at its next RX update, so
  // each tick's rcCommand is compared with the nearest of the frames in the
  // 20 ms before it. Roll, pitch and yaw rcCommand are raw in Betaflight and
  // should come back exact; throttle's is smoothed on the quad and again in
  // the sim, so it lags.
  const rcErrAxis = [0, 0, 0, 0];
  let lo = 0;
  for (let k = 0; k < sim.t.length; k++) {
    while (lo < rows.length && rows[lo].t - t0 < sim.t[k] - 0.02) lo++;
    for (let a = 0; a < 4; a++) {
      let best = Infinity;
      for (let i = lo; i < rows.length && rows[i].t - t0 <= sim.t[k]; i++) best = Math.min(best, Math.abs(sim.rc[a][k] - rows[i].rc[a]));
      if (Number.isFinite(best)) rcErrAxis[a] = Math.max(rcErrAxis[a], best);
    }
  }
  rcErr = rcErrAxis.map((v) => +v.toFixed(3));
  const axes = AXES.map((name, a) => {
    const g = sim.gyro[a].map((v, k) => v - at[k].gyro[a]);
    const sp = sim.setpoint[a].map((v, k) => v - at[k].setp[a]);
    const logFlight = metrics.flightMask(Float64Array.from(rows, (r) => (r.thr - 1000) / 1000));
    const simFlight = metrics.flightMask(Float64Array.from(sim.throttle));
    const stepLog = metrics.stepResponse(Float64Array.from(rows, (r) => r.setp[a]), Float64Array.from(rows, (r) => r.gyro[a]), logFs, logFlight.mask);
    const stepSim = metrics.stepResponse(Float64Array.from(sim.setpoint[a]), Float64Array.from(sim.gyro[a]), 1e6 / tick, simFlight.mask);
    return {
      name,
      gyroRmsLog: +rmsOf(at.map((r) => r.gyro[a])).toFixed(2),
      gyroRmsSim: +rmsOf(sim.gyro[a]).toFixed(2),
      gyroErrRms: +rmsOf(g).toFixed(2),
      setpointErrRms: +rmsOf(sp).toFixed(3),
      stepLog: stepLog ? { windows: stepLog.windows, ...stepLog.metrics, lag50Ms: lag50(stepLog) } : null,
      stepSim: stepSim ? { windows: stepSim.windows, ...stepSim.metrics, lag50Ms: lag50(stepSim) } : null,
    };
  });
  return {
    source: file.split(/[\\/]/).pop(),
    log_index: li,
    stretch_s: [+(t0).toFixed(3), +(t0 + dur).toFixed(3)],
    log: { frames: rows.length, rate_hz: +logFs.toFixed(1) },
    sim: { ticks: sim.t.length, rate_hz: 1e6 / tick, flightModeFlags: simFlags, aux: auxValues, height_m: [+sim.zMin.toFixed(3), +sim.zMax.toFixed(3)] },
    log_flight_mode_flags: flagsAt,
    rc_readback_max_error: rcErr,
    axes,
    // The log's pack current against rpm (50 ms bins, logged current).
    log_current_vs_rpm: currentBands(binRows50(log.rows, log.acc1G, log.header.motor_poles)),
  };
}

async function main() {
  const a = args(process.argv.slice(2));
  const qm = a.quadmath ?? process.env.QUADMATH_DIR;
  if (!a._[0] || !qm) {
    console.error('usage: node tools/sim-vs-log.mjs <log.BBL> --quadmath <quadmath clone> [--diff configs/<file>] [options] (or set QUADMATH_DIR); see the header of this file');
    process.exit(2);
  }
  const root = fileURLToPath(new URL('..', import.meta.url));
  const diffFile = a.diff ?? 'configs/65mm-air65-ryfly-1219s.diff';
  const diff = readFileSync(resolve(root, diffFile), 'utf8');
  const airframe = JSON.parse(readFileSync(resolve(root, a.airframe ?? 'airframes/air65.json'), 'utf8'));
  const module = await WebAssembly.compile(readFileSync(resolve(root, 'dist/sim-core.wasm')));
  const aux = Object.fromEntries((a.aux ?? '').split(',').filter(Boolean).map((kv) => kv.split('=')));
  const out = await simVsLog(findLog(a._[0]), qm, {
    diff, airframe, module, log: Number(a.log ?? 0), from: Number(a.from ?? 0), to: a.to == null ? Infinity : Number(a.to), aux,
  }, (line) => console.error(line));
  out.diff = diffFile;
  console.error(`${out.source} ${out.stretch_s[0]}-${out.stretch_s[1]} s: ${out.log.frames} frames at ${out.log.rate_hz} Hz replayed into ${out.sim.ticks} sim ticks; rcCommand read back within roll, pitch, yaw, throttle ${out.rc_readback_max_error.join(", ")}`);
  const f = (m) => (m ? `rise ${m.riseMs} ms, lag at 50 % ${m.lag50Ms} ms, overshoot ${m.overshootPct} %, settle ${m.settleMs} ms (${m.windows} windows)` : 'no step: not enough stick input');
  for (const x of out.axes) {
    console.error(`${x.name.padEnd(5)} gyro rms log ${x.gyroRmsLog} sim ${x.gyroRmsSim} deg/s, sim - log ${x.gyroErrRms} rms; setpoint sim - log ${x.setpointErrRms} rms`);
    console.error(`      step log: ${f(x.stepLog)}`);
    console.error(`      step sim: ${f(x.stepSim)}`);
  }
  const text = `${JSON.stringify(out, null, 2)}\n`;
  if (a.out) writeFileSync(a.out, text);
  else process.stdout.write(text);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
