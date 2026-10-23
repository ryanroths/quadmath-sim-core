// Where the owner's flight logs live. Logs stay out of git: the tools read
// them from SIM_CORE_LOGS (default D:\IGOW6\sim-core, the owner's folder), and
// only what they derive is committed (tests/reference/).
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export const LOGS_DIR = process.env.SIM_CORE_LOGS || 'D:/IGOW6/sim-core';

// A log given as a path that exists is used as it is; a bare name, or a
// relative path that does not exist here, is looked up in LOGS_DIR.
export function logPath(name) {
  if (isAbsolute(name) || existsSync(name)) return resolve(name);
  return join(LOGS_DIR, name);
}
