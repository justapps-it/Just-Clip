// Where video and chat come from.
//
// Every source exposes the same clock for chat and video:
//  - VODs: seconds from the start of the video
//  - live: unix seconds (wall clock), aligned through HLS program-date-time
//    or the capture time of each recorded piece.

import { api, type ChatMessage } from './api';
import { concatBytes, fetchBytes, fetchText, parseMaster, parseMedia, pickVariant, pool, type Segment } from './hls';

export interface MediaRange {
  /** One TS stream, or several standalone WebM pieces to concatenate. */
  files: { name: string; data: Uint8Array }[];
  kind: 'ts' | 'webm';
  /** Where the requested range starts inside the media (seconds). */
  offset: number;
  duration: number;
}

export interface ClipSource {
  /** Earliest and latest time currently available (source clock). */
  available(): { start: number; end: number };
  getRange(start: number, end: number, signal?: AbortSignal): Promise<MediaRange>;
}

// ---------------------------------------------------------------------------
// Twitch VOD
// ---------------------------------------------------------------------------
export class TwitchVodSource implements ClipSource {
  private segments: Segment[] = [];
  constructor(
    public id: string,
    public duration: number,
  ) {}

  async load(maxHeight: number) {
    const master = await fetchText(api.twitchVodPlaylist(this.id));
    const variant = pickVariant(parseMaster(master, location.origin + '/'), maxHeight);
    if (!variant) throw new Error('no_variant');
    const media = parseMedia(await fetchText(variant.url), variant.url);
    this.segments = media.segments;
    return variant;
  }

  available() {
    const last = this.segments.at(-1);
    return { start: 0, end: last ? last.start + last.duration : this.duration };
  }

  async getRange(start: number, end: number, signal?: AbortSignal): Promise<MediaRange> {
    const segs = this.segments.filter((s) => s.start + s.duration > start && s.start < end);
    if (!segs.length) throw new Error('out_of_range');
    const data = await pool(segs, 4, (s) => fetchBytes(s.url, signal));
    return { files: [{ name: 'input.ts', data: concatBytes(data) }], kind: 'ts', offset: start - segs[0].start, duration: end - start };
  }
}

/** Downloads the whole chat replay of a VOD, in parallel slices. */
export async function loadVodChat(
  id: string,
  duration: number,
  onProgress: (fraction: number, count: number) => void,
  signal?: AbortSignal,
): Promise<ChatMessage[]> {
  const slices = Math.min(48, Math.max(1, Math.ceil(duration / 300)));
  const size = duration / slices;
  const covered = new Float64Array(slices);
  let count = 0;
  const parts = await pool(
    Array.from({ length: slices }, (_, i) => i),
    8,
    async (i) => {
      const from = i * size;
      const to = i === slices - 1 ? Infinity : (i + 1) * size;
      const out: ChatMessage[] = [];
      let page = await retry(() => api.twitchComments(id, { offset: from }), signal);
      for (;;) {
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
        let done = false;
        for (const m of page.messages) {
          if (m.t < from) continue;
          if (m.t >= to) {
            done = true;
            break;
          }
          out.push(m);
        }
        count += page.messages.length;
        const lastT = page.messages.at(-1)?.t ?? to;
        covered[i] = Math.min(1, (Math.min(lastT, from + size) - from) / size);
        onProgress(covered.reduce((a, b) => a + b, 0) / slices, count);
        if (done || !page.next) break;
        const cursor = page.next;
        page = await retry(() => api.twitchComments(id, { cursor }), signal);
      }
      covered[i] = 1;
      return out;
    },
  );
  onProgress(1, count);
  return parts.flat();
}

async function retry<T>(fn: () => Promise<T>, signal?: AbortSignal, tries = 4): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries - 1 || signal?.aborted) throw e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
}

// ---------------------------------------------------------------------------
// Live recorders (shared buffer logic)
// ---------------------------------------------------------------------------
interface Piece {
  /** Unix seconds. */
  start: number;
  duration: number;
  data: Uint8Array;
}

export type RecorderStatus = { state: 'starting' | 'recording' | 'ended' | 'error'; message?: string; buffered: number; bytes: number };

abstract class LiveBuffer implements ClipSource {
  protected pieces: Piece[] = [];
  onStatus?: (s: RecorderStatus) => void;
  protected state: RecorderStatus['state'] = 'starting';
  constructor(public bufferSeconds: number) {}

