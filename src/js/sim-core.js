// quadmath-sim-core JS API. The only module the quadmath sim imports.
//
// Two instance roles, both fresh instances of the same compiled module:
//   config instance: boots, enters Betaflight's CLI, applies a diff line by
//     line, saves, and yields the EEPROM image. It never flies.
//   flight instance: boots from that EEPROM image (CLI never entered, so
//     arming is not blocked) and runs the fixed tick.
// Every reinit is a new WebAssembly.Instance; nothing reuses a flown instance.
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.

import {
  AUX_CHANNELS, DEFAULT_AUX, auxLine, classifyLine, parseAuxOutput, parseFeatureOutput, parseMapOutput,
} from './cli-policy.js';

const STATE = Object.freeze({
  tUs: 0, armed: 1, armingDisableFlags: 2, flightModeFlags: 3, failsafePhase: 4,
  motorDshot: 5, motorsEnabled: 9, motorMix: 10, setpoint: 14, gyroFiltered: 17,
  rcCommand: 20, rcData: 24, bfVbat: 28, bfCells: 29, bfAmps: 30, rxSignal: 31,
  attitude: 32, rcAux: 35,
});
const STATE_DOUBLES = 64;

const BOOT_CAP_US = 36_000_000;
const BOOT_CHUNK_TICKS = 100;
const MAX_AUX_SLOTS = 20;   // MAX_MODE_ACTIVATION_CONDITION_COUNT in Betaflight 4.5

export class SimCore {
  static async load(bytes, opts = {}) {
    const module = bytes instanceof WebAssembly.Module ? bytes : await WebAssembly.compile(bytes);
    return new SimCore(module, opts);
  }

  constructor(module, { rxHz = 250 } = {}) {
    this.module = module;
    this.rxHz = rxHz;
    this.eeprom = null;      // saved config image, carried across reinits
    this.rcmap = 'AETR1234';
    this.flight = null;
    this.flightLog = '';
  }

