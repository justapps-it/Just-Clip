// JustClip edge API.
// A thin, allow-listed bridge for the data a browser can't fetch by itself
// (CORS / IP-bound URLs): stream metadata, chat replay and HLS playlists.
// All video work (cutting, layout, subtitles, encoding) runs in the browser.

interface Env {
  ASSETS: { fetch(req: Request): Promise<Response> };
  YOUTUBE_API_KEY?: string;
}

class HttpError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const json = (data: unknown, status = 200, maxAge = 0) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': maxAge ? `public, max-age=${maxAge}` : 'no-store',
    },
  });

// ---------------------------------------------------------------------------
// Twitch
// ---------------------------------------------------------------------------
const TWITCH_GQL = 'https://gql.twitch.tv/gql';
// Public web client id; the second one is used by open-source VOD tools for
// chat replay, which doesn't require an integrity token.
const TWITCH_WEB_CLIENT = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const TWITCH_CHAT_CLIENT = 'kd1unb4b3q4t58fwlpcbzcbnm76a8fp';
const COMMENTS_HASH = 'b70a3591ff0f4e0313d126c6a1502d79a1c02baebb288227c582044aa76adf6a';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

async function gql(body: unknown, clientId = TWITCH_WEB_CLIENT): Promise<Any> {
  const res = await fetch(TWITCH_GQL, {
    method: 'POST',
    headers: { 'Client-Id': clientId, 'content-type': 'text/plain;charset=UTF-8', 'user-agent': UA },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Twitch GQL ${res.status}`);
  return res.json();
}

const gqlString = (s: string) => JSON.stringify(s);

async function twitchVideo(id: string) {
  const r = await gql({
    query: `query { video(id: ${gqlString(id)}) { id title lengthSeconds createdAt
      owner { login displayName } previewThumbnailURL(width: 640, height: 360) } }`,
  });
  const v = r.data?.video;
  if (!v) return json({ error: 'not_found' }, 404);
  return json(
    {
      platform: 'twitch',
      kind: 'vod',
      id: v.id,
      title: v.title,
      duration: v.lengthSeconds,
      channel: v.owner?.displayName,
      login: v.owner?.login,
      thumbnail: v.previewThumbnailURL,
      startedAt: v.createdAt,
    },
    200,
    120,
  );
}

async function twitchChannel(login: string) {
  const r = await gql({
    query: `query { user(login: ${gqlString(login)}) { login displayName profileImageURL(width: 150)
      stream { id title createdAt viewersCount game { name } previewImageURL(width: 640, height: 360) }
      videos(first: 12, type: ARCHIVE, sort: TIME) { edges { node { id title lengthSeconds createdAt
        previewThumbnailURL(width: 320, height: 180) } } } } }`,
  });
  const u = r.data?.user;
  if (!u) return json({ error: 'not_found' }, 404);
  return json({
    platform: 'twitch',
    login: u.login,
    channel: u.displayName,
    avatar: u.profileImageURL,
    live: u.stream
      ? {
          title: u.stream.title,
          startedAt: u.stream.createdAt,
          viewers: u.stream.viewersCount,
          game: u.stream.game?.name,
          thumbnail: u.stream.previewImageURL,
        }
      : null,
    vods: (u.videos?.edges ?? []).map((e: Any) => ({
      id: e.node.id,
      title: e.node.title,
      duration: e.node.lengthSeconds,
      date: e.node.createdAt,
      thumbnail: e.node.previewThumbnailURL,
    })),
  });
}

async function twitchComments(id: string, offset: string | null, cursor: string | null) {
  const variables: Record<string, unknown> = { videoID: id };
  if (cursor) variables.cursor = cursor;
  else variables.contentOffsetSeconds = Math.max(0, Math.floor(Number(offset) || 0));
  const r = await gql(
    [
      {
        operationName: 'VideoCommentsByOffsetOrCursor',
        variables,
        extensions: { persistedQuery: { version: 1, sha256Hash: COMMENTS_HASH } },
      },
    ],
    TWITCH_CHAT_CLIENT,
  );
  const c = r?.[0]?.data?.video?.comments;
  if (!c) return json({ error: r?.[0]?.errors?.[0]?.message ?? 'no_chat' }, 502);
  const edges = c.edges ?? [];
  return json({
    messages: edges.map((e: Any) => ({
      t: e.node.contentOffsetSeconds,
      u: e.node.commenter?.displayName ?? '',
      m: (e.node.message?.fragments ?? []).map((f: Any) => f.text).join(''),
    })),
    next: c.pageInfo?.hasNextPage && edges.length ? edges[edges.length - 1].cursor : null,
  });
}

async function twitchPlaylist(kind: 'vod' | 'live', idOrLogin: string, origin: string) {
  const vod = kind === 'vod';
  const r = await gql({
    operationName: 'PlaybackAccessToken_Template',
    query: `query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!) {
      streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: "site"}) @include(if: $isLive) { value signature }
      videoPlaybackAccessToken(id: $vodID, params: {platform: "web", playerBackend: "mediaplayer", playerType: "site"}) @include(if: $isVod) { value signature } }`,
    variables: { login: vod ? '' : idOrLogin, isLive: !vod, vodID: vod ? idOrLogin : '', isVod: vod },
  });
  const tok = vod ? r.data?.videoPlaybackAccessToken : r.data?.streamPlaybackAccessToken;
  if (!tok) return json({ error: 'no_token' }, 403);
  const usher = new URL(vod ? `https://usher.ttvnw.net/vod/${idOrLogin}.m3u8` : `https://usher.ttvnw.net/api/channel/hls/${idOrLogin}.m3u8`);
  usher.search = new URLSearchParams({
    sig: tok.signature,
    token: tok.value,
    allow_source: 'true',
    allow_audio_only: 'true',
    player: 'twitchweb',
    playlist_include_framerate: 'true',
    fast_bread: 'true',
    p: String(Math.floor(Math.random() * 1e6)),
  }).toString();
  const res = await fetch(usher, { headers: { 'user-agent': UA } });
  if (!res.ok) return json({ error: vod ? 'vod_unavailable' : 'offline' }, res.status === 404 ? 404 : 502);
  return playlistResponse(await res.text(), usher.href, origin, false);
}

