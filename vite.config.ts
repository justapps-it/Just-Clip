import { defineConfig, type Plugin } from 'vite';

// ONNX Runtime's wasm is served split from /vendor (see whisper.worker.ts);
// drop the copy the bundler emits: it is over Cloudflare's 25 MiB file limit.
function dropBundledOrtWasm(): Plugin {
  return {
    name: 'drop-bundled-ort-wasm',
    generateBundle(_, bundle) {
      for (const name of Object.keys(bundle)) if (/ort-wasm.*\.wasm$/.test(name)) delete bundle[name];
    },
  };
}
import react from '@vitejs/plugin-react';

// Cross-origin isolation enables SharedArrayBuffer, i.e. multi-threaded
// FFmpeg. `credentialless` still lets the page load Twitch thumbnails.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

export default defineConfig({
  plugins: [react(), dropBundledOrtWasm()],
  server: {
    headers: isolation,
    proxy: { '/api': { target: 'https://clip.justapps.it', changeOrigin: true } },
  },
  preview: {
    headers: isolation,
    proxy: { '/api': { target: 'https://clip.justapps.it', changeOrigin: true } },
  },
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util', '@huggingface/transformers'] },
  worker: { format: 'es', plugins: () => [dropBundledOrtWasm()] },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
} as Parameters<typeof defineConfig>[0]);
