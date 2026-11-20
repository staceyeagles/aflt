#!/usr/bin/env node
'use strict';
/**
 * Capture README screenshots of the live aflt dashboard using headless Chrome
 * driven over the DevTools protocol. Zero npm dependencies (dev tooling only;
 * not shipped behavior). Works on Node >= 18: uses the global WebSocket when
 * present (Node >= 22), otherwise a tiny built-in RFC 6455 client over
 * node:http (no puppeteer needed).
 *
 *   npm run screenshots
 *   DASHBOARD_URL=http://127.0.0.1:8787/ OUT_DIR=docs/images npm run screenshots
 *   node scripts/screenshots.js [dashboard-url]
 *
 * Env: DASHBOARD_URL (or argv[2]), OUT_DIR (default docs/images),
 *      CHROME_BIN (default: macOS Google Chrome), SHOT_MAX_KB (default 600).
 *
 * Shots:
 *   dashboard-sessions.png  History tree + stats side panel (overview).
 *   dashboard-history.png   Timeline-focused: side panel hidden, widest of
 *                           7d / 30d / all that actually shows Gantt markers.
 *   dashboard-graph.png     Star graph.
 *
 * Privacy: tooltips, prompt/reply history, "where we left off", document
 * dialogs, project docs/summaries and the recent-events list are hidden before
 * every capture, and no row or marker is ever selected or hovered.
 */
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const URL_ = process.argv[2] || process.env.DASHBOARD_URL || 'http://127.0.0.1:8787/';
const OUT_DIR = path.resolve(process.env.OUT_DIR || 'docs/images');
const CHROME =
  process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MAX_BYTES = (Number(process.env.SHOT_MAX_KB) || 600) * 1024;
const W = 1440;
const H = 900;
const DSF = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HIDE_CSS = `
  #graph-tooltip, #history-tooltip, #history-panel, #leftoff-panel,
  #document-dialog, #confirm-dialog, #action-status, #project-memory,
  .memory-panel, .timeline { display: none !important; }
`;

/** Minimal WebSocket client (text frames only) for Node < 22. */
class MiniWs {
  constructor() {
    this.listeners = { message: [], close: [] };
    this.buf = Buffer.alloc(0);
    this.frag = [];
    this.socket = null;
  }

  static connect(wsUrl) {
    return new Promise((resolve, reject) => {
      const u = new URL(wsUrl);
      const ws = new MiniWs();
      const key = crypto.randomBytes(16).toString('base64');
      const req = http.request({
        host: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': key,
          'Sec-WebSocket-Version': '13',
        },
      });
      req.on('upgrade', (res, socket, head) => {
        ws.socket = socket;
        socket.on('data', (d) => ws._onData(d));
        socket.on('close', () => ws.listeners.close.forEach((f) => f()));
        socket.on('error', () => {});
        if (head && head.length) ws._onData(head);
        resolve(ws);
      });
      req.on('response', () => reject(new Error('WebSocket upgrade refused')));
      req.on('error', reject);
      req.end();
    });
  }

  on(type, fn) {
    this.listeners[type].push(fn);
  }

  _frame(opcode, payload) {
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | (opcode & 0x0f);
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  send(text) {
    this._frame(0x1, Buffer.from(text, 'utf8'));
  }

  close() {
    try {
      this.socket.destroy();
    } catch {
      /* ignore */
    }
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      const masked = (b1 & 0x80) !== 0; // servers don't mask, but be safe
      if (masked) off += 4;
      if (this.buf.length < off + len) return;
      let payload = this.buf.subarray(off, off + len);
      if (masked) {
        const mk = this.buf.subarray(off - 4, off);
        payload = Buffer.from(payload.map((v, i) => v ^ mk[i & 3]));
      }
      this.buf = this.buf.subarray(off + len);
      const fin = (b0 & 0x80) !== 0;
      const op = b0 & 0x0f;
      if (op === 0x8) {
        this.close();
        return;
      }
      if (op === 0x9) {
        this._frame(0xa, Buffer.from(payload)); // pong
        continue;
      }
      if (op === 0xa) continue;
      if (op === 0x1 || op === 0x0) {
        this.frag.push(Buffer.from(payload));
        if (fin) {
          const text = Buffer.concat(this.frag).toString('utf8');
          this.frag = [];
          this.listeners.message.forEach((f) => f(text));
        }
      }
    }
  }
}

class Cdp {
  constructor(ws, onMessage) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    onMessage((raw) => {
      const msg = JSON.parse(raw);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'evaluate failed');
    return r.result.value;
  }
  close() {
    if (typeof this.ws.close === 'function') this.ws.close();
  }
}

