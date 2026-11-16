import { describe, expect, it } from 'vitest';
import { parseLink } from '../src/lib/api';
import { buildAss, groupWords } from '../src/lib/captions';
import { parseMaster, parseMedia, pickVariant } from '../src/lib/hls';
import { DEFAULT_LAYOUT, videoFilter } from '../src/lib/layout';
import { findPeaks, LiveDetector, messageWeight, sampleMessages } from '../src/lib/peaks';
import { parseIrc } from '../src/lib/sources';
import type { ChatMessage } from '../src/lib/api';

/** Steady background chat with bursts at the given seconds. */
function chat(duration: number, bursts: number[], rate = 0.5): ChatMessage[] {
  const out: ChatMessage[] = [];
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let t = 0; t < duration; t++) if (rnd() < rate) out.push({ t: t + rnd(), u: 'a', m: 'hello there' });
  for (const b of bursts) for (let i = 0; i < 80; i++) out.push({ t: b + rnd() * 10, u: 'b', m: i % 2 ? 'KEKW' : 'LMAO W' });
  return out.sort((a, b) => a.t - b.t);
}

describe('links', () => {
  it('parses Twitch and YouTube links', () => {
    expect(parseLink('https://www.twitch.tv/xqc')).toEqual({ platform: 'twitch', kind: 'channel', login: 'xqc' });
    expect(parseLink('twitch.tv/videos/123456?t=1h2m3s')).toEqual({ platform: 'twitch', kind: 'vod', id: '123456', t: 3723 });
    expect(parseLink('ibai')).toEqual({ platform: 'twitch', kind: 'channel', login: 'ibai' });
    expect(parseLink('https://youtu.be/dQw4w9WgXcQ')).toMatchObject({ platform: 'youtube', id: 'dQw4w9WgXcQ' });
    expect(parseLink('https://www.youtube.com/live/dQw4w9WgXcQ?si=x')).toMatchObject({ platform: 'youtube', id: 'dQw4w9WgXcQ' });
    expect(parseLink('https://www.youtube.com/@LofiGirl')).toMatchObject({ platform: 'youtube', id: undefined });
    expect(parseLink('https://example.com/x')).toBeNull();
  });
});

describe('peaks', () => {
  it('weights hype messages', () => {
    expect(messageWeight('hello')).toBe(1);
    expect(messageWeight('KEKW')).toBeGreaterThan(1.9);
    expect(messageWeight('ahahahah')).toBe(2);
    expect(messageWeight('')).toBe(0);
  });
  it('finds the bursts in a VOD chat', () => {
    const msgs = chat(3600, [600, 1800, 3000]);
    const peaks = findPeaks(msgs, 0, 3600, { sensitivity: 'medium', minGap: 30, limit: 10 });
    expect(peaks.length).toBe(3);
    const ts = peaks.map((p) => p.t).sort((a, b) => a - b);
    expect(ts[0]).toBeGreaterThanOrEqual(598);
    expect(ts[0]).toBeLessThanOrEqual(614);
    expect(ts[2]).toBeGreaterThanOrEqual(2998);
    expect(sampleMessages(msgs, ts[0])[0]).toMatch(/KEKW|LMAO W/);
  });
  it('finds nothing in a flat chat', () => {
    expect(findPeaks(chat(3600, []), 0, 3600, { sensitivity: 'medium', minGap: 30, limit: 10 })).toEqual([]);
  });
  it('detects live bursts once they are over', () => {
    const d = new LiveDetector({ sensitivity: 'medium', minGap: 30 });
    const msgs = chat(900, [700]).map((m) => ({ ...m, t: m.t + 1_700_000_000 }));
    const found: number[] = [];
    let k = 0;
    for (let now = 1_700_000_000; now < 1_700_000_900; now++) {
      while (k < msgs.length && msgs[k].t <= now) d.add(msgs[k++]);
      const p = d.poll(now);
      if (p) found.push(p.t - 1_700_000_000);
    }
    expect(found.length).toBe(1);
    expect(found[0]).toBeGreaterThan(695);
    expect(found[0]).toBeLessThan(720);
  });
});

