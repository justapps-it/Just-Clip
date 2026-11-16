import { useCallback, useEffect, useMemo, useState } from 'react';
import { Home } from './components/Home';
import { SessionView } from './components/SessionView';
import { detectLang, I18n, translator, type Lang } from './i18n';
import type { Session } from './session';

const REPO = 'https://github.com/justapps-it/just-clip';
type Theme = 'light' | 'dark' | 'auto';

function pref<T extends string>(key: string, fallback: T): T {
  try {
    return (localStorage.getItem(key) as T) || fallback;
  } catch {
    return fallback;
  }
}
function savePref(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* storage blocked */
  }
}

export default function App() {
  const [lang, setLangState] = useState<Lang>(detectLang);
  const t = useMemo(() => translator(lang), [lang]);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    savePref('justclip-lang', l);
  }, []);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const [theme, setTheme] = useState<Theme>(() => pref<Theme>('justclip-theme', 'auto'));
  useEffect(() => {
    if (theme === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    savePref('justclip-theme', theme);
  }, [theme]);
  const toggleTheme = () => {
    const dark = theme === 'dark' || (theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    setTheme(dark ? 'light' : 'dark');
  };

  const [session, setSession] = useState<Session | null>(null);
  useEffect(() => {
    document.title = session ? `${session.state.title} — JustClip` : 'JustClip — clip automatiche dalle tue live';
  }, [session]);

  const back = () => {
    session?.dispose();
    setSession(null);
  };

  return (
    <I18n.Provider value={{ lang, t, setLang }}>
      <div className="app">
        <header className="top">
          <a
            className="brand"
            href="/"
            onClick={(e) => {
              if (session) {
                e.preventDefault();
                back();
              }
            }}
          >
            <img src="/favicon.svg?v=1" alt="" width="32" height="32" />
            <span>JustClip</span>
          </a>
          <nav className="top-actions">
            <a className="app-pill" href="/#android" onClick={() => session && back()}>
              <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="currentColor" d="M17.6 9.48l1.84-3.18a.38.38 0 00-.66-.38l-1.86 3.22a11.4 11.4 0 00-9.84 0L5.22 5.92a.38.38 0 00-.66.38L6.4 9.48A10.8 10.8 0 001 18h22a10.8 10.8 0 00-5.4-8.52zM7 15.25a1.25 1.25 0 110-2.5 1.25 1.25 0 010 2.5zm10 0a1.25 1.25 0 110-2.5 1.25 1.25 0 010 2.5z" />
              </svg>
              <span>{t('appBadge')}</span>
            </a>
            <a className="nav-link hide-sm" href="https://www.justapps.it">
              JustApps
            </a>
            <button className="icon-btn" onClick={() => setLang(lang === 'it' ? 'en' : 'it')} aria-label={t('language_')} title={t('language_')}>
              <span className="lang">{lang === 'it' ? 'EN' : 'IT'}</span>
            </button>
            <button className="icon-btn" onClick={toggleTheme} aria-label={t('theme')} title={t('theme')}>
              <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" fill="currentColor" />
              </svg>
            </button>
            <a className="icon-btn" href={REPO} target="_blank" rel="noreferrer" aria-label="GitHub" title="GitHub">
              <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
                />
              </svg>
            </a>
          </nav>
        </header>
        <main>{session ? <SessionView session={session} onBack={back} /> : <Home onSession={setSession} />}</main>
        <footer className="foot">
          <p>
            {t('madeBy')} <a href="https://www.justapps.it">JustApps</a> · {t('openSource')},{' '}
            <a href={REPO} target="_blank" rel="noreferrer">
              {t('license')}
            </a>
          </p>
          <p>FFmpeg · Whisper · ONNX Runtime · WebAssembly</p>
        </footer>
      </div>
    </I18n.Provider>
  );
}
