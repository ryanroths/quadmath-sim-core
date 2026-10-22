// B3/B4 and the ABI surface: the module imports nothing, exports exactly the
// committed list, every Betaflight setting has an owning parameter group, and
// boot passes its asserts.
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

const core = await SimCore.load(module);
core.configure('');
core.boot();
assert.equal(core.pgMissing, 0, 'every setting has an owning parameter group');
console.log(`abi-surface: 0 imports, ${exports.length} exports, loop ${core.loopHz} Hz, PG coverage complete: PASS`);
