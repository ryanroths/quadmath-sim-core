// Exports quadmath's map collider boxes as test fixtures for P5 (ground
// clearance), by running quadmath's own map builders in Node:
//   - buildMap(THREE, id) for every id in MAP_IDS (sim-maps.js:215, 1033)
//   - installCityExploreColliders(THREE, colliders) (sim-maps.js:1199)
// The city's base buildings are built inline in sim.html, which needs a
// browser page; they are not exported here.
//
//   QUADMATH_DIR=~/webfpv-phase0/quadmath-origin-main \
//   THREE_MODULE=<three.module.js 0.160.0> node scripts/export-map-colliders.mjs
//
// THREE_MODULE defaults to the Phase 0 CDN cache (%TEMP%/webfpv-cdn), which
// holds three@0.160.0 build/three.module.js, the version sim.html loads.
// Writes tests/fixtures/maps/<id>.json: each box in quadmath's world units (as
// built) and in module-frame micrometres (what sim-core's ABI takes).
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WS = 3.5;   // world units per metre (sim.html:3090)
const root = fileURLToPath(new URL('..', import.meta.url));
const dir = process.env.QUADMATH_DIR || join(homedir(), 'webfpv-phase0', 'quadmath-origin-main');
const rev = readFileSync(join(dir, 'REV'), 'utf8').trim();

function findThree() {
  if (process.env.THREE_MODULE) return process.env.THREE_MODULE;
  const cache = join(tmpdir(), 'webfpv-cdn');
  for (const f of readdirSync(cache)) {
    const p = join(cache, f);
    if (/const REVISION = '160';/.test(readFileSync(p, 'utf8').slice(0, 400))) return p;
  }
  throw new Error('three.module.js 0.160.0 not found; set THREE_MODULE');
}

// Canvas textures are only drawn for looks; a stub canvas whose 2D context
// accepts every call lets the builders run without a DOM.
const ctx = new Proxy(function () {}, {
  get: (_, k) => (k === 'measureText' ? () => ({ width: 0 }) : ctx),
  apply: () => ctx,
  set: () => true,
});
globalThis.document = { createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => ctx }) };

const threePath = findThree();
const threeSha = createHash('sha256').update(readFileSync(threePath)).digest('hex');
// Load three from a .mjs copy so Node treats it as an ES module.
const tmp = mkdtempSync(join(tmpdir(), 'sim-core-three-'));
copyFileSync(threePath, join(tmp, 'three.module.mjs'));
const THREE = await import(pathToFileURL(join(tmp, 'three.module.mjs')).href);
const maps = await import(pathToFileURL(join(dir, 'sim-maps.js')).href);

function exportBoxes(id, boxes, how) {
  const out = [];
  for (const b of boxes) {
    if (!b || !b.min || !b.max || !(b.min.x <= b.max.x && b.min.y <= b.max.y && b.min.z <= b.max.z)) continue;
    const world = [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z];
    // module x = -world z / WS, y = -world x / WS, z = world y / WS (sim.html:3105)
    const um = [-b.max.z / WS, -b.max.x / WS, b.min.y / WS, -b.min.z / WS, -b.min.x / WS, b.max.y / WS]
      .map((m) => Math.round(m * 1e6));
    out.push({ world, um });
  }
  const file = {
    map: id,
    source: `quadmath ${rev} sim-maps.js ${how}, three ${THREE.REVISION} (sha256 ${threeSha})`,
    ws: WS,
    count: out.length,
    boxes: out,
  };
  mkdirSync(join(root, 'tests', 'fixtures', 'maps'), { recursive: true });
  writeFileSync(join(root, 'tests', 'fixtures', 'maps', `${id}.json`), `${JSON.stringify(file)}\n`);
  console.log(`${id.padEnd(14)} ${String(out.length).padStart(5)} boxes (${boxes.length - out.length} empty skipped)`);
}

for (const id of maps.MAP_IDS) {
  const built = maps.buildMap(THREE, id);
  exportBoxes(id, built.colliders, `buildMap('${id}')`);
}
const explore = [];
maps.installCityExploreColliders(THREE, explore);
exportBoxes('city-explore', explore, 'installCityExploreColliders');
