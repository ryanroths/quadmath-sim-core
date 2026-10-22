// The WebFPV reference for black-box tests, read from a local WebFPV clone at
// the commit Phase 0 pinned. Nothing of WebFPV is copied into this repo: the
// tests load its module and its config files from the clone, check the
// module's sha256, and drive it only through its exported ABI
// (WebFPV src/native/sim_abi.h, plus the sim_bf_* readouts in
// src/native/bf/bf_glue.c).
//
//   WEBFPV_DIR   the clone (default ~/webfpv-upstream)
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const WEBFPV_COMMIT = '518846c';
export const WEBFPV_WASM_SHA256 = '08e995cb51e0cb95dc737daf4c5d57cce22c4959546fbdf234aa90ebea18ff69';

export function webfpvDir() {
  const dir = process.env.WEBFPV_DIR || join(homedir(), 'webfpv-upstream');
  if (!existsSync(join(dir, '.git'))) {
    throw new Error(`WebFPV clone not found at ${dir}. Clone https://github.com/Mathew-Harvey/WebFPVSimulator `
      + `there (it needs commit ${WEBFPV_COMMIT}) or set WEBFPV_DIR.`);
  }
  return dir;
}

// A file as it is at the pinned commit, whatever the clone has checked out.
export function readPinned(path, encoding = 'utf8') {
  const out = execFileSync('git', ['-C', webfpvDir(), 'show', `${WEBFPV_COMMIT}:${path}`], { maxBuffer: 16 << 20 });
  return encoding ? out.toString(encoding) : out;
}

export async function loadWebfpvModule() {
  const bytes = readPinned('dist/sim.wasm', null);
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== WEBFPV_WASM_SHA256) throw new Error(`WebFPV dist/sim.wasm is ${sha}, expected ${WEBFPV_WASM_SHA256}`);
  return WebAssembly.compile(bytes);
}

// One WebFPV instance, initialised from a diff and reset (armed, airmode on,
// t = 0 after its own 2.6 s receiver warm-up). Sticks per its ABI: roll,
// pitch, yaw in -1..1 with +pitch nose up, throttle 0..1; it inverts pitch
// into rcData itself, so rcData[PITCH] = 1500 - 500 * pitch.
export class WebFpv {
  constructor(module, diff) {
    const e = new WebAssembly.Instance(module, { env: { emscripten_notify_memory_growth() {} } }).exports;
    e._initialize();
    this.e = e;
    const bytes = new TextEncoder().encode(diff);
    const p = e.malloc(bytes.length + 1);
    new Uint8Array(e.memory.buffer, p, bytes.length).set(bytes);
    const init = e.sim_init(p, bytes.length);
    e.free(p);
    if (init !== 0) throw new Error(`WebFPV sim_init ${init}`);
    if (e.sim_reset() !== 0) throw new Error('WebFPV sim_reset');
  }

  // One RC frame, as Betaflight channel values: the inverse of its ABI mapping.
  frame(tSeconds, [roll, pitch, yaw, throttle]) {
    const rc = this.e.sim_input(tSeconds, (roll - 1500) / 500, -(pitch - 1500) / 500, (yaw - 1500) / 500, (throttle - 1000) / 1000);
    if (rc !== 0) throw new Error(`WebFPV sim_input ${rc}`);
  }

  step(n = 1) {
    if (this.e.sim_step(n) !== 0) throw new Error('WebFPV sim_step');
  }

  // getSetpointRate(axis), through sim_bf_debug slots 5 (roll), 8 (pitch), 0 (yaw).
  setpoint(axis) {
    return this.e.sim_bf_debug([5, 8, 0][axis]);
  }

  // Applied, inert and unknown key counts of its settings table.
  counts() {
    const d = this.e.sim_bf_debug;
    return { applied: d(13), inert: d(14), unknown: d(15), table: d(16) };
  }

  #string(fn, cap = 65536) {
    const out = this.e.malloc(cap);
    const n = fn(out, cap);
    const text = n < 0 ? undefined : new TextDecoder().decode(new Uint8Array(this.e.memory.buffer, out, n));
    this.e.free(out);
    return text;
  }

  // Every key of its settings table, in table order.
  keys() {
    return this.#string((o, c) => this.e.sim_bf_dump(o, c))
      .split('\n').filter((l) => l.startsWith('set ')).map((l) => l.slice(4).split(' = ')[0]);
  }

  get(key) {
    const k = new TextEncoder().encode(`${key}\0`);
    const kp = this.e.malloc(k.length);
    new Uint8Array(this.e.memory.buffer, kp, k.length).set(k);
    const value = this.#string((o, c) => this.e.sim_bf_get(kp, o, c), 256);
    this.e.free(kp);
    return value;
  }
}
