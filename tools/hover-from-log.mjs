// Bench hover from a Betaflight blackbox log: the steady-hover numbers the
// airframe and the X3 hover-stick band need, in the tests/reference/
// air65-hover.json format, from one command. Based on the owner's hover.mjs
// (2026-10-23).
//
//   node tools/hover-from-log.mjs <log.BBL> --quadmath <quadmath clone>
//        [--airframe airframes/air65.json] [--log 0] [--window 3,59]
//        [--auw-g 25.79] [--rest-before 4.2] [--rest-after 4.08]
//        [--pack "weBLEEDfpv 340 mAh 1S BT2.0"] [--cells 1] [--current-scale 1.24]
//        [--out file.json]
//   node tools/hover-from-log.mjs <log.BBL> --plateau --log 0 [--hover tests/reference/air65-hover.json] [--out file.json]
//        the full-duty plateau of a punch-out log instead (see analysePlateau)
//   node tools/hover-from-log.mjs <log.BBL> --turtle --log 0 [--window 3,40] [--out tests/reference/air65-turtle.json]
//        the crash flips (turtles) of a log instead, from the gyro (see analyseTurtle)
//
// <log.BBL> is a path, or a name in SIM_CORE_LOGS (default D:/IGOW6/sim-core,
// tools/logs.mjs): logs stay out of git, what they give is committed.
//
// The decoder is not part of sim-core. The tool imports quadmath's vendored
// blackbox-log parser (vendor/blackbox-log.module.js, MIT, W Etheredge; the
// licence is vendor/blackbox-log.LICENSE beside it) by path from a quadmath
// clone, given by --quadmath or the QUADMATH_DIR environment variable. It is
// only read, never copied into this repository. quadmath at 98ae0b0 has it
// (last changed in feb66bd, "support Betaflight 4.5").
//
// What it reads, per main frame: rcCommand[3], motor[0..3], eRPM[0..3],
// vbatLatest (0.01 V), amperageLatest (0.01 A, the board's own current
// sensor calibration; --current-scale applies a bench correction, e.g. the
// Air65 bench's 1.24), accSmooth, gyroADC and setpoint (deg/s; divided by 10
// on a blackbox_high_resolution log); and from the header motorOutput,
// motor_poles, acc_1G and the throttle-path settings (thrust_linear,
// vbat_sag_compensation, throttle_boost, thr_mid, thr_expo, dshot_bidir,
// dyn_idle_min_rpm, dshot_idle_value, motor_output_limit, throttle_limit_type
// and _percent, vbatcellvoltage), which the gate flies on top of the class
// diff for the hover-stick band. Header values come from the log's own
// "H name:value" lines: the parser keeps some of them to itself. Duty is
// (motor - 48) / 1999, the DShot value as the ESC and the plant read it. The logged eRPM field is eRPM / 100: Betaflight 4.5 stores
// getDshotErpm(), the decoded telemetry value "erpm * 100" period conversion
// (drivers/dshot.c:183-184, blackbox/blackbox.c:261, :1170), and its own
// erpmToRpm is erpm x 100 / (poles / 2) (drivers/dshot.c:56, :160, :395-399).
//
// The hover window, unless --window is given: the longest run of whole
// seconds in which mean accZ is within 5 % of 1 g, accZ varies by less than
// 10 % of 1 g, gyro and setpoint rms are under 10 deg/s, and the motors are
// above their logged idle (the owner's criteria for the Air65 log).
//
// Prints the 1 s bins, the window, and what follows for the airframe:
//   kt = m g / (4 w_hover^2) (m from --auw-g, else the airframe's mass)
//   the static load fraction at hover, rpm / (KV x V x duty)
//   the plant's loadFraction that reproduces that ratio at hover (the plant
//     takes loadFraction as its full-throttle point; see
//     airframes/air65.json loadFraction), and tmax = kt x w_full^2 at both
//   the cell IR from the idle bin against the first hover second, and from
//     --rest-after against the last hover second
// --out writes the reference JSON; otherwise it goes to stdout. Nothing else
// is written.
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import { readFileSync, writeFileSync } from 'node:fs';
import { logPath as findLog } from './logs.mjs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TWO_PI = 2 * Math.PI;
// The duty the ESC gets from a DShot value, as the plant reads it
// (src/plant/plant.c dutyOf; Betaflight drivers/dshot.h:30-33). Not the
// header's motorOutput: that is the mixer's range, which starts above 48 with
// static idle and ends below 2047 with motor_output_limit.
const dutyOf = (motor) => (motor - 48) / 1999;
const WINDOW_RULES = 'mean accZ within 10 % of 1 g, accZ sd < 12 % of 1 g, gyro and setpoint rms < 12 deg/s, motors above logged idle; the longest run of such seconds, less one second at each end';

