// Copies WebAssembly engines and fonts into public/vendor. Cloudflare static
// assets are limited to 25 MiB per file, so large files are split into parts
// that the browser reassembles (src/core/assets.ts).
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = (p) => join(root, 'node_modules', p);
const out = join(root, 'public', 'vendor');
const PART = 20 * 1024 * 1024;

const files = [
  ['@ffmpeg/core/dist/esm/ffmpeg-core.js', 'ffmpeg/ffmpeg-core.js'],
  ['@ffmpeg/core/dist/esm/ffmpeg-core.wasm', 'ffmpeg/ffmpeg-core.wasm'],
  ['@ffmpeg/core-mt/dist/esm/ffmpeg-core.js', 'ffmpeg-mt/ffmpeg-core.js'],
  ['@ffmpeg/core-mt/dist/esm/ffmpeg-core.wasm', 'ffmpeg-mt/ffmpeg-core.wasm'],
  ['@ffmpeg/core-mt/dist/esm/ffmpeg-core.worker.js', 'ffmpeg-mt/ffmpeg-core.worker.js'],
  ['onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs', 'ort/ort-wasm-simd-threaded.asyncify.mjs'],
  ['onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm', 'ort/ort-wasm-simd-threaded.asyncify.wasm'],
  ['@expo-google-fonts/inter/800ExtraBold/Inter_800ExtraBold.ttf', 'fonts/Inter-ExtraBold.ttf'],
];

const pkgVersion = (name) => JSON.parse(readFileSync(nm(`${name}/package.json`), 'utf8')).version;
const version = ['@ffmpeg/core', '@ffmpeg/core-mt', 'onnxruntime-web', '@expo-google-fonts/inter'].map(pkgVersion).join('-');

const manifestPath = join(out, 'manifest.json');
if (existsSync(manifestPath)) {
  try {
    if (JSON.parse(readFileSync(manifestPath, 'utf8')).version === version) {
      console.log('vendor assets up to date');
      process.exit(0);
    }
  } catch {
    /* rebuild */
  }
}

rmSync(out, { recursive: true, force: true });
const manifest = { version, files: {} };
for (const [src, dest] of files) {
  const data = readFileSync(nm(src));
  const target = join(out, dest);
  mkdirSync(dirname(target), { recursive: true });
  if (data.length > PART) {
    const parts = Math.ceil(data.length / PART);
    for (let i = 0; i < parts; i++) writeFileSync(`${target}.part${i}`, data.subarray(i * PART, (i + 1) * PART));
    manifest.files[dest] = { size: data.length, parts };
  } else {
    writeFileSync(target, data);
    manifest.files[dest] = { size: data.length, parts: 0 };
  }
  console.log(`${dest} ${(data.length / 1048576).toFixed(1)} MiB`);
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
