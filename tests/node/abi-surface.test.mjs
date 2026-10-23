// B3/B4 and the ABI surface: the module imports nothing, exports exactly the
// committed list, has every export of the plan's ABI table (the M4 plant and
// world ones included), every Betaflight setting has an owning parameter
// group, and boot passes its asserts. The plant block (frozen at M4) and its
// derived readout are laid out in sim-core.js exactly as src/plant/plant.h
// numbers them.
//
//   node tests/node/abi-surface.test.mjs            # check
//   node tests/node/abi-surface.test.mjs --update   # rewrite the allow-list
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { PLANT_FIELDS, SimCore, plantBlock } from '../../src/js/sim-core.js';

const root = new URL('../../', import.meta.url);
const listUrl = new URL('tests/node/abi-exports.json', root);
const module = await WebAssembly.compile(await readFile(new URL('dist/sim-core.wasm', root)));

const imports = WebAssembly.Module.imports(module);
const exports = WebAssembly.Module.exports(module).map((e) => `${e.name}:${e.kind}`).sort();
assert.deepEqual(imports, [], 'the module imports nothing from JS');

if (process.argv.includes('--update')) {
  await writeFile(listUrl, `${JSON.stringify(exports, null, 1)}\n`);
  console.log(`abi-surface: wrote ${exports.length} exports`);
} else {
  const allowed = JSON.parse(await readFile(listUrl, 'utf8'));
  assert.deepEqual(exports, allowed, 'exports match tests/node/abi-exports.json');
}

// The plan's ABI table (PROGRESS.md, Phase 1 plan, "C exports").
const PLAN_NOW = ['sc_abi_version', 'sc_boot', 'sc_eeprom_ptr', 'sc_eeprom_size', 'sc_cli_enter', 'sc_cli_line',
  'sc_cli_log_ptr', 'sc_cli_log_len', 'sc_cli_log_clear', 'sc_reboot_requested', 'sc_battery_carry', 'sc_input',
  'sc_rx_link', 'sc_set_rx_rate', 'sc_step', 'sc_state_ptr', 'sc_fc_ptr', 'sc_events_ptr', 'sc_events_len',
  'sc_events_clear', 'sc_fault'];
const PLAN_M4 = ['sc_plant_set', 'sc_world_clear', 'sc_world_floor', 'sc_world_box', 'sc_world_trigger', 'sc_pose'];
const names = new Set(WebAssembly.Module.exports(module).map((e) => e.name));
for (const n of [...PLAN_NOW, ...PLAN_M4]) assert.ok(names.has(n), `plan export ${n} present`);

// Plant block v1: every airframe name against its PB_ index in plant.h.
const header = await readFile(new URL('src/plant/plant.h', root), 'utf8');
const enumOf = (prefix) => Object.fromEntries([...header.matchAll(new RegExp(`\\b${prefix}_(\\w+) = (\\d+)`, 'g'))].map((m) => [m[1], Number(m[2])]));
const PB = enumOf('PB');
const PD = enumOf('PD');
const PB_NAME = {
  model: 'MODEL', mass: 'MASS', wheelbase: 'WHEELBASE', boxHeightRatio: 'BOX_HEIGHT_RATIO', propDiameter: 'PROP_DIAMETER',
  kv: 'KV', vRefCell: 'V_REF_CELL', loadFraction: 'LOAD_FRACTION', tmax: 'TMAX', kqRatio: 'KQ_RATIO', tau: 'TAU',
  tauDownMult: 'TAU_DOWN_MULT', reverseScale: 'REVERSE_SCALE', cdAFront: 'CDA_FRONT', cdAPlan: 'CDA_PLAN', skinB: 'SKIN_B',
  aeroB: 'AERO_B', aeroC: 'AERO_C', discK: 'DISC_K', discEnd: 'DISC_END', groundK: 'GROUND_K', gravity: 'GRAVITY',
  airDensity: 'AIR_DENSITY', cells: 'CELLS', capacityMah: 'CAPACITY_MAH', cellIR: 'CELL_IR', iRef: 'I_REF', ocv: 'OCV',
  sagDrop: 'SAG_DROP', hoverSeconds: 'HOVER_SECONDS', sagScale: 'SAG_SCALE', bounceScale: 'BOUNCE_SCALE',
  crashScale: 'CRASH_SCALE', spinScale: 'SPIN_SCALE', ductOuterRadius: 'DUCT_RADIUS', hullBelow: 'HULL_BELOW',
  hullAbove: 'HULL_ABOVE', iRefDuty: 'I_REF_DUTY',
};
assert.deepEqual([...PLANT_FIELDS].sort(), Object.keys(PB_NAME).sort(), 'every airframe field has a PB_ name');
assert.equal(Object.keys(PB).length, PLANT_FIELDS.length + 1, 'plant.h has a PB_ entry per field, plus PB_LEN');
const probe = { id: 'probe', model: 'parity', values: {} };
for (const name of PLANT_FIELDS) {
  if (name === 'model') continue;
  const at = PB[PB_NAME[name]];
  assert.ok(Number.isInteger(at), `PB_${PB_NAME[name]} in plant.h`);
  probe.values[name] = { value: name === 'ocv' ? [0, 1, 2, 3, 4, 5, 6].map((k) => at + k) : at };
}
const block = plantBlock(probe);
assert.equal(block.length, PB.LEN, 'block length is PB_LEN');
block.forEach((v, k) => {
  if (k !== PB.MODEL) assert.equal(v, k, `plant block slot ${k} carries the field plant.h puts there`);
});
assert.equal(block[PB.MODEL], 2, 'model slot');
assert.equal(PB.OCV + 7, PB.SAG_DROP, 'ocv fills seven slots');

const core = await SimCore.load(module);
core.configure('');
// Derived readout: plantDerived names in PD_ order.
const derivedNames = Object.keys(core.plantDerived);
const PD_NAME = {
  kvRad: 'KV_RAD', ktMotor: 'KT_MOTOR', omegaFull: 'OMEGA_FULL', ktProp: 'KT_PROP', kqProp: 'KQ_PROP', rWinding: 'R_WINDING',
  jRotor: 'J_ROTOR', omegaHover: 'OMEGA_HOVER', dutyHover: 'DUTY_HOVER', ixx: 'IXX', iyy: 'IYY', izz: 'IZZ', arm: 'ARM',
  dutyCurrentRef: 'DUTY_CURRENT_REF',
};
assert.equal(derivedNames.length, PD.LEN, 'plantDerived has PD_LEN names');
assert.equal(core.flight.sc_plant_derived_len(), PD.LEN, 'sc_plant_derived_len is PD_LEN');
derivedNames.forEach((n, k) => assert.equal(PD[PD_NAME[n]], k, `plantDerived '${n}' is PD_${PD_NAME[n]}`));
assert.equal(core.pgMissing, 0, 'every setting has an owning parameter group');
assert.equal(core.fault, 0, 'boot asserts hold');
console.log(`abi-surface: 0 imports, ${exports.length} exports, ${PLAN_NOW.length} plan exports and ${PLAN_M4.length} M4 plant exports present, plant block ${PB.LEN} and derived ${PD.LEN} in plant.h order, loop ${core.loopHz} Hz, PG coverage complete: PASS`);