// Per-second bins of the decoded rows (t in s from the first frame).
export function binRows(rows) {
  const bins = [];
  const dur = rows[rows.length - 1].t;
  for (let s = 0; s < Math.floor(dur); s++) {
    const seg = rows.filter((r) => r.t >= s && r.t < s + 1);
    if (!seg.length) continue;
    const mean = (fn) => seg.reduce((a, r) => a + fn(r), 0) / seg.length;
    const sd = (fn) => { const mu = mean(fn); return Math.sqrt(mean((r) => (fn(r) - mu) ** 2)); };
    bins.push({
      s,
      thr: mean((r) => r.thr), vbat: mean((r) => r.vbat), amps: mean((r) => r.amps),
      motor: mean((r) => r.m.reduce((a, b) => a + b, 0) / r.m.length),
      erpm: mean((r) => r.erpm.reduce((a, b) => a + b, 0) / r.erpm.length),
      accZ: mean((r) => r.acc[2]), accZsd: sd((r) => r.acc[2]),
      gyroRms: Math.sqrt(mean((r) => (r.gyro[0] ** 2 + r.gyro[1] ** 2 + r.gyro[2] ** 2) / 3)),
      setpRms: Math.sqrt(mean((r) => (r.setp[0] ** 2 + r.setp[1] ** 2 + r.setp[2] ** 2) / 3)),
    });
  }
  return bins;
}

// The longest run of consecutive steady-hover bins, as [first s, last s + 1].
// The owner's criteria for the Air65 hover (tests/reference/air65-hover.json
// window_note), with the limits the owner's own window [3, 59] of that log keeps
// inside: its seconds reach 6.3 % off 1 g in mean accZ, 10.3 % in its spread and 10.5 deg/s of gyro
// rms. The run's first and last seconds are the climb into the hover and the
// move out of it, so they are left out.
export function findWindow(bins, { acc1G, motorIdle }) {
  const steady = (b) => Math.abs(b.accZ / acc1G - 1) < 0.1 && b.accZsd < 0.12 * acc1G
    && b.gyroRms < 12 && b.setpRms < 12 && b.motor > motorIdle;
  let best = null;
  let start = null;
  for (let i = 0; i <= bins.length; i++) {
    const ok = i < bins.length && steady(bins[i]) && (start === null || bins[i].s === bins[i - 1].s + 1);
    if (ok && start === null) start = i;
    if (!ok && start !== null) {
      if (!best || i - start > best[1] - best[0]) best = [start, i];
      start = i < bins.length && steady(bins[i]) ? i : null;
    }
  }
  if (!best || best[1] - best[0] < 3) return null;
  return [bins[best[0]].s + 1, bins[best[1] - 1].s];
}

