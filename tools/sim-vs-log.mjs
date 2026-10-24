// Fly a real blackbox log's sticks in sim-core and compare the gyro: the
// logged rcCommand[0..3] replayed at the log's own rate into Betaflight in
// the sim, with the same diff, armed on the floor and then flown in open air;
// the sim's filtered gyro against the logged gyroADC. Prints per-axis error
// and the closed-loop step
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
// printed, so a bad inversion shows. Arming and modes: the ARM range from the
// diff's aux lines, held in range for the whole stretch; the ANGLE and HORIZON
// ranges switched in or out of range frame by frame as the log's mode
// switches were. The slow frame's "flightModeFlags" field is Betaflight's
// rcModeActivationMask, one bit per box id (blackbox/blackbox.c:902), not the
// runtime flight mode flags, and a slow frame is written whenever it changes.
// The sim's runtime modes are checked against it every tick. --aux overrides
// channel values (5 = AUX1).
//
// Open air. Sticks replayed open loop cannot follow the logged flight's path:
// the pilot closed the loop on what the quad did, so an acro replay drifts
// from it and, from the floor, sooner or later flies the sim into the ground
// (the owner's freestyle did at 60 s and stayed inverted on the floor). The
// rate loop's response does not depend on where the quad is, so once armed
// on the floor the sim is moved OPEN_AIR_M up with a pose event and flies the
// stretch clear of everything; a step-response window that holds a tick in
// contact is still left out on the sim's side.
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
// Betaflight 4.5 runtime flight mode flags (fc/runtime_config.h), the sim's
// side; and the modes the replay can set from aux lines. A bit of the log's
// mode mask is a box id (boxId_e, fc/rc_modes.h); the box field of an aux
// line is a permanent id (msp/msp_box.c). The two agree for ARM, ANGLE and
// HORIZON (0, 1, 2), so BOX_ID serves both; another box needs both its ids.
const MODE_FLAG = { ANGLE: 1 << 0, HORIZON: 1 << 1 };
const BOX_ID = { ARM: 0, ANGLE: 1, HORIZON: 2 };
const boxOn = (mask, box) => ((mask >>> box) & 1) === 1;
// Height above the floor the replay flies from, m (teleport() takes world
// coordinates up to 2000 m, um() in src/js/sim-core.js).
const OPEN_AIR_M = 1000;
// The runtime flags a mode mask asks for (ANGLE and HORIZON only): with both
// boxes on Betaflight runs ANGLE alone (fc/core.c:970-990).
const flagsFor = (mask) => (boxOn(mask, BOX_ID.ANGLE) ? MODE_FLAG.ANGLE : boxOn(mask, BOX_ID.HORIZON) ? MODE_FLAG.HORIZON : 0);

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

// The diff's aux lines: aux <slot> <permanent id> <aux channel> <start> <end> ...
function auxRanges(diff) {
  const ranges = [];
  for (const line of diff.split('\n')) {
    const m = line.trim().match(/^aux\s+\d+\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/);
    if (m && Number(m[3]) < Number(m[4])) ranges.push({ box: Number(m[1]), channel: 4 + Number(m[2]), start: Number(m[3]), end: Number(m[4]) });
  }
  return ranges;
}

const inRange = (r) => Math.max(1000, Math.min(2000, Math.round((r.start + r.end) / 2)));

