// Renders one clip: cut → (transcribe) → compose each format → MP4.
import { buildAss, type Word } from './captions';
import { getFFmpeg, run } from './ffmpeg';
import { type Format, type LayoutSettings, outputSize, videoFilter } from './layout';
import type { MediaRange } from './sources';
import { transcribe } from './whisper';

export interface RenderOptions {
  formats: Format[];
  quality: 720 | 1080;
  layout: LayoutSettings;
  subtitles: boolean;
  language: string;
  /** Title shown at the start of the clip. */
  hook?: string;
}

export interface RenderResult {
  outputs: { format: Format; data: Uint8Array }[];
  thumbnail: Uint8Array;
  words: Word[];
}

export type Stage = 'prepare' | 'transcribe' | 'model' | 'render-horizontal' | 'render-vertical';

let jobSeq = 0;

export async function renderClip(range: MediaRange, opts: RenderOptions, onProgress: (stage: Stage, p: number | null) => void): Promise<RenderResult> {
  onProgress('prepare', null);
  const ff = await getFFmpeg((f) => onProgress('prepare', f));
  const dir = `/job${++jobSeq}`;
  await ff.createDir(dir);
  const written: string[] = [];
  const write = async (name: string, data: Uint8Array | string) => {
    await ff.writeFile(`${dir}/${name}`, data);
    written.push(`${dir}/${name}`);
  };
  try {
    for (const f of range.files) await write(f.name, f.data);
    const inputAt = (ss: number, t?: number): string[] => {
      const seek = ['-ss', ss.toFixed(3), ...(t ? ['-t', t.toFixed(3)] : [])];
      return range.kind === 'webm'
        ? ['-f', 'concat', '-safe', '0', ...seek, '-i', `${dir}/list.txt`]
        : [...seek, '-i', `${dir}/${range.files[0].name}`];
    };
    if (range.kind === 'webm') await write('list.txt', range.files.map((f) => `file '${dir}/${f.name}'`).join('\n'));
    const input = inputAt(range.offset, range.duration);

    // Thumbnail from the middle of the clip.
    await run([...inputAt(range.offset + range.duration * 0.45), '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', `${dir}/thumb.jpg`]);
    written.push(`${dir}/thumb.jpg`);
    const thumbnail = (await ff.readFile(`${dir}/thumb.jpg`)) as Uint8Array;

    let words: Word[] = [];
    if (opts.subtitles) {
      await run([...input, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', `${dir}/audio.pcm`]);
      written.push(`${dir}/audio.pcm`);
      const pcm = (await ff.readFile(`${dir}/audio.pcm`)) as Uint8Array;
      const audio = new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength));
      if (audio.length > 16000) {
        words = await transcribe(audio, opts.language, (p, phase) => onProgress(phase === 'download' ? 'model' : 'transcribe', p));
      }
    }

    const outputs: RenderResult['outputs'] = [];
    for (const format of opts.formats) {
      const [W, H] = outputSize(format, opts.quality);
      const probe = videoFilter(format, opts.quality, opts.layout, null);
      let subs: string | null = null;
      if (words.length || opts.hook) {
        subs = `${dir}/sub-${format}.ass`;
        const hook = opts.hook ? { text: opts.hook, until: Math.min(3, range.duration), y: format === 'vertical' ? H * 0.09 : H * 0.12 } : undefined;
        await write(
          `sub-${format}.ass`,
          buildAss(words, { width: W, height: H, fontSize: probe.fontSize, y: probe.captionY, maxWords: format === 'vertical' ? 3 : 5 }, hook),
        );
      }
      const { graph } = videoFilter(format, opts.quality, opts.layout, subs);
      const out = `${dir}/out-${format}.mp4`;
      await run(
        [
          ...input,
          '-filter_complex', graph,
          '-map', '[v]', '-map', '0:a?',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', opts.quality === 1080 ? '21' : '23', '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
          '-movflags', '+faststart',
          out,
        ],
        (p) => onProgress(`render-${format}`, p),
      );
      written.push(out);
      outputs.push({ format, data: (await ff.readFile(out)) as Uint8Array });
    }
    return { outputs, thumbnail, words };
  } finally {
    for (const f of written) await ff.deleteFile(f).catch(() => {});
    await ff.deleteDir(dir).catch(() => {});
  }
}

/** One frame of the source (for the layout editor). */
export async function extractFrame(range: MediaRange): Promise<Blob> {
  const ff = await getFFmpeg();
  const dir = `/frame${++jobSeq}`;
  await ff.createDir(dir);
  try {
    for (const f of range.files) await ff.writeFile(`${dir}/${f.name}`, f.data);
    const input =
      range.kind === 'webm'
        ? (await ff.writeFile(`${dir}/list.txt`, range.files.map((f) => `file '${dir}/${f.name}'`).join('\n')), ['-f', 'concat', '-safe', '0', '-i', `${dir}/list.txt`])
        : ['-i', `${dir}/${range.files[0].name}`];
    await run(['-ss', range.offset.toFixed(3), ...input, '-frames:v', '1', '-q:v', '3', `${dir}/frame.jpg`]);
    const data = (await ff.readFile(`${dir}/frame.jpg`)) as Uint8Array;
    return new Blob([data as BlobPart], { type: 'image/jpeg' });
  } finally {
    for (const f of [...range.files.map((f) => f.name), 'list.txt', 'frame.jpg']) await ff.deleteFile(`${dir}/${f}`).catch(() => {});
    await ff.deleteDir(dir).catch(() => {});
  }
}

/** Mono 16 kHz PCM of a media range (for loudness analysis). */
export async function extractPcm(range: MediaRange): Promise<Float32Array> {
  const ff = await getFFmpeg();
  const dir = `/pcm${++jobSeq}`;
  await ff.createDir(dir);
  const names = range.files.map((f) => `${dir}/${f.name}`);
  try {
    for (const f of range.files) await ff.writeFile(`${dir}/${f.name}`, f.data);
    let input: string[];
    if (range.kind === 'webm') {
      await ff.writeFile(`${dir}/list.txt`, range.files.map((f) => `file '${dir}/${f.name}'`).join('\n'));
      names.push(`${dir}/list.txt`);
      input = ['-f', 'concat', '-safe', '0', '-ss', range.offset.toFixed(3), '-t', range.duration.toFixed(3), '-i', `${dir}/list.txt`];
    } else input = ['-ss', range.offset.toFixed(3), '-t', range.duration.toFixed(3), '-i', names[0]];
    await run([...input, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', `${dir}/a.pcm`]);
    names.push(`${dir}/a.pcm`);
    const pcm = (await ff.readFile(`${dir}/a.pcm`)) as Uint8Array;
    return new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength));
  } finally {
    for (const n of names) await ff.deleteFile(n).catch(() => {});
    await ff.deleteDir(dir).catch(() => {});
  }
}