// ---------------------------------------------------------------------------
// YouTube — official Data API v3 only (key in the YOUTUBE_API_KEY secret).
// Video comes from the user's own browser tab (screen capture), not from here.
// ---------------------------------------------------------------------------
const YT_API = 'https://www.googleapis.com/youtube/v3';

async function ytApi(env: Env, path: string, params: Record<string, string>): Promise<Any> {
  if (!env.YOUTUBE_API_KEY) throw new HttpError('youtube_key_missing', 503);
  const u = new URL(`${YT_API}/${path}`);
  u.search = new URLSearchParams({ ...params, key: env.YOUTUBE_API_KEY }).toString();
  const res = await fetch(u);
  const body: Any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = body?.error?.errors?.[0]?.reason ?? `youtube_${res.status}`;
    throw new HttpError(reason, res.status === 403 || res.status === 404 ? res.status : 502);
  }
  return body;
}

async function youtubeLive(env: Env, id: string) {
  const r = await ytApi(env, 'videos', { id, part: 'snippet,liveStreamingDetails' });
  const v = r.items?.[0];
  if (!v) return json({ error: 'not_found' }, 404);
  const d = v.liveStreamingDetails ?? {};
  return json({
    id,
    title: v.snippet?.title ?? '',
    channel: v.snippet?.channelTitle ?? '',
    thumbnail: v.snippet?.thumbnails?.high?.url ?? `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    live: v.snippet?.liveBroadcastContent === 'live',
    liveChatId: d.activeLiveChatId ?? null,
    startedAt: d.actualStartTime ?? null,
  });
}

async function youtubeChat(env: Env, chat: string, page: string | null) {
  const params: Record<string, string> = { liveChatId: chat, part: 'snippet,authorDetails', maxResults: '2000' };
  if (page) params.pageToken = page;
  const r = await ytApi(env, 'liveChat/messages', params);
  return json({
    messages: (r.items ?? []).map((it: Any) => ({
      t: Date.parse(it.snippet?.publishedAt) / 1000,
      u: it.authorDetails?.displayName ?? '',
      m: it.snippet?.displayMessage ?? '',
    })),
    next: r.nextPageToken ?? null,
    wait: Math.max(5000, Number(r.pollingIntervalMillis) || 5000),
  });
}

/** Resolves youtube.com/@handle (or /live) to the id of the current live. */
async function youtubeResolve(raw: string) {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return json({ error: 'bad_url' }, 400);
  }
  if (!/(^|\.)youtube\.com$/.test(u.hostname)) return json({ error: 'not_youtube' }, 400);
  let path = u.pathname.replace(/\/+$/, '');
  if (!/^\/(@[\w.-]+|channel\/[\w-]+|c\/[\w.-]+|user\/[\w.-]+)(\/live)?$/.test(path)) return json({ error: 'bad_url' }, 400);
  if (!path.endsWith('/live')) path += '/live';
  const res = await fetch(`https://www.youtube.com${path}?hl=en`, {
    headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', cookie: 'SOCS=CAI' },
  });
  const html = await res.text();
  const id = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/)?.[1];
  return id ? json({ id }) : json({ error: 'no_live' }, 404);
}