// One value for an aux channel that puts each of its ranges in or out as
// wanted (Betaflight's isRangeActive, fc/rc_modes.c:87-95: start <= v < end):
// the middle of a wanted range first, then the channel's ends, then every
// 5 us; null if no value does.
function channelValue(rs, want) {
  const ok = (v) => rs.every((r, i) => (r.start <= v && v < r.end) === want[i]);
  const tries = [...rs.filter((r, i) => want[i]).map(inRange), 1000, 2000];
  for (let v = 1000; v <= 2000; v += 5) tries.push(v);
  return tries.find(ok) ?? null;
}

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

  // Modes: the log's mode mask in effect at each frame, the last slow frame at
  // or before it, else the first one logged (a log's first frames can have
  // none before them).
  const slow = log.slow.filter((s) => s.flightModeFlags != null);
  if (!slow.length) {
    print('warning: the log has no slow frames, so its modes are unknown: replaying ARM alone (acro) unless --aux sets the mode channels');
    slow.push({ t: t0, flightModeFlags: 1 << BOX_ID.ARM });
  }
  let si = 0;
  const maskAt = (t) => {
    while (si + 1 < slow.length && slow[si + 1].t <= t) si++;
    return slow[si].flightModeFlags;
  };
  const maskStart = maskAt(t0);
  // Slow frames also come periodically with the mask unchanged; the changes:
  const changes = [];
  for (let i = 0, prev = maskStart; i < slow.length; i++) {
    const s = slow[i];
    if (s.t > t0 && s.t <= rows[rows.length - 1].t && s.flightModeFlags !== prev) {
      changes.push({ t: +(s.t - t0).toFixed(3), mask: s.flightModeFlags });
      prev = s.flightModeFlags;
    }
  }
  const core = await SimCore.load(module, { trace: false });
  const report = core.configure({ diff, plant: airframe, world: { floorZ: 0 } });
  for (const l of report.lines.filter((x) => x.status === 'rejected' || x.status === 'error')) {
    print(`warning: config line ${l.n} ${l.status}: ${l.text} (${l.msg})`);
  }
  // The aux ranges Betaflight runs with: the diff's, and any sim-core added.
  const applied = [...report.lines.filter((x) => x.status === 'applied').map((x) => x.text), ...report.added.map((x) => x.text)];
  const ranges = auxRanges(applied.join('\n'));
  const armRange = ranges.find((r) => r.box === BOX_ID.ARM);
  if (!armRange) throw new Error('the diff has no aux range for ARM');
  // The aux channels for a mode mask: on each channel that carries ARM, ANGLE
  // or HORIZON, one value with ARM in range, ANGLE and HORIZON as the mask has
  // them and any other box on the channel out (a three-position switch is two
  // ranges on one channel); then the --aux overrides.
  const modeBoxes = new Set(Object.values(BOX_ID));
  const channels = [...new Set(ranges.filter((r) => modeBoxes.has(r.box)).map((r) => r.channel))];
  const auxCache = new Map();
  const auxFor = (mask) => {
    if (!auxCache.has(mask)) {
      const v = new Array(12).fill(1000);
      for (const ch of channels) {
        if (aux[ch + 1] != null) continue;   // set by --aux below
        const rs = ranges.filter((r) => r.channel === ch);
        const want = rs.map((r) => r.box === BOX_ID.ARM || ((r.box === BOX_ID.ANGLE || r.box === BOX_ID.HORIZON) && boxOn(mask, r.box)));
        const x = channelValue(rs, want);
        if (x === null) throw new Error(`no value of AUX${ch - 3} gives mode mask ${mask} with the diff's aux ranges (pass --aux)`);
        v[ch - 4] = x;
      }
      for (const [k, x] of Object.entries(aux)) v[Number(k) - 5] = Number(x);
      auxCache.set(mask, v);
    }
    return auxCache.get(mask);
  };
  const auxValues = auxFor(maskStart);

  const invert = await inversion(module, diff, airframe);
  // Armed at rest on the floor, throttle low, as the log begins.
  core.input([1500, 1500, 1500, 1000, ...auxValues]);
  core.step(100);
  if (!core.fc.armed) throw new Error(`the sim did not arm (arming disable flags 0x${core.fc.armingDisableFlags.toString(16)})`);
  const simFlags = core.fc.flightModeFlags;
  print(`modes: log mode mask ${maskStart} at the start (ARM ${boxOn(maskStart, BOX_ID.ARM)}, ANGLE ${boxOn(maskStart, BOX_ID.ANGLE)}, HORIZON ${boxOn(maskStart, BOX_ID.HORIZON)}), ${changes.length} changes in the stretch; sim runtime flags ${simFlags}`);

  // Into open air (the header): the pose event takes effect at the replay's
  // first tick, which then starts from OPEN_AIR_M.
  core.teleport({ pos: [0, 0, OPEN_AIR_M] });
  const z0 = OPEN_AIR_M;

  // Replay: each log frame's channels at its own time; the sim records every tick.
  const start = core.simTimeUs;
  const tick = core.tickUs;
  const sim = { t: [], gyro: [[], [], []], setpoint: [[], [], []], throttle: [], rc: [[], [], [], []], contact: [], zMin: Infinity, zMax: -Infinity };
  let next = 0;
  let rcErr = 0;
  // Mode check: ticks whose runtime ANGLE/HORIZON differ from the mask in
  // effect, outside the 20 ms after a mask change (a switch takes effect at
  // Betaflight's next RX update, as the rcCommand readback allows below).
  let mask = maskStart;
  let maskChangedAt = -Infinity;
  let modeMismatchTicks = 0;
  // The sim's own mode changes (runtime ANGLE/HORIZON), s from the start.
  const simModeChanges = [];
  let simModes = simFlags & 3;
  const endUs = start + Math.floor(dur * 1e6);
  while (core.simTimeUs < endUs) {
    while (next < rows.length && start + Math.round((rows[next].t - t0) * 1e6) <= core.simTimeUs) {
      const r = rows[next];
      const m = maskAt(r.t);
      if (m !== mask) {
        mask = m;
        maskChangedAt = r.t - t0;
      }
      const ch = [invert[0](r.rc[0]), invert[1](r.rc[1]), invert[2](r.rc[2]), invert[3](r.rc[3])];
      core.input([...ch, ...auxFor(mask)], start + Math.round((r.t - t0) * 1e6));
      next++;
    }
    core.flight.sc_step(1);
    if (core.fault) throw new Error(`sim fault ${core.fault} at ${((core.simTimeUs - start) / 1e6).toFixed(3)} s`);
    const fc = core.fc;
    const ts = (core.simTimeUs - start) / 1e6;
    if (ts - maskChangedAt > 0.02 && (fc.flightModeFlags & 3) !== flagsFor(mask)) modeMismatchTicks++;
    if ((fc.flightModeFlags & 3) !== simModes) {
      simModes = fc.flightModeFlags & 3;
      simModeChanges.push({ t: +ts.toFixed(3), flags: simModes });
    }
    sim.t.push(ts);
    for (let a = 0; a < 3; a++) {
      sim.gyro[a].push(fc.gyroFiltered[a]);
      // The setpoint the PID ran on, after angle mode: what the blackbox's
      // setpoint field logs (blackbox/blackbox.c:1153).
      sim.setpoint[a].push(fc.pidSetpoint[a]);
    }
    for (let a = 0; a < 4; a++) sim.rc[a].push(fc.rcCommand[a]);
    sim.throttle.push((fc.rcCommand[3] - 1000) / 1000);
    sim.contact.push(core.state.contactFlags ? 1 : 0);
    const z = core.state.pos[2] - z0;
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
    // No window that holds a tick in contact: quadmath's stepResponse checks
    // the mask on every 32nd sample of a window, so each contact tick masks
    // the 32 ticks up to it, of which a window holding it checks one.
    for (let k = 0; k < simFlight.mask.length; k++) if (sim.contact[k]) simFlight.mask.fill(0, Math.max(0, k - 31), k + 1);
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
    sim: { ticks: sim.t.length, rate_hz: 1e6 / tick, flightModeFlags: simFlags, aux: auxValues, open_air_m: OPEN_AIR_M, height_m: [+sim.zMin.toFixed(3), +sim.zMax.toFixed(3)], contact_ticks: sim.contact.reduce((a, b) => a + b, 0) },
    // The log's mode switches (rcModeActivationMask, bit n = box id n) at the
    // start and each change after it, s from the stretch's start; the sim's
    // ticks whose ANGLE/HORIZON differ from them.
    log_mode_mask: maskStart,
    log_mode_changes: changes,
    mode_mismatch_ticks: modeMismatchTicks,
    sim_mode_changes: simModeChanges,
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