// The hover numbers over a window of bins, and what follows for the plant.
// air: the airframe's values block; opts: auwG, restBefore, restAfter, cells.
export function analyse(bins, window, header, air, opts = {}) {
  const [w0, w1] = window;
  const win = bins.filter((b) => b.s >= w0 && b.s < w1);
  if (!win.length) throw new Error(`no bins in the window ${w0}-${w1} s`);
  const mean = (fn, set = win) => set.reduce((a, b) => a + fn(b), 0) / set.length;
  const rpmOf = (erpm) => (erpm * 100) / (header.motor_poles / 2);
  const part = (set) => ({
    vbat: round(mean((b) => b.vbat, set), 3), amps: round(mean((b) => b.amps, set), 2),
    duty: round(dutyOf(mean((b) => b.motor, set)), 3), rpm: Math.round(rpmOf(mean((b) => b.erpm, set))),
  });
  const thrRc = mean((b) => b.thr);
  const duty = dutyOf(mean((b) => b.motor));
  const erpm = mean((b) => b.erpm);
  const rpm = rpmOf(erpm);
  const omega = (rpm * TWO_PI) / 60;
  const vbat = mean((b) => b.vbat);
  const amps = mean((b) => b.amps);
  const cells = opts.cells ?? air.cells.value;
  const measured = {
    hover_throttle_rc: Math.round(thrRc),
    hover_stick: round((thrRc - 1000) / 1000, 3),
    hover_motor_duty: round(duty, 3),
    hover_erpm_logged_mean: Math.round(erpm),
    hover_rpm: Math.round(rpm),
    hover_omega_rad_s: Math.round(omega),
    vbat_mean_v: round(vbat, 3),
    amps_mean_a: round(amps, 2),
    power_mean_w: round(vbat * amps, 2),
    first_10s: part(win.slice(0, 10)),
    last_10s: part(win.slice(-10)),
    idle_prearm_bin0: { vbat: round(bins[0].vbat, 2), amps: round(bins[0].amps, 2) },
    vbat_rest_before: opts.restBefore ?? null,
    vbat_rest_after: opts.restAfter ?? null,
    cells,
    pack: opts.pack ?? null,
    auw_g: opts.auwG ?? null,
  };

  // The plant (src/plant/plant.c derive()): w_full = lf x Kv x Vref, and at
  // steady hover rpm / (KV x V x duty) = 1 / (1 + (1 - lf) w_hover / (lf^2 Kv Vref)).
  const kvRad = (air.kv.value * TWO_PI) / 60;
  const vRef = air.vRefCell.value * cells;
  const massKg = opts.auwG ? opts.auwG / 1000 : air.mass.value;
  const g = air.gravity.value;
  const kt = (massKg * g) / (4 * omega * omega);
  const ratio = rpm / (air.kv.value * vbat * duty);
  const c = (1 / ratio - 1) * (kvRad * vRef) / omega;
  const lfPlant = (-1 + Math.sqrt(1 + 4 * c)) / (2 * c);
  const tmaxAt = (lf) => kt * (lf * kvRad * vRef) ** 2;
  const first = win[0];
  const last = win[win.length - 1];
  const derived = {
    static_load_fraction_hover: round(ratio, 3),
    static_load_fraction_note: `hover_rpm / (KV ${air.kv.value} x vbat_mean x hover_motor_duty)`,
    kt_prop_from_hover_N_per_rad2: Number(kt.toExponential(4)),
    kt_note: `m g / (4 omega^2) at m = ${massKg} kg${opts.auwG ? ' (auw_g)' : ' (the airframe mass: no --auw-g given)'}, g = ${g}`,
    plant_load_fraction_for_hover_ratio: round(lfPlant, 4),
    plant_load_fraction_note: `the plant's loadFraction (its full-throttle point at ${air.vRefCell.value} V per cell) at which its own hover ratio equals static_load_fraction_hover`,
    tmax_N_at_load_fraction: {
      [String(air.loadFraction.value)]: round(tmaxAt(air.loadFraction.value), 5),
      [String(round(lfPlant, 4))]: round(tmaxAt(lfPlant), 5),
    },
    tmax_note: 'kt x (lf x Kv x vRefCell)^2: the airframe tmax that carries the measured kt at that loadFraction',
    cell_ir_start_ohm: round((bins[0].vbat - first.vbat) / ((first.amps - bins[0].amps) * cells), 4),
    cell_ir_start_note: `(${round(bins[0].vbat, 2)} - ${round(first.vbat, 2)}) V / (${round(first.amps, 2)} - ${round(bins[0].amps, 2)}) A: bin 0 (before take-off) against the window's first second; state of charge moves in between`,
    cell_ir_end_ohm: opts.restAfter ? round((opts.restAfter - last.vbat) / (last.amps * cells), 4) : null,
    cell_ir_end_note: opts.restAfter ? `(${opts.restAfter} - ${round(last.vbat, 2)}) V / ${round(last.amps, 2)} A: rest after landing against the window's last second` : 'needs --rest-after',
    current_sensor_note: `currentSensor ${header.currentSensor ? header.currentSensor.join(', ') : 'not in header'} as logged; not corrected`,
  };
  return { measured, derived };
}

const round = (v, d) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) out._.push(a);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[a.slice(2)] = argv[++i];
    else out[a.slice(2)] = true;   // a bare flag (--plateau)
  }
  return out;
}

const listNum = (v) => (v == null ? null : String(v).split(',').map((x) => Number(x.trim())));
const headerNum = (u, k) => (u.has(k) ? Number(u.get(k)) : null);
const PRODUCT = 'H Product:Blackbox flight data recorder by Nicholas Sherlock';

