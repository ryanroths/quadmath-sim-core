// Headless Chrome for the browser tests, with no dependencies: a static file
// server bound to 127.0.0.1 for the repo root, Chrome started headless with a
// throwaway profile, and a small DevTools-protocol client over Node's
// built-in WebSocket that records every console message, exception and log
// entry the page produces.
//
//   CHROME_PATH   the Chrome binary, if not in a standard place
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.diff': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

// Serves files under root to 127.0.0.1 only; nothing outside root. Port 0
// takes any free port.
export async function serve(root, { port = 0 } = {}) {
  const base = normalize(root.endsWith(sep) ? root : root + sep);
  const server = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      const file = normalize(join(base, path));
      if (req.method !== 'GET' || !file.startsWith(base)) throw Object.assign(new Error('forbidden'), { status: 403 });
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch (err) {
      res.writeHead(err.status || 404, { 'content-type': 'text/plain' });
      res.end(String(err.message));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((r) => server.close(r)) };
}

export function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const r = spawnSync('which', [name], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  throw new Error('Chrome not found; set CHROME_PATH');
}

const CALL_TIMEOUT_MS = 60_000;

class Cdp {
  #id = 0;
  #pending = new Map();
  #listeners = [];

  constructor(ws) {
    this.ws = ws;
    // A closed connection or a dead browser fails every call still waiting,
    // so nothing hangs on a reply that cannot come.
    ws.addEventListener('close', () => this.failAll(new Error('DevTools connection closed')));
    ws.addEventListener('error', () => this.failAll(new Error('DevTools connection error')));
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined && this.#pending.has(msg.id)) {
        const { resolve, reject } = this.#pending.get(msg.id);
        this.#pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.#listeners) fn(msg);
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error(`DevTools connection to ${url} failed`)), { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}, timeoutMs = CALL_TIMEOUT_MS) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`DevTools ${method}: no reply in ${timeoutMs} ms`));
      }, timeoutMs);
      const done = (fn) => (v) => {
        clearTimeout(timer);
        fn(v);
      };
      this.#pending.set(id, { resolve: done(resolve), reject: done(reject) });
      if (this.ws.readyState !== WebSocket.OPEN) {
        this.#pending.get(id).reject(new Error(`DevTools ${method}: connection not open`));
        this.#pending.delete(id);
        return;
      }
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  failAll(err) {
    for (const { reject } of this.#pending.values()) reject(err);
    this.#pending.clear();
  }

  on(fn) {
    this.#listeners.push(fn);
  }

  close() {
    this.ws.close();
  }
}

async function removeProfile(profile) {
  for (let i = 0; i < 10; i++) {
    try {
      await rm(profile, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

function exited(proc, ms) {
  return Promise.race([
    new Promise((r) => (proc.exitCode !== null || proc.signalCode !== null ? r() : proc.once('exit', r))),
    new Promise((r) => setTimeout(r, ms)),
  ]);
}

// Starts headless Chrome and returns a session on its first page, recording
// console output; headless false opens a visible window instead, and args
// are extra switches. Call close() when done. If starting fails, Chrome is stopped and its profile removed
// before the error is thrown.
export async function launch({ headless = true, args = [] } = {}) {
  const binary = findChrome();
  const profile = await mkdtemp(join(tmpdir(), 'sim-core-chrome-'));
  const console = [];
  let proc;
  let cdp;
  let wsUrl;
  let version;
  try {
    proc = spawn(binary, [
      ...(headless ? ['--headless=new'] : ['--window-size=1280,800']), '--remote-debugging-port=0', `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
      '--disable-component-update', '--disable-sync', '--metrics-recording-only', ...args, 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    proc.on('error', () => {});   // a spawn failure is reported by the start-up promise below
    wsUrl = await new Promise((resolve, reject) => {
      let err = '';
      const fail = (e) => {
        clearTimeout(timer);
        reject(e);
      };
      const timer = setTimeout(() => fail(new Error(`Chrome did not start: ${err.slice(-500)}`)), 30_000);
      proc.stderr.on('data', (d) => {
        err += d;
        const m = err.match(/DevTools listening on (ws:\/\/\S+)/);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
      proc.once('error', (e) => fail(new Error(`Chrome did not start (${binary}): ${e.message}`)));
      proc.once('exit', (code) => fail(new Error(`Chrome exited ${code}: ${err.slice(-500)}`)));
    });
    const port = new URL(wsUrl).port;
    version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).Browser;
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('Chrome has no page target');
    cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    proc.on('exit', (code) => cdp.failAll(new Error(`Chrome exited ${code}`)));
    cdp.on((msg) => {
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = msg.params.args.map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type)).join(' ');
        // A failed console.assert is an error, as DevTools shows it.
        console.push({ source: 'console', level: msg.params.type === 'assert' ? 'error' : msg.params.type, text });
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        console.push({ source: 'exception', level: 'error', text: (d.exception && d.exception.description) || d.text });
      } else if (msg.method === 'Log.entryAdded') {
        const e = msg.params.entry;
        console.push({ source: `log:${e.source}`, level: e.level, text: `${e.text}${e.url ? ` (${e.url})` : ''}` });
      }
    });
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');
  } catch (err) {
    if (cdp) cdp.close();
    if (proc && proc.pid !== undefined && proc.exitCode === null) {
      proc.kill();
      await exited(proc, 5000);
    }
    await removeProfile(profile);
    throw err;
  }
  return {
    version,
    console,
    cdp,
    async goto(url) {
      await cdp.send('Page.navigate', { url });
    },
    async evaluate(expression) {
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(`evaluate: ${r.exceptionDetails.text}`);
      return r.result.value;
    },
    async close() {
      try {
        const browser = await Cdp.connect(wsUrl);
        await browser.send('Browser.close', {}, 5000).catch(() => {});
        browser.close();
      } catch {
        // already gone
      }
      cdp.close();
      await exited(proc, 10_000);
      if (proc.exitCode === null) proc.kill();
      await exited(proc, 5000);
      await removeProfile(profile);
    },
  };
}
