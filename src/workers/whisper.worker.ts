/// <reference lib="webworker" />
// Speech-to-text with Whisper (transformers.js / ONNX Runtime), word-level
// timestamps. Runs on WebGPU when available, WebAssembly otherwise.
import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';
import { assetUrl, vendorUrl } from '../core/assets';

declare const self: DedicatedWorkerGlobalScope;

const MODEL = 'onnx-community/whisper-base_timestamped';

let asr: Promise<AutomaticSpeechRecognitionPipeline> | undefined;

async function hasWebGPU() {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    return Boolean(gpu && (await gpu.requestAdapter()));
  } catch {
    return false;
  }
}

function load(progress: (p: number, phase: string) => void) {
  asr ??= (async () => {
    env.allowLocalModels = false;
    const onnx = env.backends.onnx as { wasm?: { wasmPaths?: unknown; numThreads?: number } };
    if (onnx.wasm) {
      // Self-hosted ONNX Runtime (no third-party CDN).
      onnx.wasm.wasmPaths = {
        mjs: vendorUrl('ort/ort-wasm-simd-threaded.asyncify.mjs'),
        wasm: await assetUrl('ort/ort-wasm-simd-threaded.asyncify.wasm', (f) => progress((f ?? 0) * 0.3, 'download')),
      };
      onnx.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 2);
    }
    const gpu = await hasWebGPU();
    const files = new Map<string, number>();
    return (await pipeline('automatic-speech-recognition', MODEL, {
      device: gpu ? 'webgpu' : 'wasm',
      dtype: gpu ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8',
      progress_callback: (e: { status: string; file?: string; progress?: number }) => {
        if (e.status === 'progress' && e.file) {
          files.set(e.file, (e.progress ?? 0) / 100);
          const vals = [...files.values()];
          progress(0.3 + (0.7 * vals.reduce((a, b) => a + b, 0)) / Math.max(vals.length, 3), 'download');
        }
      },
    })) as AutomaticSpeechRecognitionPipeline;
  })();
  asr.catch(() => (asr = undefined));
  return asr;
}

interface Request {
  id: number;
  audio: Float32Array;
  language: string;
}

self.onmessage = async (e: MessageEvent<Request>) => {
  const { id, audio, language } = e.data;
  const post = (msg: object) => self.postMessage({ id, ...msg });
  try {
    const run = await load((p, phase) => post({ type: 'progress', p, phase }));
    post({ type: 'progress', p: null, phase: 'transcribe' });
    const opts: Record<string, unknown> = { return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5 };
    if (language && language !== 'auto') opts.language = language;
    const out = (await run(audio, opts)) as { chunks?: { text: string; timestamp: [number, number | null] }[] };
    const words = (out.chunks ?? [])
      .map((c) => ({ text: c.text.trim(), start: c.timestamp[0], end: c.timestamp[1] ?? c.timestamp[0] + 0.3 }))
      .filter((w) => w.text);
    post({ type: 'done', words });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