// One log of a blackbox file: its header values and its main frames as rows.
// The parser takes some header lines for itself (motorOutput, acc_1G,
// vbatref, minthrottle, gyro_scale) and drops others (vbat_scale,
// currentSensor), so headers.unknown lacks them; every header value is read
// from the log's own "H name:value" lines, with the parser's map underneath.
export async function readLog(logPath, quadmathDir, li = 0) {
  const { Parser, getWasm } = await import(pathToFileURL(join(quadmathDir, 'vendor', 'blackbox-log.module.js')).href);
  const parser = await Parser.init(await getWasm());
  const bytes = readFileSync(logPath);
  const file = parser.loadFile(new Uint8Array(bytes));
  if (!(li >= 0 && li < file.logCount)) throw new Error(`log ${li} not in file (${file.logCount} logs)`);
  const h = file.parseHeaders(li);
  const u = new Map(h.unknown);
  const text = bytes.toString('latin1');
  const starts = [];
  for (let i = text.indexOf(PRODUCT); i >= 0; i = text.indexOf(PRODUCT, i + 1)) starts.push(i);
  if (starts.length !== file.logCount) throw new Error(`${starts.length} header blocks for ${file.logCount} logs`);
  for (const line of text.slice(starts[li], starts[li + 1] ?? text.length).split('\n')) {
    if (!line.startsWith('H ')) break;
    const c = line.indexOf(':');
    if (c > 2) u.set(line.slice(2, c), line.slice(c + 1));
  }
  const header = {
    motorOutput: listNum(u.get('motorOutput')), motor_poles: headerNum(u, 'motor_poles'), dshot_bidir: headerNum(u, 'dshot_bidir'),
    vbat_scale: headerNum(u, 'vbat_scale'), currentSensor: listNum(u.get('currentSensor')),
    thrust_linear: headerNum(u, 'thrust_linear'), vbat_sag_compensation: headerNum(u, 'vbat_sag_compensation'),
    throttle_boost: headerNum(u, 'throttle_boost'), rates_type: headerNum(u, 'rates_type'),
    thr_mid: headerNum(u, 'thr_mid'), thr_expo: headerNum(u, 'thr_expo'),
    // The rest of the throttle path (tools/config-from-log.mjs checks the
    // whole header against a diff).
    // vbatcellvoltage is min, warning, max in 0.01 V; the warning voltage sets
    // the range vbat_sag_compensation works over (flight/mixer_init.c:350-354).
    dyn_idle_min_rpm: headerNum(u, 'dyn_idle_min_rpm'), dshot_idle_value: headerNum(u, 'dshot_idle_value'),
    motor_output_limit: headerNum(u, 'motor_output_limit'),
    throttle_limit_type: headerNum(u, 'throttle_limit_type'), throttle_limit_percent: headerNum(u, 'throttle_limit_percent'),
    vbatcellvoltage: listNum(u.get('vbatcellvoltage')),
    blackbox_high_resolution: headerNum(u, 'blackbox_high_resolution'),
  };
  for (const k of ['motorOutput', 'motor_poles']) if (header[k] == null) throw new Error(`header has no ${k}`);
  const acc1G = headerNum(u, 'acc_1G');
  if (!acc1G) throw new Error('header has no acc_1G');

  const frames = [];
  // Slow frames carry the flight mode flags; kept with the index of the main
  // frame they follow.
  const slow = [];
  for (const ev of h.getDataParser()) {
    if (ev.kind === 'main') frames.push(ev.data);
    else if (ev.kind === 'slow' && ev.data && ev.data.fields) slow.push({ at: frames.length, flightModeFlags: ev.data.fields.get('flightModeFlags') ?? null });
  }
  if (frames.length < 64) throw new Error(`log ${li} has ${frames.length} main frames`);
  const get = (fr, k) => fr.fields.get(k);
  // blackbox_high_resolution logs rcCommand, setpoint and gyro x10
  // (blackbox/blackbox.c:1138, :1149, :1154).
  const hiRes = header.blackbox_high_resolution ? 10 : 1;
  const t0 = frames[0].time;
  const rows = frames.map((fr) => ({
    t: fr.time - t0,
    thr: get(fr, 'rcCommand[3]') / hiRes,
    rc: [0, 1, 2, 3].map((i) => get(fr, `rcCommand[${i}]`) / hiRes),
    vbat: (get(fr, 'vbatLatest') ?? 0) / 100,
    amps: (get(fr, 'amperageLatest') ?? 0) / 100,
    m: [0, 1, 2, 3].map((i) => get(fr, `motor[${i}]`)),
    erpm: [0, 1, 2, 3].map((i) => get(fr, `eRPM[${i}]`)),
    acc: [0, 1, 2].map((i) => get(fr, `accSmooth[${i}]`)),
    gyro: [0, 1, 2].map((i) => get(fr, `gyroADC[${i}]`) / hiRes),
    setp: [0, 1, 2].map((i) => get(fr, `setpoint[${i}]`) / hiRes),
  }));
  if (rows.some((r) => r.erpm.some((v) => v == null))) throw new Error('log has no eRPM fields (dshot_bidir off?)');
  // A corrupt frame can decode as a huge value (quadmath blackbox-extract.js
  // holds the last good sample for the same reason); frames with a motor
  // outside DShot's 0..2047 or a negative eRPM are dropped and counted.
  const good = rows.filter((r) => r.m.every((v) => v >= 0 && v <= 2047) && r.erpm.every((v) => v >= 0));
  const dropped = rows.length - good.length;
  return {
    logCount: file.logCount, header, acc1G, rows: good, dropped,
    // Each slow frame at the time of the main frame before it.
    slow: slow.map((x) => ({ t: frames[Math.max(0, x.at - 1)].time - t0, flightModeFlags: x.flightModeFlags })),
    rawHeader: Object.fromEntries(u),
    info: { datetime: u.get('Log start datetime') ?? null, craft: h.craftName, board: h.boardInfo, firmware: h.firmwareRevision },
  };
}