async function launchChrome() {
  if (!fs.existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME} (set CHROME_BIN)`);
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aflt-shots-'));
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDir}`,
      `--window-size=${W},${H}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const portFile = path.join(userDir, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(100);
  if (!fs.existsSync(portFile)) {
    proc.kill();
    throw new Error('Chrome did not expose a DevTools port');
  }
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
  return { proc, port, userDir };
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

async function connect(port) {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    try {
      const list = await getJson(`http://127.0.0.1:${port}/json/list`);
      target = list.find((t) => t.type === 'page');
    } catch {
      /* retry */
    }
    if (!target) await sleep(100);
  }
  if (!target) throw new Error('No Chrome page target');
  if (typeof WebSocket !== 'undefined') {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('WebSocket error')), { once: true });
    });
    return new Cdp(ws, (fn) => ws.addEventListener('message', (ev) => fn(ev.data)));
  }
  const ws = await MiniWs.connect(target.webSocketDebuggerUrl);
  return new Cdp(ws, (fn) => ws.on('message', fn));
}

async function shoot(cdp, file) {
  // Park the pointer far away (no hover popups) and re-assert hidden panels.
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: W - 2, y: H - 2 });
  await cdp.eval(`
    for (const id of ['graph-tooltip','history-tooltip','history-panel','leftoff-panel']) {
      const el = document.getElementById(id); if (el) el.hidden = true;
    }
    for (const id of ['document-dialog','confirm-dialog']) {
      const d = document.getElementById(id); if (d && d.open) d.close();
    }
    true`);
  await sleep(400);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
}

function have(cmd) {
  return spawnSync('which', [cmd], { stdio: 'ignore' }).status === 0;
}

function optimize(file) {
  const size = () => fs.statSync(file).size;
  if (size() <= MAX_BYTES) return;
  if (have('pngquant')) {
    spawnSync('pngquant', ['--quality=60-90', '--force', '--ext', '.png', file]);
  }
  if (size() > MAX_BYTES && have('optipng')) spawnSync('optipng', ['-o2', '-quiet', file]);
  // Last resort (macOS): downscale until it fits.
  for (const px of [2560, 2304, 2048, 1800]) {
    if (size() <= MAX_BYTES || !have('sips')) break;
    spawnSync('sips', ['-Z', String(px), file], { stdio: 'ignore' });
  }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const { proc, port, userDir } = await launchChrome();
  const out = [];
  let cdp;
  try {
    cdp = await connect(port);
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: W,
      height: H,
      deviceScaleFactor: DSF,
      mobile: false,
    });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `document.addEventListener('DOMContentLoaded',()=>{const s=document.createElement('style');s.textContent=${JSON.stringify(HIDE_CSS)};document.head.appendChild(s);});`,
    });
    await cdp.send('Page.navigate', { url: URL_ });
    for (let i = 0; i < 100; i++) {
      if (await cdp.eval(`!!document.getElementById('view-history')`)) break;
      await sleep(100);
    }
    // Re-inject hide CSS in case DOMContentLoaded already fired before the hook.
    await cdp.eval(`(()=>{const s=document.createElement('style');s.id='aflt-shot-hide';s.textContent=${JSON.stringify(HIDE_CSS)};document.head.appendChild(s);return true})()`);
    await sleep(2500); // initial SSE/state load

    const click = (sel) =>
      cdp.eval(`(()=>{const b=document.querySelector(${JSON.stringify(sel)});if(!b)return false;b.click();return true})()`);
    const markerCount = () =>
      cdp.eval(`document.querySelectorAll('#history-tree .gantt-marker').length`);

    // 1) Sessions overview: History tree + side stats panel, nothing selected.
    await click('#view-history');
    await sleep(1200);
    let f = path.join(OUT_DIR, 'dashboard-sessions.png');
    await shoot(cdp, f);
    out.push(f);

    // 2) History: timeline-focused. Hide the side panel so the Gantt gets the
    // full width; prefer 7d, widen to 30d / all when no markers are visible.
    await cdp.eval(
      `(()=>{const p=document.getElementById('panel');if(p)p.style.display='none';return true})()`,
    );
    let used = '7d';
    for (const preset of ['7d', '30d', 'all']) {
      used = preset;
      await click(`.timeline-preset[data-preset="${preset}"]`);
      await sleep(1200);
      if ((await markerCount()) > 0) break;
    }
    console.error(`history preset: ${used} (${await markerCount()} markers)`);
    f = path.join(OUT_DIR, 'dashboard-history.png');
    await shoot(cdp, f);
    out.push(f);
    await cdp.eval(
      `(()=>{const p=document.getElementById('panel');if(p)p.style.display='';return true})()`,
    );

    // 3) Graph.
    await click('#view-graph');
    await sleep(3500); // let the force layout settle
    await click('#graph-fit');
    await sleep(1500);
    f = path.join(OUT_DIR, 'dashboard-graph.png');
    await shoot(cdp, f);
    out.push(f);
  } finally {
    if (cdp) cdp.close();
    proc.kill();
    try {
      fs.rmSync(userDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  for (const file of out) {
    optimize(file);
    console.log(`${path.relative(process.cwd(), file)}  ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
  }
}

main().catch((e) => {
  console.error(`screenshots: ${e.message}`);
  process.exit(1);
});
