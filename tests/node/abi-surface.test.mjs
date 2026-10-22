// B3/B4 and the ABI surface: the module imports nothing, exports exactly the
// committed list, has every export of the plan's ABI table that does not wait
// for the M4 plant (and none of those that do, so sim-core.js's "arrives with
// M4" errors are true), every Betaflight setting has an owning parameter
// group, and boot passes its asserts.
//
//   node tests/node/abi-surface.test.mjs            # check
//   node tests/node/abi-surface.test.mjs --update   # rewrite the allow-list
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { SimCore } from '../../src/js/sim-core.js';

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
for (const n of PLAN_NOW) assert.ok(names.has(n), `plan export ${n} present`);
for (const n of PLAN_M4) assert.ok(!names.has(n), `${n} waits for the M4 plant`);

const core = await SimCore.load(module);
core.configure('');
assert.equal(core.pgMissing, 0, 'every setting has an owning parameter group');
assert.equal(core.fault, 0, 'boot asserts hold');
console.log(`abi-surface: 0 imports, ${exports.length} exports, ${PLAN_NOW.length} plan exports present, ${PLAN_M4.length} M4 exports absent (${PLAN_M4.join(' ')}), loop ${core.loopHz} Hz, PG coverage complete: PASS`);
