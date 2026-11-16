// Virality index (0–100) for a candidate moment.
//
// Short-form clips that travel share a few traits: a strong collective
// reaction (many people, same reaction, instantly), an emotional payoff
// (laughter, shock, hype), a sudden change (surprise), something audible
// happening on stream, and a tight structure (the event comes early, the
// clip is short). Clipping tools score along similar lines (OpusClip: hook,
// flow, value, trend) and research on Twitch highlights (LIGHTOR, Ringer
// 2022, MINT) uses chat volume, message similarity and message length.
//
// Each signal is normalized to 0..1 and combined with fixed weights; the
// audio part is optional (computed when the audio is available).

import type { ChatMessage } from './api';

export type Emotion = 'laugh' | 'hype' | 'shock' | 'clip';

const EMOTION_WORDS: Record<Emotion, RegExp> = {
  laugh: /^(lol+|lmao+|lmfao+|kekw|kek|omegalul|icant|xd+|l+u+l+|(a?ha){2,}h?|(ja){2,}|rofl|dead|morto|sto morendo)$/,
  hype: /^(pog|pogchamp|poggers|pogu|w+|letsgo+|lets|goat|insane|clean|massive|huge|aura|ez|gg|fire|cinema|peak)$/,
  shock: /^(wtf|omg|omfg|what|huh|no+|holy|bruh|wait|nah|yo+|madonna|oddio|cosa|bro)$/,
  clip: /^(clip|clipit|clipped|clippa|clippate|clipper|clipalo)$/,
};
const EMOTION_EMOJI: Record<Emotion, RegExp> = {
  laugh: /[😂🤣💀😭]/u,
  hype: /[🔥💯🐐🚀👑]/u,
  shock: /[😱🤯😳😮👀🫨]/u,
  clip: /🎬/u,
};

function emotionsOf(text: string): Set<Emotion> {
  const out = new Set<Emotion>();
  const words = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (const e of Object.keys(EMOTION_WORDS) as Emotion[]) {
    if (words.some((w) => EMOTION_WORDS[e].test(w)) || EMOTION_EMOJI[e].test(text)) out.add(e);
  }
  if (/clip\s*(it|that|this)|clippa/i.test(text)) out.add('clip');
  if (/\?{2,}|!{3,}/.test(text)) out.add('shock');
  return out;
}

/** Normal form used to measure "everyone typing the same thing". */
function normalize(text: string): string {
  const first = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{Extended_Pictographic}\s]/gu, '')
    .trim()
    .split(/\s+/)[0] ?? '';
  // "LMAOOOO" → "lmao", "hahahaha" → "haha"
  return first.replace(/(.)\1{2,}/gu, '$1$1').replace(/^((?:a?ha){2})(?:a?ha)+h?$/, '$1');
}

const sat = (x: number) => Math.max(0, Math.min(1, x));
const median = (a: number[]) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export interface ChatFeatures {
  /** Messages per second in the reaction window vs. around it. */
  lift: number;
  /** Share of messages with a reaction (laugh, hype, shock, clip). */
  reaction: number;
  /** Share of messages repeating one of the 3 most common forms. */
  consensus: number;
  /** Rise speed: rate in the last 4 s before the peak vs. the 10 s before. */
  sharpness: number;
  /** Distinct chatters in the window vs. a baseline window of equal length. */
  breadth: number;
  /** Baseline / window median message length (short messages = instinct). */
  brevity: number;
  emotion: Emotion | null;
  clipRequests: number;
  /** Most typed reaction, to use as hook title. */
  topReaction: string;
}

function windowOf(messages: ChatMessage[], from: number, to: number): ChatMessage[] {
  // messages are sorted by t
  let lo = 0;
  let hi = messages.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (messages[mid].t < from) lo = mid + 1;
    else hi = mid;
  }
  const out: ChatMessage[] = [];
  for (let i = lo; i < messages.length && messages[i].t < to; i++) out.push(messages[i]);
  return out;
}

