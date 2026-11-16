import { useState } from 'react';
import { api, ApiError, parseLink, type TwitchChannel, type YouTubeLive } from '../lib/api';
import { TabRecorder } from '../lib/sources';
import { useI18n } from '../i18n';
import { Session } from '../session';
import { useAndroidRelease } from '../app-release';

interface Props {
  onSession(s: Session): void;
}

const fmtDuration = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
};

export function Home({ onSession }: Props) {
  const { t, lang } = useI18n();
  const ANDROID = useAndroidRelease();
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [channel, setChannel] = useState<TwitchChannel | null>(null);
  const [yt, setYt] = useState<{ url: string; info: YouTubeLive | null; chatError?: string } | null>(null);

  const reset = () => {
    setChannel(null);
    setYt(null);
    setError(null);
  };

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    reset();
    const parsed = parseLink(link);
    if (!parsed) return setError(t('badLink'));
    setBusy(true);
    try {
      if (parsed.platform === 'twitch' && parsed.kind === 'vod') {
        onSession(await Session.twitchVod(parsed.id));
      } else if (parsed.platform === 'twitch') {
        setChannel(await api.twitchChannel(parsed.login));
      } else {
        let id = parsed.id;
        if (!id) id = (await api.youtubeResolve(parsed.url)).id;
        let info: YouTubeLive | null = null;
        let chatError: string | undefined;
        try {
          info = await api.youtubeLive(id);
        } catch (err) {
          chatError = err instanceof ApiError ? err.code : String(err);
        }
        setYt({ url: `https://www.youtube.com/watch?v=${id}`, info, chatError });
      }
    } catch (err) {
      setError(err instanceof ApiError && (err.status === 404 || err.code === 'not_found' || err.code === 'no_live') ? t('notFound') : `${t('error')}: ${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(false);
    }
  };

  const startYoutube = async () => {
    if (!yt) return;
    try {
      onSession(
        await Session.tab({
          title: yt.info?.title ?? 'YouTube live',
          channel: yt.info?.channel ?? 'YouTube',
          thumbnail: yt.info?.thumbnail,
          liveChatId: yt.info?.liveChatId,
        }),
      );
    } catch (err) {
      if ((err as Error).name !== 'NotAllowedError') setError(`${t('error')}: ${(err as Error).message}`);
    }
  };

  return (
    <>
      <section className="hero">
        <h1>
          {t('heroA')}
          <br />
          <span>{t('heroB')}</span>
        </h1>
        <p className="lead">{t('lead')}</p>
        <form className="link-form" onSubmit={submit}>
          <input
            className="link-input"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder={t('placeholder')}
            aria-label={t('placeholder')}
            autoFocus
            inputMode="url"
            spellCheck={false}
          />
          <button className="btn primary big" disabled={busy || !link.trim()}>
            {busy ? t('loading') : t('go')}
          </button>
        </form>
        {error && <p className="form-error">{error}</p>}
      </section>

      <section className="android" id="android">
        <div className="android-card">
          <img className="android-icon" src="/icons/icon-192.png?v=1" alt="" width="96" height="96" />
          <div className="android-body">
            <span className="android-badge">{t('appBadge')} · v{ANDROID.version}</span>
            <h2>{t('appTitle')}</h2>
            <p>{t('appText')}</p>
            <ul className="android-features">
              <li>{t('appF1')}</li>
              <li>{t('appF2')}</li>
              <li>{t('appF3')}</li>
            </ul>
          </div>
          <div className="android-cta">
            <a className="btn android-download" href={ANDROID.url} rel="noopener">
              <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="currentColor" d="M17.6 9.48l1.84-3.18a.38.38 0 00-.66-.38l-1.86 3.22a11.4 11.4 0 00-9.84 0L5.22 5.92a.38.38 0 00-.66.38L6.4 9.48A10.8 10.8 0 001 18h22a10.8 10.8 0 00-5.4-8.52zM7 15.25a1.25 1.25 0 110-2.5 1.25 1.25 0 010 2.5zm10 0a1.25 1.25 0 110-2.5 1.25 1.25 0 010 2.5z" />
              </svg>
              {t('appDownload')}
              <small>{ANDROID.sizeMB} MB</small>
            </a>
            <p className="android-install">{t('appInstall')}</p>
            <p className="android-hash" title={`SHA-256 ${ANDROID.sha256}`}>
              <a href={ANDROID.releases} target="_blank" rel="noreferrer">
                GitHub Releases
              </a>{' '}
              {ANDROID.date ? ` · ${new Date(ANDROID.date).toLocaleDateString(lang, { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}
              {ANDROID.sha256 ? ` · SHA-256 ${ANDROID.sha256.slice(0, 12)}…` : ''}
            </p>
          </div>
        </div>
      </section>

      {channel && (
        <section className="panel">
          <div className="channel-head">
            <img src={channel.avatar} alt="" width="56" height="56" className="avatar" />
            <div>
              <h2>{channel.channel}</h2>
              <p className="muted">{channel.live ? `${t('liveNow')} · ${channel.live.viewers.toLocaleString(lang)} ${t('viewers')}${channel.live.game ? ` · ${channel.live.game}` : ''}` : t('offline')}</p>
            </div>
          </div>
          {channel.live && (
            <div className="live-card">
              <img src={channel.live.thumbnail.replace('{width}', '640').replace('{height}', '360')} alt="" className="thumb" />
              <div className="live-card-body">
                <span className="live-dot">LIVE</span>
                <h3>{channel.live.title}</h3>
                <button
                  className="btn accent big"
                  onClick={async () => {
                    setBusy(true);
                    onSession(await Session.twitchLive(channel.login, { title: channel.live!.title, channel: channel.channel, thumbnail: channel.live!.thumbnail }));
                  }}
                >
                  {t('followLive')}
                </button>
              </div>
            </div>
          )}
          {channel.vods.length > 0 && (
            <>
              <h3 className="sub">{t('recentVods')}</h3>
              <ul className="vods">
                {channel.vods.map((v) => (
                  <li key={v.id}>
                    <button
                      className="vod"
                      onClick={async () => {
                        setBusy(true);
                        try {
                          onSession(await Session.twitchVod(v.id));
                        } catch (err) {
                          setError(`${t('error')}: ${(err as Error).message}`);
                          setBusy(false);
                        }
                      }}
                    >
                      <img src={v.thumbnail} alt="" loading="lazy" />
                      <span className="vod-time">{fmtDuration(v.duration)}</span>
                      <span className="vod-title">{v.title}</span>
                      <span className="vod-date muted">{new Date(v.date).toLocaleDateString(lang, { day: 'numeric', month: 'short' })}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {yt && (
        <section className="panel">
          <h2>{yt.info?.title ?? t('ytTitle')}</h2>
          {yt.info && <p className="muted">{yt.info.channel}</p>}
          <p className="yt-how">{t('ytHow')}</p>
          <p className="small muted">
            {yt.chatError === 'youtube_key_missing'
              ? t('ytNoKey')
              : yt.info && !yt.info.live
                ? t('ytNotLive')
                : yt.info?.liveChatId
                  ? t('ytChatOk')
                  : t('ytNoChat')}
          </p>
          <div className="row">
            <a className="btn" href={yt.url} target="_blank" rel="noreferrer">
              {t('ytOpen')} ↗
            </a>
            <button className="btn accent" onClick={startYoutube} disabled={!TabRecorder.supported()}>
              {t('ytRecord')}
            </button>
          </div>
          {!TabRecorder.supported() && <p className="form-error">{t('tabUnsupported')}</p>}
        </section>
      )}

      <section className="how">
        <ol>
          {(['1', '2', '3'] as const).map((n) => (
            <li key={n}>
              <span className="num">{n}</span>
              <h3>{t(`how${n}t`)}</h3>
              <p>{t(`how${n}`)}</p>
            </li>
          ))}
        </ol>
        <p className="privacy">
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 2l8 3v6c0 5-3.4 9.4-8 11-4.6-1.6-8-6-8-11V5l8-3z" fill="currentColor" />
          </svg>
          {t('privacy')}
        </p>
      </section>
    </>
  );
}
