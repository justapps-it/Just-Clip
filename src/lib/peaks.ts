// Finds the moments where chat explodes.
//
// Each message gets a weight (hype words, emotes, caps, "!!!", "???"), the
// weights are summed per second and smoothed; a moment is a local maximum
// that stands out from the surrounding baseline (robust z-score: median and
// MAD, so a busy chat doesn't flag everything and a quiet one still works).

import type { ChatMessage } from './api';

const HYPE = [
  'lul', 'lol', 'lmao', 'lmfao', 'kekw', 'kek', 'omegalul', 'icant', 'xd', 'xdd', 'haha', 'hahaha', 'ahah', 'ahahah', 'jaja', 'jajaja',
  'pog', 'pogchamp', 'poggers', 'pogu', 'poggies', 'pogger', 'w', 'ww', 'www', 'holy', 'wtf', 'omg', 'clip', 'clipit', 'clipped',
  'insane', 'gg', 'ez', 'rip', 'wow', 'letsgo', 'lets', 'goat', 'aura', 'monkas', 'pepega', 'sadge', 'omegakek', 'ratio',
  'nooo', 'noooo', 'what', 'bruh', 'madonna', 'dio', 'assurdo', 'pazzesco', 'raga', 'clippa', 'grande', 'oddio',
];
const HYPE_SET = new Set(HYPE);
const HYPE_EMOJI = /[😂🤣💀🔥😱😭🤯👀🫡💯🥶😳]/u;

export function messageWeight(text: string): number {
  const m = text.trim();
  if (!m) return 0;
  let w = 1;
  const words = m.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.some((x) => HYPE_SET.has(x) || /^(a?ha){2,}h?$|^(ja){2,}$|^x+d+$|^l+u+l+$|^w{2,}$|^no{3,}$/.test(x))) w += 1;
  if (HYPE_EMOJI.test(m)) w += 0.5;
  if (/[!?]{2,}/.test(m)) w += 0.5;
  const letters = m.replace(/[^\p{L}]/gu, '');
  if (letters.length >= 4 && letters === letters.toUpperCase() && letters !== letters.toLowerCase()) w += 0.5;
  return Math.min(w, 3);
}

/** Weighted activity per second, starting at `t0`. */
export function activitySeries(messages: ChatMessage[], t0: number, t1: number): Float64Array {
  const n = Math.max(1, Math.ceil(t1 - t0) + 1);
  const s = new Float64Array(n);
  for (const msg of messages) {
    const i = Math.floor(msg.t - t0);
    if (i >= 0 && i < n) s[i] += messageWeight(msg.m);
  }
  return s;
}

