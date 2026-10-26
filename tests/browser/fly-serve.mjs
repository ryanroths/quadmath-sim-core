// npm run fly: serves the repo root to 127.0.0.1 and prints the fly
// harness's address. 127.0.0.1 is a secure context, which the Gamepad API
// needs. PORT picks the port (default 8642).
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import { fileURLToPath } from 'node:url';
import { serve } from './chrome.mjs';

const port = Number(process.env.PORT || 8642);
const server = await serve(fileURLToPath(new URL('../../', import.meta.url)), { port });
console.log(`fly: ${server.url}tests/browser/fly.html   (Ctrl+C stops)`);
console.log('TX16S: plug in USB, pick Joystick on the radio, then move a stick in the page.');
