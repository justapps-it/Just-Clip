# JustClip

**Your stream, already clipped.** Paste a Twitch or YouTube link: JustClip follows the chat, finds the moments where it explodes and turns them into **16:9 and 9:16 clips with animated subtitles** (facecam on top, gameplay below). Open source, by [JustApps](https://www.justapps.it) · **[clip.justapps.it](https://clip.justapps.it)**

🇮🇹 *Incolla un link Twitch o YouTube: JustClip segue la chat, trova i picchi e crea clip orizzontali e verticali con i sottotitoli, direttamente nel browser.*

## How it works

| Source | Video | Chat |
| --- | --- | --- |
| Twitch VOD (`twitch.tv/videos/…`) | Only the segments around each moment are downloaded from the HLS playlist | Full chat replay, downloaded in parallel slices |
| Twitch live (`twitch.tv/channel`) | The live HLS stream is recorded into a rolling in-memory buffer (last N minutes) | Twitch IRC over WebSocket (anonymous, read-only) |
| YouTube live | The user's own tab is recorded with screen/tab capture (`getDisplayMedia` + `MediaRecorder`), in standalone WebM pieces | Official YouTube Data API v3 (`liveChatMessages`) |

1. **Peak detection** (`src/lib/peaks.ts`): each message is weighted (laughs, “W”, “CLIP IT”, emotes, caps, `!!!`), summed per second and smoothed; a moment is a local maximum with a high robust z-score (median/MAD baseline). Lives use an online detector that fires when the burst is over.
2. **Clip** = `[peak − before, peak + after]` (25 s / 8 s by default), adjustable per moment.
3. **Subtitles**: Whisper (`onnx-community/whisper-base_timestamped`) with word timestamps, via transformers.js on WebGPU or WebAssembly; captions are burned with libass, the spoken word highlighted in orange.
4. **Render**: FFmpeg (WebAssembly, multi-threaded when the page is cross-origin isolated) builds each format and encodes H.264/AAC MP4.

Everything except fetching public stream data runs in the browser. The edge Worker (`worker/index.ts`) is a thin, allow-listed bridge for data browsers can't fetch because of CORS: Twitch GQL (metadata, chat replay, playback token), HLS playlists, and the YouTube Data API.

**YouTube**: JustClip does not download from YouTube or bypass its protections. The video comes from the user's own browser tab; chat comes from the official API.

## Android app

`android/` is a native Kotlin app (Jetpack Compose + Media3) that clips **Twitch lives in the background**: a foreground service records the stream into a rolling buffer, reads chat over IRC, detects moments with the same virality model as the web app and renders 16:9 / 9:16 clips with the phone's hardware encoder (facecam-over-gameplay layout in a GPU shader, title card), saving them to *Movies/JustClip* with a notification for each clip.

The signed APK is published as a GitHub release asset: [latest JustClip.apk](https://github.com/justapps-it/Just-Clip/releases/latest/download/JustClip.apk).

```bash
cd android
./gradlew :app:testDebugUnitTest       # JVM tests (parsing, detection, virality, layout)
./gradlew :app:assembleRelease         # needs JUSTCLIP_KEYSTORE* in ~/.gradle/gradle.properties
cp app/build/outputs/apk/release/app-release.apk release/JustClip.apk
git commit -am "Android 1.0.1" && git push   # the workflow creates the android-v1.0.1 release
```

Then update `src/app-release.ts` (version, size, SHA-256) and bump `versionCode` / `versionName` in `android/app/build.gradle.kts` before building. The release keystore is kept outside the repository: keep a backup, Android only accepts updates signed with the same key.

## Configuration

The YouTube chat needs a YouTube Data API v3 key stored as a Worker secret:

```bash
npx wrangler secret put YOUTUBE_API_KEY
```

(Google Cloud console → APIs & Services → enable *YouTube Data API v3* → Credentials → API key. Restrict it to the YouTube Data API.)

## Development

```bash
npm install
npm run dev          # http://localhost:5173 (/api is proxied to clip.justapps.it)
npm test             # unit tests
npm run build && E2E_URL=https://clip.justapps.it/ node scripts/e2e.mjs   # real VOD end-to-end
npm run deploy       # Cloudflare Worker + static assets on clip.justapps.it
```

`scripts/prepare-assets.mjs` copies FFmpeg (single and multi-thread), ONNX Runtime and the caption font into `public/vendor`, splitting files over Cloudflare's 25 MiB limit; `src/core/assets.ts` reassembles and caches them.

## License

[GPL-3.0-or-later](LICENSE). Engines keep their licenses: FFmpeg (GPL), ONNX Runtime (MIT), transformers.js (Apache-2.0), Whisper weights (MIT), Inter (OFL).