  protected push(p: Piece) {
    this.pieces.push(p);
    const keepFrom = p.start + p.duration - this.bufferSeconds;
    while (this.pieces.length > 1 && this.pieces[0].start + this.pieces[0].duration < keepFrom) this.pieces.shift();
    this.emit();
  }

  protected emit(message?: string) {
    const { start, end } = this.available();
    this.onStatus?.({ state: this.state, message, buffered: Math.max(0, end - start), bytes: this.pieces.reduce((n, p) => n + p.data.length, 0) });
  }

  available() {
    if (!this.pieces.length) return { start: 0, end: 0 };
    const last = this.pieces.at(-1)!;
    return { start: this.pieces[0].start, end: last.start + last.duration };
  }

  protected range(start: number, end: number) {
    const sel = this.pieces.filter((p) => p.start + p.duration > start && p.start < end);
    if (!sel.length) throw new Error('out_of_range');
    return sel;
  }

  abstract getRange(start: number, end: number): Promise<MediaRange>;
  abstract stop(): void;
}

// ---------------------------------------------------------------------------
// Twitch live: follows the HLS playlist and keeps the last minutes in memory.
// ---------------------------------------------------------------------------
export class TwitchLiveRecorder extends LiveBuffer {
  private stopped = false;
  private seen = new Set<number>();
  private abort = new AbortController();
  /** Seconds between the HLS timestamps and when viewers (and chat) see it. */
  latency = 0;

  constructor(
    public login: string,
    bufferSeconds: number,
    private maxHeight: number,
  ) {
    super(bufferSeconds);
  }

  async start() {
    const master = await fetchText(api.twitchLivePlaylist(this.login), this.abort.signal);
    const variant = pickVariant(parseMaster(master, location.origin + '/'), this.maxHeight);
    if (!variant) throw new Error('no_variant');
    this.state = 'recording';
    this.emit();
    void this.loop(variant.url);
    return variant;
  }

  private async loop(url: string) {
    let failures = 0;
    while (!this.stopped) {
      let wait = 2000;
      try {
        const pl = parseMedia(await fetchText(url, this.abort.signal), url);
        wait = Math.max(1000, (pl.targetDuration * 1000) / 2);
        const fresh = pl.segments.filter((s) => !this.seen.has(s.seq) && !s.ad);
        for (const s of pl.segments) this.seen.add(s.seq);
        for (const s of fresh) {
          const data = await fetchBytes(s.url, this.abort.signal);
          const start = (s.pdt ?? Date.now() - s.duration * 1000) / 1000;
          this.latency = Math.max(0, Date.now() / 1000 - (start + s.duration));
          this.push({ start, duration: s.duration, data });
        }
        failures = 0;
        if (pl.ended) {
          this.state = 'ended';
          this.emit();
          return;
        }
      } catch (e) {
        if (this.stopped) return;
        failures++;
        this.emit(e instanceof Error ? e.message : String(e));
        if (failures > 15) {
          this.state = 'error';
          this.emit('stream_lost');
          return;
        }
      }
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  async getRange(start: number, end: number): Promise<MediaRange> {
    const sel = this.range(start, end);
    return { files: [{ name: 'input.ts', data: concatBytes(sel.map((p) => p.data)) }], kind: 'ts', offset: Math.max(0, start - sel[0].start), duration: end - start };
  }

  stop() {
    this.stopped = true;
    this.abort.abort();
    this.state = 'ended';
  }
}

// ---------------------------------------------------------------------------
// Tab capture: records the tab where the user watches the stream (YouTube or
// anything else). The recorder restarts every few seconds so each piece is a
// standalone WebM file that can be cut and joined later.
// ---------------------------------------------------------------------------
export class TabRecorder extends LiveBuffer {
  stream?: MediaStream;
  video?: HTMLVideoElement;
  private recorder?: MediaRecorder;
  private timer?: number;
  private stopped = false;

  constructor(
    bufferSeconds: number,
    private pieceSeconds = 6,
  ) {
    super(bufferSeconds);
  }

  static supported() {
    return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getDisplayMedia) && typeof MediaRecorder !== 'undefined';
  }

  async start() {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      // Chrome hints: offer tabs first, include tab audio.
      ...({ preferCurrentTab: false, selfBrowserSurface: 'exclude', systemAudio: 'include', surfaceSwitching: 'include' } as object),
    } as DisplayMediaStreamOptions);
    this.stream = stream;
    if (!stream.getAudioTracks().length) this.emit('no_audio');
    stream.getVideoTracks()[0]?.addEventListener('ended', () => this.stop());
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play().catch(() => {});
    this.video = video;
    this.state = 'recording';
    this.next();
    this.emit();
  }

  private mime() {
    for (const m of ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']) if (MediaRecorder.isTypeSupported(m)) return m;
    return '';
  }

  private next() {
    if (this.stopped || !this.stream) return;
    const rec = new MediaRecorder(this.stream, { mimeType: this.mime(), videoBitsPerSecond: 6_000_000, audioBitsPerSecond: 160_000 });
    const chunks: Blob[] = [];
    const startedAt = Date.now() / 1000;
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = async () => {
      const blob = new Blob(chunks, { type: rec.mimeType });
      const duration = Date.now() / 1000 - startedAt;
      if (blob.size) this.push({ start: startedAt, duration, data: new Uint8Array(await blob.arrayBuffer()) });
    };
    rec.start();
    this.recorder = rec;
    this.timer = window.setTimeout(() => {
      // Start the next piece before stopping this one to minimize the gap.
      const old = this.recorder;
      this.next();
      old?.stop();
    }, this.pieceSeconds * 1000);
  }

  async getRange(start: number, end: number): Promise<MediaRange> {
    const sel = this.range(start, end);
    return {
      files: sel.map((p, i) => ({ name: `piece${String(i).padStart(3, '0')}.webm`, data: p.data })),
      kind: 'webm',
      offset: Math.max(0, start - sel[0].start),
      duration: end - start,
    };
  }

  /** Current frame (for the layout editor). */
  snapshot(): HTMLCanvasElement | null {
    const v = this.video;
    if (!v || !v.videoWidth) return null;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d')!.drawImage(v, 0, 0);
    return c;
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.recorder?.state === 'recording') this.recorder.stop();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.state = 'ended';
    this.emit();
  }
}

