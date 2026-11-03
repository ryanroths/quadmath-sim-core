// Prints the Fractal75 values that come out of quadmath's own functions, so
// the airframe file (airframes/fractal75.json) can commit them as literals, as
// scripts/derive-air65.mjs does for the Air65. quadmath gained the Fractal75
// build preset after de9b15d (the Air65's pin), so this runs against quadmath
// origin/main 992a046:
//
//   QUADMATH_DIR=<quadmath clone at 992a046> node scripts/derive-fractal75.mjs
//
// Reads quadmath's modules; writes nothing. Bench inputs come from
// data/bench/fractal75-analog-rcinpower0802-25k.json in the same tree
// (provisional: kitchen-scale AUW, current sensor uncalibrated).
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = process.env.QUADMATH_DIR;
if (!dir) {
  console.error('usage: QUADMATH_DIR=<quadmath clone> node scripts/derive-fractal75.mjs');
  process.exit(2);
}
const rev = existsSync(join(dir, 'REV'))
  ? readFileSync(join(dir, 'REV'), 'utf8').trim()
  : execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
const load = (f) => import(pathToFileURL(join(dir, f)).href);
const build = await load('sim-build.js');
const whoop = await load('sim-whoop.js');
const qp = await load('quadphysics.js');
const bench = JSON.parse(readFileSync(join(dir, 'data/bench/fractal75-analog-rcinpower0802-25k.json'), 'utf8'));

const preset = build.BUILD_PRESETS.fractal75;
const phys = build.physicsFromBuild(preset);
const pack = build.batteryFromBuild(preset);
// whoopScale and the ground cushion on the preset build (35.7 g: quadmath's
// normalizeBuild rounds AUW to 0.1 g), as the Air65's derive does.
const scale = whoop.whoopScale(preset);
const groundK = whoop.whoopGroundK(preset, whoop.DEFAULT_WHOOP);
const F = qp.FLOATINESS_DEFAULT;
const cdMul = 1.85 - 0.85 * F;            // quadphysics.js setFloatiness
const userDragMul = phys.drag / 0.55;     // sim.html applyCfgToQp: (CFG.drag || 0.55) / 0.55
// aeroCoeffs takes the drag multipliers itself at 992a046 (quadphysics.js
// aeroCoeffs: cdMul x userDragMul on the CdA terms, aeroBMul on aeroB, aeroC).
const aero = qp.aeroCoeffs({ propDiameter: phys.preset.propDiameter, cdMul, userDragMul, aeroBMul: cdMul });

const out = {
  quadmath: rev,
  preset,
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
  aeroCoeffs: aero,
  drag: { userDragMul, cdAFront: aero.cdAxy, cdAPlan: aero.cdAz },
  whoopScale: scale,
  groundK,
  constants: { G: 9.81, AIR_DENSITY: qp.AIR_DENSITY, FLOOR_CLEARANCE_M: qp.FLOOR_CLEARANCE_M, REVERSE_THRUST_SCALE: qp.REVERSE_THRUST_SCALE },
  motorTauUp: phys.preset.motorTau * 0.73,
  bench: {
    auw_g: bench.auw_g, motor: bench.motor, motor_kv: bench.motor_kv, prop: bench.prop,
    battery: bench.battery, capacity_mah: bench.packs['wbf-450'].capacity_mah, source: bench.source,
  },
};
console.log(JSON.stringify(out, (k, v) => (typeof v === 'number' ? Number(v.toPrecision(17)) : v), 2));