// Everything from a log to the reference JSON. opts: the command-line options
// (log, window, auw-g, rest-before, rest-after, pack, cells, current-scale).
export async function hoverFromLog(logPath, quadmathDir, air, opts = {}, print = () => {}) {
  const li = Number(opts.log ?? 0);
  const log = await readLog(logPath, quadmathDir, li);
  const currentScale = opts['current-scale'] == null ? 1 : Number(opts['current-scale']);
  const rows = currentScale === 1 ? log.rows : log.rows.map((r) => ({ ...r, amps: r.amps * currentScale }));
  const dur = rows[rows.length - 1].t;
  const bins = binRows(rows);
  print(`${basename(logPath)}: log ${li} of ${log.logCount}, ${rows.length} frames, ${dur.toFixed(1)} s, ${(rows.length / dur).toFixed(0)} Hz; ${log.info.firmware ?? ''} ${log.info.board ?? ''} ${log.info.craft ?? ''}`);
  print(' s   thr   vbat   amps  duty   eRPM   accZ  accZsd gyroRms setpRms');
  for (const b of bins) {
    print(`${String(b.s).padStart(2)} ${b.thr.toFixed(0).padStart(5)} ${b.vbat.toFixed(2).padStart(6)} ${b.amps.toFixed(2).padStart(6)} ${dutyOf(b.motor).toFixed(3).padStart(6)} ${b.erpm.toFixed(0).padStart(6)} ${b.accZ.toFixed(0).padStart(6)} ${b.accZsd.toFixed(0).padStart(6)} ${b.gyroRms.toFixed(1).padStart(7)} ${b.setpRms.toFixed(1).padStart(7)}`);
  }
  // Above idle: 2 % of the mixer's range over the lowest bin.
  const [lo, hi] = log.header.motorOutput;
  const idleMotor = Math.min(...bins.map((b) => b.motor));
  const window = opts.window ? listNum(opts.window) : findWindow(bins, { acc1G: log.acc1G, motorIdle: idleMotor + 0.02 * (hi - lo) });
  if (!window) throw new Error(`no steady hover found (${WINDOW_RULES}); give --window`);
  const num = (k) => (opts[k] == null ? undefined : Number(opts[k]));
  const { measured, derived } = analyse(bins, window, log.header, air, {
    auwG: num('auw-g'), restBefore: num('rest-before'), restAfter: num('rest-after'), cells: num('cells'), pack: opts.pack,
  });
  if (currentScale !== 1) derived.current_sensor_note = `logged current x ${currentScale} (--current-scale) in every amps value above`;
  return {
    source: basename(logPath),
    flown: [log.info.datetime, log.info.craft, log.info.board, log.info.firmware].filter(Boolean).join(', '),
    log: { frames: rows.length, duration_s: round(dur, 1), rate_hz: Math.round(rows.length / dur), logs_in_file: log.logCount, corrupt_frames_dropped: log.dropped },
    window_s: window,
    window_note: opts.window ? 'given with --window' : `the longest steady run: ${WINDOW_RULES} (tools/hover-from-log.mjs)`,
    header: log.header,
    measured,
    derived,
  };
}

// ---- Full-duty plateau mode (--plateau): the punches of a punch-out log.
const PLATEAU_RULES = '50 ms bins with mean duty > 0.9; runs less than 100 ms apart are one punch; steady values leave out the first 100 ms (the rotors spinning up); onset accZ is the highest bin in the first 150 ms';

// 50 ms bins of the rows: duty, rpm, pack, accZ (g).
export function binRows50(rows, acc1G, motorPoles) {
  const W = 0.05;
  const bins = [];
  let i = 0;
  const end = rows[rows.length - 1].t;
  for (let k = 0; k * W < end; k++) {
    const s = k * W;
    const seg = [];
    while (i < rows.length && rows[i].t < s + W) {
      if (rows[i].t >= s) seg.push(rows[i]);
      i++;
    }
    if (!seg.length) continue;
    const mean = (fn) => seg.reduce((a, r) => a + fn(r), 0) / seg.length;
    bins.push({
      t: s,
      duty: mean((r) => dutyOf(r.m.reduce((a, b) => a + b, 0) / r.m.length)),
      rpm: (mean((r) => r.erpm.reduce((a, b) => a + b, 0) / r.erpm.length) * 100) / (motorPoles / 2),
      vbat: mean((r) => r.vbat), amps: mean((r) => r.amps),
      accZ: mean((r) => r.acc[2]) / acc1G,
    });
  }
  return bins;
}

// Current against rpm, 2 krpm bands of 50 ms bins with the motors driven.
export function currentBands(bins, scale = 1) {
  const mean = (set, k) => set.reduce((a, b) => a + b[k], 0) / set.length;
  const bands = [];
  for (let lo = 20000; lo < 80000; lo += 2000) {
    const band = bins.filter((b) => b.duty > 0.1 && b.rpm >= lo && b.rpm < lo + 2000);
    if (band.length >= 4) bands.push({ krpm: [lo / 1000, (lo + 2000) / 1000], bins: band.length, rpm: Math.round(mean(band, 'rpm')), amps: round(mean(band, 'amps') * scale, 2) });
  }
  return bands;
}

