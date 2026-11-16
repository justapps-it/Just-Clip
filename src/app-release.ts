// Android app download. The APK is a GitHub release asset; the page reads the
// latest version, size and checksum from the GitHub API (no manual updates),
// with these values as a fallback when the API can't be reached.
import { useEffect, useState } from 'react';

const REPO = 'justapps-it/Just-Clip';

export interface AndroidRelease {
  url: string;
  releases: string;
  version: string;
  sizeMB: number;
  sha256: string;
  date?: string;
}

export const ANDROID: AndroidRelease = {
  url: `https://github.com/${REPO}/releases/latest/download/JustClip.apk`,
  releases: `https://github.com/${REPO}/releases/latest`,
  version: '1.0.0',
  sizeMB: 5.7,
  sha256: 'e7846c4c0c525e1583fdf245bb735263fd050096cf33b26d48eddf34db8292c8',
};

let cached: Promise<AndroidRelease> | undefined;

function fetchLatest(): Promise<AndroidRelease> {
  cached ??= fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: 'application/vnd.github+json' } })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((r: { tag_name: string; html_url: string; published_at: string; assets: { name: string; size: number; digest?: string; browser_download_url: string }[] }) => {
      const apk = r.assets.find((a) => a.name === 'JustClip.apk');
      if (!apk) return ANDROID;
      return {
        url: apk.browser_download_url,
        releases: r.html_url,
        version: r.tag_name.replace(/^android-v/, ''),
        sizeMB: Math.round((apk.size / 1048576) * 10) / 10,
        sha256: apk.digest?.replace(/^sha256:/, '') ?? '',
        date: r.published_at,
      };
    })
    .catch(() => ANDROID);
  return cached;
}

export function useAndroidRelease(): AndroidRelease {
  const [release, setRelease] = useState(ANDROID);
  useEffect(() => {
    let alive = true;
    fetchLatest().then((r) => alive && setRelease(r));
    return () => {
      alive = false;
    };
  }, []);
  return release;
}
