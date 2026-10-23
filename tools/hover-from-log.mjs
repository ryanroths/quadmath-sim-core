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
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TWO_PI = 2 * Math.PI;
// The duty the ESC gets from a DShot value, as the plant reads it
// (src/plant/plant.c dutyOf; Betaflight drivers/dshot.h:30-33). Not the
// header's motorOutput: that is the mixer's range, which starts above 48 with
// static idle and ends below 2047 with motor_output_limit.
const dutyOf = (motor) => (motor - 48) / 1999;
const WINDOW_RULES = 'mean accZ within 5 % of 1 g, accZ sd < 10 % of 1 g, gyro rms < 10 deg/s, setpoint rms < 10 deg/s, motors above logged idle';

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
export function findWindow(bins, { acc1G, motorIdle }) {
  const steady = (b) => Math.abs(b.accZ / acc1G - 1) < 0.05 && b.accZsd < 0.1 * acc1G
    && b.gyroRms < 10 && b.setpRms < 10 && b.motor > motorIdle;
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
  return best ? [bins[best[0]].s, bins[best[1] - 1].s + 1] : null;
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
    if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
    else out._.push(a);
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
    // The rest of the throttle path (tests/lib/bench-hover.mjs flies them).
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
  for (const ev of h.getDataParser()) if (ev.kind === 'main') frames.push(ev.data);
  if (frames.length < 64) throw new Error(`log ${li} has ${frames.length} main frames`);
  const get = (fr, k) => fr.fields.get(k);
  // blackbox_high_resolution logs rcCommand, setpoint and gyro x10
  // (blackbox/blackbox.c:1138, :1149, :1154).
  const hiRes = header.blackbox_high_resolution ? 10 : 1;
  const t0 = frames[0].time;
  const rows = frames.map((fr) => ({
    t: fr.time - t0,
    thr: get(fr, 'rcCommand[3]') / hiRes,
    vbat: (get(fr, 'vbatLatest') ?? 0) / 100,
    amps: (get(fr, 'amperageLatest') ?? 0) / 100,
    m: [0, 1, 2, 3].map((i) => get(fr, `motor[${i}]`)),
    erpm: [0, 1, 2, 3].map((i) => get(fr, `eRPM[${i}]`)),
    acc: [0, 1, 2].map((i) => get(fr, `accSmooth[${i}]`)),
    gyro: [0, 1, 2].map((i) => get(fr, `gyroADC[${i}]`) / hiRes),
    setp: [0, 1, 2].map((i) => get(fr, `setpoint[${i}]`) / hiRes),
  }));
  if (rows.some((r) => r.erpm.some((v) => v == null))) throw new Error('log has no eRPM fields (dshot_bidir off?)');
  return {
    logCount: file.logCount, header, acc1G, rows,
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
    log: { frames: rows.length, duration_s: round(dur, 1), rate_hz: Math.round(rows.length / dur), logs_in_file: log.logCount },
    window_s: window,
    window_note: opts.window ? 'given with --window' : `the longest steady run: ${WINDOW_RULES} (tools/hover-from-log.mjs)`,
    header: log.header,
    measured,
    derived,
  };
}

async function main() {
  const a = args(process.argv.slice(2));
  const logPath = a._[0];
  const qm = a.quadmath ?? process.env.QUADMATH_DIR;
  if (!logPath || !qm) {
    console.error('usage: node tools/hover-from-log.mjs <log.BBL> --quadmath <quadmath clone> [options] (or set QUADMATH_DIR); see the header of this file');
    process.exit(2);
  }
  const root = fileURLToPath(new URL('..', import.meta.url));
  const air = JSON.parse(readFileSync(resolve(root, a.airframe ?? 'airframes/air65.json'), 'utf8')).values;
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
