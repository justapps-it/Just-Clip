// A clipping session: one source (VOD, Twitch live, captured tab), its chat,
// the detected moments and the render queue.
import { useSyncExternalStore } from 'react';
import { api, type ChatMessage } from './lib/api';
import { extractFrame, renderClip, type Stage } from './lib/clip';
import type { Format } from './lib/layout';
import { activitySeries, findPeaks, LiveDetector, sampleMessages, smooth } from './lib/peaks';
import {
  loadVodChat,
  TabRecorder,
  TwitchLiveRecorder,
  TwitchVodSource,
  twitchLiveChat,
  youtubeLiveChat,
  type ClipSource,
  type RecorderStatus,
} from './lib/sources';
import { getSettings, layoutFor } from './settings';

export type MomentStatus = 'found' | 'waiting' | 'queued' | 'working' | 'done' | 'error';

export interface Moment {
  id: string;
  /** Chat peak (source clock). */
  peak: number;
  /** Clip range (media clock). */
  start: number;
  end: number;
  score: number;
  samples: string[];
  manual: boolean;
  status: MomentStatus;
  stage?: Stage;
  progress: number | null;
  outputs: { format: Format; url: string; size: number }[];
  thumb?: string;
  transcript?: string;
  error?: string;
}

export type SessionKind = 'twitch-vod' | 'twitch-live' | 'tab';

export interface SessionState {
  kind: SessionKind;
  title: string;
  channel: string;
  thumbnail?: string;
  phase: 'starting' | 'chat' | 'ready' | 'live' | 'ended' | 'error';
  error?: string;
  chatProgress: number;
  chatCount: number;
  chatConnected: boolean;
  /** Chart: weighted chat activity, `step` seconds per value, from `t0`. */
  activity: { t0: number; step: number; values: number[] };
  moments: Moment[];
  /** Live recording status. */
  buffered: number;
  bytes: number;
  now: number;
  /** VOD duration (s). */
  duration: number;
  /** Clock origin for live time labels (unix s). */
  startedAt: number;
  warning?: string;
}

let momentSeq = 0;

export class Session {
  state: SessionState;
  private listeners = new Set<() => void>();
  private source?: ClipSource;
  private messages: ChatMessage[] = [];
  private detector?: LiveDetector;
  private stops: (() => void)[] = [];
  private queue: string[] = [];
  private working = false;
  private abort = new AbortController();
  layoutKey: string;

  constructor(kind: SessionKind, info: { title: string; channel: string; thumbnail?: string; duration?: number }) {
    this.layoutKey = info.channel || 'default';
    this.state = {
      kind,
      title: info.title,
      channel: info.channel,
      thumbnail: info.thumbnail,
      phase: 'starting',
      chatProgress: 0,
      chatCount: 0,
      chatConnected: false,
      activity: { t0: 0, step: 30, values: [] },
      moments: [],
      buffered: 0,
      bytes: 0,
      now: Date.now() / 1000,
      duration: info.duration ?? 0,
      startedAt: Date.now() / 1000,
    };
  }

  // ---- store -----------------------------------------------------------------
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getSnapshot = () => this.state;
  private set(patch: Partial<SessionState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }
  private setMoment(id: string, patch: Partial<Moment>) {
    this.set({ moments: this.state.moments.map((m) => (m.id === id ? { ...m, ...patch } : m)) });
  }

  // ---- Twitch VOD ------------------------------------------------------------
  static async twitchVod(id: string) {
    const v = await api.twitchVideo(id);
    const s = new Session('twitch-vod', { title: v.title, channel: v.channel, thumbnail: v.thumbnail, duration: v.duration });
    void s.startVod(v.id, v.duration);
    return s;
  }

