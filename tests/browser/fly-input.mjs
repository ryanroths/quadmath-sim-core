// The fly harness's input path: a gamepad snapshot to RC channels, the
// sim-time stamp each 4 ms poll goes into sim-core's input ring with, and
// when the radio link to Betaflight is up.
//
// Channels are the radio's, 1:1 (PROGRESS.md, Phase 1 plan: "a TX16S in
// joystick mode is a radio"): sticks at 1500 + 500 x stick, throttle at
// 1000 + 1000 x throttle, aux channels at 1500 + 500 x the axis as the radio
// sends it. AUX1, AUX2, ... are the axes the sticks do not use, in order (a
// TX16S's CH5.. on axes 4..); a calibrated arm switch swaps into AUX1 and a
// mode switch into AUX2, and every other channel keeps its place.
//
// Stamps: polls run on a 4 ms timer between animation frames, so each is
// stamped with the sim time its wall time corresponds to (PROGRESS.md, plan
// decision 9). After each frame's advance(), the frame's wall time maps to
// simTimeUs + alpha x tickUs; a poll w ms later is that plus w ms. Stamps
// ahead of the sim wait in the ring for their RX tick, so Betaflight sees a
// new sample on every 250 Hz RX frame, not once a frame.
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import { applyAxisMap } from './fly-radio.mjs';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const AUX_CHANNELS = 12;
const us = (v) => Math.round(clamp(1500 + 500 * v, 1000, 2000));

function axisValue(gp, i) {
  const v = gp && gp.axes ? Number(gp.axes[i]) : NaN;
  return Number.isFinite(v) ? v : 0;
}

function buttonValue(gp, i) {
  const b = gp && gp.buttons ? gp.buttons[i] : null;
  return b && (b.pressed || b.value > 0.5) ? 1 : -1;
}

const isSource = (s) => !!s && (Number.isFinite(s.i) || Number.isFinite(s.button));

// The source of AUX1, AUX2, ...: { i } an axis, { button } a button, null
// none (the channel stays at 1000).
export function auxSources(map, axisCount) {
  const sticks = new Set(['r', 'p', 'y', 't'].map((k) => map[k] && map[k].i));
  const slots = [];
  for (let i = 0; i < axisCount; i++) if (!sticks.has(i)) slots.push({ i });
  ['arm', 'mode'].forEach((k, at) => {
    const src = map[k];
    if (!isSource(src)) return;
    while (slots.length <= at) slots.push(null);
    const from = Number.isFinite(src.i) ? slots.findIndex((s) => s && s.i === src.i) : -1;
    if (from >= 0) [slots[at], slots[from]] = [slots[from], slots[at]];
    else {
      if (slots[at]) slots.push(slots[at]);
      slots[at] = Number.isFinite(src.i) ? { i: src.i } : { button: src.button };
    }
  });
  return slots.slice(0, AUX_CHANNELS);
}

// 16 channels for core.input(): roll, pitch, yaw, throttle, AUX1..AUX12,
// integers 1000..2000.
export function channelsFrom(gp, map) {
  const s = applyAxisMap(gp.axes, map);
  const ch = new Array(4 + AUX_CHANNELS).fill(1000);
  ch[0] = us(s.r);
  ch[1] = us(s.p);
  ch[2] = us(s.y);
  ch[3] = Math.round(1000 + 1000 * clamp(s.t, 0, 1));
  auxSources(map, gp.axes ? gp.axes.length : 0).forEach((src, k) => {
    if (src) ch[4 + k] = us(Number.isFinite(src.button) ? buttonValue(gp, src.button) : axisValue(gp, src.i));
  });
  return ch;
}

// Sim-time stamps for polls. horizonUs caps how far ahead of the sim a stamp
// may go: past it (the frames stopped, a hidden tab) a poll is dropped, so
// the ring never fills while the sim waits. Stamps never go backwards.
export class InputClock {
  constructor({ horizonUs = 100_000 } = {}) {
    this.horizonUs = horizonUs;
    this.rebase();
  }

  // After a reinit() (a new instance: its clock and ring start over).
  rebase() {
    this.anchorWallMs = null;
    this.anchorSimUs = 0;
    this.lastUs = -1;
  }

  // Call after each frame's advance(), with that frame's wall time.
  anchor(core, wallMs) {
    this.anchorWallMs = wallMs;
    this.anchorSimUs = core.simTimeUs + core.alpha * core.tickUs;
  }

  // The stamp for a poll at wallMs, or null to drop it.
  stamp(core, wallMs) {
    const now = core.simTimeUs;
    const want = this.anchorWallMs === null ? now : this.anchorSimUs + (wallMs - this.anchorWallMs) * 1000;
    const t = Math.max(Math.round(want), now, this.lastUs);
    if (t > now + this.horizonUs) return null;
    this.lastUs = t;
    return t;
  }
}

// The radio link to Betaflight. It is down while there is no radio and while
// the wizard runs, and after every boot (configure, reinit), which runs on
// sim-core's neutral frame with the aux channels low. It comes up again only
// once Betaflight has noticed the loss (rxSignal false) and a real radio
// sample has reached the ring's RX frame, so the first frame Betaflight gets
// back is the radio's. Betaflight's own guard then sees the arm switch where
// it really is: switched on, it needs a cycle (NOT_DISARMED), as on the real
// quad when its radio link comes back; nothing here arms or refuses to.
export class RadioLink {
  constructor(core) {
    this.attach(core);
  }

  // A fresh instance (after configure or reinit): its link starts up.
  attach(core) {
    this.core = core;
    this.up = true;
    this.drop();
  }

  drop() {
    if (this.up) this.core.link(false);
    this.up = false;
    this.liveUs = null;
  }

  // A radio sample went into the ring at stampUs.
  sample(stampUs) {
    if (this.liveUs === null) this.liveUs = stampUs;
  }

  // Each frame: want is whether there is a radio to fly from.
  update(want) {
    if (!want) {
      this.drop();
      return;
    }
    if (this.up || this.liveUs === null) return;
    const rxUs = 1e6 / this.core.rxHz;
    if (this.core.simTimeUs >= this.liveUs + rxUs && !this.core.fc.rxSignal) {
      this.core.link(true);
      this.up = true;
    }
  }
}
