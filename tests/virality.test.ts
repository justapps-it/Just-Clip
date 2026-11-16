import { describe, expect, it } from 'vitest';
import { buildAss } from '../src/lib/captions';
import { audioFeatures, chatFeatures, smartBounds, virality } from '../src/lib/virality';
import type { ChatMessage } from '../src/lib/api';

function chat(burst: (i: number) => string, users = 80): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let t = 0; t < 600; t += 2) out.push({ t, u: `u${t % 37}`, m: 'just chatting about stuff' });
  for (let i = 0; i < users; i++) out.push({ t: 300 + (i % 10), u: `v${i}`, m: burst(i) });
  return out.sort((a, b) => a.t - b.t);
}

describe('virality', () => {
  it('ranks a unanimous laughing burst above a noisy one', () => {
    const laugh = chatFeatures(chat(() => 'LMAOOO'), 305);
    const noise = chatFeatures(chat((i) => `random message number ${i} about things`), 305);
    expect(laugh.consensus).toBeGreaterThan(0.6);
    expect(laugh.emotion).toBe('laugh');
    expect(laugh.topReaction).toBe('LMAOO');
    const a = virality({ z: 4, chat: laugh, duration: 30 }).score;
    const b = virality({ z: 4, chat: noise, duration: 30 }).score;
    expect(a).toBeGreaterThan(b + 15);
  });
  it('counts clip requests and shock', () => {
    const f = chatFeatures(chat((i) => (i % 2 ? 'CLIP IT' : 'WTF???')), 305);
    expect(f.clipRequests).toBeGreaterThan(30);
    expect(f.emotion).toBe('shock');
  });
  it('finds the loud moment in audio and tightens the cut', () => {
    const sr = 16000;
    const pcm = new Float32Array(sr * 40);
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin(i / 7) * (i > sr * 22 && i < sr * 26 ? 0.8 : 0.02);
    const a = audioFeatures(pcm, sr);
    expect(a.loudLift).toBeGreaterThan(20);
    expect(a.onset).toBeGreaterThan(21);
    expect(a.onset).toBeLessThan(23);
    // range starts at 100 s; chat peak at 128 s (6 s after the event at ~122 s)
    const b = smartBounds(128, 25, 8, a, 100);
    expect(b.start).toBeCloseTo(112, 0);
    expect(b.hookAt).toBeCloseTo(10, 0);
  });
  it('prefers 15–35 s clips', () => {
    const f = chatFeatures(chat(() => 'KEKW'), 305);
    expect(virality({ z: 4, chat: f, duration: 30 }).score).toBeGreaterThan(virality({ z: 4, chat: f, duration: 75 }).score);
  });
  it('adds a title card to the subtitles', () => {
    const ass = buildAss([], { width: 720, height: 1280, fontSize: 54, y: 486, maxWords: 3 }, { text: 'chat: lmao', until: 3, y: 115 });
    expect(ass).toContain('Style: Hook,Inter ExtraBold,43');
    expect(ass).toContain('Dialogue: 1,0:00:00.00,0:00:03.00,Hook,,0,0,0,,{\\pos(360,115)\\fad(120,200)}CHAT: LMAO');
  });
});