  private async startVod(id: string, duration: number) {
    const src = new TwitchVodSource(id, duration);
    this.source = src;
    try {
      this.set({ phase: 'chat' });
      const [, messages] = await Promise.all([
        src.load(getSettings().quality),
        loadVodChat(id, duration, (p, n) => this.set({ chatProgress: p, chatCount: n }), this.abort.signal),
      ]);
      this.messages = messages.sort((a, b) => a.t - b.t);
      this.analyzeVod();
      this.set({ phase: 'ready', chatCount: messages.length });
    } catch (e) {
      if (this.abort.signal.aborted) return;
      this.set({ phase: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** (Re)computes moments from the whole chat, keeping rendered ones. */
  analyzeVod() {
    const st = getSettings();
    const dur = this.state.duration;
    const s = smooth(activitySeries(this.messages, 0, dur), 1);
    const step = Math.max(10, Math.round(dur / 400));
    const values: number[] = [];
    for (let i = 0; i < s.length; i += step) {
      let acc = 0;
      for (let j = i; j < Math.min(s.length, i + step); j++) acc += s[j];
      values.push(acc);
    }
    const peaks = findPeaks(this.messages, 0, dur, { sensitivity: st.sensitivity, minGap: st.before + st.after, limit: st.maxMoments });
    const keep = this.state.moments.filter((m) => m.manual || m.status !== 'found');
    const fresh = peaks
      .filter((p) => !keep.some((m) => Math.abs(m.peak - p.t) < (st.before + st.after) / 2))
      .map((p) => this.newMoment(p.t, p.score, false));
    this.set({ activity: { t0: 0, step, values }, moments: [...keep, ...fresh].sort((a, b) => a.peak - b.peak) });
  }

  // ---- Twitch live -----------------------------------------------------------
  static async twitchLive(login: string, info: { title: string; channel: string; thumbnail?: string }) {
    const s = new Session('twitch-live', info);
    void s.startTwitchLive(login);
    return s;
  }

  private async startTwitchLive(login: string) {
    const st = getSettings();
    const rec = new TwitchLiveRecorder(login, st.bufferMinutes * 60, st.quality);
    this.source = rec;
    this.watchRecorder(rec);
    try {
      await rec.start();
      this.set({ phase: 'live' });
    } catch (e) {
      this.set({ phase: 'error', error: e instanceof Error ? e.message : String(e) });
      return;
    }
    this.stops.push(() => rec.stop());
    this.stops.push(
      twitchLiveChat(
        login,
        (m) => this.onLiveMessage(m),
        (s) => this.set({ chatConnected: s === 'open' }),
      ),
    );
    this.startLiveLoop(() => rec.latency);
  }

  // ---- Tab capture (YouTube or anything) -------------------------------------
  static async tab(info: { title: string; channel: string; thumbnail?: string; liveChatId?: string | null }) {
    const st = getSettings();
    const rec = new TabRecorder(st.bufferMinutes * 60);
    await rec.start(); // must run inside the click handler (user gesture)
    const s = new Session('tab', info);
    s.source = rec;
    s.watchRecorder(rec);
    s.set({ phase: 'live' });
    s.stops.push(() => rec.stop());
    if (info.liveChatId) {
      s.stops.push(
        youtubeLiveChat(
          info.liveChatId,
          (m) => s.onLiveMessage(m),
          (e) => s.set({ warning: e.message, chatConnected: false }),
        ),
      );
      s.set({ chatConnected: true });
    }
    s.startLiveLoop(() => 0);
    return s;
  }

  snapshot(): HTMLCanvasElement | null {
    return this.source instanceof TabRecorder ? this.source.snapshot() : null;
  }

  private watchRecorder(rec: TwitchLiveRecorder | TabRecorder) {
    rec.onStatus = (s: RecorderStatus) => {
      this.set({
        buffered: s.buffered,
        bytes: s.bytes,
        ...(s.state === 'ended' && this.state.phase === 'live' ? { phase: 'ended' as const } : {}),
        ...(s.state === 'error' ? { phase: 'error' as const, error: s.message } : {}),
        ...(s.message === 'no_audio' ? { warning: 'no_audio' } : {}),
      });
    };
  }

  private onLiveMessage(m: ChatMessage) {
    this.detector?.add(m);
    this.messages.push(m);
    if (this.messages.length > 20000) this.messages.splice(0, 5000);
    this.state = { ...this.state, chatCount: this.state.chatCount + 1 };
  }

  private startLiveLoop(latency: () => number) {
    const st = getSettings();
    this.detector = new LiveDetector({ sensitivity: st.sensitivity, minGap: st.before + st.after });
    const timer = window.setInterval(() => {
      const now = Date.now() / 1000;
      const peak = this.detector!.poll(now);
      if (peak) {
        const m = this.newMoment(peak.t - latency(), peak.score, false, peak.t);
        this.set({ moments: [...this.state.moments, m] });
        if (getSettings().autoRender) this.render(m.id);
      }
      const series = this.detector!.series(now, 600);
      const step = 5;
      const values: number[] = [];
      for (let i = 0; i < series.length; i += step) values.push(series.slice(i, i + step).reduce((a, b) => a + b, 0));
      this.set({ now, activity: { t0: Math.floor(now) - 600, step, values } });
      this.pump();
    }, 1000);
    this.stops.push(() => clearInterval(timer));
  }

  // ---- moments ---------------------------------------------------------------
  private newMoment(mediaPeak: number, score: number, manual: boolean, chatPeak = mediaPeak): Moment {
    const st = getSettings();
    return {
      id: `m${++momentSeq}`,
      peak: mediaPeak,
      start: Math.max(0, mediaPeak - st.before),
      end: this.state.duration ? Math.min(this.state.duration, mediaPeak + st.after) : mediaPeak + st.after,
      score,
      samples: sampleMessages(this.messages, chatPeak),
      manual,
      status: 'found',
      progress: null,
      outputs: [],
    };
  }

  /** "Clip it!" button: the last N seconds of a live, or around a VOD time. */
  clipNow(at?: number) {
    const st = getSettings();
    const end = at ?? (this.source ? this.source.available().end : Date.now() / 1000);
    const m = this.newMoment(end - st.after, 0, true);
    if (at === undefined) {
      m.end = end;
      m.start = end - st.before - st.after;
    }
    this.set({ moments: [...this.state.moments, m] });
    this.render(m.id);
  }

  adjust(id: string, which: 'start' | 'end', delta: number) {
    const m = this.state.moments.find((x) => x.id === id);
    if (!m) return;
    const v = Math.max(0, m[which] + delta);
    if (which === 'start' && v >= m.end - 3) return;
    if (which === 'end' && v <= m.start + 3) return;
    this.revoke(m);
    this.setMoment(id, { [which]: v, status: m.status === 'done' || m.status === 'error' ? 'found' : m.status, outputs: [], thumb: undefined });
  }

  remove(id: string) {
    const m = this.state.moments.find((x) => x.id === id);
    if (m) this.revoke(m);
    this.queue = this.queue.filter((q) => q !== id);
    this.set({ moments: this.state.moments.filter((x) => x.id !== id) });
  }

  private revoke(m: Moment) {
    m.outputs.forEach((o) => URL.revokeObjectURL(o.url));
    if (m.thumb) URL.revokeObjectURL(m.thumb);
  }

  render(id: string) {
    if (!this.queue.includes(id)) this.queue.push(id);
    this.setMoment(id, { status: 'queued', error: undefined, progress: null });
    this.pump();
  }

  renderAll() {
    for (const m of this.state.moments) if (m.status === 'found' || m.status === 'error') this.render(m.id);
  }

  private async pump() {
    if (this.working || !this.source) return;
    const src = this.source;
    const id = this.queue.find((q) => {
      const m = this.state.moments.find((x) => x.id === q);
      // Live: wait until the end of the clip has been recorded.
      return m && src.available().end >= m.end;
    });
    // Mark the ones still waiting for the stream.
    for (const q of this.queue) {
      const m = this.state.moments.find((x) => x.id === q);
      if (m && q !== id && m.status === 'queued' && src.available().end < m.end) this.setMoment(q, { status: 'waiting' });
    }
    if (!id) return;
    this.working = true;
    this.queue = this.queue.filter((q) => q !== id);
    const m = this.state.moments.find((x) => x.id === id)!;
    const st = getSettings();
    try {
      this.setMoment(id, { status: 'working', stage: 'prepare', progress: null });
      const avail = src.available();
      const range = await src.getRange(Math.max(m.start, avail.start), Math.min(m.end, avail.end), this.abort.signal);
      const formats: Format[] = [...(st.horizontal ? ['horizontal' as const] : []), ...(st.vertical ? ['vertical' as const] : [])];
      const res = await renderClip(
        range,
        { formats: formats.length ? formats : ['vertical'], quality: st.quality, layout: layoutFor(this.layoutKey), subtitles: st.subtitles, language: st.language },
        (stage, p) => this.setMoment(id, { stage, progress: p }),
      );
      this.setMoment(id, {
        status: 'done',
        progress: 1,
        outputs: res.outputs.map((o) => ({ format: o.format, size: o.data.length, url: URL.createObjectURL(new Blob([o.data as BlobPart], { type: 'video/mp4' })) })),
        thumb: URL.createObjectURL(new Blob([res.thumbnail as BlobPart], { type: 'image/jpeg' })),
        transcript: res.words.map((w) => w.text).join(' '),
      });
    } catch (e) {
      if (!this.abort.signal.aborted) this.setMoment(id, { status: 'error', error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.working = false;
      if (!this.abort.signal.aborted) void this.pump();
    }
  }

  /** A frame for the layout editor. */
  async frame(): Promise<string | null> {
    const snap = this.snapshot();
    if (snap) return snap.toDataURL('image/jpeg', 0.85);
    if (!this.source) return null;
    const a = this.source.available();
    if (a.end <= a.start) return null;
    const mid = this.state.kind === 'twitch-vod' ? (this.state.moments[0]?.peak ?? Math.min(600, a.end / 2)) : a.end - 4;
    const range = await this.source.getRange(Math.max(a.start, mid - 1), Math.min(a.end, mid + 1));
    return URL.createObjectURL(await extractFrame(range));
  }

  stop() {
    this.stops.forEach((s) => s());
    this.stops = [];
    if (this.state.phase === 'live' || this.state.phase === 'starting') this.set({ phase: 'ended' });
  }

  dispose() {
    this.stop();
    this.abort.abort();
    this.state.moments.forEach((m) => this.revoke(m));
  }
}

export function useSession(s: Session): SessionState {
  return useSyncExternalStore(s.subscribe, s.getSnapshot);
}