// The punches, their steady plateau and onset, the pack's sag from the hover
// before each, and current against rpm over the whole log.
export function analysePlateau(bins, air, hover, opts = {}) {
  const W = 0.05;
  const scale = opts.currentScale ?? 1;
  const mean = (set, k) => set.reduce((a, b) => a + b[k], 0) / set.length;
  const runs = [];
  for (const b of bins.filter((x) => x.duty > 0.9)) {
    const last = runs.at(-1);
    if (last && b.t - last.at(-1).t <= 2 * W + 1e-9) last.push(b);
    else runs.push([b]);
  }
  const punches = runs.filter((run) => run.length >= 3).map((run) => {
    const t0 = run[0].t;
    const steady = run.filter((b) => b.t >= t0 + 0.1 - 1e-9);
    const onset = run.filter((b) => b.t < t0 + 0.15 - 1e-9);
    const pre = bins.filter((b) => b.t >= t0 - 0.3 - 1e-9 && b.t < t0 - 0.1 - 1e-9);
    const p = {
      start_s: round(t0, 2), end_s: round(run.at(-1).t + W, 2), bins: run.length,
      steady: {
        duty: round(mean(steady, 'duty'), 3), rpm: Math.round(mean(steady, 'rpm')),
        vbat: round(mean(steady, 'vbat'), 3), amps: round(mean(steady, 'amps') * scale, 2),
      },
      onset_accZ_g: round(Math.max(...onset.map((b) => b.accZ)), 2),
      before: pre.length ? { duty: round(mean(pre, 'duty'), 3), vbat: round(mean(pre, 'vbat'), 3), amps: round(mean(pre, 'amps') * scale, 2) } : null,
    };
    // From hover: the pack's sag over the step in current is its IR.
    if (p.before && p.before.duty < 0.5) {
      p.cell_ir_ohm = round((p.before.vbat - p.steady.vbat) / ((p.steady.amps - p.before.amps) * (opts.cells ?? air.cells.value)), 4);
    }
    return p;
  });
  if (!punches.length) throw new Error(`no full-duty plateau (${PLATEAU_RULES})`);
  const steadyBins = runs.filter((run) => run.length >= 3).flatMap((run) => run.filter((b) => b.t >= run[0].t + 0.1 - 1e-9));
  const m = {
    duty: round(mean(steadyBins, 'duty'), 3),
    rpm: Math.round(mean(steadyBins, 'rpm')),
    vbat_v: round(mean(steadyBins, 'vbat'), 3),
    amps_a: round(mean(steadyBins, 'amps') * scale, 2),
    onset_accZ_g: Math.max(...punches.map((p) => p.onset_accZ_g)),
  };
  m.omega_rad_s = Math.round((m.rpm * TWO_PI) / 60);
  const bands = currentBands(bins, scale);
  const derived = {
    load_fraction_full: round(m.rpm / (air.kv.value * m.vbat_v * m.duty), 4),
    load_fraction_note: `rpm / (KV ${air.kv.value} x vbat x duty) on the steady plateau`,
  };
  if (hover) {
    const wh = hover.measured.hover_omega_rad_s;
    derived.thrust_law = {
      omega_hover_rad_s: wh,
      predicted_onset_accZ_g: round((m.omega_rad_s / wh) ** 2, 3),
      measured_onset_accZ_g: m.onset_accZ_g,
      note: 'thrust = kt w^2 with kt from the hover (m g / (4 w_hover^2)): at the plateau rpm, thrust / weight = (w / w_hover)^2, the specific force at onset before the quad gains speed',
    };
  }
  const irs = punches.filter((p) => p.cell_ir_ohm !== undefined).map((p) => p.cell_ir_ohm);
  if (irs.length) {
    derived.cell_ir_ohm = irs;
    derived.cell_ir_note = `(vbat before - vbat steady) / (amps steady - amps before) per punch from hover, before = 300..100 ms before the punch${scale !== 1 ? `, current x ${scale}` : ', logged current'}`;
  }
  return { punches, measured: m, current_vs_rpm: bands, derived };
}

export async function plateauFromLog(logPath, quadmathDir, air, hover, opts = {}) {
  const li = Number(opts.log ?? 0);
  const log = await readLog(logPath, quadmathDir, li);
  const bins = binRows50(log.rows, log.acc1G, log.header.motor_poles);
  const scale = opts['current-scale'] == null ? 1 : Number(opts['current-scale']);
  const a = analysePlateau(bins, air, hover, { currentScale: scale });
  const dur = log.rows[log.rows.length - 1].t;
  return {
    source: basename(logPath),
    log_index: li,
    mode: 'full-duty plateau',
    rule: PLATEAU_RULES,
    flown: [log.info.datetime, log.info.craft, log.info.board, log.info.firmware].filter(Boolean).join(', '),
    log: { frames: log.rows.length, duration_s: round(dur, 1), rate_hz: Math.round(log.rows.length / dur), logs_in_file: log.logCount, corrupt_frames_dropped: log.dropped },
    current_scale: scale,
    header: log.header,
    ...a,
  };
}


