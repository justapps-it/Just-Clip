// FFmpeg (WebAssembly). Multi-threaded when the page is cross-origin
// isolated (Chrome, Firefox, Edge), single-threaded otherwise (Safari).
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { assetUrl, loadAsset, vendorUrl } from '../core/assets';

let instance: Promise<FFmpeg> | undefined;
let progressCb: ((p: number) => void) | undefined;
let log: string[] = [];

function forced(): string | null {
  try {
    return localStorage.getItem('justclip-ffmpeg');
  } catch {
    return null;
  }
}

export const multiThreaded = () =>
  forced() !== 'st' && typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined';

export function getFFmpeg(onDownload?: (f: number) => void): Promise<FFmpeg> {
  instance ??= (async () => {
    const ff = new FFmpeg();
    ff.on('log', ({ message }) => {
      log.push(message);
      if (log.length > 40) log.shift();
    });
    ff.on('progress', ({ progress }) => progressCb?.(Math.max(0, Math.min(1, progress))));
    const mt = multiThreaded();
    const dir = mt ? 'ffmpeg-mt' : 'ffmpeg';
    const wasmURL = await assetUrl(`${dir}/ffmpeg-core.wasm`, (f) => onDownload?.(f ?? 0));
    await ff.load({
      coreURL: vendorUrl(`${dir}/ffmpeg-core.js`),
      wasmURL,
      ...(mt ? { workerURL: vendorUrl(`${dir}/ffmpeg-core.worker.js`) } : {}),
    });
    await ff.createDir('/fonts').catch(() => {});
    await ff.writeFile('/fonts/Inter-ExtraBold.ttf', await loadAsset('fonts/Inter-ExtraBold.ttf'));
    return ff;
  })();
  instance.catch(() => (instance = undefined));
  return instance;
}

/** Runs one FFmpeg command; throws with the tail of the log on failure. */
export async function run(args: string[], onProgress?: (p: number) => void): Promise<void> {
  const ff = await getFFmpeg();
  if (multiThreaded()) {
    // ffmpeg-core-mt crashes ("function signature mismatch") when it picks the
    // thread count itself: always set it explicitly.
    const n = String(Math.max(2, Math.min(4, navigator.hardwareConcurrency || 4)));
    args = ['-filter_threads', n, '-filter_complex_threads', n, ...args.slice(0, -1), '-threads', n, args[args.length - 1]];
  }
  log = [];
  progressCb = onProgress;
  try {
    const code = await ff.exec(args);
    if (code !== 0) throw new Error(`FFmpeg ${code}: ${log.filter((l) => !/^\s*(frame|size)=/.test(l)).slice(-5).join(' | ')}`);
  } finally {
    progressCb = undefined;
  }
}
