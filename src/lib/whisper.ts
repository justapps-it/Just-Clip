import type { Word } from './captions';

let worker: Worker | undefined;
let seq = 0;

export function transcribe(audio: Float32Array, language: string, onProgress?: (p: number | null, phase: string) => void): Promise<Word[]> {
  worker ??= new Worker(new URL('../workers/whisper.worker.ts', import.meta.url), { type: 'module' });
  const id = ++seq;
  const w = worker;
  return new Promise((resolve, reject) => {
    const onMsg = (e: MessageEvent) => {
      if (e.data.id !== id) return;
      if (e.data.type === 'progress') onProgress?.(e.data.p, e.data.phase);
      else {
        w.removeEventListener('message', onMsg);
        if (e.data.type === 'done') resolve(e.data.words);
        else reject(new Error(e.data.message));
      }
    };
    w.addEventListener('message', onMsg);
    w.postMessage({ id, audio, language }, [audio.buffer]);
  });
}
