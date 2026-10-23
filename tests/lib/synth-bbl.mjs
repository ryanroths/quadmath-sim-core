// A synthetic Betaflight 4.5 blackbox log (all I-frames) of an Air65-like
// hover, written with Betaflight's own main-frame field definitions,
// predictors and encodings (vendor/betaflight src/main/blackbox/blackbox.c
// :182-275) and its header lines (:1361-1399). For testing
// tools/hover-from-log.mjs through a real decoder; no flight log is in the
// repository. Shape: idle, take-off, 56 s of hover (3-59 s), a throttle blip,
// hover, landing; the hover holds rcCommand 1371, motor 720 (duty 0.336) and
// logged eRPM 1942 (32,367 rpm on 12 poles).
//
//   synthHoverBbl({ rate = 200, motorLow = 48, idle = 0, hiRes = false }) -> Buffer
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.

const ACC_1G = 2048;
const VBATREF = 420;

// name, signed, I predictor, I encoding, P predictor, P encoding
const FIELDS = [
  ['loopIteration', 0, 0, 1, 6, 9],
  ['time', 0, 0, 1, 2, 0],
  ['rcCommand[0]', 1, 0, 0, 1, 8], ['rcCommand[1]', 1, 0, 0, 1, 8], ['rcCommand[2]', 1, 0, 0, 1, 8], ['rcCommand[3]', 0, 0, 1, 1, 8],
  ['setpoint[0]', 1, 0, 0, 1, 8], ['setpoint[1]', 1, 0, 0, 1, 8], ['setpoint[2]', 1, 0, 0, 1, 8], ['setpoint[3]', 1, 0, 0, 1, 8],
  ['vbatLatest', 0, 9, 3, 1, 6],
  ['amperageLatest', 1, 0, 0, 1, 6],
  ['gyroADC[0]', 1, 0, 0, 3, 0], ['gyroADC[1]', 1, 0, 0, 3, 0], ['gyroADC[2]', 1, 0, 0, 3, 0],
  ['accSmooth[0]', 1, 0, 0, 3, 0], ['accSmooth[1]', 1, 0, 0, 3, 0], ['accSmooth[2]', 1, 0, 0, 3, 0],
  ['motor[0]', 0, 11, 1, 3, 0], ['motor[1]', 0, 5, 0, 3, 0], ['motor[2]', 0, 5, 0, 3, 0], ['motor[3]', 0, 5, 0, 3, 0],
  ['eRPM[0]', 0, 0, 1, 1, 0], ['eRPM[1]', 0, 0, 1, 1, 0], ['eRPM[2]', 0, 0, 1, 1, 0], ['eRPM[3]', 0, 0, 1, 1, 0],
];

