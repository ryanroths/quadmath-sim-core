// Prints the Air65 values that come out of quadmath's own functions, so the
// airframe file (airframes/air65.json) can commit them as literals, as the
// Phase 1 plan asks ("physicsFromBuild ... is run once and its outputs are
// committed as literal tables"). Run against quadmath origin/main de9b15d:
//
//   QUADMATH_DIR=~/webfpv-phase0/quadmath-origin-main node scripts/derive-air65.mjs
//
// Reads quadmath's modules; writes nothing. Bench inputs come from
// data/bench/air65-analog-vci0702-30k.json in the same tree.
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = process.env.QUADMATH_DIR || join(homedir(), 'webfpv-phase0', 'quadmath-origin-main');
const rev = readFileSync(join(dir, 'REV'), 'utf8').trim();
const load = (f) => import(pathToFileURL(join(dir, f)).href);
const build = await load('sim-build.js');
const whoop = await load('sim-whoop.js');
const qp = await load('quadphysics.js');
const bench = JSON.parse(readFileSync(join(dir, 'data/bench/air65-analog-vci0702-30k.json'), 'utf8'));

const preset = build.BUILD_PRESETS.air65;
const phys = build.physicsFromBuild(preset);
const pack = build.batteryFromBuild(preset);
// whoopScale and the ground cushion on the preset build. They cannot take the
// bench AUW (25.42 g): both call normalizeBuild, which rounds AUW to 0.1 g
// (sim-build.js:62), so the preset's 25.4 g is what quadmath's own functions
// give.
const scale = whoop.whoopScale(preset);
const groundK = whoop.whoopGroundK(preset, whoop.DEFAULT_WHOOP);
const F = qp.FLOATINESS_DEFAULT;
const cdMul = 1.85 - 0.85 * F;            // quadphysics.js setFloatiness
const userDragMul = phys.drag / 0.55;     // sim.html applyCfgToQp: (CFG.drag || 0.55) / 0.55
const area = (phys.preset.propDiameter / 0.031) ** 2;

const out = {
  quadmath: rev,
  physicsFromBuild: {
    maxThrustPerMotor: phys.preset.maxThrustPerMotor,
    motorTau: phys.preset.motorTau,
    kQ: phys.preset.kQ,
    drag: phys.drag,
    wheelbase: phys.preset.wheelbase,
    propDiameter: phys.preset.propDiameter,
    twrAtPresetMass: phys.twr,
  },
  batteryFromBuild: pack,
  floatiness: { F, cdMul, spoolTauMul: 0.73, spoolDownMul: 1.40 },
  drag: {
    userDragMul,
    cdAFront: 0.0054 * area * cdMul * userDragMul,
    cdAPlan: 0.0060 * area * cdMul * userDragMul,
  },
  whoopScale: scale,
  groundK,
  constants: { G: 9.81, AIR_DENSITY: qp.AIR_DENSITY, FLOOR_CLEARANCE_M: qp.FLOOR_CLEARANCE_M },
  motorTauUp: phys.preset.motorTau * 0.73,
  bench: { auw_g: bench.auw_g, motor_kv: bench.motor_kv, capacity_mah: bench.pack.capacity_mah },
};
console.log(JSON.stringify(out, (k, v) => (typeof v === 'number' ? Number(v.toPrecision(17)) : v), 2));