// ---------------------------------------------------------------------------
// Live chat
// ---------------------------------------------------------------------------

/** Twitch chat over the public anonymous IRC WebSocket. Returns a stop function. */
export function twitchLiveChat(login: string, onMessage: (m: ChatMessage) => void, onState?: (s: 'open' | 'closed') => void): () => void {
  let ws: WebSocket | undefined;
  let closed = false;
  let retry = 0;
  const connect = () => {
    ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
    ws.onopen = () => {
      retry = 0;
      ws!.send('CAP REQ :twitch.tv/tags');
      ws!.send('PASS SCHMOOPIIE');
      ws!.send(`NICK justinfan${Math.floor(10000 + Math.random() * 80000)}`);
      ws!.send(`JOIN #${login}`);
      onState?.('open');
    };
    ws.onmessage = (e) => {
      for (const line of String(e.data).split('\r\n')) {
        if (!line) continue;
        if (line.startsWith('PING')) {
          ws!.send(line.replace('PING', 'PONG'));
          continue;
        }
        const m = parseIrc(line);
        if (m) onMessage(m);
      }
    };
    ws.onclose = () => {
      onState?.('closed');
      if (!closed) setTimeout(connect, Math.min(30000, 1000 * 2 ** retry++));
    };
  };
  connect();
  return () => {
    closed = true;
    ws?.close();
  };
}

export function parseIrc(line: string): ChatMessage | null {
  // @tags :user!user@user.tmi.twitch.tv PRIVMSG #channel :message
  const m = line.match(/^(?:@(\S+) )?:(\w+)!\S+ PRIVMSG #\w+ :(.*)$/);
  if (!m) return null;
  const tags = Object.fromEntries((m[1] ?? '').split(';').map((kv) => kv.split('=') as [string, string]));
  const ts = Number(tags['tmi-sent-ts']) || Date.now();
  return { t: ts / 1000, u: tags['display-name'] || m[2], m: m[3].replace(/^\u0001ACTION (.*)\u0001$/, '$1') };
}

/** YouTube live chat through the official Data API (via the edge API). */
export function youtubeLiveChat(liveChatId: string, onMessage: (m: ChatMessage) => void, onError?: (e: Error) => void): () => void {
  let stopped = false;
  let page: string | undefined;
  const since = Date.now() / 1000 - 5;
  const loop = async () => {
    while (!stopped) {
      let wait = 6000;
      try {
        const r = await api.youtubeChat(liveChatId, page);
        page = r.next ?? page;
        for (const m of r.messages) if (m.t >= since) onMessage(m);
        wait = r.wait;
      } catch (e) {
        onError?.(e as Error);
        wait = 15000;
      }
      await new Promise((r) => setTimeout(r, wait));
    }
  };
  void loop();
  return () => {
    stopped = true;
  };
}
