// Turns word timestamps into TikTok-style burned-in captions (ASS / libass):
// short uppercase groups, the word being spoken highlighted in orange.

export interface Word {
  text: string;
  start: number;
  end: number;
}

export interface CaptionStyle {
  width: number;
  height: number;
  fontSize: number;
  /** Vertical center of the captions (pixels from top). */
  y: number;
  maxWords: number;
}

const FONT = 'Inter ExtraBold';
const WHITE = '&H00FFFFFF';
const ORANGE = '&H001F5AFF'; // #ff5a1f in ASS BGR

function ts(t: number): string {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

const escapeAss = (s: string) => s.replace(/\\/g, '＼').replace(/[{}]/g, '').replace(/\n/g, ' ');

/** Groups words into short captions, breaking on pauses and punctuation. */
export function groupWords(words: Word[], maxWords: number, maxChars = 22): Word[][] {
  const groups: Word[][] = [];
  let cur: Word[] = [];
  for (const w of words) {
    const text = w.text.trim();
    if (!text) continue;
    const prev = cur.at(-1);
    const len = cur.reduce((n, x) => n + x.text.trim().length + 1, 0) + text.length;
    if (cur.length && (cur.length >= maxWords || len > maxChars || (prev && w.start - prev.end > 0.6))) {
      groups.push(cur);
      cur = [];
    }
    cur.push({ ...w, text });
    if (/[.!?…]$/.test(text)) {
      groups.push(cur);
      cur = [];
    }
  }
  if (cur.length) groups.push(cur);
  return groups;
}

export function buildAss(words: Word[], style: CaptionStyle): string {
  const outline = Math.round(style.fontSize / 9);
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${style.width}
PlayResY: ${style.height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,${FONT},${style.fontSize},${WHITE},${WHITE},&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,${outline},${Math.round(outline / 2)},5,40,40,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const x = Math.round(style.width / 2);
  const y = Math.round(style.y);
  const lines: string[] = [];
  for (const group of groupWords(words, style.maxWords)) {
    const groupEnd = group.at(-1)!.end;
    group.forEach((w, i) => {
      const start = w.start;
      const end = i < group.length - 1 ? group[i + 1].start : Math.max(groupEnd, start + 0.2);
      if (end <= start) return;
      const text = group
        .map((g, j) => (j === i ? `{\\c${ORANGE}}${escapeAss(g.text.toUpperCase())}{\\c${WHITE}}` : escapeAss(g.text.toUpperCase())))
        .join(' ');
      // A tiny "pop" on the first word of each group.
      const pop = i === 0 ? '{\\fscx92\\fscy92\\t(0,90,\\fscx100\\fscy100)}' : '';
      lines.push(`Dialogue: 0,${ts(start)},${ts(end)},Cap,,0,0,0,,{\\pos(${x},${y})}${pop}${text}`);
    });
  }
  return header + lines.join('\n') + '\n';
}
