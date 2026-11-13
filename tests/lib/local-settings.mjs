// One machine's settings for the tests: local-settings.json at the repo root,
// gitignored (local-settings.example.json shows the keys). An environment
// variable, where a setting has one, wins over the file, so CI keeps setting
// its own paths.
//
//   webfpvDir   the WebFPV clone (env WEBFPV_DIR; tests/lib/webfpv.mjs)
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOCAL_SETTINGS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'local-settings.json');

export function localSetting(key) {
  if (!existsSync(LOCAL_SETTINGS)) return undefined;
  let all;
  try {
    all = JSON.parse(readFileSync(LOCAL_SETTINGS, 'utf8'));
  } catch (e) {
    throw new Error(`${LOCAL_SETTINGS} is not valid JSON: ${e.message}`);
  }
  const value = all[key];
  if (value !== undefined && typeof value !== 'string') {
    throw new Error(`${LOCAL_SETTINGS}: ${key} must be a string`);
  }
  return value || undefined;
}
