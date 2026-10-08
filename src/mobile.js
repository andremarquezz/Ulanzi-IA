import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PORT = 3333;
const TOKEN_FILE = path.join(os.homedir(), '.jey-codex-mobile-token');
const here = dirname(fileURLToPath(import.meta.url));
const MOBILE_HTML = path.join(here, '..', 'resources', 'mobile.html');
const MOBILE_MANIFEST = path.join(here, '..', 'resources', 'manifest.webmanifest');
const MOBILE_SW = path.join(here, '..', 'resources', 'sw.js');
const MOBILE_ICON = path.join(here, '..', 'resources', 'icon.svg');

function readOrCreateToken() {
  try {
    const existing = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (existing.length >= 12) return existing;
  } catch {}

  const token = crypto.randomBytes(12).toString('hex');
  try { fs.writeFileSync(TOKEN_FILE, token + '\n', { mode: 0o600 }); } catch {}
  return token;
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
}

function sendHtml(res, body) {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendFile(res, file, contentType, cacheControl = 'no-cache') {
  try {
    const data = fs.readFileSync(file);
    res.writeHead(200, { 'content-type': contentType, 'cache-control': cacheControl, 'content-length': data.length });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: 'not found' });
  }
}

function localAddresses(port, token) {
  const result = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      result.push('http://' + entry.address + ':' + port + '/?token=' + token);
    }
  }
  return result;
}

function renderPage(token) {
  const html = fs.readFileSync(MOBILE_HTML, 'utf8');
  return html
    .replaceAll('__JEY_TOKEN__', JSON.stringify(token))
    .replaceAll('__JEY_TOKEN_VALUE__', encodeURIComponent(token));
}

function renderManifest(token) {
  const manifest = fs.readFileSync(MOBILE_MANIFEST, 'utf8');
  return manifest.replaceAll('__JEY_TOKEN_VALUE__', encodeURIComponent(token));
}

export function startMobileServer({
  getState,
  refresh,
  switchAccount,
  log = () => {},
  port = Number(process.env.JEY_MOBILE_PORT || DEFAULT_PORT),
}) {
  const token = readOrCreateToken();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost'));
      const supplied = url.searchParams.get('token') || req.headers['x-jey-token'];

      if (supplied !== token) {
        if (url.pathname === '/') {
          res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('Token invalido. Abra a URL exibida no log do plugin.');
        } else {
          sendJson(res, 401, { error: 'unauthorized' });
        }
        return;
      }

      if (req.method === 'GET' && url.pathname === '/') {
        sendHtml(res, renderPage(token));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/manifest.webmanifest') {
        const manifest = renderManifest(token);
        res.writeHead(200, { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'no-cache' });
        res.end(manifest);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/sw.js') {
        sendFile(res, MOBILE_SW, 'application/javascript; charset=utf-8', 'no-cache');
        return;
      }

      if (req.method === 'GET' && url.pathname === '/icon.svg') {
        sendFile(res, MOBILE_ICON, 'image/svg+xml; charset=utf-8', 'public, max-age=86400');
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/status') {
        sendJson(res, 200, getState());
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/refresh') {
        await refresh(true);
        sendJson(res, 200, getState());
        return;
      }

      const match = req.method === 'POST' && url.pathname.match(/^\/api\/switch\/(jey|americano)$/);
      if (match) {
        const result = await switchAccount(match[1]);
        sendJson(res, 200, result);
        return;
      }

      sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      log('mobile request error: ' + String(error));
      sendJson(res, 500, { error: String(error?.message || error) });
    }
  });

  server.on('error', (error) => log('mobile server error: ' + String(error)));
  server.listen(port, '0.0.0.0', () => {
    log('mobile server ready port=' + port);
    for (const url of localAddresses(port, token)) log('mobile url ' + url);
  });

  return {
    port,
    token,
    urls: () => localAddresses(port, token),
    close: () => server.close(),
  };
}
