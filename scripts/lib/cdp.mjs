// Minimal Chrome DevTools Protocol client and Chrome launcher.
// No dependencies: Node 22 ships WebSocket and fetch.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

function findChrome() {
  const found = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error('Chrome not found. Set CHROME_PATH to a Chrome or Edge executable.');
  return found;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Start headless Chrome with the real GPU, a fake camera and autoplay
 * allowed, and connect to its first page.
 *
 * @param {{width?: number, height?: number, port?: number}} [options]
 * @returns {Promise<{page: Page, close: () => Promise<void>}>}
 */
export async function launch(options = {}) {
  const port = options.port ?? 9400 + Math.floor(Math.random() * 400);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'motiondiff-chrome-'));
  const child = spawn(findChrome(), [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${options.width ?? 1440},${options.height ?? 900}`,
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--enable-precise-memory-info',
    '--no-first-run',
    '--hide-scrollbars',
    'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let attempt = 0; attempt < 50 && !target; attempt++) {
    await sleep(200);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      target = list.find((entry) => entry.type === 'page');
    } catch { /* not up yet */ }
  }
  if (!target) {
    child.kill();
    throw new Error('Chrome did not start');
  }

  const page = await Page.connect(target.webSocketDebuggerUrl);
  return {
    page,
    async close() {
      page.close();
      child.kill();
      await sleep(300);
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome may still hold a lock */ }
    },
  };
}

const LOG_HOOK = `(() => {
  const buf = (window.__logs = []);
  for (const k of ['log', 'warn', 'error']) {
    const o = console[k].bind(console);
    console[k] = (...a) => {
      try { buf.push(k + ': ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); }
      catch { buf.push(k + ': <unserializable>'); }
      o(...a);
    };
  }
  window.addEventListener('error', (e) => buf.push('UNCAUGHT: ' + e.message + ' @' + e.filename + ':' + e.lineno));
  window.addEventListener('unhandledrejection', (e) => buf.push('REJECTION: ' + ((e.reason && e.reason.message) || e.reason)));
})();`;

export class Page {
  static connect(wsUrl) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const page = new Page(ws);
      ws.onopen = () => resolve(page);
      ws.onerror = (e) => reject(new Error('CDP socket error ' + (e.message || '')));
    });
  }

  constructor(ws) {
    this._ws = ws;
    this._id = 0;
    this._pending = new Map();
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      const waiter = msg.id && this._pending.get(msg.id);
      if (!waiter) return;
      this._pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message));
      else waiter.resolve(msg.result);
    };
  }

  send(method, params = {}) {
    const id = ++this._id;
    this._ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this._pending.set(id, { resolve, reject }));
  }

  close() { this._ws.close(); }

  /** Set the viewport. `mobile` also switches on touch emulation. */
  async viewport({ width, height, dpr = 1, mobile = false }) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile });
    await this.send('Emulation.setTouchEmulationEnabled', { enabled: mobile });
  }

  async open(url, settleMs = 1500) {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    if (!this._hooked) {
      await this.send('Page.addScriptToEvaluateOnNewDocument', { source: LOG_HOOK });
      this._hooked = true;
    }
    await this.send('Page.navigate', { url });
    await sleep(settleMs);
  }

  /**
   * Run an async function body in the page and return its (JSON) result.
   * `args` is available inside the body as `args`.
   */
  async eval(body, args = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async (args) => { ${body}\n })(${JSON.stringify(args)})`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error('Page error: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  }

  async key(key, { code = key, shift = false } = {}) {
    const base = {
      key, code, modifiers: shift ? 8 : 0,
      windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : ({ Tab: 9, Enter: 13, Escape: 27, ' ': 32, ArrowLeft: 37, ArrowRight: 39 })[key] ?? 0,
    };
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: key.length === 1 ? key : undefined });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  async mouseMove(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  }

  async screenshot(file, { full = false } = {}) {
    const params = { format: 'png' };
    if (full) {
      const metrics = await this.send('Page.getLayoutMetrics');
      const size = metrics.cssContentSize || metrics.contentSize;
      params.captureBeyondViewport = true;
      params.clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 };
    }
    const r = await this.send('Page.captureScreenshot', params);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  }
}

export function saveDataUrl(file, dataUrl) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
}

export function readDataUrl(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webm' ? 'video/webm' : ext === 'mp4' ? 'video/mp4' : 'image/png';
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
}