// ---- Turtle mode (--turtle): the crash flips of a log, from the gyro alone.
// Betaflight logs no crash-flip flag, so a flip is found as the rotation it
// makes. The gyro clips at 2000 deg/s (an ICM-42688-P at its +-2000 range,
// as the sim's), so a clipped flip's peak and rotation are lower bounds; the
// time it takes to turn over is the number that stays honest.
export const TURTLE_RULES = 'a flip is a run of samples with the roll or pitch gyro above 100 deg/s, gaps under 50 ms joined, extended either side to where both fall below 20 deg/s, that turns at least 90 deg by the integrated gyro on its main axis; per flip: the axis, the rotation, the peak rate (clipped when within 1 % of 2000 deg/s: the peak and the rotation are then lower bounds), the time from the run\'s start to 180 deg, and the mean rate over the run';
const TURTLE_RATE = 100;
const TURTLE_EDGE = 20;
const TURTLE_GAP_S = 0.05;
const TURTLE_MIN_DEG = 90;
const GYRO_RANGE = 2000;

// rows: { t (s), gyro: [roll, pitch, yaw] deg/s }, in time order. window:
// [s0, s1] to look in only, or null.
export function analyseTurtle(rows, window = null) {
  const inWindow = window ? rows.filter((r) => r.t >= window[0] && r.t <= window[1]) : rows;
  const fast = (r) => Math.abs(r.gyro[0]) > TURTLE_RATE || Math.abs(r.gyro[1]) > TURTLE_RATE;
  const runs = [];
  let run = null;
  for (let i = 0; i < inWindow.length; i++) {
    const r = inWindow[i];
    if (fast(r)) {
      if (run && r.t - run.last <= TURTLE_GAP_S) {
        run.end = i;
        run.last = r.t;
      } else {
        run = { start: i, end: i, last: r.t };
        runs.push(run);
      }
    }
  }
  const flips = [];
  const moving = (r) => Math.abs(r.gyro[0]) > TURTLE_EDGE || Math.abs(r.gyro[1]) > TURTLE_EDGE;
  for (const run of runs) {
    let { start, end } = run;
    while (start > 0 && moving(inWindow[start - 1])) start--;
    while (end < inWindow.length - 1 && moving(inWindow[end + 1])) end++;
    const seg = inWindow.slice(start, end + 1);
    if (seg.length < 2) continue;
    const turned = [0, 0];
    let at180 = null;
    let peak = 0;
    for (let k = 1; k < seg.length; k++) {
      const dt = seg[k].t - seg[k - 1].t;
      for (const axis of [0, 1]) turned[axis] += seg[k].gyro[axis] * dt;
      const axisNow = Math.abs(turned[0]) >= Math.abs(turned[1]) ? 0 : 1;
      if (at180 === null && Math.abs(turned[axisNow]) >= 180) at180 = seg[k].t - seg[0].t;
    }
    const axis = Math.abs(turned[0]) >= Math.abs(turned[1]) ? 0 : 1;
    if (Math.abs(turned[axis]) < TURTLE_MIN_DEG) continue;
    for (const r of seg) peak = Math.max(peak, Math.abs(r.gyro[axis]));
    const duration = seg[seg.length - 1].t - seg[0].t;
    flips.push({
      axis: axis === 0 ? 'roll' : 'pitch',
      start_s: round(seg[0].t, 3),
      end_s: round(seg[seg.length - 1].t, 3),
      rotation_deg: round(turned[axis], 1),
      peak_rate_dps: round(peak, 1),
      clipped: peak >= 0.99 * GYRO_RANGE,
      time_to_180_ms: at180 === null ? null : round(at180 * 1000, 1),
      mean_rate_dps: duration > 0 ? round(Math.abs(turned[axis]) / duration, 1) : null,
    });
  }
  const over = flips.filter((f) => f.time_to_180_ms !== null);
  const median = (xs) => {
    const a = [...xs].sort((x, y) => x - y);
    return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : null;
  };
  return {
    flips,
    measured: flips.length ? {
      flips: flips.length,
      time_to_180_ms: median(over.map((f) => f.time_to_180_ms)),
      peak_rate_dps: Math.max(...flips.map((f) => f.peak_rate_dps)),
      clipped: flips.some((f) => f.clipped),
      mean_rate_dps: median(flips.map((f) => f.mean_rate_dps).filter((x) => x !== null)),
    } : null,
  };
}

