// Output formats and layouts.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type VerticalMode = 'crop' | 'stack';

export interface LayoutSettings {
  vertical: VerticalMode;
  /** Facecam area in the source (0..1). */
  face: Rect;
  /** Gameplay area in the source (0..1). */
  game: Rect;
  /** Horizontal center of the 9:16 crop (0..1). */
  cropX: number;
  /** Share of the vertical frame used by the facecam (stack mode). */
  faceShare: number;
}

export const DEFAULT_LAYOUT: LayoutSettings = {
  vertical: 'stack',
  face: { x: 0.74, y: 0.02, w: 0.24, h: 0.3 },
  game: { x: 0.125, y: 0, w: 0.75, h: 1 },
  cropX: 0.5,
  faceShare: 0.38,
};

export const FACE_PRESETS: Record<string, Rect> = {
  topLeft: { x: 0.02, y: 0.02, w: 0.24, h: 0.3 },
  topRight: { x: 0.74, y: 0.02, w: 0.24, h: 0.3 },
  bottomLeft: { x: 0.02, y: 0.68, w: 0.24, h: 0.3 },
  bottomRight: { x: 0.74, y: 0.68, w: 0.24, h: 0.3 },
};

export type Format = 'horizontal' | 'vertical';

export function outputSize(format: Format, quality: 720 | 1080): [number, number] {
  if (format === 'horizontal') return quality === 1080 ? [1920, 1080] : [1280, 720];
  return quality === 1080 ? [1080, 1920] : [720, 1280];
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const f = (n: number) => n.toFixed(4);
const crop = (r: Rect) => `crop=w=iw*${f(r.w)}:h=ih*${f(r.h)}:x=iw*${f(r.x)}:y=ih*${f(r.y)}`;

/** Fill a W×H box from a crop, cutting what doesn't fit (no letterboxing). */
const cover = (w: number, h: number) => `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h}`;

/**
 * FFmpeg filter graph from input [0:v] to [v].
 * Returns the graph and the vertical position for captions.
 */
export function videoFilter(format: Format, quality: 720 | 1080, layout: LayoutSettings, subtitles: string | null): { graph: string; captionY: number; fontSize: number } {
  const [W, H] = outputSize(format, quality);
  const subs = subtitles ? `,subtitles=filename=${subtitles}:fontsdir=/fonts` : '';
  if (format === 'horizontal') {
    return {
      graph: `[0:v]fps=30,scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1${subs}[v]`,
      captionY: H * 0.82,
      fontSize: Math.round(H * 0.065),
    };
  }
  if (layout.vertical === 'crop') {
    return {
      graph: `[0:v]fps=30,crop=w=min(iw\\,ih*9/16):h=ih:x=(iw-min(iw\\,ih*9/16))*${f(layout.cropX)}:y=0,${cover(W, H)},setsar=1${subs}[v]`,
      captionY: H * 0.7,
      fontSize: Math.round(W * 0.075),
    };
  }
  const top = even(H * layout.faceShare);
  const bottom = H - top;
  return {
    graph:
      `[0:v]fps=30,split=2[a][b];` +
      `[a]${crop(layout.face)},${cover(W, top)}[top];` +
      `[b]${crop(layout.game)},${cover(W, bottom)}[bot];` +
      `[top][bot]vstack=inputs=2,setsar=1${subs}[v]`,
    captionY: top,
    fontSize: Math.round(W * 0.075),
  };
}