export function synthHoverBbl({ rate = 200, motorLow = 48, idle = 0, hiRes = false } = {}) {
  const scale = hiRes ? 10 : 1;
  const header = [
    'Product:Blackbox flight data recorder by Nicholas Sherlock',
    'Data version:2',
    'I interval:1',
    'P interval:1',
    'P ratio:1',
    `Field I name:${FIELDS.map((f) => f[0]).join(',')}`,
    `Field I signed:${FIELDS.map((f) => f[1]).join(',')}`,
    `Field I predictor:${FIELDS.map((f) => f[2]).join(',')}`,
    `Field I encoding:${FIELDS.map((f) => f[3]).join(',')}`,
    `Field P predictor:${FIELDS.map((f) => f[4]).join(',')}`,
    `Field P encoding:${FIELDS.map((f) => f[5]).join(',')}`,
    'Field S name:flightModeFlags,stateFlags,failsafePhase,rxSignalReceived,rxFlightChannelsValid',
    'Field S signed:0,0,0,0,0',
    'Field S predictor:0,0,0,0,0',
    'Field S encoding:1,1,1,1,1',
    'Firmware type:Cleanflight',
    'Firmware revision:Betaflight 4.5.1 (77d01ba3b) STM32G47X',
    'Firmware date:Oct  1 2024 10:00:00',
    'Board information:BEFH BETAFPVG473',
    'Log start datetime:2026-10-23T09:08:13.000-07:00',
    'Craft name:SYNTH',
    'minthrottle:1070',
    'maxthrottle:2000',
    'gyro_scale:0x3f800000',
    `motorOutput:${motorLow},2047`,
    `acc_1G:${ACC_1G}`,
    'vbat_scale:110',
    'vbatcellvoltage:330,350,430',
    `vbatref:${VBATREF}`,
    'currentSensor:-600,750',
    'looptime:125',
    'thr_mid:50',
    'thr_expo:0',
    'dshot_bidir:1',
    'motor_poles:12',
    'motor_pwm_protocol:6',
    `dshot_idle_value:${idle}`,
    'rates_type:3',
    'vbat_sag_compensation:70',
    'dyn_idle_min_rpm:0',
    'motor_output_limit:100',
    'throttle_limit_type:0',
    'throttle_limit_percent:100',
    'throttle_boost:5',
    'thrust_linear:20',
    'debug_mode:0',
    'features:541130760',
    `blackbox_high_resolution:${hiRes ? 1 : 0}`,
  ];
  const bytes = [];
  for (const l of header) for (const c of Buffer.from(`H ${l}\n`, 'latin1')) bytes.push(c);
  const uvb = (v) => {
    let x = v >>> 0;
    while (x >= 0x80) {
      bytes.push((x & 0x7f) | 0x80);
      x >>>= 7;
    }
    bytes.push(x);
  };
  const svb = (v) => uvb(((v << 1) ^ (v >> 31)) >>> 0);
  const neg14 = (v) => uvb((-v) & 0x3fff);
  const n = Math.round(66.1 * rate);
  for (let k = 0; k < n; k++) {
    const t = k / rate;
    const w = Math.sin(k * 0.7);
    const hover = (t >= 3 && t < 59) || (t >= 60 && t < 64);
    const u = Math.min(1, Math.max(0, (t - 3) / 56));
    let thr = 1371, motor = 720, erpm = 1942, accZ = ACC_1G + 20 * w, vbat = 4.11 - 0.25 * u, amps = 2.79 + 0.32 * u;
    if (t < 1) { thr = 1000; motor = motorLow; erpm = 0; accZ = ACC_1G; vbat = 4.24; amps = 0.62; }
    else if (!hover && t < 3) { thr = 1450; motor = 900; erpm = 2300; accZ = 1.3 * ACC_1G; }
    else if (!hover && t < 60) { thr = 1600; motor = 1100; erpm = 2600; accZ = 1.6 * ACC_1G + 300 * w; }
    else if (!hover) { thr = 1200; motor = 400; erpm = 1300; accZ = 0.7 * ACC_1G + 400 * w; }
    const r = {
      loopIteration: k * (8000 / rate), time: 5_000_000 + Math.round(t * 1e6),
      'rcCommand[0]': 0, 'rcCommand[1]': 0, 'rcCommand[2]': 0, 'rcCommand[3]': thr * scale,
      'setpoint[0]': 0, 'setpoint[1]': 0, 'setpoint[2]': 0, 'setpoint[3]': thr - 1000,
      vbatLatest: Math.round(vbat * 100), amperageLatest: Math.round(amps * 100),
      'gyroADC[0]': Math.round(3 * w * scale), 'gyroADC[1]': Math.round(-3 * w * scale), 'gyroADC[2]': Math.round(2 * w * scale),
      'accSmooth[0]': Math.round(5 * w), 'accSmooth[1]': Math.round(-5 * w), 'accSmooth[2]': Math.round(accZ),
      'motor[0]': Math.round(motor + 2 * w), 'motor[1]': Math.round(motor - 2 * w), 'motor[2]': Math.round(motor + w), 'motor[3]': Math.round(motor - w),
      'eRPM[0]': Math.max(0, Math.round(erpm + 3 * w)), 'eRPM[1]': Math.max(0, Math.round(erpm - 3 * w)), 'eRPM[2]': erpm, 'eRPM[3]': erpm,
    };
    bytes.push('I'.charCodeAt(0));
    for (const [name, , ip, ie] of FIELDS) {
      let v = r[name];
      if (ip === 9) v -= VBATREF;
      else if (ip === 11) v -= motorLow;
      else if (ip === 5) v -= r['motor[0]'];
      if (ie === 1) uvb(v);
      else if (ie === 0) svb(v);
      else if (ie === 3) neg14(v);
      else throw new Error(`encoding ${ie}`);
    }
  }
  bytes.push('E'.charCodeAt(0), 0xff);
  for (const c of Buffer.from('End of log\0', 'latin1')) bytes.push(c);
  return Buffer.from(bytes);
}