describe('captions', () => {
  const words = [
    { text: 'no', start: 0, end: 0.2 },
    { text: 'way', start: 0.2, end: 0.5 },
    { text: 'bro', start: 0.5, end: 0.8 },
    { text: 'that', start: 2, end: 2.2 },
    { text: 'was', start: 2.2, end: 2.4 },
    { text: 'insane!', start: 2.4, end: 3 },
  ];
  it('groups by pauses and size', () => {
    expect(groupWords(words, 3).map((g) => g.map((w) => w.text).join(' '))).toEqual(['no way bro', 'that was insane!']);
  });
  it('builds an ASS file with the active word highlighted', () => {
    const ass = buildAss(words, { width: 1080, height: 1920, fontSize: 80, y: 700, maxWords: 3 });
    expect(ass).toContain('PlayResX: 1080');
    expect(ass).toContain('Style: Cap,Inter ExtraBold,80');
    expect(ass).toContain('Dialogue: 0,0:00:00.00,0:00:00.20,Cap,,0,0,0,,{\\pos(540,700)}');
    expect(ass).toContain('{\\c&H001F5AFF}WAY{\\c&H00FFFFFF}');
  });
});

describe('hls', () => {
  const master = `#EXTM3U
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="chunked",NAME="1080p60"
#EXT-X-STREAM-INF:BANDWIDTH=8000000,CODECS="avc1.64002A,mp4a.40.2",RESOLUTION=1920x1080,VIDEO="chunked",FRAME-RATE=60.000
https://cdn/chunked/index.m3u8
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="720p60",NAME="720p60"
#EXT-X-STREAM-INF:BANDWIDTH=3400000,RESOLUTION=1280x720,VIDEO="720p60",FRAME-RATE=60.000
https://cdn/720p60/index.m3u8
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="720p30",NAME="720p"
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,VIDEO="720p30",FRAME-RATE=30.000
https://cdn/720p30/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=160000,CODECS="mp4a.40.2",VIDEO="audio_only"
https://cdn/audio/index.m3u8`;
  it('picks 720p30 for 720 and source for 1080', () => {
    const v = parseMaster(master, 'https://cdn/');
    expect(v).toHaveLength(4);
    expect(pickVariant(v, 720)?.url).toBe('https://cdn/720p30/index.m3u8');
    expect(pickVariant(v, 1080)?.name).toBe('1080p60');
  });
  it('parses live segments, PDT and ads', () => {
    const pl = parseMedia(
      `#EXTM3U
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:100
#EXT-X-PROGRAM-DATE-TIME:2026-11-16T10:00:00.000Z
#EXTINF:2.000,live
seg100.ts
#EXT-X-DATERANGE:ID="stitched-ad-1",CLASS="twitch-stitched-ad",START-DATE="2026-11-16T10:00:02Z"
#EXTINF:2.000,Amazon
ad.ts
#EXT-X-DISCONTINUITY
#EXT-X-PROGRAM-DATE-TIME:2026-11-16T10:00:04.000Z
#EXTINF:2.000,live
seg102.ts`,
      'https://cdn/x/index.m3u8',
    );
    expect(pl.segments.map((s) => [s.seq, s.ad])).toEqual([
      [100, false],
      [101, true],
      [102, false],
    ]);
    expect(pl.segments[2].pdt).toBe(Date.parse('2026-11-16T10:00:04Z'));
    expect(pl.segments[0].url).toBe('https://cdn/x/seg100.ts');
  });
});

describe('irc', () => {
  it('parses PRIVMSG with tags', () => {
    const m = parseIrc('@badge-info=;display-name=Ada;tmi-sent-ts=1700000000123 :ada!ada@ada.tmi.twitch.tv PRIVMSG #xqc :KEKW W');
    expect(m).toEqual({ t: 1700000000.123, u: 'Ada', m: 'KEKW W' });
    expect(parseIrc(':tmi.twitch.tv 001 justinfan :Welcome')).toBeNull();
  });
});

describe('layout', () => {
  it('stacks facecam over game for 9:16', () => {
    const f = videoFilter('vertical', 1080, DEFAULT_LAYOUT, '/j/sub.ass');
    expect(f.graph).toContain('vstack=inputs=2');
    expect(f.graph).toContain('scale=1080:730');
    expect(f.graph).toContain('subtitles=filename=/j/sub.ass:fontsdir=/fonts');
    expect(f.captionY).toBe(730);
  });
  it('center-crops when asked', () => {
    expect(videoFilter('vertical', 720, { ...DEFAULT_LAYOUT, vertical: 'crop' }, null).graph).toContain('crop=w=min(iw\\,ih*9/16)');
    expect(videoFilter('horizontal', 720, DEFAULT_LAYOUT, null).graph).toContain('pad=1280:720');
  });
});
