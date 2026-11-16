// Calls to the JustClip edge API (worker/index.ts).

export interface ChatMessage {
  /** Seconds: video offset for VODs, unix time for live chat. */
  t: number;
  u: string;
  m: string;
}

export interface TwitchChannel {
  platform: 'twitch';
  login: string;
  channel: string;
  avatar: string;
  live: null | { title: string; startedAt: string; viewers: number; game?: string; thumbnail: string };
  vods: { id: string; title: string; duration: number; date: string; thumbnail: string }[];
}

export interface TwitchVideo {
  platform: 'twitch';
  kind: 'vod';
  id: string;
  title: string;
  duration: number;
  channel: string;
  login: string;
  thumbnail: string;
  startedAt: string;
}

export interface YouTubeLive {
  id: string;
  title: string;
  channel: string;
  thumbnail: string;
  live: boolean;
  liveChatId: string | null;
  startedAt: string | null;
}

export class ApiError extends Error {
  constructor(
    public code: string,
    public status: number,
  ) {
    super(code);
  }
}

async function get<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/${path}`, init);
  const body = await res.json().catch(() => ({ error: `http_${res.status}` }));
  if (!res.ok || body.error) throw new ApiError(body.error ?? `http_${res.status}`, res.status);
  return body as T;
}

export const api = {
  twitchChannel: (login: string) => get<TwitchChannel>(`twitch/channel/${encodeURIComponent(login)}`),
  twitchVideo: (id: string) => get<TwitchVideo>(`twitch/video/${id}`),
  twitchComments: (id: string, at: { offset?: number; cursor?: string }) =>
    get<{ messages: ChatMessage[]; next: string | null }>(
      `twitch/comments/${id}?${at.cursor ? `cursor=${encodeURIComponent(at.cursor)}` : `offset=${Math.floor(at.offset ?? 0)}`}`,
    ),
  twitchVodPlaylist: (id: string) => `/api/twitch/vod-playlist/${id}`,
  twitchLivePlaylist: (login: string) => `/api/twitch/live-playlist/${encodeURIComponent(login)}`,
  youtubeResolve: (url: string) => get<{ id: string }>(`youtube/resolve?url=${encodeURIComponent(url)}`),
  youtubeLive: (id: string) => get<YouTubeLive>(`youtube/live/${id}`),
  youtubeChat: (liveChatId: string, page?: string) =>
    get<{ messages: ChatMessage[]; next: string | null; wait: number }>(
      `youtube/chat?chat=${encodeURIComponent(liveChatId)}${page ? `&page=${encodeURIComponent(page)}` : ''}`,
    ),
};

// ---- Link parsing -----------------------------------------------------------

export type ParsedLink =
  | { platform: 'twitch'; kind: 'channel'; login: string }
  | { platform: 'twitch'; kind: 'vod'; id: string; t?: number }
  | { platform: 'youtube'; url: string; id?: string };

function parseTwitchTime(t: string | null): number | undefined {
  if (!t) return undefined;
  const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m) return undefined;
  return (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0);
}

export function parseLink(input: string): ParsedLink | null {
  const raw = input.trim();
  if (!raw) return null;
  if (/^\w{3,25}$/.test(raw)) return { platform: 'twitch', kind: 'channel', login: raw.toLowerCase() };
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^(www|m|go)\./, '');
  if (host === 'twitch.tv') {
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] === 'videos' && /^\d+$/.test(parts[1] ?? '')) return { platform: 'twitch', kind: 'vod', id: parts[1], t: parseTwitchTime(u.searchParams.get('t')) };
    if (parts[1] === 'video' && /^\d+$/.test(parts[2] ?? '')) return { platform: 'twitch', kind: 'vod', id: parts[2] };
    if (parts[0] && /^\w{3,25}$/.test(parts[0])) return { platform: 'twitch', kind: 'channel', login: parts[0].toLowerCase() };
    return null;
  }
  if (host === 'youtube.com' || host === 'youtu.be' || host === 'music.youtube.com') {
    const id =
      host === 'youtu.be'
        ? u.pathname.slice(1, 12)
        : u.searchParams.get('v') ?? u.pathname.match(/\/(?:live|shorts|embed)\/([\w-]{11})/)?.[1];
    return { platform: 'youtube', url: u.href, id: id && /^[\w-]{11}$/.test(id) ? id : undefined };
  }
  return null;
}
