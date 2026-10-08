import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const root = process.cwd();
const name = 'com.ulanzi.ulanzistudio.jeycodex.ulanziPlugin';
const out = path.join(root, 'dist', name);

fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
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

fs.writeFileSync(path.join(out, 'plugin', 'package.json'), '{ "type": "module" }\n');
fs.copyFileSync(path.join(root, 'plugin', 'manifest.json'), path.join(out, 'manifest.json'));
fs.copyFileSync(path.join(root, 'plugin', 'en.json'), path.join(out, 'en.json'));
fs.cpSync(path.join(root, 'plugin', 'resources'), path.join(out, 'resources'), { recursive: true });

const wasm = path.join(root, 'node_modules', '@resvg', 'resvg-wasm', 'index_bg.wasm');
fs.copyFileSync(wasm, path.join(out, 'resources', 'resvg.wasm'));
fs.cpSync(path.join(root, 'node_modules', 'ws'), path.join(out, 'node_modules', 'ws'), { recursive: true });

for (const required of [
  'manifest.json',
  'plugin/app.js',
  'resources/resvg.wasm',
  'resources/fonts/IBMPlexSans-Regular.ttf',
  'resources/fonts/IBMPlexSans-Bold.ttf',
  'resources/icons/usage.png',
  'node_modules/ws',
]) {
  if (!fs.existsSync(path.join(out, required))) {
    throw new Error('missing ' + required);
  }
}

console.log('Built: ' + out);
