// End-to-end test on a real Twitch VOD: chat download → moments → render.
// Usage: npm run build && node scripts/e2e.mjs [vodId]   (SUBS=1 to test subtitles)
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const { chromium } = createRequire(import.meta.url)('playwright');
const PORT = 4190;
const VOD = process.argv[2] || '2910024547';
const SHOTS = process.env.SHOTS;

const server = process.env.E2E_URL ? null : spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe', detached: true });
const stop = () => {
  try {
    if (server) process.kill(-server.pid);
  } catch {
    /* gone */
  }
};
process.on('exit', stop);
if (server)
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => String(d).includes(String(PORT)) && resolve());
    setTimeout(() => reject(new Error('preview did not start')), 20000);
  });
const URL = process.env.E2E_URL || `http://localhost:${PORT}/`;

const browser = await chromium.launch();
const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
page.on('pageerror', (e) => console.log('pageerror', e.message));
page.on('console', (m) => m.type() === 'error' && console.log('console', m.text().slice(0, 300)));
await page.addInitScript((subs) => {
  localStorage.setItem('justclip-settings', JSON.stringify({ subtitles: subs[0], maxMoments: 5 }));
  if (subs[1]) localStorage.setItem('justclip-ffmpeg', subs[1]);
}, [Boolean(process.env.SUBS), process.env.FFMPEG || '']);
await page.goto(URL);
console.log('isolated:', await page.evaluate(() => crossOriginIsolated));

const t0 = Date.now();
await page.fill('.link-input', `https://www.twitch.tv/videos/${VOD}`);
await page.click('button:has-text("Start")');
await page.waitForSelector('.session', { timeout: 30000 });
let lastStatus = '';
await page.waitForFunction(
  () => {
    const s = document.querySelector('.status')?.textContent ?? '';
    return !/Reading chat|Starting/.test(s) && (document.querySelector('.moment') || document.querySelector('.empty') || /Error/.test(s));
  },
  null,
  { timeout: 600000, polling: 1000 },
).catch(async (e) => {
  console.log('status at timeout:', await page.textContent('.status'));
  throw e;
});
void lastStatus;
const status = await page.textContent('.status');
const info = await page.textContent('.session-info p');
const moments = await page.locator('.moment').count();
console.log(`chat loaded in ${((Date.now() - t0) / 1000).toFixed(0)}s · ${info} · status "${status}" · moments ${moments}`);
if (SHOTS) await page.screenshot({ path: `${SHOTS}/session.png`, fullPage: true });
if (!moments) throw new Error('no moments');

const t1 = Date.now();
const first = page.locator('.moment').first();
console.log('moment:', (await first.locator('.moment-top').textContent())?.replace(/\s+/g, ' '), '|', await first.locator('.reasons').textContent().catch(() => ''), '| title:', await first.locator('.hook-input').inputValue().catch(() => ''));
await page.waitForTimeout(8000); // let the audio scan refine scores
console.log('after audio scan:', (await page.locator('.moment .viral b').allTextContents()).join(' '));
await first.getByRole('button', { name: 'Create clip' }).click();
let last = '';
const deadline = Date.now() + 15 * 60_000;
while (Date.now() < deadline) {
  const s = (await first.locator('.progress-wrap .small').textContent().catch(() => '')) ?? '';
  if (s && s !== last) {
    console.log(`  ${((Date.now() - t1) / 1000).toFixed(0)}s ${s}`);
    last = s;
  }
  if ((await first.locator('a.btn.accent').count()) > 0 || (await first.locator('.form-error').count()) > 0) break;
  await page.waitForTimeout(1000);
}
const err = await first.locator('.form-error').textContent().catch(() => null);
if (err) throw new Error(`render error: ${err}`);
console.log(`rendered in ${((Date.now() - t1) / 1000).toFixed(0)}s`);

const outputs = await first.locator('a.btn.accent').evaluateAll((as) =>
  Promise.all(
    as.map(async (a) => {
      const v = document.createElement('video');
      v.src = a.href;
      await new Promise((r, j) => {
        v.onloadedmetadata = r;
        v.onerror = () => j(new Error('video error'));
      });
      const head = new Uint8Array(await (await fetch(a.href)).arrayBuffer()).slice(4, 8);
      return { name: a.getAttribute('download'), w: v.videoWidth, h: v.videoHeight, d: v.duration, ftyp: String.fromCharCode(...head) };
    }),
  ),
);
console.log(outputs);
if (SHOTS) {
  // A frame of each output, to check layout and captions by eye.
  const frames = await first.locator('a.btn.accent').evaluateAll((as) =>
    Promise.all(
      as.map(async (a) => {
        const v = document.createElement('video');
        v.muted = true;
        v.src = a.href;
        await new Promise((r) => (v.onloadeddata = r));
        const shots = [];
        for (const at of [1.5, 12]) {
          v.currentTime = Math.min(v.duration - 1, at);
          await new Promise((r) => (v.onseeked = r));
          const c = document.createElement('canvas');
          c.width = v.videoWidth;
          c.height = v.videoHeight;
          c.getContext('2d').drawImage(v, 0, 0);
          shots.push(c.toDataURL('image/jpeg', 0.85));
        }
        return shots;
      }),
    ),
  );
  const { writeFileSync } = await import('node:fs');
  frames.flat().forEach((d, i) => writeFileSync(`${SHOTS}/frame${i}.jpg`, Buffer.from(d.split(',')[1], 'base64')));
  await first.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/clip.png`, fullPage: true });
}
const ok = outputs.length === 2 && outputs.every((o) => o.ftyp === 'ftyp' && o.d > 10) && outputs.some((o) => o.w === 720 && o.h === 1280) && outputs.some((o) => o.w === 1280 && o.h === 720);
await browser.close();
stop();
console.log(ok ? 'E2E PASSED' : 'E2E FAILED');
process.exit(ok ? 0 : 1);
