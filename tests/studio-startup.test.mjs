import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import { goalIconSvg } from '../src/goal-icons.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const bundleRoot = path.join(root, 'dist/com.ulanzi.ulanzistudio.jeycodex.ulanziPlugin');
const built = fs.existsSync(path.join(bundleRoot, 'plugin/app.js'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('full plugin recovers from delayed Studio startup and reconnects with all key images', { skip: !built }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ulanzi-studio-startup-'));
  const reserve = net.createServer();
  await new Promise((resolve) => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  const uuids = ['jey5h', 'goals', 'goalmonitor', 'goalautomatic', 'hb5h', 'hb7d', 'switchhb'].map((suffix) => 'com.ulanzi.ulanzistudio.jeycodex.' + suffix);
  let stderr = '', exited = false, server, connections = 0;
  const received = new Map();
  const toasts = [], openedPages = [];
  let nativeOpenRequests = 0, socketForActions;
  const child = spawn(process.execPath, [path.join(bundleRoot, 'plugin/app.js'), '127.0.0.1', String(port), 'en'], {
    env: { ...process.env, USERPROFILE: temp, HOME: temp, LOCALAPPDATA: temp, TEMP: temp, TMP: temp },
    windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', (b) => { const text = String(b); if (!text.includes('data:image')) stderr = (stderr + text).slice(-5000); });
  const finished = new Promise((resolve) => child.once('exit', (code) => { exited = true; resolve(code); }));
  const wait = async (predicate) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (predicate()) return;
      if (exited) throw new Error('Plugin exited during startup: ' + stderr);
      await sleep(25);
    }
    throw new Error('Studio handshake timed out: ' + stderr);
  };
  try {
    await wait(() => stderr.includes('WEBSOCKET ERROR'));
    server = new WebSocketServer({ host: '127.0.0.1', port });
    server.on('connection', (socket) => {
      socketForActions = socket;
      connections++;
      socket.on('message', (raw) => {
        const frame = JSON.parse(raw);
        if (frame.cmd === 'toast') toasts.push(frame.msg);
        if (frame.cmd === 'openurl') {
          nativeOpenRequests++;
          const url = new URL(frame.url);
          for (const [key,value] of Object.entries(frame.param || {})) url.searchParams.set(key,value);
          void fetch(url).then((r)=>r.text()).then((body)=>openedPages.push(body));
        }
        if (frame.cmd === 'connected') {
          socket.send('invalid bootstrap frame');
          socket.send(JSON.stringify({ ignored: true }));
          uuids.forEach((uuid, i) => socket.send(JSON.stringify({ cmd: 'add', uuid, key: 'test_' + i, actionid: 'test-action-' + i })));
        }
        for (const item of frame.param?.statelist || []) {
          if (uuids.includes(item.uuid) && item.data?.startsWith('data:image/png;base64,')) received.set(item.uuid, item.data);
        }
      });
    });
    await wait(() => received.size === uuids.length);
    assert.equal(exited, false);
    socketForActions.send(JSON.stringify({ cmd:'run', uuid:uuids[2], key:'test_2', actionid:'test-action-2' }));
    await wait(()=>toasts.some((text)=>text.includes('Nenhum Goal selecionado')));
    assert.equal(nativeOpenRequests,0,'execution key must not duplicate the panel opener');
    socketForActions.send(JSON.stringify({ cmd:'run', uuid:uuids[1], key:'test_1', actionid:'test-action-1' }));
    await wait(()=>openedPages.length===1);
    assert.ok(openedPages[0].includes('Saída da execução'));
    received.clear();
    for (const socket of server.clients) socket.terminate();
    await wait(() => connections >= 2 && received.size === uuids.length);
    assert.equal(exited, false);
  } finally {
    child.kill(); await finished;
    if (server) { for (const socket of server.clients) socket.terminate(); await new Promise((resolve) => server.close(resolve)); }
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('packaged fallback icons contain rendered text using bundled fonts', { skip: !built }, async () => {
  await initWasm(fs.readFileSync(path.join(bundleRoot, 'resources/resvg.wasm')));
  const font = {
    fontBuffers: ['IBMPlexSans-Regular.ttf', 'IBMPlexSans-Bold.ttf'].map((name) => new Uint8Array(fs.readFileSync(path.join(bundleRoot, 'resources/fonts', name)))),
    loadSystemFonts: false, defaultFontFamily: 'IBM Plex Sans',
  };
  for (const [file, kind] of [['goals', 'goals'], ['goal-monitor', 'monitor'], ['goal-automatic', 'automatic']]) {
    const svg = goalIconSvg(kind);
    const withoutText = svg.replace(/<text\b[^>]*>[\s\S]*?<\/text>/g, '');
    const render = (input) => Buffer.from(new Resvg(input, { fitTo: { mode: 'width', value: 144 }, font }).render().asPng());
    const png = fs.readFileSync(path.join(bundleRoot, 'resources/icons', file + '.png'));
    assert.ok(png.equals(render(svg)), 'packaged image must use the supplied fonts');
    assert.ok(!png.equals(render(withoutText)), 'text must be visible in the fallback image');
  }
});