export async function turtleFromLog(logPath, quadmathDir, opts = {}) {
  const li = Number(opts.log ?? 0);
  const log = await readLog(logPath, quadmathDir, li);
  const window = opts.window ? String(opts.window).split(',').map(Number) : null;
  const a = analyseTurtle(log.rows, window);
  if (!a.flips.length) throw new Error(`no flip found (${TURTLE_RULES})${window ? ` in ${window.join('-')} s` : ''}`);
  const dur = log.rows[log.rows.length - 1].t;
  const crash = Object.fromEntries(Object.entries(log.rawHeader).filter(([k]) => /crash_?flip/i.test(k)));
  return {
    source: basename(logPath),
    log_index: li,
    mode: 'turtle',
    rule: TURTLE_RULES,
    window_s: window,
    flown: [log.info.datetime, log.info.craft, log.info.board, log.info.firmware].filter(Boolean).join(', '),
    log: { frames: log.rows.length, duration_s: round(dur, 1), rate_hz: Math.round(log.rows.length / dur), logs_in_file: log.logCount, corrupt_frames_dropped: log.dropped },
    header: { ...log.header, ...crash },
    ...a,
  };
}

async function main() {
  const a = args(process.argv.slice(2));
  const logPath = a._[0] && findLog(a._[0]);
  const qm = a.quadmath ?? process.env.QUADMATH_DIR;
  if (!logPath || !qm) {
    console.error('usage: node tools/hover-from-log.mjs <log.BBL> --quadmath <quadmath clone> [options] (or set QUADMATH_DIR); see the header of this file');
    process.exit(2);
  }
  const root = fileURLToPath(new URL('..', import.meta.url));
  const air = JSON.parse(readFileSync(resolve(root, a.airframe ?? 'airframes/air65.json'), 'utf8')).values;
  if (a.turtle !== undefined) {
    const t = await turtleFromLog(logPath, qm, a);
    const text = `${JSON.stringify(t, null, 2)}\n`;
    if (a.out) writeFileSync(a.out, text);
    else process.stdout.write(text);
    for (const x of t.flips) console.error(`flip ${x.start_s}-${x.end_s} s on ${x.axis}: ${x.rotation_deg} deg, peak ${x.peak_rate_dps} deg/s${x.clipped ? ' (clipped)' : ''}, 180 deg at ${x.time_to_180_ms} ms, mean ${x.mean_rate_dps} deg/s`);
    console.error(`turtle: ${t.measured.flips} flips; 180 deg at ${t.measured.time_to_180_ms} ms (median), peak ${t.measured.peak_rate_dps} deg/s${t.measured.clipped ? ' (clipped)' : ''}`);
    return;
  }
  if (a.plateau !== undefined) {
    const hover = JSON.parse(readFileSync(resolve(root, a.hover ?? 'tests/reference/air65-hover.json'), 'utf8'));
    const p = await plateauFromLog(logPath, qm, air, hover, a);
    const text = `${JSON.stringify(p, null, 2)}\n`;
    if (a.out) writeFileSync(a.out, text);
    else process.stdout.write(text);
    for (const x of p.punches) console.error(`punch ${x.start_s}-${x.end_s} s: steady duty ${x.steady.duty}, ${x.steady.rpm} rpm, ${x.steady.vbat} V, ${x.steady.amps} A; onset ${x.onset_accZ_g} g${x.cell_ir_ohm !== undefined ? `; from ${x.before.vbat} V at ${x.before.amps} A, cell IR ${x.cell_ir_ohm}` : ''}`);
    console.error(`plateau: duty ${p.measured.duty}, ${p.measured.rpm} rpm, ${p.measured.vbat_v} V, ${p.measured.amps_a} A, onset ${p.measured.onset_accZ_g} g; load fraction at full ${p.derived.load_fraction_full}; thrust law predicts ${p.derived.thrust_law?.predicted_onset_accZ_g} g`);
    return;
  }
  const out = await hoverFromLog(logPath, qm, air, a, (line) => console.error(line));
  const text = `${JSON.stringify(out, null, 2)}\n`;
  if (a.out) writeFileSync(a.out, text);
  else process.stdout.write(text);
  const { measured: m, derived: d } = out;
  console.error(`window ${out.window_s[0]}-${out.window_s[1]} s: hover stick ${m.hover_stick}, duty ${m.hover_motor_duty}, ${m.hover_rpm} rpm (${m.hover_omega_rad_s} rad/s), ${m.vbat_mean_v} V, ${m.amps_mean_a} A`);
  console.error(`airframe: kt ${d.kt_prop_from_hover_N_per_rad2}; hover ratio ${d.static_load_fraction_hover}; plant loadFraction for it ${d.plant_load_fraction_for_hover_ratio}; tmax ${JSON.stringify(d.tmax_N_at_load_fraction)}; cell IR ${d.cell_ir_start_ohm} (start), ${d.cell_ir_end_ohm} (end)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