// ---------------------------------------------------------------------------
// HLS proxy (allow-listed video CDNs only: this is not an open proxy)
// ---------------------------------------------------------------------------
const PROXY_HOSTS = [
  /\.ttvnw\.net$/,
  /\.cloudfront\.net$/,
  /\.twitchcdn\.net$/,
  /^vod-[a-z-]+\.twitch\.tv$/,
];
const allowed = (u: URL) => u.protocol === 'https:' && PROXY_HOSTS.some((re) => re.test(u.hostname));

/**
 * Rewrites every URI in a playlist: nested playlists go through this Worker,
 * media segments stay direct (the browser falls back to the proxy if the CDN
 * refuses cross-origin requests).
 */
function rewritePlaylist(text: string, base: string, origin: string, forceProxy: boolean): string {
  const prox = (u: string) => `${origin}/api/proxy?u=${encodeURIComponent(u)}${forceProxy ? '&f=1' : ''}`;
  const isPlaylist = (u: string) => /\.m3u8(\?|$)|\/playlist|\/hls_playlist|\/manifest/.test(u);
  const fix = (uri: string) => {
    const abs = new URL(uri, base).href;
    return forceProxy || isPlaylist(abs) ? prox(abs) : abs;
  };
  return text
    .split('\n')
    .map((line) => {
      const l = line.trim();
      if (!l) return line;
      if (l.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${fix(u)}"`);
      return fix(l);
    })
    .join('\n');
}

function playlistResponse(text: string, base: string, origin: string, forceProxy: boolean) {
  return new Response(rewritePlaylist(text, base, origin, forceProxy), {
    headers: { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store' },
  });
}

async function proxy(req: Request, origin: string) {
  const q = new URL(req.url).searchParams;
  let u: URL;
  try {
    u = new URL(q.get('u') ?? '');
  } catch {
    return json({ error: 'bad_url' }, 400);
  }
  if (!allowed(u)) return json({ error: 'host_not_allowed' }, 403);
  const headers: Record<string, string> = { 'user-agent': UA };
  const range = req.headers.get('range');
  if (range) headers.range = range;
  const res = await fetch(u.href, { headers });
  const type = res.headers.get('content-type') ?? '';
  if (/mpegurl/i.test(type) || /\.m3u8(\?|$)/.test(u.pathname)) {
    if (!res.ok) return json({ error: `upstream_${res.status}` }, res.status);
    return playlistResponse(await res.text(), u.href, origin, q.get('f') === '1');
  }
  const out = new Headers();
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const v = res.headers.get(h);
    if (v) out.set(h, v);
  }
  out.set('cache-control', 'no-store');
  return new Response(res.body, { status: res.status, headers: out });
}

// ---------------------------------------------------------------------------
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    const q = url.searchParams;
    const [, platform, action, id = ''] = url.pathname.split('/').filter(Boolean);
    try {
      if (platform === 'twitch') {
        if (action === 'video' && /^\d+$/.test(id)) return await twitchVideo(id);
        if (action === 'comments' && /^\d+$/.test(id)) return await twitchComments(id, q.get('offset'), q.get('cursor'));
        if (action === 'vod-playlist' && /^\d+$/.test(id)) return await twitchPlaylist('vod', id, url.origin);
        if (action === 'channel' && /^\w{2,25}$/.test(id)) return await twitchChannel(id.toLowerCase());
        if (action === 'live-playlist' && /^\w{2,25}$/.test(id)) return await twitchPlaylist('live', id.toLowerCase(), url.origin);
      }
      if (platform === 'youtube') {
        if (action === 'live' && /^[\w-]{11}$/.test(id)) return await youtubeLive(env, id);
        if (action === 'chat') return await youtubeChat(env, q.get('chat') ?? '', q.get('page'));
        if (action === 'resolve') return await youtubeResolve(q.get('url') ?? '');
      }
      if (platform === 'proxy') return await proxy(req, url.origin);
      return json({ error: 'not_found' }, 404);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      return json({ error: e instanceof Error ? e.message : String(e) }, 502);
    }
  },
};
