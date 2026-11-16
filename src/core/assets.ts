// Loads vendored WebAssembly engines from /vendor. Files larger than the
// 25 MiB Cloudflare limit are stored in parts and reassembled here. Results
// are kept in the Cache API so engines work offline after the first use.

interface Manifest {
  version: string;
  files: Record<string, { size: number; parts: number }>;
}

const BASE =
  typeof location === 'undefined' ? '/vendor/' : new URL('vendor/', location.origin + import.meta.env.BASE_URL).href;
const CACHE = 'justclip-engines';

let manifestPromise: Promise<Manifest> | undefined;
function manifest(): Promise<Manifest> {
  return (manifestPromise ??= fetch(BASE + 'manifest.json', { cache: 'no-cache' }).then((r) => {
    if (!r.ok) throw new Error('Engine manifest not found');
    return r.json();
  }));
}

export type ProgressFn = (fraction: number | null, message?: string) => void;

async function fetchWithProgress(url: string, onBytes: (n: number) => void): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed: ${url} (${res.status})`);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    onBytes(value.length);
  }
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

const memory = new Map<string, Promise<Uint8Array>>();

export function loadAsset(path: string, progress?: ProgressFn): Promise<Uint8Array> {
  let p = memory.get(path);
  if (!p) {
    p = loadAssetUncached(path, progress);
    memory.set(path, p);
    p.catch(() => memory.delete(path));
  }
  return p;
}

async function loadAssetUncached(path: string, progress?: ProgressFn): Promise<Uint8Array> {
  const m = await manifest();
  const entry = m.files[path];
  if (!entry) throw new Error(`Unknown engine asset: ${path}`);
  const cacheKey = `${BASE}${path}?v=${m.version}`;

  let cache: Cache | undefined;
  try {
    cache = await caches.open(CACHE);
    const hit = await cache.match(cacheKey);
    if (hit) return new Uint8Array(await hit.arrayBuffer());
  } catch {
    cache = undefined; // Cache API unavailable (private mode, http).
  }

  let loaded = 0;
  const onBytes = (n: number) => {
    loaded += n;
    progress?.(Math.min(1, loaded / entry.size), 'download');
  };
  let data: Uint8Array;
  if (entry.parts === 0) {
    data = await fetchWithProgress(BASE + path, onBytes);
  } else {
    const parts = await Promise.all(
      Array.from({ length: entry.parts }, (_, i) => fetchWithProgress(`${BASE}${path}.part${i}`, onBytes)),
    );
    data = new Uint8Array(entry.size);
    let off = 0;
    for (const part of parts) {
      data.set(part, off);
      off += part.length;
    }
  }
  if (data.length !== entry.size) throw new Error(`Corrupted download: ${path}`);

  if (cache) {
    try {
      // Drop engines from previous versions.
      for (const req of await cache.keys()) {
        if (req.url.startsWith(BASE + path + '?') && req.url !== cacheKey) await cache.delete(req);
      }
      await cache.put(cacheKey, new Response(data as BlobPart));
    } catch {
      /* quota exceeded: fine, just not cached */
    }
  }
  return data;
}

const MIME: Record<string, string> = { wasm: 'application/wasm', js: 'text/javascript' };

/** A URL for the asset; split files are served from an in-memory blob. */
export async function assetUrl(path: string, progress?: ProgressFn): Promise<string> {
  const m = await manifest();
  const entry = m.files[path];
  if (entry && entry.parts === 0 && !path.endsWith('.wasm')) return BASE + path;
  const data = await loadAsset(path, progress);
  const ext = path.split('.').pop() ?? '';
  return URL.createObjectURL(new Blob([data as BlobPart], { type: MIME[ext] ?? 'application/octet-stream' }));
}

export function vendorUrl(path: string): string {
  return BASE + path;
}
