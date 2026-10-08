import fs from 'node:fs';
import path from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initWasm, Resvg } from '@resvg/resvg-wasm';

const here = dirname(fileURLToPath(import.meta.url));
const resources = path.join(here, '..', 'resources');

let ready = null;
let initialized = false;

export function initRenderer() {
  if (!ready) {
    ready = (async () => {
      const wasm = fs.readFileSync(path.join(resources, 'resvg.wasm'));
      await initWasm(wasm);
      initialized = true;
    })();
  }
  return ready;
}

function fontBuffers() {
  return ['IBMPlexSans-Regular.ttf', 'IBMPlexSans-Bold.ttf']
    .map((name) => path.join(resources, 'fonts', name))
    .filter(fs.existsSync)
    .map((file) => new Uint8Array(fs.readFileSync(file)));
}

const fonts = {
  fontBuffers: fontBuffers(),
  loadSystemFonts: false,
  defaultFontFamily: 'IBM Plex Sans',
};

function escapeXml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function formatReset(resetsAt) {
  if (!resetsAt) return '';
  const remaining = Math.max(0, new Date(resetsAt).getTime() - Date.now());
  const mins = Math.floor(remaining / 60000);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const minutes = mins % 60;

  if (days > 0) return String(days) + 'd' + String(hours) + 'h';
  if (hours > 0) return String(hours) + 'h' + String(minutes) + 'm';
  return String(Math.max(0, minutes)) + 'm';
}

function gaugeColor(remaining) {
  if (remaining >= 60) return '#34d399';
  if (remaining >= 35) return '#facc15';
  if (remaining >= 15) return '#fb923c';
  return '#f43f5e';
}

export function gaugeSvg(options) {
  const account = options.account;
  const windowLabel = options.windowLabel;
  const reading = options.reading;
  const status = options.status || 'ok';
  const stale = options.stale === true;
  const syncing = options.syncing === true;
  const W = 144;
  const H = 144;
  const remaining = reading ? Math.max(0, Math.min(100, 100 - reading.usedPercent)) : 0;
  const color = gaugeColor(remaining);
  const fillH = reading ? Math.round(H * remaining / 100) : 0;
  const fillY = H - fillH;
  const value = reading ? String(Math.round(remaining)) : '—';
  const footer =
    syncing ? 'SYNC'
      : status === 'login' ? 'LOGIN'
        : status === 'error' ? 'OFFLINE'
          : stale ? 'STALE'
            : formatReset(reading?.resetsAt);
  const valueColor = reading ? color : '#64748b';
  const footerColor = syncing ? '#38bdf8' : (stale || status !== 'ok' ? '#94a3b8' : '#ffffff');
  const accountSize = account.length > 6 ? 9 : 11;

  let svg = '';
  svg += '<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">';
  svg += '<defs><clipPath id="clip"><rect width="144" height="144" rx="12"/></clipPath></defs>';
  svg += '<rect width="144" height="144" rx="12" fill="#0f172a"/>';
  if (reading && !syncing) {
    svg += '<rect x="2" y="2" width="140" height="140" rx="10" fill="none" stroke="' + color + '" stroke-width="2" opacity="0.55"/>';
  }
  if (syncing) svg += '<rect x="2" y="2" width="140" height="140" rx="10" fill="none" stroke="#38bdf8" stroke-width="3" opacity="0.95"/>';
  if (reading) {
    svg += '<g clip-path="url(#clip)">';
    svg += '<rect x="0" y="' + fillY + '" width="144" height="' + fillH + '" fill="' + color + '" opacity="0.14"/>';
    svg += '<rect x="0" y="' + Math.max(0, fillY - 2) + '" width="144" height="3" fill="' + color + '" opacity="0.95"/>';
    svg += '</g>';
  }
  svg += '<text x="13" y="31" font-family="IBM Plex Sans" font-size="26" font-weight="700" fill="#e2e8f0">' + escapeXml(windowLabel) + '</text>';
  svg += '<text x="131" y="18" text-anchor="end" font-family="IBM Plex Sans" font-size="' + accountSize + '" font-weight="700" fill="#94a3b8">' + escapeXml(account) + '</text>';
  svg += '<text x="72" y="91" text-anchor="middle" font-family="IBM Plex Sans" font-size="48" font-weight="700" fill="' + valueColor + '">' + value;
  if (reading) svg += '<tspan font-size="23">%</tspan>';
  svg += '</text>';
  svg += '<text x="72" y="121" text-anchor="middle" font-family="IBM Plex Sans" font-size="16" font-weight="700" fill="' + footerColor + '">' + escapeXml(footer) + '</text>';
  svg += '</svg>';
  return svg;
}

const cache = new Map();

export function svgToDataUri(svg) {
  const hit = cache.get(svg);
  if (hit) return hit;
  if (!initialized) throw new Error('renderer not initialized');

  const image = new Resvg(svg, {
    fitTo: { mode: 'width', value: 196 },
    font: fonts,
  }).render().asPng();

  const uri = 'data:image/png;base64,' + Buffer.from(image).toString('base64');
  if (cache.size > 64) cache.delete(cache.keys().next().value);
  cache.set(svg, uri);
  return uri;
}
