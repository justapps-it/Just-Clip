// Minimal HLS support: playlist parsing and segment download.

export interface Variant {
  url: string;
  bandwidth: number;
  width: number;
  height: number;
  fps: number;
  name: string;
  audioOnly: boolean;
}

export interface Segment {
  url: string;
  duration: number;
  /** Media sequence number (stable across live playlist refreshes). */
  seq: number;
  /** Start within the playlist (seconds). */
  start: number;
  /** Wall clock start (ms) from EXT-X-PROGRAM-DATE-TIME, when present. */
  pdt?: number;
  /** EXTINF title; Twitch marks real stream segments as "live". */
  title: string;
  /** Twitch ad / discontinuity markers. */
  ad: boolean;
}

export interface MediaPlaylist {
  segments: Segment[];
  targetDuration: number;
  ended: boolean;
}

function attrs(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out[m[1]] = m[3] ?? m[2];
  return out;
}

export function parseMaster(text: string, base: string): Variant[] {
  const lines = text.split(/\r?\n/);
  const names = new Map<string, string>();
  for (const l of lines) {
    if (l.startsWith('#EXT-X-MEDIA:')) {
      const a = attrs(l);
      if (a['GROUP-ID'] && a.NAME) names.set(a['GROUP-ID'], a.NAME);
    }
  }
  const variants: Variant[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
    const a = attrs(lines[i]);
    let j = i + 1;
    while (j < lines.length && (!lines[j].trim() || lines[j].startsWith('#'))) j++;
    if (j >= lines.length) break;
    const [w, h] = (a.RESOLUTION ?? '0x0').split('x').map(Number);
    const group = a.VIDEO ?? '';
    variants.push({
      url: new URL(lines[j].trim(), base).href,
      bandwidth: Number(a.BANDWIDTH) || 0,
      width: w || 0,
      height: h || 0,
      fps: Number(a['FRAME-RATE']) || 30,
      name: names.get(group) ?? (h ? `${h}p` : group),
      audioOnly: group === 'audio_only' || (!w && /mp4a/.test(a.CODECS ?? '') && !/avc|hvc|av01/.test(a.CODECS ?? '')),
    });
  }
  return variants;
}

/** Best variant not taller than `maxHeight`, preferring 30 fps (cheaper to render). */
export function pickVariant(variants: Variant[], maxHeight: number): Variant | undefined {
  const video = variants.filter((v) => !v.audioOnly && v.height > 0);
  const fit = video.filter((v) => v.height <= maxHeight);
  const pool = fit.length ? fit : video.sort((a, b) => a.height - b.height).slice(0, 1);
  return pool.sort((a, b) => b.height - a.height || Math.abs(a.fps - 30) - Math.abs(b.fps - 30) || a.bandwidth - b.bandwidth)[0];
}

export function parseMedia(text: string, base: string): MediaPlaylist {
  const lines = text.split(/\r?\n/);
  const segments: Segment[] = [];
  let seq = 0;
  let targetDuration = 6;
  let ended = false;
  let pendingDur = 0;
  let pendingTitle = '';
  let pendingPdt: number | undefined;
  let inAd = false;
  let start = 0;
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) continue;
    if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = Number(l.slice(22)) || 0;
    else if (l.startsWith('#EXT-X-TARGETDURATION:')) targetDuration = Number(l.slice(22)) || targetDuration;
    else if (l.startsWith('#EXT-X-ENDLIST')) ended = true;
    else if (l.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) pendingPdt = Date.parse(l.slice(25));
    else if (l.startsWith('#EXT-X-DATERANGE:')) {
      const a = attrs(l);
      if (/stitched-ad|twitch-ad|amazon/i.test(`${a.CLASS ?? ''} ${a.ID ?? ''}`)) inAd = true;
    } else if (l.startsWith('#EXT-X-DISCONTINUITY')) inAd = false;
    else if (l.startsWith('#EXTINF:')) {
      const [d, ...title] = l.slice(8).split(',');
      pendingDur = Number(d) || 0;
      pendingTitle = title.join(',').trim();
    } else if (!l.startsWith('#')) {
      const ad = inAd || /amazon|adsquared|twitch-ad|stitched/i.test(pendingTitle);
      segments.push({
        url: new URL(l, base).href,
        duration: pendingDur,
        seq: seq++,
        start,
        pdt: pendingPdt,
        title: pendingTitle,
        ad,
      });
      start += pendingDur;
      // Without explicit PDTs, extrapolate from the previous one.
      pendingPdt = pendingPdt !== undefined ? pendingPdt + pendingDur * 1000 : undefined;
      pendingDur = 0;
      pendingTitle = '';
    }
  }
  return { segments, targetDuration, ended };
}

// ---- Fetching ---------------------------------------------------------------

let directBlocked = false;

const proxied = (url: string) => (url.startsWith('/api/') || url.includes('/api/proxy?') ? url : `/api/proxy?u=${encodeURIComponent(url)}`);

/**
 * Downloads a segment straight from the CDN, falling back to the edge proxy
 * if the CDN doesn't allow cross-origin requests (remembered afterwards).
 */
export async function fetchBytes(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  if (!directBlocked && !url.startsWith('/')) {
    try {
      const res = await fetch(url, { signal, mode: 'cors', credentials: 'omit' });
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
    }
    directBlocked = true;
  }
  const res = await fetch(proxied(url), { signal });
  if (!res.ok) throw new Error(`segment_${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(url, { signal, cache: 'no-store' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `playlist_${res.status}`);
  }
  return res.text();
}

/** Runs async jobs with bounded concurrency, keeping result order. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