  #instantiate() {
    const instance = new WebAssembly.Instance(this.module, {});
    const e = instance.exports;
    if (e._initialize) e._initialize();
    if (e.sc_abi_version() !== 1) throw new Error(`sim-core ABI ${e.sc_abi_version()}, expected 1`);
    if (this.eeprom) {
      new Uint8Array(e.memory.buffer, e.sc_eeprom_ptr(), e.sc_eeprom_size()).set(this.eeprom);
    }
    const fault = e.sc_boot();
    if (fault) throw new Error(`sim-core boot fault ${fault}`);
    return e;
  }

  static #log(e) {
    const bytes = new Uint8Array(e.memory.buffer, e.sc_log_ptr_export(), e.sc_log_len_export());
    const text = new TextDecoder().decode(bytes);
    e.sc_log_clear_export();
    return text;
  }

  static #cli(e, line) {
    const bytes = new TextEncoder().encode(line);
    if (bytes.length > 255) throw new Error('CLI line longer than 255 bytes');
    new Uint8Array(e.memory.buffer, e.sc_scratch_ptr(), bytes.length).set(bytes);
    const rc = e.sc_cli_line(bytes.length);
    return { rc, output: SimCore.#log(e) };
  }

  #configInstance() {
    const e = this.#instantiate();
    e.sc_cli_begin();
    SimCore.#log(e);
    return e;
  }

  // Applies a Betaflight diff through Betaflight's own CLI, then saves. Every
  // input line gets exactly one result: applied, rejected (with the reason),
  // error (with Betaflight's message), or comment. A class diff starts from
  // factory defaults, so nothing from an earlier configure() carries over.
  configure(diffText, { fromDefaults = true } = {}) {
    if (fromDefaults) this.eeprom = null;
    const e = this.#configInstance();
    const loopHz = e.sc_loop_hz();
    const lines = [];
    String(diffText).split('\n').forEach((text, i) => {
      const verdict = classifyLine(text, { loopHz });
      const entry = { n: i + 1, text: text.replace(/\r$/, ''), status: verdict.status, msg: verdict.msg || '' };
      if (verdict.status === 'apply') {
        const { rc, output } = SimCore.#cli(e, verdict.line);
        if (rc === 1 || rc < 0) {
          entry.status = 'error';
          entry.msg = rc < 0 ? `sim-core rc ${rc}` : (output.match(/###ERROR[^\n]*/) || [output.trim()])[0];
        } else if (verdict.aux && !this.#auxEchoMatches(output, verdict.aux)) {
          // Betaflight keeps a stale mode for an unknown box id (cli/cli.c:1188-1228),
          // which on an unused slot is ARM. Clear the slot and report it.
          SimCore.#cli(e, auxLine(verdict.aux.index, 0, 0, 900, 900));
          entry.status = 'rejected';
          entry.msg = `Betaflight has no mode with permanent id ${verdict.aux.boxId}; slot ${verdict.aux.index} cleared`;
        } else {
          entry.status = 'applied';
          if (verdict.note) entry.msg = verdict.note;
          if (verdict.feature) entry.feature = verdict.feature;
        }
      }
      lines.push(entry);
    });

    const added = this.#addDefaultAux(e);
    this.rcmap = parseMapOutput(SimCore.#cli(e, 'map').output) || 'AETR1234';

    // Save: Betaflight writes the EEPROM image and asks for a reboot.
    SimCore.#cli(e, 'save');
    if (!e.sc_reboot_pending()) throw new Error('save did not request a reboot');
    this.eeprom = new Uint8Array(e.memory.buffer, e.sc_eeprom_ptr(), e.sc_eeprom_size()).slice();

    // Backstop: Betaflight clears features it was not built with at boot
    // (config/config.c). Read back what survived from a fresh instance.
    this.#checkFeatures(lines);

    const count = (s) => lines.filter((l) => l.status === s).length;
    return {
      lines, added, rcmap: this.rcmap, loopHz,
      applied: count('applied'), rejected: count('rejected'), errors: count('error'), comments: count('comment'),
    };
  }

  // The CLI first echoes the typed line, then prints the slot as Betaflight
  // resolved it (cli/cli.c:1232-1240). The last matching line is the result.
  #auxEchoMatches(output, aux) {
    const echo = parseAuxOutput(output).filter((a) => a.index === aux.index).at(-1);
    return !!echo && echo.boxId === aux.boxId && echo.channel === aux.channel;
  }

  // Default ARM/ANGLE/HORIZON/FLIP lines, only when there is no usable ARM
  // range, and only into free slots so the diff's own modes survive.
  #addDefaultAux(e) {
    const slots = parseAuxOutput(SimCore.#cli(e, 'aux').output);
    const used = (a) => a.low < a.high;
    if (slots.some((a) => used(a) && a.boxId === 0 && a.channel < AUX_CHANNELS)) return [];
    const free = [];
    for (let i = 0; i < MAX_AUX_SLOTS; i++) {
      const slot = slots.find((a) => a.index === i);
      if (!slot || !used(slot)) free.push(i);
    }
    const added = [];
    DEFAULT_AUX.forEach((d, k) => {
      if (k >= free.length) return;
      const line = auxLine(free[k], d.boxId, d.channel);
      const { rc, output } = SimCore.#cli(e, line);
      added.push({ text: line, status: rc === 0 ? 'added' : 'error', msg: rc === 0 ? 'no usable ARM range in the diff' : output.trim() });
    });
    return added;
  }

  #checkFeatures(lines) {
    const featureLines = lines.filter((l) => l.status === 'applied' && l.feature);
    if (!featureLines.length) return;
    const e = this.#configInstance();
    const enabled = parseFeatureOutput(SimCore.#cli(e, 'feature').output);
    for (const l of featureLines) {
      if (enabled.has(l.feature.name) !== l.feature.enable) {
        l.status = 'rejected';
        l.msg = `Betaflight ${l.feature.enable ? 'cleared' : 'kept'} feature ${l.feature.name} at boot (not supported by this build)`;
      }
    }
  }

  // Fresh flight instance from the saved image, ticked until Betaflight has no
  // arming-disable flag left (sticks centred, throttle low, aux low).
  boot() {
    const e = this.#instantiate();
    if (e.sc_rx_rate(this.rxHz) !== 0) throw new Error(`rx rate ${this.rxHz} Hz not allowed for this build`);
    this.flight = e;
    this.flightLog = SimCore.#log(e);
    const start = e.sc_time();
    let ticks = 0;
    while (this.state().armingDisableFlags !== 0) {
      if (e.sc_time() - start >= BOOT_CAP_US) {
        throw new Error(`boot did not reach arm-ready, flags 0x${this.state().armingDisableFlags.toString(16)}`);
      }
      ticks += e.sc_step(BOOT_CHUNK_TICKS);
      if (e.sc_fault_code()) throw new Error(`fault ${e.sc_fault_code()} during boot`);
    }
    return { ticks, simTimeUs: e.sc_time() };
  }

  get simTimeUs() {
    return this.flight.sc_time();
  }

  get loopHz() {
    return this.flight ? this.flight.sc_loop_hz() : 0;
  }

  get pgMissing() {
    return this.flight.sc_pg_missing();
  }

  // Sticks: roll, pitch, yaw in -1..1, throttle 0..1 (rounded to whole
  // channel steps). aux: integers 1000..2000 for AUX1..AUX12. tUs: whole
  // microseconds of sim time, by default the next tick.
  input({ roll = 0, pitch = 0, yaw = 0, throttle = 0 } = {}, aux = [], tUs = this.simTimeUs) {
    if (!Number.isInteger(tUs) || tUs < 0) throw new Error(`input time ${tUs} is not whole microseconds`);
    if (aux.length > AUX_CHANNELS) throw new Error(`at most ${AUX_CHANNELS} aux channels`);
    for (const v of aux) {
      if (!Number.isInteger(v) || v < 1000 || v > 2000) throw new Error(`aux value ${v} is not an integer in 1000..2000`);
    }
    for (const [k, v] of Object.entries({ roll, pitch, yaw, throttle })) {
      if (!Number.isFinite(v)) throw new Error(`stick ${k} is not finite`);
    }
    const auxAt = (k) => (k < aux.length ? aux[k] : 1000);
    const value = {
      A: Math.round(1500 + 500 * clamp(roll, -1, 1)),
      E: Math.round(1500 + 500 * clamp(pitch, -1, 1)),
      R: Math.round(1500 + 500 * clamp(yaw, -1, 1)),
      T: Math.round(1000 + 1000 * clamp(throttle, 0, 1)),
      1: auxAt(0), 2: auxAt(1), 3: auxAt(2), 4: auxAt(3),
    };
    const ch = new Uint16Array(16);
    for (let raw = 0; raw < 8; raw++) ch[raw] = value[this.rcmap[raw]];
    for (let k = 4; k < AUX_CHANNELS; k++) ch[4 + k] = auxAt(k);
    const e = this.flight;
    new Uint16Array(e.memory.buffer, e.sc_scratch_ptr(), 16).set(ch);
    const rc = e.sc_input(tUs, 16);
    if (rc !== 0) throw new Error(`sc_input rc ${rc}`);
  }

  link(up) {
    this.flight.sc_rx_link_export(up ? 1 : 0);
  }

  step(ticks) {
    const ran = this.flight.sc_step(ticks);
    const fault = this.flight.sc_fault_code();
    if (fault) throw new Error(`sim-core fault ${fault}`);
    return ran;
  }

  // The whole state block as bytes, for trace hashes.
  stateBytes() {
    const e = this.flight;
    return new Uint8Array(e.memory.buffer, e.sc_state(), STATE_DOUBLES * 8).slice();
  }

  state() {
    const e = this.flight;
    const s = new Float64Array(e.memory.buffer, e.sc_state(), STATE_DOUBLES);
    const at = (k, n) => Array.from(s.subarray(STATE[k], STATE[k] + n));
    return {
      tUs: s[STATE.tUs],
      armed: s[STATE.armed] === 1,
      armingDisableFlags: s[STATE.armingDisableFlags],
      flightModeFlags: s[STATE.flightModeFlags],
      failsafePhase: s[STATE.failsafePhase],
      motorDshot: at('motorDshot', 4),
      motorsEnabled: s[STATE.motorsEnabled] === 1,
      motorMix: at('motorMix', 4),
      setpoint: at('setpoint', 3),
      gyroFiltered: at('gyroFiltered', 3),
      rcCommand: at('rcCommand', 4),
      rcData: at('rcData', 4),
      rcAux: at('rcAux', 4),
      bfVbat: s[STATE.bfVbat],
      bfCells: s[STATE.bfCells],
      bfAmps: s[STATE.bfAmps],
      rxSignal: s[STATE.rxSignal] === 1,
      attitude: at('attitude', 3),
    };
  }
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
