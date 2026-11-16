import { useEffect, useState } from 'react';
import { useI18n, type Key } from '../i18n';
import { useSession, type Moment, type Session, type SessionState } from '../session';
import { updateSettings, useSettings } from '../settings';
import { LayoutEditor } from './LayoutEditor';

const clock = (s: number) => {
  const sec = Math.max(0, Math.floor(s));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const ss = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};
const mb = (n: number) => `${(n / 1048576).toFixed(n > 10 * 1048576 ? 0 : 1)} MB`;

/** Time label: VOD offset, or local time of day for lives. */
function label(st: SessionState, t: number, lang: string) {
  if (st.kind === 'twitch-vod') return clock(t);
  return new Date(t * 1000).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function Chart({ st, onPick }: { st: SessionState; onPick?(t: number): void }) {
  const { values, step, t0 } = st.activity;
  if (!values.length) return <div className="chart empty" />;
  const W = 1000;
  const H = 120;
  const max = Math.max(...values, 1);
  const x = (i: number) => (i / Math.max(1, values.length - 1)) * W;
  const y = (v: number) => H - 6 - (v / max) * (H - 14);
  const line = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const span = values.length * step;
  const pos = (t: number) => ((t - t0) / span) * W;
  return (
    <svg
      className="chart"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Chat activity"
      onClick={(e) => {
        if (!onPick) return;
        const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
        onPick(t0 + ((e.clientX - r.left) / r.width) * span);
      }}
    >
      <path d={`${line}L${W},${H}L0,${H}Z`} className="chart-area" />
      <path d={line} className="chart-line" />
      {st.moments.map((m, i) => {
        const px = pos(m.peak);
        if (px < 0 || px > W) return null;
        return (
          <g key={m.id}>
            <line x1={px} x2={px} y1={0} y2={H} className="chart-peak" />
            <text x={Math.min(W - 14, Math.max(4, px + 4))} y={14} className="chart-label">
              {i + 1}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function MomentCard({ m, i, st, session }: { m: Moment; i: number; st: SessionState; session: Session }) {
  const { t, lang } = useI18n();
  const busy = m.status === 'queued' || m.status === 'working' || m.status === 'waiting';
  const vertical = m.outputs.find((o) => o.format === 'vertical') ?? m.outputs[0];
  const base = st.channel.replace(/[^\w-]+/g, '_') || 'clip';
  return (
    <li className={`moment status-${m.status}`}>
      <div className="moment-media">
        {vertical ? (
          <video src={`${vertical.url}#t=0.5`} poster={vertical.format === 'vertical' ? undefined : m.thumb} controls playsInline preload="metadata" className={vertical.format} />
        ) : m.thumb ? (
          <img src={m.thumb} alt="" />
        ) : (
          <div className="moment-placeholder">
            <span>{i + 1}</span>
          </div>
        )}
      </div>
      <div className="moment-body">
        <div className="moment-top">
          <strong>
            #{i + 1} · {label(st, m.peak, lang)}
          </strong>
          <span className="muted small">
            {m.manual ? t('manual') : `${t('score')} ${m.score.toFixed(1)}`} · {Math.round(m.end - m.start)}s
          </span>
        </div>
        {m.samples.length > 0 && (
          <ul className="samples">
            {m.samples.map((s, k) => (
              <li key={k}>{s}</li>
            ))}
          </ul>
        )}
        {m.transcript && <p className="transcript">“{m.transcript.length > 160 ? m.transcript.slice(0, 157) + '…' : m.transcript}”</p>}

        {busy && (
          <div className="progress-wrap">
            <div className="progress">
              <div className={`bar ${m.progress === null ? 'indeterminate' : ''}`} style={{ width: m.progress === null ? undefined : `${Math.round(m.progress * 100)}%` }} />
            </div>
            <span className="small muted">
              {m.status === 'waiting' ? t('waiting') : m.status === 'queued' ? t('queued') : t((m.stage ?? 'prepare') as Key)}
              {m.progress !== null && m.status === 'working' ? ` · ${Math.round(m.progress * 100)}%` : ''}
            </span>
          </div>
        )}
        {m.status === 'error' && <p className="form-error small">{m.error}</p>}

        <div className="moment-actions">
          {(m.status === 'found' || m.status === 'error') && (
            <>
              <div className="trim">
                <button className="chip" onClick={() => session.adjust(m.id, 'start', -5)} title="-5s">
                  ◀ 5s
                </button>
                <span className="small muted">
                  {label(st, m.start, lang)} – {label(st, m.end, lang)}
                </span>
                <button className="chip" onClick={() => session.adjust(m.id, 'end', 5)} title="+5s">
                  5s ▶
                </button>
              </div>
              <button className="btn primary" onClick={() => session.render(m.id)}>
                {m.status === 'error' ? t('retry') : t('create')}
              </button>
            </>
          )}
          {m.outputs.map((o) => (
            <a key={o.format} className="btn accent" href={o.url} download={`${base}-${i + 1}-${o.format === 'vertical' ? '9x16' : '16x9'}.mp4`}>
              {t('download')} {t(o.format)} <span className="muted-on-accent">{mb(o.size)}</span>
            </a>
          ))}
          {!busy && (
            <button className="icon-btn" onClick={() => session.remove(m.id)} aria-label={t('remove')} title={t('remove')}>
              ✕
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

function SettingsPanel({ live, onLayout }: { live: boolean; onLayout(): void }) {
  const { t } = useI18n();
  const s = useSettings();
  return (
    <div className="settings">
      <label>
        <span>{t('sensitivity')}</span>
        <select value={s.sensitivity} onChange={(e) => updateSettings({ sensitivity: e.target.value as typeof s.sensitivity })}>
          <option value="low">{t('low')}</option>
          <option value="medium">{t('medium')}</option>
          <option value="high">{t('high')}</option>
        </select>
      </label>
      <label>
        <span>
          {t('before')} <b>{s.before}s</b>
        </span>
        <input type="range" min={5} max={60} step={1} value={s.before} onChange={(e) => updateSettings({ before: Number(e.target.value) })} />
      </label>
      <label>
        <span>
          {t('after')} <b>{s.after}s</b>
        </span>
        <input type="range" min={0} max={30} step={1} value={s.after} onChange={(e) => updateSettings({ after: Number(e.target.value) })} />
      </label>
      <fieldset>
        <legend>{t('formats')}</legend>
        <label className="check">
          <input type="checkbox" checked={s.horizontal} onChange={(e) => updateSettings({ horizontal: e.target.checked })} /> 16:9
        </label>
        <label className="check">
          <input type="checkbox" checked={s.vertical} onChange={(e) => updateSettings({ vertical: e.target.checked })} /> 9:16
        </label>
      </fieldset>
      <label>
        <span>{t('layout')}</span>
        <div className="row">
          <select value={s.layout.vertical} onChange={(e) => updateSettings({ layout: { ...s.layout, vertical: e.target.value as 'crop' | 'stack' } })}>
            <option value="stack">{t('layoutStack')}</option>
            <option value="crop">{t('layoutCrop')}</option>
          </select>
          <button type="button" className="btn small" onClick={onLayout}>
            {t('editLayout')}
          </button>
        </div>
      </label>
      <label>
        <span>{t('quality')}</span>
        <select value={s.quality} onChange={(e) => updateSettings({ quality: Number(e.target.value) as 720 | 1080 })}>
          <option value={720}>720p</option>
          <option value={1080}>1080p</option>
        </select>
      </label>
      <fieldset>
        <legend>{t('subtitles')}</legend>
        <label className="check">
          <input type="checkbox" checked={s.subtitles} onChange={(e) => updateSettings({ subtitles: e.target.checked })} /> {t('subtitles')}
        </label>
        <select value={s.language} onChange={(e) => updateSettings({ language: e.target.value })} disabled={!s.subtitles} aria-label={t('language')}>
          <option value="auto">{t('auto')}</option>
          {[
            ['it', 'Italiano'],
            ['en', 'English'],
            ['es', 'Español'],
            ['fr', 'Français'],
            ['de', 'Deutsch'],
            ['pt', 'Português'],
          ].map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </fieldset>
      {live ? (
        <>
          <label className="check">
            <input type="checkbox" checked={s.autoRender} onChange={(e) => updateSettings({ autoRender: e.target.checked })} /> {t('autoRender')}
          </label>
          <label>
            <span>
              {t('bufferMinutes')} <b>{s.bufferMinutes}</b>
            </span>
            <input type="range" min={1} max={10} value={s.bufferMinutes} onChange={(e) => updateSettings({ bufferMinutes: Number(e.target.value) })} />
          </label>
        </>
      ) : (
        <label>
          <span>
            {t('maxMoments')} <b>{s.maxMoments}</b>
          </span>
          <input type="range" min={3} max={30} value={s.maxMoments} onChange={(e) => updateSettings({ maxMoments: Number(e.target.value) })} />
        </label>
      )}
    </div>
  );
}

export function SessionView({ session, onBack }: { session: Session; onBack(): void }) {
  const { t, lang } = useI18n();
  const st = useSession(session);
  const settings = useSettings();
  const [showSettings, setShowSettings] = useState(false);
  const [layoutOpen, setLayoutOpen] = useState(false);
  const live = st.kind !== 'twitch-vod';

  // VOD: recompute moments when detection settings change.
  useEffect(() => {
    if (st.kind === 'twitch-vod' && st.phase === 'ready') session.analyzeVod();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.sensitivity, settings.before, settings.after, settings.maxMoments]);

  const busy = st.moments.some((m) => m.status === 'working' || m.status === 'queued');
  useEffect(() => {
    if (!(live && st.phase === 'live') && !busy) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [live, st.phase, busy]);

  const status =
    st.phase === 'starting'
      ? t('starting')
      : st.phase === 'chat'
        ? `${t('chatLoading')} ${Math.round(st.chatProgress * 100)}%`
        : st.phase === 'live'
          ? t('recording')
          : st.phase === 'ended'
            ? t('ended')
            : st.phase === 'error'
              ? `${t('error')}: ${st.error}`
              : t('analyzed');

  return (
    <section className="session">
      <div className="session-head">
        {st.thumbnail && <img className="thumb" src={st.thumbnail.replace('{width}', '320').replace('{height}', '180')} alt="" />}
        <div className="session-info">
          <div className="badges">
            {st.phase === 'live' && <span className="live-dot">LIVE</span>}
            <span className={`status ${st.phase}`}>{status}</span>
          </div>
          <h1>{st.title}</h1>
          <p className="muted">
            {st.channel}
            {st.kind === 'twitch-vod' && st.duration ? ` · ${clock(st.duration)}` : ''}
            {st.chatCount ? ` · ${st.chatCount.toLocaleString(lang)} ${t('messages')}` : ''}
            {live && st.buffered ? ` · ${t('buffer')} ${clock(st.buffered)} (${mb(st.bytes)})` : ''}
          </p>
          {live && <p className="small muted">{st.chatConnected ? `● ${t('chatOn')}` : `○ ${t('chatOff')}`} · {t('keepOpen')}</p>}
          {st.warning === 'no_audio' && <p className="form-error small">{t('noAudio')}</p>}
        </div>
        <div className="session-actions">
          {live && st.phase === 'live' && (
            <>
              <button className="btn accent big" onClick={() => session.clipNow()} disabled={st.buffered < 5}>
                {t('clipIt')}
              </button>
              <button className="btn" onClick={() => session.stop()}>
                {t('stop')}
              </button>
            </>
          )}
          <button className="btn ghost" onClick={onBack}>
            ← {t('back')}
          </button>
        </div>
      </div>

      {st.phase === 'chat' && (
        <div className="progress big-progress">
          <div className="bar" style={{ width: `${Math.round(st.chatProgress * 100)}%` }} />
        </div>
      )}

      <Chart st={st} onPick={st.kind === 'twitch-vod' && st.phase === 'ready' ? (time) => session.clipNow(Math.round(time)) : undefined} />

      <div className="moments-head">
        <h2>
          {t('moments')} <span className="count">{st.moments.length}</span>
        </h2>
        <div className="row">
          <button className="btn small" onClick={() => setShowSettings((v) => !v)} aria-expanded={showSettings}>
            {t('settings')} {showSettings ? '▴' : '▾'}
          </button>
          {st.moments.some((m) => m.status === 'found' || m.status === 'error') && (
            <button className="btn primary small" onClick={() => session.renderAll()}>
              {t('renderAll')}
            </button>
          )}
        </div>
      </div>
      {showSettings && <SettingsPanel live={live} onLayout={() => setLayoutOpen(true)} />}

      {st.moments.length === 0 && (st.phase === 'ready' || st.phase === 'live') && <p className="empty muted">{st.phase === 'ready' ? t('noMomentsVod') : t('noMoments')}</p>}
      <ul className="moments">
        {[...st.moments]
          .map((m, i) => ({ m, i }))
          .reverse()
          .sort((a, b) => (live ? b.m.peak - a.m.peak : a.m.peak - b.m.peak))
          .map(({ m, i }) => (
            <MomentCard key={m.id} m={m} i={i} st={st} session={session} />
          ))}
      </ul>

      {layoutOpen && <LayoutEditor session={session} onClose={() => setLayoutOpen(false)} />}
    </section>
  );
}