/** Moving sum over `w` seconds (centered). */
export function smooth(s: Float64Array, w: number): Float64Array {
  const out = new Float64Array(s.length);
  const half = Math.floor(w / 2);
  let acc = 0;
  for (let i = 0; i < s.length + half; i++) {
    if (i < s.length) acc += s[i];
    if (i - w >= 0) acc -= s[i - w];
    const j = i - half;
    if (j >= 0 && j < s.length) out[j] = acc;
  }
  return out;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const a = [...values].sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

export interface Peak {
  /** Seconds (same clock as the chat timestamps). */
  t: number;
  score: number;
  z: number;
  /** Weighted messages in the smoothing window at the peak. */
  activity: number;
}

export type Sensitivity = 'low' | 'medium' | 'high';
export const Z_THRESHOLD: Record<Sensitivity, number> = { low: 3.2, medium: 2.4, high: 1.8 };

export interface PeakOptions {
  sensitivity: Sensitivity;
  /** Minimum distance between two moments (seconds). */
  minGap: number;
  /** Max number of moments returned (best first). */
  limit: number;
  /** Seconds of context used for the baseline. */
  baselineWindow?: number;
  smoothWindow?: number;
}

const isHype = (text: string) => messageWeight(text) > 1;

/** Robust z-score of `s[i]` against the window around it (excluding itself). */
function zScoreAt(s: Float64Array, i: number, win: number, step: number, from = 0, floor = 1): number {
  const half = Math.floor(win / 2);
  const sample: number[] = [];
  for (let j = Math.max(from, i - half); j < Math.min(s.length, i + half); j += step) {
    if (Math.abs(j - i) > 15) sample.push(s[j]);
  }
  if (sample.length < 10) return 0;
  const base = median(sample);
  const mad = median(sample.map((v) => Math.abs(v - base))) * 1.4826;
  return (s[i] - base) / Math.max(mad, floor);
}

/**
 * Two signals, each against its own baseline:
 *  - volume: how many messages (works for normal chats);
 *  - reaction share: the fraction of laughs / hype / emotes (works when the
 *    chat is saturated or replay is capped, as on very big channels).
 */
interface Signals {
  volume: Float64Array;
  hype: Float64Array;
  ratio: Float64Array;
}

function signals(count: Float64Array, hype: Float64Array, smoothW: number): Signals {
  const volume = smooth(count, smoothW);
  const h = smooth(hype, smoothW);
  const ratio = new Float64Array(volume.length);
  for (let i = 0; i < ratio.length; i++) ratio[i] = h[i] / (volume[i] + 4);
  return { volume, hype: h, ratio };
}

function combinedZ(sig: Signals, i: number, win: number, step: number, from = 0): number {
  const zv = zScoreAt(sig.volume, i, win, step, from, Math.sqrt(Math.max(1, median([sig.volume[i]]))));
  const zr = zScoreAt(sig.ratio, i, win, step, from, 0.03);
  // Reward moments where both signals agree.
  return Math.max(zv, zr) + 0.35 * Math.max(0, Math.min(zv, zr));
}

/** Offline detection over a whole VOD. */
export function findPeaks(messages: ChatMessage[], t0: number, t1: number, opts: PeakOptions): Peak[] {
  const n = Math.max(1, Math.ceil(t1 - t0) + 1);
  const count = new Float64Array(n);
  const hype = new Float64Array(n);
  for (const m of messages) {
    const i = Math.floor(m.t - t0);
    if (i < 0 || i >= n) continue;
    count[i]++;
    if (isHype(m.m)) hype[i]++;
  }
  const sig = signals(count, hype, opts.smoothWindow ?? 10);
  const win = opts.baselineWindow ?? 600;
  const threshold = Z_THRESHOLD[opts.sensitivity];
  const z = new Float64Array(n);
  for (let i = 0; i < n; i++) z[i] = sig.hype[i] >= 3 ? combinedZ(sig, i, win, 3) : 0;
  const candidates: Peak[] = [];
  for (let i = 1; i < n - 1; i++) {
    if (z[i] < threshold || z[i] < z[i - 1] || z[i] < z[i + 1]) continue;
    candidates.push({ t: t0 + i, z: z[i], activity: sig.volume[i], score: z[i] * Math.log2(2 + sig.hype[i]) });
  }
  return suppress(candidates, opts.minGap, opts.limit);
}

/** Keeps the best peak in every `gap`-second neighborhood. */
export function suppress(peaks: Peak[], gap: number, limit: number): Peak[] {
  const out: Peak[] = [];
  for (const p of [...peaks].sort((a, b) => b.score - a.score)) {
    if (out.some((q) => Math.abs(q.t - p.t) < gap)) continue;
    out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Online detection for live streams. Feed messages as they arrive and call
 * `poll(now)` regularly: it returns a peak once the burst is over, so the
 * clip can include the aftermath.
 */
export class LiveDetector {
  private count = new Map<number, number>();
  private hype = new Map<number, number>();
  private weighted = new Map<number, number>();
  private lastPeakAt = -Infinity;
  private best: Peak | null = null;
  private firstAt = Infinity;
  /** Seconds of chat needed before triggering (a baseline must exist). */
  static WARMUP = 90;
  constructor(public opts: Omit<PeakOptions, 'limit'>) {}

  add(msg: ChatMessage) {
    const sec = Math.floor(msg.t);
    if (sec < this.firstAt) this.firstAt = sec;
    const w = messageWeight(msg.m);
    this.count.set(sec, (this.count.get(sec) ?? 0) + 1);
    this.weighted.set(sec, (this.weighted.get(sec) ?? 0) + w);
    if (w > 1) this.hype.set(sec, (this.hype.get(sec) ?? 0) + 1);
  }

  /** Weighted chat activity per second for the last `seconds` (for charts). */
  series(now: number, seconds: number): Float64Array {
    const t0 = Math.floor(now) - seconds;
    const s = new Float64Array(seconds + 1);
    for (let i = 0; i <= seconds; i++) s[i] = this.weighted.get(t0 + i) ?? 0;
    return s;
  }

  poll(now: number): Peak | null {
    const win = this.opts.baselineWindow ?? 300;
    const smoothW = this.opts.smoothWindow ?? 10;
    // Analyze up to a few seconds ago so the smoothing window is complete.
    const end = Math.floor(now) - Math.ceil(smoothW / 2);
    const t0 = end - win;
    for (const map of [this.count, this.hype, this.weighted]) for (const k of map.keys()) if (k < t0 - 120) map.delete(k);
    if (end - this.firstAt < LiveDetector.WARMUP) return null;
    const count = new Float64Array(win + 1);
    const hype = new Float64Array(win + 1);
    for (let i = 0; i <= win; i++) {
      count[i] = this.count.get(t0 + i) ?? 0;
      hype[i] = this.hype.get(t0 + i) ?? 0;
    }
    const sig = signals(count, hype, smoothW);
    const i = win;
    const z = sig.hype[i] >= 3 ? combinedZ(sig, i, win * 2, 2, Math.max(0, this.firstAt - t0)) : 0;
    const threshold = Z_THRESHOLD[this.opts.sensitivity];
    if (z >= threshold && end - this.lastPeakAt >= this.opts.minGap) {
      const p = { t: end, z, activity: sig.volume[i], score: z * Math.log2(2 + sig.hype[i]) };
      if (!this.best || p.score > this.best.score) this.best = p;
      return null;
    }
    // The burst is over (or has lasted long enough): emit the best moment.
    if (this.best && (z < threshold * 0.6 || end - this.best.t > 20)) {
      const p = this.best;
      this.best = null;
      this.lastPeakAt = p.t;
      return p;
    }
    return null;
  }
}

/** A few representative messages around a moment (for the UI). */
export function sampleMessages(messages: ChatMessage[], t: number, before = 6, after = 6, n = 4): string[] {
  const near = messages.filter((m) => m.t >= t - before && m.t <= t + after && m.m.trim());
  const counts = new Map<string, number>();
  for (const m of near) {
    const k = m.m.trim();
    counts.set(k, (counts.get(k) ?? 0) + messageWeight(k));
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => (k.length > 60 ? k.slice(0, 57) + '…' : k));
}