export function chatFeatures(sorted: ChatMessage[], peak: number): ChatFeatures {
  const W0 = peak - 8;
  const W1 = peak + 6;
  const win = windowOf(sorted, W0, W1);
  const before = windowOf(sorted, peak - 150, peak - 25);
  const after = windowOf(sorted, peak + 25, peak + 150);
  const base = [...before, ...after];
  const firstT = sorted[0]?.t ?? peak;
  const lastT = sorted[sorted.length - 1]?.t ?? peak;
  const baseSpan = Math.max(1, Math.max(0, peak - 25 - Math.max(peak - 150, firstT)) + Math.max(0, Math.min(peak + 150, lastT) - (peak + 25)));
  const winSpan = W1 - W0;
  const rateW = win.length / winSpan;
  const rateB = base.length / baseSpan;

  const counts = new Map<string, number>();
  const reactionCounts = new Map<string, number>();
  const emo: Record<Emotion, number> = { laugh: 0, hype: 0, shock: 0, clip: 0 };
  let reacting = 0;
  for (const m of win) {
    const n = normalize(m.m);
    if (n) counts.set(n, (counts.get(n) ?? 0) + 1);
    const e = emotionsOf(m.m);
    if (e.size) {
      reacting++;
      if (n) reactionCounts.set(n, (reactionCounts.get(n) ?? 0) + 1);
    }
    e.forEach((x) => emo[x]++);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const topShare = top.slice(0, 3).reduce((n, [, c]) => n + c, 0) / Math.max(1, win.length);
  // Title: the most typed reaction ("LMAO", "WTF", "W"), as chat wrote it.
  const topMsg = [...reactionCounts.entries()].sort((a, b) => b[1] - a[1]).find(([k, c]) => c >= 2 && k.length <= 16)?.[0].toUpperCase() ?? '';

  const rising = windowOf(sorted, peak - 4, peak).length / 4;
  const earlier = windowOf(sorted, peak - 14, peak - 4).length / 10;
  const usersW = new Set(win.map((m) => m.u)).size;
  const baseSlice = windowOf(sorted, peak - 60, peak - 60 + winSpan);
  const usersB = Math.max(1, new Set(baseSlice.map((m) => m.u)).size);
  const lenW = median(win.map((m) => m.m.length));
  const lenB = median(base.map((m) => m.m.length));
  const dominant = (Object.entries(emo) as [Emotion, number][])
    .filter(([e]) => e !== 'clip')
    .sort((a, b) => b[1] - a[1])[0];

  return {
    lift: rateW / Math.max(rateB, 0.15),
    reaction: reacting / Math.max(1, win.length),
    consensus: topShare,
    sharpness: rising / Math.max(earlier, 0.3),
    breadth: usersW / usersB,
    brevity: lenB && lenW ? lenB / lenW : 1,
    emotion: dominant && dominant[1] >= 3 ? dominant[0] : emo.clip >= 3 ? 'clip' : null,
    clipRequests: emo.clip,
    topReaction: topMsg,
  };
}

export interface AudioFeatures {
  /** Loudest 0.5 s vs. the clip median (dB). */
  loudLift: number;
  /** Seconds from clip start to the strongest loudness rise. */
  onset: number;
  /** Share of the clip below -45 dBFS. */
  silence: number;
}

/** Loudness analysis of mono PCM (any sample rate). */
export function audioFeatures(pcm: Float32Array, sampleRate: number): AudioFeatures {
  const hop = Math.round(sampleRate * 0.1);
  const db: number[] = [];
  for (let i = 0; i + hop <= pcm.length; i += hop) {
    let acc = 0;
    for (let j = i; j < i + hop; j++) acc += pcm[j] * pcm[j];
    db.push(10 * Math.log10(acc / hop + 1e-10));
  }
  if (db.length < 10) return { loudLift: 0, onset: 0, silence: 1 };
  const smooth = db.map((_, i) => {
    const s = db.slice(Math.max(0, i - 2), i + 3);
    return s.reduce((a, b) => a + b, 0) / s.length;
  });
  const med = median(smooth);
  let best = 0;
  let bestRise = -Infinity;
  for (let i = 5; i < smooth.length; i++) {
    const rise = smooth[i] - Math.min(...smooth.slice(Math.max(0, i - 15), i - 2));
    if (rise > bestRise) {
      bestRise = rise;
      best = i;
    }
  }
  return {
    loudLift: Math.max(...smooth) - med,
    onset: best * 0.1,
    silence: db.filter((d) => d < -45).length / db.length,
  };
}

export interface Virality {
  score: number;
  parts: { key: ViralityPart; value: number }[];
  emotion: Emotion | null;
}

export type ViralityPart = 'intensity' | 'consensus' | 'emotion' | 'surprise' | 'audio' | 'structure';

const WEIGHTS: Record<ViralityPart, number> = {
  intensity: 0.26,
  consensus: 0.14,
  emotion: 0.18,
  surprise: 0.12,
  audio: 0.16,
  structure: 0.14,
};

export function virality(opts: { z: number; chat: ChatFeatures; audio?: AudioFeatures; duration: number; hookAt?: number }): Virality {
  const { chat, audio } = opts;
  const parts: Record<ViralityPart, number | null> = {
    // How much chat stands out (robust z) and how many more messages than usual.
    intensity: sat(0.65 * sat(opts.z / 4) + 0.35 * sat((chat.lift - 1) / 2.5)) * (0.75 + 0.25 * sat(chat.breadth / 2)) + 0.15 * sat((chat.reaction - 0.3) / 0.3),
    consensus: sat((chat.consensus - 0.1) / 0.35),
    emotion: sat(chat.reaction * 1.4 + Math.min(0.3, chat.clipRequests * 0.06) + (chat.emotion === 'laugh' || chat.emotion === 'shock' ? 0.1 : 0)),
    surprise: sat((chat.sharpness - 1) / 2.5) * 0.8 + sat((chat.brevity - 1) / 1) * 0.2,
    audio: audio ? sat((audio.loudLift - 5) / 13) * (1 - 0.6 * sat((audio.silence - 0.2) / 0.5)) : null,
    // 15–35 s is the sweet spot; the event should land within the first ~12 s.
    structure:
      (opts.duration < 12 ? sat(opts.duration / 12) : opts.duration <= 35 ? 1 : sat(1 - (opts.duration - 35) / 30)) *
      (opts.hookAt === undefined ? 0.85 : opts.hookAt <= 12 ? 1 : sat(1 - (opts.hookAt - 12) / 15)),
  };
  let total = 0;
  let weight = 0;
  for (const [k, v] of Object.entries(parts) as [ViralityPart, number | null][]) {
    if (v === null) continue;
    total += WEIGHTS[k] * v;
    weight += WEIGHTS[k];
  }
  return {
    score: Math.round((100 * total) / weight),
    parts: (Object.entries(parts) as [ViralityPart, number | null][]).filter(([, v]) => v !== null).map(([key, value]) => ({ key, value: value as number })),
    emotion: chat.emotion,
  };
}

/**
 * Tighter, hook-first boundaries: when the audio shows where the action is,
 * start a few seconds before it (setup) and end after the reaction.
 * `rangeStart` is the start of the analyzed audio, in the source clock.
 */
export function smartBounds(peak: number, before: number, after: number, audio: AudioFeatures | undefined, rangeStart: number): { start: number; end: number; hookAt?: number } {
  let start = peak - before;
  let end = peak + after;
  if (audio && audio.loudLift >= 6) {
    const event = rangeStart + audio.onset;
    if (event > peak - before - 5 && event < peak + 2) {
      start = Math.max(peak - before - 5, event - Math.min(10, before));
      end = Math.max(end, event + 6);
    }
    return { start, end, hookAt: event - start };
  }
  return { start, end };
}
