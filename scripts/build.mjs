import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import { switchIconSvg } from '../src/switch-icons.js';
import { goalIconSvg } from '../src/goal-icons.js';

const root = fs.realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const name = 'com.ulanzi.ulanzistudio.jeycodex.ulanziPlugin';
const out = path.join(root, 'dist', name);

const dist = path.resolve(root, 'dist');
if (path.dirname(dist) !== root) throw new Error('invalid build output directory');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'plugin'), { recursive: true });
fs.mkdirSync(path.join(out, 'resources'), { recursive: true });
fs.mkdirSync(path.join(out, 'node_modules'), { recursive: true });

await build({
  entryPoints: [path.join(root, 'src', 'app.js')],
  outfile: path.join(out, 'plugin', 'app.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['ws'],
  logLevel: 'warning',
});

await build({
  entryPoints: [path.join(root, 'src', 'goal-worker.js')],
  outfile: path.join(out, 'plugin', 'goal-worker.js'),
  bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'warning',
});

fs.writeFileSync(path.join(out, 'plugin', 'package.json'), '{ "type": "module" }\n');
fs.copyFileSync(path.join(root, 'plugin', 'manifest.json'), path.join(out, 'manifest.json'));
fs.copyFileSync(path.join(root, 'plugin', 'en.json'), path.join(out, 'en.json'));
fs.cpSync(path.join(root, 'plugin', 'resources'), path.join(out, 'resources'), { recursive: true });

const wasm = path.join(root, 'node_modules', '@resvg', 'resvg-wasm', 'index_bg.wasm');
fs.copyFileSync(wasm, path.join(out, 'resources', 'resvg.wasm'));
await initWasm(fs.readFileSync(wasm));
const iconFont = {
  fontBuffers: ['IBMPlexSans-Regular.ttf', 'IBMPlexSans-Bold.ttf']
    .map((file) => new Uint8Array(fs.readFileSync(path.join(out, 'resources', 'fonts', file)))),
  loadSystemFonts: false,
  defaultFontFamily: 'IBM Plex Sans',
};

const generatedIcons = [
  'goals',
  'goal-monitor',
  'goal-automatic',
  'mobile-running',
  'mobile-stopped',
  'switch-jey-idle',
  'switch-jey-active',
  'switch-jey-switching',
  'switch-americano-idle',
  'switch-americano-active',
  'switch-americano-switching',
  'switch-hb-idle',
  'switch-hb-active',
  'switch-hb-switching',
];

for (const name of generatedIcons) {
  const match = /^switch-(jey|americano|hb)-(idle|active|switching)$/.exec(name);
  const goalKind = { goals: 'goals', 'goal-monitor': 'monitor', 'goal-automatic': 'automatic' }[name];
  const svg = match
    ? switchIconSvg(match[1], match[2])
    : goalKind ? goalIconSvg(goalKind) : fs.readFileSync(path.join(out, 'resources', 'icons', name + '.svg'), 'utf8');
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: 144 }, font: iconFont }).render().asPng();
  fs.writeFileSync(path.join(out, 'resources', 'icons', name + '.png'), png);
}

fs.cpSync(path.join(root, 'node_modules', 'ws'), path.join(out, 'node_modules', 'ws'), { recursive: true });

for (const required of [
  'manifest.json',
  'plugin/app.js',
  'plugin/goal-worker.js',
  'resources/goals.html',
  'resources/resvg.wasm',
  'resources/fonts/IBMPlexSans-Regular.ttf',
  'resources/fonts/IBMPlexSans-Bold.ttf',
  'resources/icons/usage.png',
  ...generatedIcons.map((name) => 'resources/icons/' + name + '.png'),
  'node_modules/ws',
]) {
  if (!fs.existsSync(path.join(out, required))) {
    throw new Error('missing ' + required);
  }
}

console.log('Built: ' + out);
